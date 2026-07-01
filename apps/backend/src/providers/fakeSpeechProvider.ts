import type {
  AudioFrame,
  SegmentEvent,
  SpeechProvider,
  SpeechRecognitionStream,
} from "./types.js";

const SCRIPT = [
  "hello from echoflow",
  "this is the second segment",
  "and a third line to finalize",
];

// Parallel to SCRIPT (one entry per segment); the `?? "spk-a"` keeps the type
// `string` under noUncheckedIndexedAccess — the index is always in range because
// emissions only happen after the SCRIPT[segmentIndex] guard.
const SPEAKERS = ["spk-a", "spk-b", "spk-a"];

export class FakeSpeechProvider implements SpeechProvider {
  open(opts: {
    onSegment: (event: SegmentEvent) => void;
  }): SpeechRecognitionStream {
    let languageEmitted = false;
    let segmentIndex = 0;
    let wordIndex = 0;
    let segmentStartMs = 0;
    let lastTimestampMs = 0;
    let closed = false;

    function pushFrame(frame: AudioFrame): void {
      if (closed) {
        return;
      }

      if (!languageEmitted) {
        opts.onSegment({ kind: "language", sourceLanguage: "en" });
        languageEmitted = true;
      }

      const sentence = SCRIPT[segmentIndex];
      if (sentence === undefined) {
        return;
      }

      lastTimestampMs = frame.timestampMs;
      const words = sentence.split(" ");
      if (wordIndex === 0) {
        segmentStartMs = frame.timestampMs;
      }
      wordIndex += 1;
      const segmentId = `seg-${segmentIndex + 1}`;
      const speakerId = SPEAKERS[segmentIndex] ?? "spk-a";

      if (wordIndex < words.length) {
        opts.onSegment({
          kind: "partial",
          segmentId,
          text: words.slice(0, wordIndex).join(" "),
          startTimeMs: segmentStartMs,
          speakerId,
        });
        return;
      }

      opts.onSegment({
        kind: "final",
        segmentId,
        text: words.join(" "),
        startTimeMs: segmentStartMs,
        endTimeMs: frame.timestampMs,
        speakerId,
      });
      segmentIndex += 1;
      wordIndex = 0;
    }

    return {
      pushFrame,
      // Async so real streaming adapters can drain in-flight audio; the fake resolves immediately.
      async end() {
        if (closed) {
          return;
        }
        const sentence = SCRIPT[segmentIndex];
        if (sentence !== undefined && wordIndex > 0) {
          const words = sentence.split(" ");
          opts.onSegment({
            kind: "final",
            segmentId: `seg-${segmentIndex + 1}`,
            text: words.join(" "),
            startTimeMs: segmentStartMs,
            endTimeMs: lastTimestampMs,
            speakerId: SPEAKERS[segmentIndex] ?? "spk-a",
          });
          segmentIndex += 1;
          wordIndex = 0;
        }
        closed = true;
      },
      async close() {
        closed = true;
      },
    };
  }
}
