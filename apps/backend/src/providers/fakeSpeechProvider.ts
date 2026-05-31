export type SpeechSegment = {
  segmentId: string;
  partialText: string;
  finalText: string;
  sourceLanguage: string;
};

export type SpeechProvider = {
  recognize(frame: unknown): Promise<SpeechSegment>;
  close(): Promise<void> | void;
};

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
