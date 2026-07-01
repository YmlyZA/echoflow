export type AudioFrame = {
  data: Buffer | ArrayBuffer;
  sequenceNumber: number;
  timestampMs: number;
};

export type SegmentEvent =
  | { kind: "language"; sourceLanguage: string }
  | { kind: "partial"; segmentId: string; text: string; startTimeMs: number; speakerId?: string }
  | {
      kind: "final";
      segmentId: string;
      text: string;
      startTimeMs: number;
      endTimeMs: number;
      speakerId?: string;
    };

export interface SpeechRecognitionStream {
  pushFrame(frame: AudioFrame): void;
  end(): Promise<void>;
  close(): Promise<void>;
}

export type SpeechProvider = {
  open(opts: {
    onSegment: (event: SegmentEvent) => void;
    onError?: (error: Error) => void;
  }): SpeechRecognitionStream;
};

export type TranslationInput = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslationProvider = {
  translate(input: TranslationInput): Promise<string>;
  close(): Promise<void> | void;
};
