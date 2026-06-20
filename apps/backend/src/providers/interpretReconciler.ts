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

  reconcile(event: AstServerEvent): InterpretSegment[] {
    if (event.kind === "source") {
      this.sourceText = event.text;
      if (event.final) {
        return []; // source end is not a render boundary; translation end is
      }
      return [
        {
          kind: "partial",
          segmentId: `ast-${this.ordinal}`,
          text: this.sourceText,
          startTimeMs: 0,
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
        startTimeMs: 0,
        endTimeMs: 0,
      };
      this.ordinal += 1;
      this.sourceText = "";
      this.translationText = "";
      return [final];
    }
    return [];
  }
}
