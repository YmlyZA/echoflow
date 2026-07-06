import type { SubtitleDisplaySegment } from "./reducer";

// Tolerance (seconds) between the live playhead and the latest recorded final:
// within this of the captured edge, treat the user as watching live.
const EDGE_EPSILON_SEC = 2;

/**
 * Picks what the overlay shows: the live streaming line when watching at the
 * captured edge (or when there is no video-time info), the recorded line for the
 * scrubbed-back position otherwise (which may be null in a silence gap).
 */
export function chooseDisplaySegment(input: {
  currentTimeSec: number | null;
  maxCapturedVideoSec: number | null;
  liveSegment: SubtitleDisplaySegment | null;
  replaySegment: SubtitleDisplaySegment | null;
}): SubtitleDisplaySegment | null {
  if (input.currentTimeSec === null || input.maxCapturedVideoSec === null) {
    return input.liveSegment;
  }
  if (input.currentTimeSec >= input.maxCapturedVideoSec - EDGE_EPSILON_SEC) {
    return input.liveSegment;
  }
  return input.replaySegment;
}
