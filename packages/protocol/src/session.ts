export type AudioFormatMetadata = {
  mimeType: string;
  codec?: string;
  sampleRateHz: number;
  channelCount: number;
  bitsPerSample?: number;
};

export type ClientCapabilities = {
  binaryAudioFrames: boolean;
  partialSubtitles: boolean;
  finalSubtitles: boolean;
  languageEvents: boolean;
  errorEvents: boolean;
};

export type SessionHandshakeRequest = {
  apiKey: string;
  sessionId: string;
  tabTitle: string;
  tabUrl: string;
  targetLanguage: string;
  audioFormat: AudioFormatMetadata;
  clientCapabilities?: ClientCapabilities;
};

export type SessionConfig = {
  backendUrl: string;
  apiKey: string;
  targetLanguage: string;
  audioFormat: AudioFormatMetadata;
  clientCapabilities?: ClientCapabilities;
};

export type SessionMetadata = {
  sessionId: string;
  tabTitle: string;
  tabUrl: string;
  targetLanguage: string;
  sourceLanguage?: string;
  startedAt: string;
  endedAt?: string;
};
