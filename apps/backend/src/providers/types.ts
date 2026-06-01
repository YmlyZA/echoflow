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

export type TranslationInput = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslationProvider = {
  translate(input: TranslationInput): Promise<string>;
  close(): Promise<void> | void;
};
