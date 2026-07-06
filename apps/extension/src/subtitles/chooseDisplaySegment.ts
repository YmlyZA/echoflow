import type { SubtitleDisplaySegment } from "./reducer";

// How far the playhead can LEAD the last confirmed final (ASR latency + an
// in-progress sentence) and still count as watching live. A larger gap means the
// user jumped forward into cached territory.
const LIVE_AHEAD_SEC = 30;
// How far the playhead can TRAIL the live front (a small back-scrub) and still
// count as live; a larger gap is a scrub back into recorded content.
const LIVE_BEHIND_SEC = 4;

/**
 * Picks what the overlay shows. `liveEdgeSec` is the current session's live capture
 * front (max videoEnd of LIVE finals) — NOT the timeline extent, which with a
 * loaded cache spans the whole video. Watching near the front → the streaming line;
 * scrubbed away (back, or forward into cached territory) → the recorded line.
 */
export function chooseDisplaySegment(input: {
  currentTimeSec: number | null;
  liveEdgeSec: number | null;
  liveSegment: SubtitleDisplaySegment | null;
  replaySegment: SubtitleDisplaySegment | null;
}): SubtitleDisplaySegment | null {
  if (input.currentTimeSec === null) {
    return input.liveSegment;
  }
  if (input.liveEdgeSec === null) {
    // No live final yet: show the cached line at this position if we have one,
    // otherwise the streaming line (partials at the start of capture).
    return input.replaySegment ?? input.liveSegment;
  }
  if (
    input.currentTimeSec >= input.liveEdgeSec - LIVE_BEHIND_SEC &&
    input.currentTimeSec <= input.liveEdgeSec + LIVE_AHEAD_SEC
  ) {
    return input.liveSegment;
  }
  return input.replaySegment;
}
