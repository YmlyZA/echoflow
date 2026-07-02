import type { SegmentEvent } from "./types.js";
import type { VolcengineUtterance } from "./volcengineAsrProtocol.js";

// SeedASR (result_type:"single") streams a tentative partial tail (multi-sentence,
// unstable punctuation) and flags an utterance `definite` once a sentence is
// confirmed. We surface confirmed sentences only: one final per new `definite`
// utterance, keyed on our own monotonic ordinal. Partials are ignored.
export class UtteranceReconciler {
  private ordinal = 0;
  private lastEmittedStartTime = -1;

  reconcile(utterances: VolcengineUtterance[]): SegmentEvent[] {
    const events: SegmentEvent[] = [];

    for (const utterance of utterances) {
      if (utterance.definite !== true) {
        continue;
      }
      const text = utterance.text ?? "";
      const startTimeMs = utterance.start_time ?? 0;
      // Dedupe by utterance boundary: SeedASR re-sends a confirmed sentence with
      // the same start_time, but a genuinely repeated sentence is a later VAD
      // segment with a later start_time — so a verbatim repeat still surfaces.
      if (text === "" || startTimeMs <= this.lastEmittedStartTime) {
        continue;
      }

      this.lastEmittedStartTime = startTimeMs;
      this.ordinal += 1;
      events.push({
        kind: "final",
        segmentId: `seg-${this.ordinal}`,
        text,
        startTimeMs,
        endTimeMs: utterance.end_time ?? startTimeMs,
      });
    }

    return events;
  }
}
