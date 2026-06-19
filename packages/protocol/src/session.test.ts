import { describe, expect, it } from "vitest";
import { isClientMessage, isStartSessionMessage, CANONICAL_PCM_AUDIO_FORMAT } from "./session";

const validStartMessage = {
  type: "start",
  apiKey: "dev-key",
  sessionId: "local-1",
  tabTitle: "Example",
  tabUrl: "https://example.com/watch",
  targetLanguage: "zh-CN",
  audioFormat: {
    mimeType: "audio/webm",
    codec: "opus",
    sampleRateHz: 48_000,
    channelCount: 2,
  },
  clientCapabilities: {
    binaryAudioFrames: true,
    partialSubtitles: true,
    finalSubtitles: true,
    languageEvents: true,
    errorEvents: true,
  },
};

describe("session protocol", () => {
  it("accepts start messages through the client message validator", () => {
    expect(isClientMessage({ type: "start" })).toBe(true);
  });

  it("accepts start session messages for the backend handshake", () => {
    expect(isStartSessionMessage(validStartMessage)).toBe(true);
  });

  it("accepts a minimal start control message planned for fake backend tests", () => {
    expect(isStartSessionMessage({ type: "start" })).toBe(true);
  });

  it("rejects unknown client message types", () => {
    expect(isStartSessionMessage({ type: "audio" })).toBe(false);
  });

  it("rejects invalid handshake fields", () => {
    expect(
      isStartSessionMessage({
        ...validStartMessage,
        audioFormat: { ...validStartMessage.audioFormat, sampleRateHz: "48000" },
      }),
    ).toBe(false);

    expect(
      isStartSessionMessage({
        ...validStartMessage,
        clientCapabilities: {
          ...validStartMessage.clientCapabilities,
          partialSubtitles: "yes",
        },
      }),
    ).toBe(false);
  });

  it("rejects present-but-undefined optional handshake fields", () => {
    expect(
      isStartSessionMessage({
        ...validStartMessage,
        clientCapabilities: undefined,
      }),
    ).toBe(false);
  });
});

describe("start mode field", () => {
  it("accepts a start message with a valid mode", () => {
    expect(isStartSessionMessage({ type: "start", mode: "pipeline" })).toBe(true);
    expect(isStartSessionMessage({ type: "start", mode: "interpret" })).toBe(true);
  });

  it("accepts a start message with no mode", () => {
    expect(isStartSessionMessage({ type: "start" })).toBe(true);
  });

  it("rejects a start message with an invalid mode", () => {
    expect(isStartSessionMessage({ type: "start", mode: "turbo" })).toBe(false);
    expect(isStartSessionMessage({ type: "start", mode: 1 })).toBe(false);
  });
});

describe("CANONICAL_PCM_AUDIO_FORMAT", () => {
  it("describes 16 kHz / 16-bit / mono signed PCM", () => {
    expect(CANONICAL_PCM_AUDIO_FORMAT).toEqual({
      mimeType: "audio/pcm",
      codec: "pcm_s16le",
      sampleRateHz: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
  });

  it("is accepted on a start message by the client-message guard", () => {
    expect(
      isStartSessionMessage({
        type: "start",
        audioFormat: CANONICAL_PCM_AUDIO_FORMAT,
      }),
    ).toBe(true);
  });
});
