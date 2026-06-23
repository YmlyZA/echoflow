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
      if (!event.final) {
        // 651: non-final source frames are DELTA fragments — accumulate them
        // into the current line. Timestamps are 0 on these frames.
        this.sourceText += event.text;
        return [
          {
            kind: "partial",
            segmentId: `ast-${this.ordinal}`,
            text: this.sourceText,
            startTimeMs: this.sourceStartTime,
          },
        ];
      }
      // 652: the source end frame carries the CUMULATIVE line plus the real
      // start/end timestamps. Treat it as authoritative; don't render yet —
      // the translation end frame is the segment boundary.
      this.sourceText = event.text;
      this.sourceStartTime = event.startTime;
      this.sourceEndTime = event.endTime;
      return [];
    }
    if (event.kind === "translation") {
      if (!event.final) {
        // 654: non-final translation frames are DELTA fragments — buffer them;
        // we surface the cumulative translation only on the end frame.
        return [];
      }
      // 655: the translation end frame carries the CUMULATIVE translation and
      // real timestamps. Pair it with the buffered source line and emit.
      this.translationText = event.text;
      const final: InterpretSegment = {
        kind: "final",
        segmentId: `ast-${this.ordinal}`,
        text: this.sourceText,
        translatedText: this.translationText,
        // Prefer the source-end timestamps; fall back to the translation-end
        // frame's (they match in practice) if no source-end was seen.
        startTimeMs: this.sourceStartTime || event.startTime,
        endTimeMs: this.sourceEndTime || event.endTime,
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
