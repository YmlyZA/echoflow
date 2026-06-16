import type { SegmentEvent } from "./types.js";
import type { VolcengineUtterance } from "./volcengineAsrProtocol.js";

export class UtteranceReconciler {
  private readonly finalized = new Set<number>();
  private readonly lastPartialText = new Map<number, string>();

  reconcile(utterances: VolcengineUtterance[]): SegmentEvent[] {
    const events: SegmentEvent[] = [];

    utterances.forEach((utterance, index) => {
      if (this.finalized.has(index)) {
        return;
      }

      const segmentId = `seg-${index + 1}`;
      const text = utterance.text ?? "";
      const startTimeMs = utterance.start_time ?? 0;

      if (utterance.definite === true) {
        this.finalized.add(index);
        this.lastPartialText.delete(index);
        events.push({
          kind: "final",
          segmentId,
          text,
          startTimeMs,
          endTimeMs: utterance.end_time ?? startTimeMs,
        });
        return;
      }

      if (this.lastPartialText.get(index) === text) {
        return;
      }
      this.lastPartialText.set(index, text);
      events.push({ kind: "partial", segmentId, text, startTimeMs });
    });

    return events;
  }
}
