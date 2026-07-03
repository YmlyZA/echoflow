# Capture → Video-Time Alignment Design (SP1b)

> Captured 2026-07-03. Second slice of the "history as user data" arc. Anchors each recorded final
> to the video's playback position (`videoStartSec`/`videoEndSec`), so a transcript can later be
> looked up by video time — the direct prerequisite for scrub-sync (SP2) and cache reuse (SP3).

## Goal

Every recorded final carries the video-playback position where its words were spoken, computed
accurately regardless of ASR latency or a mid-capture seek. When no `<video>` is present (or no
timing samples exist yet), the final is still recorded — just without video times (best-effort).

## Why not the obvious approaches

- **Stamp `video.currentTime` when the final arrives:** wrong. Finals arrive 1–3s *after* the words
  were spoken (ASR + network latency), so the playhead has moved on — the subtitle would be anchored
  ~2s too late. Noticeable when scrubbing.
- **`V0 + startTimeMs` (video position at capture start + capture offset):** correct only if playback
  is perfectly linear; a mid-capture seek makes every later final diverge permanently.

The accurate approach correlates **capture time ↔ video time via wall-clock**, using the ASR
utterance's own start time (which reflects *when in the captured audio* it occurred, not when the
final arrived).

## Architecture

Three contexts cooperate; the wire protocol (`packages/protocol`) is unchanged — all new data rides
the internal runtime bus and the history record.

### 1. Content script samples the video timeline (page → background)

The content script runs in the page and can read the active `<video>`. On mount it locates the video
(the first/primary media element) and reports `(wallClockMs, videoSec)` samples to the background via
a new `VIDEO_TIME_SAMPLE` runtime message — throttled on `timeupdate` (~4 Hz native) plus immediate
samples on `seeked`/`play`/`pause` so discontinuities are captured precisely. If no `<video>` exists,
it simply sends nothing (alignment is then unavailable → finals recorded without video times).

### 2. Offscreen reports the capture start instant (offscreen → background)

`startTimeMs` on a final is relative to the captured audio stream (first frame = 0). To turn it into
a wall-clock instant, the background needs the wall-clock when capture began. The offscreen records
`captureStartedAtMs` (wall-clock at `pipeline.start()`) and includes it on the existing
`SESSION_STARTED` runtime message. One value per session; no per-final plumbing.

### 3. Background correlates and stores (the alignment)

The background, for the active session:
- maintains a bounded `videoTimeIndex` (a ring of recent `(wallClockMs, videoSec)` samples fed by
  `VIDEO_TIME_SAMPLE`);
- remembers `captureStartedAtMs` from `SESSION_STARTED`;
- on each `final`, computes the spoken wall-clock — `spokenStartMs = captureStartedAtMs +
  event.startTimeMs` (and `spokenEndMs` from `endTimeMs`) — and looks each up in the index to get
  `videoStartSec` / `videoEndSec`, which it stores on the history segment.

`videoTimeIndex.lookup(wallClockMs)` returns the **nearest** sample's `videoSec` when one exists
within a tolerance (~1 s ≈ a few sample intervals), else `undefined`. Nearest (not interpolation)
avoids interpolating across a seek discontinuity; at ~4 Hz sampling the nearest sample is within
~125 ms of truth — ample for subtitle anchoring. The ring is bounded (e.g. last ~1200 samples,
minutes of history) because finals arrive within seconds of being spoken, so only recent samples are
ever needed for live alignment; the aligned times are then persisted on the history record.

### 4. History schema: video times on the record (no protocol change)

`HistorySegmentRecord` currently *is* the protocol `SubtitleSegment`. Decouple it:
`HistorySegmentRecord = SubtitleSegment & { videoStartSec?: number; videoEndSec?: number }`.
`finalEventToSegment` gains optional `videoStartSec`/`videoEndSec` args and spreads them onto the
`makeFinalSegment` result. The wire `SubtitleSegment` and `makeFinalSegment` are untouched; only the
stored record carries the extra optional fields. No Dexie index change is needed (video times are
not indexed in this slice — SP2 reads them per session and can sort in memory).

## Components (units)

- `src/subtitles/videoTimeIndex.ts` — pure: `createVideoTimeIndex(opts?)` → `{ addSample(wallClockMs,
  videoSec), lookup(wallClockMs): number | undefined }`; bounded ring, nearest-within-tolerance.
- `messaging/messages.ts` — `VideoTimeSampleMessage { type: "VIDEO_TIME_SAMPLE"; localSessionId;
  wallClockMs; videoSec }`; `SessionStartedMessage` gains `captureStartedAtMs?: number`. `isRuntimeMessage`
  accepts the new type; sender validation (Slice E) already applies.
- `history/segmentMapping.ts` + `history/historyStore.ts` — extended record + optional video args.
- `entrypoints/content.tsx` — video sampling (entrypoint).
- `entrypoints/offscreen/main.ts` — record + send `captureStartedAtMs` (entrypoint).
- `entrypoints/background.ts` — index + alignment + store on the history segment (entrypoint).

## Testing

- **`videoTimeIndex.test.ts`**: nearest sample within tolerance; `undefined` beyond tolerance / empty;
  ring eviction keeps the newest; a seek (non-monotonic `videoSec`) resolves to the nearest wall-clock
  sample, not an interpolation across the jump.
- **`messages.test.ts`**: `isRuntimeMessage` accepts `VIDEO_TIME_SAMPLE`.
- **`segmentMapping.test.ts`** / **`historyStore.test.ts`**: `finalEventToSegment` carries
  `videoStartSec`/`videoEndSec` when supplied; a segment persists + reads them back; omitting them
  leaves the fields `undefined` (unchanged behavior).
- Content sampling, offscreen `captureStartedAtMs`, and background alignment are entrypoint wiring
  (smoke-covered); the pure `videoTimeIndex` + the mapping carry the unit contract. The alignment
  arithmetic (`captureStartedAtMs + startTimeMs → lookup`) is a thin call over the tested index.

## Non-goals (later slices)

- **SP2 — scrub-sync playback:** reading these video times to drive the overlay from `video.currentTime`.
- **SP3 — per-video cache reuse** / identity normalization.
- Sub-frame accuracy, playback-rate compensation, or interpolation across seeks (nearest-sample is
  sufficient for v1; revisit if scrub precision demands it).
- Any wire-protocol change or a Dexie index on video time.

## Rollout

1. Land on `feat/video-time-alignment` via PR (CI `check` gates the merge).
2. Manual check post-merge: capture a standard HTML5 `<video>`, then inspect a session's exported
   history — finals carry plausible `videoStartSec` matching where they were spoken; seeking mid-
   capture keeps later finals aligned to the new position.
3. Docs: mark SP1b shipped in `docs/superpowers/backlog.md` (and fix the stale `#9 → PR #TBD`
   reference to `#27`); note `VIDEO_TIME_SAMPLE` + video-time history in `CLAUDE.md`.
