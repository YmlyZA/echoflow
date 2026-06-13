# Spec 1 — Realtime Pipeline & Segment-Semantics Refactor

**Date:** 2026-06-13
**Status:** Approved (design)
**Scope track:** Technical-debt paydown, sub-project 1 of 2 (Spec 2 = session robustness: SW-restart recovery + in-session reconnect).

## Problem

The realtime path works end-to-end on fake providers, but the backend conflates "an audio chunk arrived" with "a subtitle segment finished." Reading the runtime surfaced four coupled defects:

1. **Double processing (P0).** `realtimeClient.sendAudioFrame` sends two WebSocket messages per 250 ms chunk — a JSON `audio_frame` metadata frame, then the binary blob. The backend's `handleFrame` runs the full `recognize → translate → translate` pipeline on *both* (the JSON via `handleClientMessage`'s `audio_frame` case, the binary via the fall-through). Every chunk is processed twice, producing duplicate `partial`/`final` events and, under a real provider, double latency and double translation cost.
2. **No segment model (P0).** `recognize(frame): SpeechSegment` is request-response and runs per frame, emitting `partial` + `final` for every chunk with a constant `segmentId: "fake-1"`. Real streaming ASR (Volcengine/Aliyun/Tencent) is bidirectional: you push audio continuously and the service pushes back partial updates and final results on its own VAD/punctuation cadence, owning segment boundaries. The current shape cannot host a real provider.
3. **Wrong export timestamps (P1).** `OffscreenAudioPipeline` computes correct capture-relative `timestampMs` per frame, but the backend ignores frame metadata entirely and `background.forwardServerEvent` stamps history segments with `Date.now()` (and `startTimeMs === endTimeMs`). `formatTimestamp` then renders epoch-derived nonsense.
4. **`sourceLanguage` never persisted (P1).** The `language` event updates only a background module variable; the history *session* record keeps `sourceLanguage: undefined`, so exports always show `unknown`.

A latent fifth defect rides along: the constant `segmentId` means history's `[sessionId+segmentId]` primary key overwrites every segment to one row.

## Goals / Success Criteria

- One audio chunk is processed **exactly once**.
- The speech provider interface is **streaming** and shaped so a real ASR adapter is a drop-in implementation (Spec for "real ASR" is a later phase; this spec only ships the fake adapter against the new interface).
- The fake provider emits **multiple distinct segments** with progressive `partial`s and a closing `final`, carrying **real capture-relative timestamps**, fully deterministic (no `Date.now`, no randomness).
- Exported transcripts show **correct timestamps and source language**.
- All behavior covered by deterministic unit tests using the existing DI + in-memory + pure-reducer style. Existing `dev-smoke.sh` / Playwright smoke remain valid and unchanged.

## Non-Goals (explicitly deferred)

- SW-restart session recovery and in-session WebSocket reconnect → **Spec 2**.
- `finalizedSegmentIds` unbounded growth (P2; segment count is now bounded per session) → optional, default Spec 2.
- `apiKey` in WS query string → documented limitation, acceptable for the localhost MVP (browser `WebSocket` cannot set headers); not changed here.
- Embedding `sequenceNumber`/`timestampMs` into a binary frame header → YAGNI; the two-message scheme is kept with a clarified contract.
- Translating `partial` text → out of scope by decision (partials display source only; see §1).

## Design

### §1 Streaming Speech Provider interface (backend-internal)

The provider contract changes from request-response to a callback/sink stream. These types live in the **backend** (`apps/backend/src/providers/types.ts`), not the wire protocol package — they are an internal port, not a network contract.

