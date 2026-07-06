# Scrub-Sync Playback Design (SP2)

> Captured 2026-07-06. Third slice of the "history as user data" arc. Makes the video-time
> alignment from SP1b *visible*: when the user scrubs the video back within the captured range,
> the overlay shows the line that was recorded at that position instead of the live-streaming line.

## Goal

During a live session, the overlay follows the video's `currentTime`:
- watching at the live edge → the streaming current line (today's behavior, unchanged);
- scrubbed back to an earlier position within what's been captured → the **recorded** line at that
  video position;
- a silence gap or a position before anything captured → no line.

Scope is the **current session's captured range** — replaying a *previously* captured video's
transcript is SP3 (cache reuse). This slice turns SP1b's stored `videoStartSec`/`videoEndSec` into
a user-visible feature.

## Design

### 1. Video-timed finals reach the content script

Finals carry `videoStartSec`/`videoEndSec` only in the background (computed there for the history
write — SP1b). For the overlay to replay by video time, the content script needs them. Extend the
**internal** `ServerEventMessage` with optional `videoStartSec?`/`videoEndSec?`; `background.forward
ServerEvent` sets them for `final` events (reusing the values it already computes for the history
append). The wire `ServerEvent`/protocol is untouched — this is the extension's own bus.

### 2. Content script builds a video-time timeline

A new pure `subtitleTimeline` (`src/subtitles/subtitleTimeline.ts`) indexes finals by video time:
`add({ videoStartSec, videoEndSec, segment })`, `segmentAt(videoSec, holdSec?)`, `maxVideoEndSec()`,
`reset()`. `segmentAt` returns the latest entry with `videoStartSec <= videoSec`, but only if
`videoSec <= videoEndSec + holdSec` (default ~1 s, bridging inter-sentence gaps) — else `undefined`
(a real silence gap shows nothing rather than a stale line). The content component feeds each
video-timed final into the timeline as it arrives.

### 3. Live-vs-replay selection (pure)

A pure `chooseDisplaySegment` (`src/subtitles/chooseDisplaySegment.ts`) decides what the overlay
shows:

```
chooseDisplaySegment({ currentTimeSec, maxCapturedVideoSec, liveSegment, replaySegment }):
  if currentTimeSec === null or maxCapturedVideoSec === null → liveSegment   // no video-time info yet: behave as today
  if currentTimeSec >= maxCapturedVideoSec - EDGE_EPSILON_SEC → liveSegment   // at/near the live edge → streaming
  return replaySegment                                                        // scrubbed back → recorded line (may be null in a gap)
```

`EDGE_EPSILON_SEC` (~2 s) tolerates the lag between the live playhead and the latest recorded final.
`liveSegment` is the existing reducer `currentSegment` (partials + latest final); `replaySegment` is
`timeline.segmentAt(currentTimeSec)?.segment ?? null`.

### 4. Content component wiring

`EchoFlowMount` gains: a `subtitleTimeline` ref (fed on each `final` `SERVER_EVENT` that carries
video times), a `currentTimeSec` state (updated from the existing sampling effect — it already reads
`video.currentTime`, now also `setState`s it, throttled), and `maxCapturedVideoSec` from
`timeline.maxVideoEndSec()`. It computes `displayedSegment = chooseDisplaySegment(...)` and passes
that to `<SubtitleOverlay segment=... />` instead of always `subtitleState.currentSegment`. Live
partials/finals still flow through the reducer unchanged; replay is layered on top. When no `<video>`
exists (`currentTimeSec` stays null), behavior is exactly today's.

## Components (units)

- `src/subtitles/subtitleTimeline.ts` — pure timeline index (add / segmentAt / maxVideoEndSec / reset).
- `src/subtitles/chooseDisplaySegment.ts` — pure live-vs-replay decision.
- `src/messaging/messages.ts` — `ServerEventMessage` gains `videoStartSec?`/`videoEndSec?`.
- `entrypoints/background.ts` — set video times on the forwarded final `SERVER_EVENT` (reuse SP1b's computed values).
- `entrypoints/content.tsx` — timeline ref, `currentTimeSec` state, `chooseDisplaySegment` wiring.

## Testing

- **`subtitleTimeline.test.ts`**: `segmentAt` inside a segment → that segment; within `holdSec` of a
  segment's end → still that segment; beyond the hold (long gap) → `undefined`; before all entries →
  `undefined`; picks the correct entry among several; `maxVideoEndSec` tracks the max.
- **`chooseDisplaySegment.test.ts`**: null `currentTimeSec`/`maxCaptured` → `liveSegment`; at the edge
  (within `EDGE_EPSILON`) → `liveSegment`; scrubbed back → `replaySegment`; scrubbed back into a gap
  (`replaySegment` null) → null.
- **`messages.test.ts`**: a `SERVER_EVENT` with `videoStartSec`/`videoEndSec` is accepted (optional
  fields; guard unchanged).
- Background wiring (attach video times to the forwarded final) and content wiring (timeline feed +
  `currentTimeSec` state + selection) are entrypoint code (smoke-covered); the two pure helpers carry
  the unit contract.

## Non-goals (later / out of scope)

- **SP3 — per-video cache reuse:** loading a *previous* session's transcript on revisit; identity
  normalization / provider `videoId`. SP2 replays only the current session's captured range.
- A seek-bar / transcript-scrubber UI, click-to-seek, or a full transcript panel in the overlay.
- Playback-rate compensation or sub-100ms replay precision (nearest/hold is sufficient).
- Any wire-protocol change.

## Rollout

1. Land on `feat/scrub-sync-playback` via PR (CI `check` gates the merge).
2. Manual check post-merge: capture an HTML5 `<video>`; let a few lines record; scrub back — the
   overlay shows the recorded line at that position; scrub to the live edge — it resumes the
   streaming line; scrub into a silence gap — it clears.
3. Docs: mark SP2 shipped in `docs/superpowers/backlog.md`; note replay in `CLAUDE.md`.
