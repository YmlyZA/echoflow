import type { SubtitleDisplaySegment } from "./reducer";

// Symmetric tolerance (seconds) around the live capture front: within this of the
// front (ahead by ASR lag, or slightly behind), the user is watching live.
const EDGE_BAND_SEC = 4;

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
  if (Math.abs(input.currentTimeSec - input.liveEdgeSec) <= EDGE_BAND_SEC) {
    return input.liveSegment;
  }
  return input.replaySegment;
}