```ts
export type AudioFrame = {
  data: Buffer | ArrayBuffer;   // binary audio payload
  sequenceNumber: number;
  timestampMs: number;          // capture-relative, from the offscreen pipeline
};

export type SegmentEvent =
  | { kind: "language"; sourceLanguage: string }
  | { kind: "partial"; segmentId: string; text: string; startTimeMs: number }
  | { kind: "final"; segmentId: string; text: string; startTimeMs: number; endTimeMs: number };

export interface SpeechRecognitionStream {
  pushFrame(frame: AudioFrame): void;   // non-blocking
  end(): Promise<void>;                 // input finished; flush any in-progress segment as final
  close(): Promise<void>;               // release immediately, stop callbacks
}

export interface SpeechProvider {
  open(opts: { onSegment: (event: SegmentEvent) => void }): SpeechRecognitionStream;
}
```

**Rationale (Shape A — sink/callback):** matches `ws`'s `socket.on("message")` event model; real streaming ASR SDKs are push+callback; backpressure can be absorbed inside `pushFrame`; trivially testable by injecting `onSegment` and asserting the collected event sequence. (Async-iterator and EventEmitter alternatives were rejected: the former needs bridging from ws callbacks and adds ceremony; the latter is weakly typed and clashes with the repo's DI/pure-function test style.)

**Translation provider** keeps its interface (`translate(input): Promise<string>`). Only the call site changes: translate **once per `final`**; do **not** translate `partial`s. The reducer's existing `event.translatedText ?? previous ?? ""` fallback renders the source-only partial.

### §2 Backend `RealtimeSession` — pump + relay

Split the session into an input side (pump frames into the provider stream) and an output side (`onSegment` translates + relays). The session no longer processes audio directly.

Connection lifecycle:

```
"start" control       → stream = speechProvider.open({ onSegment }); set targetLanguage
                         (NO audio processing on start — fixes the start-processes-audio bug)
"audio_frame" JSON     → stash pendingFrameMeta { sequenceNumber, timestampMs }
binary frame           → stream.pushFrame({ data, ...pendingFrameMeta }); clear pending
"stop" control         → await stream.end(); socket.close()
socket "close" event   → await stream.close()
```

Output side — the only place `ServerEvent`s are produced:

- `language` → relay `language` ServerEvent (the once-only guard moves **into the provider**; the session just relays whatever the provider emits).
- `partial` → relay `partial` ServerEvent with `sourceText: event.text`, `translatedText` omitted. No translation.
- `final` → `translate(event.text)` once → relay `final` ServerEvent with `sourceText`, `translatedText`, **and `startTimeMs`/`endTimeMs`**.

**Frame metadata contract (clarified, not re-framed):** an `audio_frame` JSON message announces metadata for the **immediately-following** binary frame. A single WebSocket connection preserves message order, so "last-seen metadata applies to the next binary frame" is safe. A backend ordering test guards this.

### §3 Wire protocol change

`packages/protocol/src/events.ts`:

- Extend `FinalSubtitleEvent` with `startTimeMs: number` and `endTimeMs: number`. This is the only clean channel for real timestamps to reach the extension's history.
- `PartialSubtitleEvent` is **not** extended (history persists finals only — YAGNI).
- Update the `isServerEvent` guard's `"final"` case to require both new numeric fields; update `events.test.ts` (accept valid, reject missing/non-numeric).

`ClientMessage` / `session.ts` are unchanged — the double-processing fix is entirely backend framing semantics.

### §4 Fake streaming provider

`FakeSpeechProvider.open({ onSegment })` returns a `SpeechRecognitionStream` driven **purely by frame count** (no wall clock, no randomness → deterministic).

```ts
const SCRIPT = [
  "hello from echoflow",
  "this is the second segment",
  "and a third line to finalize",
]; // each entry = one segment, advanced word-by-word
```

`pushFrame(frame)` behavior:

- First frame ever: emit `{ kind: "language", sourceLanguage: "en" }`.
- Every `K` frames: advance the current segment's partial by one word → emit `{ kind: "partial", segmentId: "seg-N", text: <word prefix>, startTimeMs: <first frame ts of this segment> }`.
- When the current segment's words are exhausted (after `M` frames): emit `{ kind: "final", segmentId: "seg-N", text: <full sentence>, startTimeMs, endTimeMs: <last frame ts> }`; advance to the next `SCRIPT` entry; increment `N`.
- `end()`: flush any in-progress segment as a `final`.

