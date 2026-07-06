import type { SubtitleDisplaySegment } from "./reducer";

export interface TimelineEntry {
  videoStartSec: number;
  videoEndSec: number;
  segment: SubtitleDisplaySegment;
}

const DEFAULT_HOLD_SEC = 1;

/**
 * Indexes finals by video-playback time so the overlay can replay the line at a
 * scrubbed position. `segmentAt` returns the latest entry starting at or before
 * the queried time, held briefly past its end (holdSec) to bridge inter-sentence
 * gaps; a longer silence clears to undefined. Entries are not assumed sorted (a
 * mid-capture seek can reorder video-start), so lookup scans — the count is small
 * (one per sentence) and lookups are throttled.
 */
export function createSubtitleTimeline(): {
  add(entry: TimelineEntry): void;
  segmentAt(videoSec: number, holdSec?: number): TimelineEntry | undefined;
  maxVideoEndSec(): number | undefined;
  reset(): void;
} {
  let entries: TimelineEntry[] = [];

  return {
    add(entry: TimelineEntry): void {
      entries.push(entry);
    },
    segmentAt(videoSec: number, holdSec: number = DEFAULT_HOLD_SEC): TimelineEntry | undefined {
      let best: TimelineEntry | undefined;
      for (const entry of entries) {
        if (entry.videoStartSec <= videoSec) {
          if (best === undefined || entry.videoStartSec > best.videoStartSec) {
            best = entry;
          }
        }
      }
      if (best === undefined || videoSec > best.videoEndSec + holdSec) {
        return undefined;
      }
      return best;
    },
    maxVideoEndSec(): number | undefined {
      let max: number | undefined;
      for (const entry of entries) {
        if (max === undefined || entry.videoEndSec > max) {
          max = entry.videoEndSec;
        }
      }
      return max;
    },
    reset(): void {
      entries = [];
    }
  };
}
