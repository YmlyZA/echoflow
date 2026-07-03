# Video-Anchored History — Foundation Design (SP1a)

> Captured 2026-07-03. First slice of the "history as user data" arc (local, video-aware; no
> accounts). Makes the transcript a **complete, identified** record — the proper fix for audit #9
> — and stores which video each session belongs to. Sets up later slices: capture→video-time
> alignment (SP1b), scrub-sync playback (SP2), per-video cache reuse (SP3).

## Goal

The history a session produces is **complete** (every confirmed final is recorded, not just the
ones that survived a render-time race) and **identified** (each session knows which video/page it
transcribed). Rendering stays a clean single "current line" — no visual flash-back — so completeness
does not cost UX.

## The problem (audit #9)

`pipelineSubtitleSource` keeps a single `pendingFinal` slot and, after translating, emits the final
only when `job.segmentId === latestSegmentId` (latest-wins). Two consequences:
1. **Single-slot overwrite:** a second final arriving during one translation RTT overwrites the
   first before it is ever translated — it is lost entirely.
2. **Latest-wins emit drop:** a final whose translation finishes after a newer segment started is
   silently dropped.
Because the extension only records finals it actually receives (`background.forwardServerEvent`),
both dropped classes vanish from history, not just from the screen. The latest-wins behavior exists
for a real reason — a bounded "movie-style current line" render — but it is imposed on the *history*
consumer, which wants completeness. The fix is to **split the two concerns onto the one event
stream**: the backend emits every final; the render layer picks the latest.

## Design

### 1. Backend: translate a FIFO queue, emit every final in order

Replace the single `pendingFinal` slot in `pipelineSubtitleSource` with a **bounded FIFO queue**:

- `onSegment` pushes each `final` onto the queue (instead of overwriting a slot) and kicks the
  single-flight drain worker.
- `drainTranslations` shifts the queue front, translates it, and **always emits** the translated
  `final` (in completion = arrival order) — the `job.segmentId === latestSegmentId` emit gate is
  removed. The translation-failure path (audit #1, already shipped) is unchanged: on a throw it
  still emits the source-only final + non-fatal `translation_failed` error.
- **Bound:** cap the queue at `MAX_PENDING_FINALS` (64). If a push would exceed it (a pathologically
  stalled translation provider), drop the **oldest** queued final and emit one non-fatal
  `history_truncated` error event, so memory is bounded and the truncation is visible rather than
  silent. In practice sentence rate (seconds) ≪ translation RTT (~300 ms), so the queue sits at
  0–1 and this never fires.

`latestSegmentId` tracking and the partial path are unchanged. `end()`'s idle-drain (await the queue
empty + no in-flight translation) already generalizes from the single slot to the queue.

This removes the render-vs-history conflict at the source: the backend's job becomes "emit every
confirmed final, translated, in order."

### 2. Extension render: monotonic current-line guard

With the backend emitting every final, a slow-translated older final can now arrive **after** a newer
line is already shown. To keep the "single current line" UX, `subtitles/reducer.ts` gains a
**monotonic guard**: a `final` (or `partial`) whose segment is *older* than the currently displayed
segment does not replace `currentSegment` (it is still counted in `finalizedSegmentIds`). Ordering is
by parsing the backend's `e{epoch}:seg-{ordinal}` id into `(epoch, ordinal)` and comparing tuples
(higher epoch wins; then higher ordinal) — a new helper `compareSegmentId(a, b)` in `src/subtitles/`.
History is untouched by this guard: `background.forwardServerEvent` records **every** final it
receives, so completeness lives in the background and clean rendering lives in the content script —
the two consumers of the same stream, each doing its own job.

### 3. History: store video identity on the session

`HistorySessionRecord` gains `videoUrl?: string` and `videoTitle?: string`. `background.startSession`
fetches the tab's url/title (`chrome.tabs.get(tabId)` — readable under the `activeTab` grant the
session's user gesture already provides) and passes them into `historyStore.createLocalSession`.
Dexie schema bumps to **v2**, indexing `videoUrl` (for the later cache lookup); the fields are
additive, so existing v1 records upgrade cleanly (missing fields stay `undefined`). This is the
identity that SP3 (cache reuse) keys on; storing it now means history recorded from this point is
already cache-ready.

Normalization / provider `videoId` parsing (YouTube `?v=`, etc.) is **not** in this slice — we store
the raw tab url/title; identity-matching rules are SP3's concern.

## Testing

- **`pipelineSubtitleSource.test.ts`**: two finals arriving within one translation RTT are BOTH
  emitted (queue, no overwrite); a slow-translated earlier final is still emitted after a later one
  (no latest-wins drop). **Update** the existing latest-wins test — which pins the old drop — to
  assert the new emit-all behavior. Queue-bound test: exceeding `MAX_PENDING_FINALS` drops the oldest
  and emits `history_truncated` (injectable bound for the test).
- **`reducer.test.ts`** + **`compareSegmentId` test**: an older final does not replace a newer shown
  segment (no flash-back); a newer final does; `compareSegmentId` orders by epoch then ordinal.
- **`historyStore.test.ts`**: `createLocalSession` persists `videoUrl`/`videoTitle`; `getSegments`
  still returns all recorded finals.
- Background wiring (tab fetch → identity) is entrypoint code (smoke-covered); the tab-metadata read
  mirrors the offscreen's existing `getTabMetadata`.
- **CLAUDE.md** update: the architecture note currently describes latest-wins as the pipeline's
  design; revise it to "emit every final; the extension render picks the latest, history keeps all."

## Non-goals (later slices)

- **SP1b — capture→video-time alignment:** content-script `video.currentTime` sampling → background
  aligns each final to a video position (`videoStartSec`/`videoEndSec`). Segments here keep their
  capture-relative `startTimeMs`/`endTimeMs`.
- **SP2 — scrub-sync playback:** overlay follows `video.currentTime` (incl. seeks) from the stored
  video-time.
- **SP3 — per-video cache reuse:** revisiting a known `videoUrl` loads its transcript; identity
  normalization / `videoId`.
- **SP4 — accounts / cloud sync** (uses the existing `syncStatus`).

## Rollout

1. Land on `feat/video-anchored-history-foundation` via PR (CI `check` gates the merge).
2. Manual check post-merge: rapid sentences (or a slow translation) no longer drop lines from the
   Options history panel / export; the overlay still shows one clean current line; a session's
   history record carries the video url/title.
3. Update `docs/superpowers/backlog.md`: #9 resolved via this foundation; SP1b/SP2/SP3/SP4 tracked.