Segment timestamps are taken **directly from the pushed frames' `timestampMs`** — not self-generated. Because frame timing comes from `OffscreenAudioPipeline` (injectable `now`), a test that pushes frames with known timestamps yields fully determined segment times. `segmentId` is incrementing (`seg-1`, `seg-2`, …), not the constant `"fake-1"`, which also fixes the history primary-key overwrite.

### §5 Timestamp / persistence correctness closure

`apps/extension/entrypoints/background.ts` → `forwardServerEvent`:

- **`final`:** build `makeFinalSegment` with `startTimeMs: event.startTimeMs`, `endTimeMs: event.endTimeMs` (from §3). Delete the `Date.now()` stamping.
- **`language`:** in addition to updating the `detectedSourceLanguage` module variable, persist it to the history session via a new thin store method.

`apps/extension/src/history/historyStore.ts`:

- Add `updateSessionLanguages(sessionId, changes: { sourceLanguage?: string; targetLanguage?: string }): Promise<void>` wrapping `persistence.updateSession` (also bumps `updatedAt`). Exports then show the real source language instead of `unknown`, and `formatTimestamp` renders sane values.

### §6 Testing strategy

Deterministic, DI, in-memory, pure-function — consistent with existing tests.

| Layer | Test |
|---|---|
| protocol · `events.test.ts` | `final` guard accepts valid `startTimeMs`/`endTimeMs`; rejects missing / non-numeric. |
| backend · `fakeSpeechProvider.test.ts` | Push known-timing frames → assert deterministic sequence: `language` once, progressive `partial`s, multiple `final`s with correct `segmentId`s and frame-derived timestamps; `end()` flushes in-progress segment. |
| backend · `realtime/session.test.ts` | ① **No double processing** — stub provider counting `pushFrame`; `start` + `audio_frame` JSON + binary results in exactly one frame pumped and one partial/final set. ② Metadata→binary pairing/ordering — frame carries the preceding meta's `timestampMs`. ③ `start` does not process audio. ④ `final` carries timestamps; `translate` called once per `final`, zero per `partial`. ⑤ `stop` → `end` + `close`. |
| extension · background | `final` with timestamps → `historyStore.appendSegment` persists those times (assert via in-memory persistence). `language` → session `sourceLanguage` persisted. |
| extension · `subtitles/reducer.test.ts` | Multiple distinct `segmentId`s do not collapse; `partial` without `translatedText` renders source. |
| extension · `historyStore.test.ts` | `updateSessionLanguages` method; export contains real source language + sane timestamps. |
| e2e | `dev-smoke.sh` / Playwright smoke unchanged; still valid. |

## Affected files

- `packages/protocol/src/events.ts`, `events.test.ts` — extend `FinalSubtitleEvent` + guard.
- `apps/backend/src/providers/types.ts` — new streaming `SpeechProvider`/`SpeechRecognitionStream`/`AudioFrame`/`SegmentEvent`.
- `apps/backend/src/providers/fakeSpeechProvider.ts`, `fakeSpeechProvider.test.ts` — multi-segment streaming fake.
- `apps/backend/src/realtime/session.ts`, `session.test.ts` — pump + relay; frame pairing; once-per-final translation.
- `apps/extension/entrypoints/background.ts` — real timestamps + persist source language.
- `apps/extension/src/history/historyStore.ts`, `historyStore.test.ts` — `updateSessionLanguages`; export correctness.
- `apps/extension/src/subtitles/reducer.test.ts` — multi-segment + source-only partial coverage.

## Sequencing within Spec 1

1. Protocol (`FinalSubtitleEvent` + guard + test) — the contract everything else depends on.
2. Backend provider interface + fake provider + tests.
3. Backend `RealtimeSession` pump/relay + tests.
4. Extension background + historyStore correctness + tests.
5. Full `pnpm build && pnpm test && pnpm typecheck` green; smoke unchanged.
