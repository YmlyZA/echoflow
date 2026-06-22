import type { AstServerEvent } from "./astProtocol.js";

export type InterpretSegment =
  | { kind: "language"; sourceLanguage: string }
  | { kind: "partial"; segmentId: string; text: string; startTimeMs: number }
  | {
      kind: "final";
      segmentId: string;
      text: string;
      translatedText: string;
      startTimeMs: number;
      endTimeMs: number;
    };

export class InterpretReconciler {
  private ordinal = 0;
  private sourceText = "";
  private translationText = "";
  private sourceStartTime = 0;
  private sourceEndTime = 0;

  reconcile(event: AstServerEvent): InterpretSegment[] {
    if (event.kind === "source") {
      // Capture startTime from the first source event of this segment (when sourceText was empty).
      if (this.sourceText === "") {
        this.sourceStartTime = event.startTime;
      }
      this.sourceEndTime = event.endTime;
      this.sourceText = event.text;
      if (event.final) {
        return []; // source end is not a render boundary; translation end is
      }
      return [
        {
          kind: "partial",
          segmentId: `ast-${this.ordinal}`,
          text: this.sourceText,
          startTimeMs: this.sourceStartTime,
        },
      ];
    }
    if (event.kind === "translation") {
      this.translationText = event.text;
      if (!event.final) {
        return []; // buffer revising translation; surface only on end
      }
      const final: InterpretSegment = {
        kind: "final",
        segmentId: `ast-${this.ordinal}`,
        text: this.sourceText,
        translatedText: this.translationText,
        startTimeMs: this.sourceStartTime,
        endTimeMs: this.sourceEndTime,
      };
      this.ordinal += 1;
      this.sourceText = "";
      this.translationText = "";
      this.sourceStartTime = 0;
      this.sourceEndTime = 0;
      return [final];
    }
    return [];
  }
}
