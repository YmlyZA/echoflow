import type { SpeechProvider, SpeechSegment } from "./types.js";

export class FakeSpeechProvider implements SpeechProvider {
  async recognize(_frame: unknown): Promise<SpeechSegment> {
    return {
      segmentId: "fake-1",
      partialText: "hello from fake speech",
      finalText: "hello from fake speech provider",
      sourceLanguage: "en",
    };
  }

  close(): void {
    // No resources to release for the deterministic fake provider.
  }
}
