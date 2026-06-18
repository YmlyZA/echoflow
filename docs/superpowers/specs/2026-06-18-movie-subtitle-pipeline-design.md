# Movie-Style Live Bilingual Subtitle Pipeline — Design

**Date:** 2026-06-18
**Status:** Approved (design); pending implementation plan

## Goal

Make EchoFlow's on-page subtitles behave like real movie bilingual subtitles: a
single, concise **current line** (source updates live; translation a beat later)
that keeps pace with speech — instead of one ever-growing line whose translation
falls arbitrarily behind.

## Problems being fixed

Observed with the real Volcengine SeedASR path:

1. **One ever-growing line.** ASR is fast and accurate, but the source line keeps
   extending until it fills/overflows the overlay. Root cause: the adapter
   requests Volcengine's default `result_type:"full"` (cumulative — every frame
   re-sends the whole transcript), and the reconciler/overlay faithfully render
   the growing current utterance.
2. **Translation falls behind, then stops showing.** Root cause: `session.ts`
   translates every `final` with a blocking `await` inside one serialized `tail`
   promise chain. The moment finals arrive faster than the translation HTTP
   round-trip, the queue grows without bound and lag compounds until translations
   are minutes behind. (It already translates one utterance's text, not "all"
   text — the killer is the serial blocking + unbounded queue.)

Rendering is already single-line: the reducer keeps one replaceable
`currentSegment` (`reducer.ts`) and the overlay renders exactly one source + one
translation `<p>` (`SubtitleOverlay.tsx`). So no change is needed there.

## Desired UX (chosen)

**Finalized whole-sentence subtitles** (revised 2026-06-18 after capturing real
frames — see "Post-capture revision" below): show one **confirmed** sentence at a
time, source + translation together, replacing the previous line. Cleanest,
most movie-like, and most reliable. A short VAD reduces the per-sentence delay.

(An earlier "live-typing" option — render the growing partial live — was
rejected once the real data showed partials run 1–2 sentences ahead with
*unstable, revising punctuation*, so only `definite` is a trustworthy sentence
boundary.)

## Approach

Let Volcengine's VAD segment sentences server-side, and make translation
non-blocking and latest-wins so it can never back up. **Backend-only** — no
protocol or extension changes.

```
Volcengine (VAD-segmented, result_type:single)
   → utteranceReconciler (incremental, monotonic segments)
   → RealtimeSession (instant source delivery + single-flight latest-wins translation)
   → existing ServerEvents → extension reducer (unchanged) → overlay (one live line)
```

## Section 1 — Request config (server-side segmentation)

In `apps/backend/src/providers/volcengineSpeechProvider.ts`, `buildRequestConfig`
adds three fields to `request`:

```ts
request: {
  model_name: "bigmodel",
  enable_punc: true,
  result_type: "single",        // incremental: stop re-sending the whole transcript
  show_utterances: true,        // utterances[] with definite + timestamps
  vad_segment_duration: VAD_SEGMENT_DURATION_MS, // ~1s silence splits a sentence
}
```

- `VolcengineAsrRequestConfig` (in `volcengineAsrProtocol.ts`) gains the three
  optional fields: `result_type?: string`, `show_utterances?: boolean`,
  `vad_segment_duration?: number`.
- `VAD_SEGMENT_DURATION_MS` is a named constant defaulting to `1000`, overridable
  via the env var `VOLCENGINE_ASR_VAD_MS` (parsed in `config.ts`, carried on
  `VolcengineAsrConfig`) so pacing can be tuned without a rebuild. If the env var
  is absent or invalid, the default applies.

Reference for the parameters: <https://www.volcengine.com/docs/6561/1354869>.
`result_type:"single"` returns results incrementally (does not re-send
previously-segmented sentences); `show_utterances:true` is required to receive
`utterances` with `definite`; `vad_segment_duration` (default 3000 ms) is the
silence threshold that splits sentences.

## Section 2 — Reconciler: finalized sentences only (post-capture revision)

**Real frames captured 2026-06-18** show that under `result_type:"single"` SeedASR
streams a tentative partial *tail* that runs 1–2 sentences ahead with **unstable,
revising punctuation** (e.g. `"…warnings? I except."` → `"…except that one, I
think."`), and flags an utterance `definite:true` only when a sentence is
**confirmed** (after which `single` mode drops it from later frames). So the only
trustworthy sentence boundary is `definite`. Given the chosen finalized-only UX,
the reconciler ignores partials entirely:

`apps/backend/src/providers/utteranceReconciler.ts` emits **one `final` per newly
confirmed `definite` utterance**:

