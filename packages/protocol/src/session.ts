export type AudioFormatMetadata = {
  mimeType: string;
  codec?: string;
  sampleRateHz: number;
  channelCount: number;
  bitsPerSample?: number;
};

export const CANONICAL_PCM_AUDIO_FORMAT: AudioFormatMetadata = {
  mimeType: "audio/pcm",
  codec: "pcm_s16le",
  sampleRateHz: 16000,
  channelCount: 1,
  bitsPerSample: 16,
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

export type StartSessionMessage = {
  type: "start";
} & Partial<SessionHandshakeRequest>;

export type AudioFrameMetadata = {
  sequenceNumber: number;
  timestampMs: number;
  durationMs?: number;
  byteLength?: number;
};

export type AudioFrameMessage = {
  type: "audio_frame";
  sessionId?: string;
  frame: AudioFrameMetadata;
};

export type StopSessionMessage = {
  type: "stop";
  sessionId?: string;
  reason?: string;
};

export type ClientMessage =
  | StartSessionMessage
  | AudioFrameMessage
  | StopSessionMessage;

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

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "start":
      return isStartSessionMessage(value);
    case "audio_frame":
      return isAudioFrameMessage(value);
    case "stop":
      return isStopSessionMessage(value);
    default:
      return false;
  }
}

export function isStartSessionMessage(
  value: unknown,
): value is StartSessionMessage {
  if (!isRecord(value) || value.type !== "start") {
    return false;
  }

  return (
    isOptionalString(value, "apiKey") &&
    isOptionalString(value, "sessionId") &&
    isOptionalString(value, "tabTitle") &&
    isOptionalString(value, "tabUrl") &&
    isOptionalString(value, "targetLanguage") &&
    isOptionalAudioFormat(value, "audioFormat") &&
    isOptionalClientCapabilities(value, "clientCapabilities")
  );
}

function isAudioFrameMessage(value: Record<string, unknown>): value is AudioFrameMessage {
  return (
    value.type === "audio_frame" &&
    isOptionalString(value, "sessionId") &&
    isAudioFrameMetadata(value.frame)
  );
}

function isStopSessionMessage(value: Record<string, unknown>): value is StopSessionMessage {
  return (
    value.type === "stop" &&
    isOptionalString(value, "sessionId") &&
    isOptionalString(value, "reason")
  );
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !hasOwn(value, key) || typeof value[key] === "string";
}

function isOptionalAudioFormat(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return !hasOwn(value, key) || isAudioFormatMetadata(value[key]);
}

function isOptionalClientCapabilities(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return !hasOwn(value, key) || isClientCapabilities(value[key]);
}

function isAudioFormatMetadata(value: unknown): value is AudioFormatMetadata {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.mimeType === "string" &&
    isOptionalString(value, "codec") &&
    typeof value.sampleRateHz === "number" &&
    Number.isFinite(value.sampleRateHz) &&
    typeof value.channelCount === "number" &&
    Number.isFinite(value.channelCount) &&
    (!hasOwn(value, "bitsPerSample") ||
      (typeof value.bitsPerSample === "number" &&
        Number.isFinite(value.bitsPerSample)))
  );
}

function isAudioFrameMetadata(value: unknown): value is AudioFrameMetadata {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.sequenceNumber === "number" &&
    Number.isFinite(value.sequenceNumber) &&
    typeof value.timestampMs === "number" &&
    Number.isFinite(value.timestampMs) &&
    (!hasOwn(value, "durationMs") ||
      (typeof value.durationMs === "number" && Number.isFinite(value.durationMs))) &&
    (!hasOwn(value, "byteLength") ||
      (typeof value.byteLength === "number" && Number.isFinite(value.byteLength)))
  );
}

function isClientCapabilities(value: unknown): value is ClientCapabilities {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.binaryAudioFrames === "boolean" &&
    typeof value.partialSubtitles === "boolean" &&
    typeof value.finalSubtitles === "boolean" &&
    typeof value.languageEvents === "boolean" &&
    typeof value.errorEvents === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