- Maintain a monotonic `ordinal` (starts at 0) and `lastFinalText`.
- For each utterance in the frame, in order: skip unless `definite === true`;
  skip empty text or text equal to `lastFinalText` (dedupe a re-sent confirmation);
  otherwise set `lastFinalText`, increment `ordinal`, and emit a `final` for
  `seg-${ordinal}` with `startTimeMs`/`endTimeMs`.
- Never emit `partial` events.

This keys segment identity on our own monotonic ordinal (not the vendor index) and
is robust to multi-utterance frames (a confirmed sentence + a trailing partial)
since non-`definite` entries are ignored.

## Section 3 — Decoupled, latest-wins translation (`session.ts`)

Replace the blocking serial translation with non-blocking delivery + a
single-flight, latest-wins translator.

- The one-time `language` event emits immediately. (With the finalized-only
  reconciler no `partial` events occur; the session keeps its partial-delivery
  path so it stays provider-agnostic, but it is simply never exercised by the
  Volcengine path.)
- **Finals go through a single-flight latest-wins translator:**
  - The session tracks `latestSegmentId` — updated on every segment event it
    receives from the reconciler.
  - On a `final`, record `{ segmentId, sourceText, startTimeMs, endTimeMs }` as
    the pending translation, superseding any not-yet-started pending final.
  - A single worker translates the pending final. When it resolves, emit the
    `final` `ServerEvent` (source + translation) **only if its `segmentId` is
    still `latestSegmentId`** (no newer segment has appeared); otherwise drop it.
    Then pick up the next pending final, if any.
  - At most one translation in flight and at most one pending → the pipeline can
    never accumulate a backlog. Under fast speech, a superseded sentence's
    translation is skipped (its source already showed live) rather than piling up.
- Errors: a translation failure still surfaces via the existing
  `error` `ServerEvent` path (and provider `onError` for connection failures).
- Ordering guarantee: because the backend only ever emits the live partial and a
  still-current final, the extension never receives an out-of-order final to
  regress to.

The existing ordered `tail` chain is retained only for the immediate
(non-translated) events (language/partial) to preserve their arrival order; final
translation moves to the single-flight worker described above.

## Section 4 — Reducer / protocol: no change

The backend is the single authority for the "current line", so the extension
needs no changes:

- `reducer.ts` already renders a single replaceable `currentSegment` and already
  applies a `final` that had no preceding partial (it sets `currentSegment`
  unconditionally), so short sentences still display.
- No protocol field is added; `partial`/`final` `ServerEvent`s are unchanged.
- `finalizedSegmentIds` bounding (Spec 2) is unaffected.

## Section 5 — Testing

- **Task 0 — capture real frames (temporary).** Add a one-line debug log of the
  parsed Volcengine `result` in `volcengineSpeechProvider`'s `onMessage` (behind
  an env flag, e.g. `ECHOFLOW_ASR_DEBUG=1`), run a short real session, record the
  `result_type:"single"` frame shape, then remove the log. This grounds the
  reconciler model in Section 2 before it is finalized.
- **Reconciler unit tests** (`utteranceReconciler.test.ts`, rewritten): partial
  growth within a sentence; `definite` → exactly one final; ordinal bumps on the
  next sentence; no re-emit of a finalized sentence; robustness to utterance-index
  reset (crafted frames mirroring the observed SeedASR shape).
- **Session tests** (`session.test.ts`): partials are emitted without waiting on a
  slow translation provider (non-blocking — a deliberately delayed fake
  translator must not delay partial delivery); latest-wins (a newer final arriving
  during translation supersedes/drops the stale one); a final is emitted with its
  translation when it is still the latest segment.
- **Provider test** (`volcengineSpeechProvider.test.ts`): the full-client-request
  JSON includes `result_type:"single"`, `show_utterances:true`, and
  `vad_segment_duration`.
- **Config test** (`config.test.ts`): `VOLCENGINE_ASR_VAD_MS` flows into
  `asr.volcengine` (default when unset).
- **Manual e2e:** real run — one short live source line that resets per sentence,
  with the Chinese translation appearing a beat later and keeping pace; confirm it
  no longer grows unbounded or falls behind.

## Out of scope (future work)

- Translating partials (debounced) for even earlier translation — deferred; the
  per-final latest-wins model is the MVP.
- Backend↔Volcengine auto-reconnect and `end()` drain (carried over from the ASR
  spec's out-of-scope list).
- Tuning `vad_segment_duration` per content type, or exposing it in the extension
  UI.
