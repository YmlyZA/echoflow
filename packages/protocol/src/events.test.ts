import { describe, expect, it } from "vitest";
import { isServerEvent, makeFinalSegment } from "./events";

describe("protocol events", () => {
  it("accepts partial subtitle events without translation", () => {
    expect(
      isServerEvent({
        type: "partial",
        segmentId: "s1",
        sourceText: "hello every",
      }),
    ).toBe(true);
  });

  it("accepts partial subtitle events with translation", () => {
    expect(
      isServerEvent({
        type: "partial",
        segmentId: "s1",
        sourceText: "hello every",
        translatedText: "你好，每",
      }),
    ).toBe(true);
  });

  it("accepts final subtitle events", () => {
    expect(
      isServerEvent({
        type: "final",
        segmentId: "s1",
        sourceText: "hello everyone",
        translatedText: "大家好",
        startTimeMs: 0,
        endTimeMs: 1000,
      }),
    ).toBe(true);
  });

  it("accepts language events", () => {
    expect(
      isServerEvent({
        type: "language",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
    ).toBe(true);
  });

  it("accepts error events", () => {
    expect(
      isServerEvent({
        type: "error",
        code: "stt_unavailable",
        message: "Speech recognition provider unavailable",
      }),
    ).toBe(true);
  });

  it("rejects unknown event types", () => {
    expect(isServerEvent({ type: "unknown" })).toBe(false);
  });

  it("rejects events missing required fields", () => {
    expect(isServerEvent({ type: "language", sourceLanguage: "en" })).toBe(
      false,
    );
    expect(isServerEvent({ type: "partial", segmentId: "s1" })).toBe(false);
    expect(
      isServerEvent({
        type: "final",
        segmentId: "s1",
        sourceText: "hello",
      }),
    ).toBe(false);
    expect(isServerEvent({ type: "error", code: "stt_unavailable" })).toBe(
      false,
    );
  });

  it("rejects present-but-undefined optional partial translations", () => {
    expect(
      isServerEvent({
        type: "partial",
        segmentId: "s1",
        sourceText: "hello",
        translatedText: undefined,
      }),
    ).toBe(false);
  });

  it("creates finalized history segments", () => {
    expect(
      makeFinalSegment({
        sessionId: "local-1",
        segmentId: "s1",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        sourceText: "hello",
        translatedText: "你好",
        startTimeMs: 0,
        endTimeMs: 900,
      }).status,
    ).toBe("final");
  });

  it("accepts partial and final events carrying a string speakerId", () => {
    expect(
      isServerEvent({ type: "partial", segmentId: "s1", sourceText: "hi", speakerId: "spk-a" })
    ).toBe(true);
    expect(
      isServerEvent({
        type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
        startTimeMs: 0, endTimeMs: 1, speakerId: "spk-a"
      })
    ).toBe(true);
  });

  it("accepts final events with no speakerId (field is optional)", () => {
    expect(
      isServerEvent({
        type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
        startTimeMs: 0, endTimeMs: 1
      })
    ).toBe(true);
  });

  it("rejects events whose speakerId is present but not a string", () => {
    expect(
      isServerEvent({ type: "partial", segmentId: "s1", sourceText: "hi", speakerId: 3 })
    ).toBe(false);
    expect(
      isServerEvent({
        type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
        startTimeMs: 0, endTimeMs: 1, speakerId: 3
      })
    ).toBe(false);
  });

  it("accepts a status event for both connection states", () => {
    expect(isServerEvent({ type: "status", state: "reconnecting" })).toBe(true);
    expect(isServerEvent({ type: "status", state: "live" })).toBe(true);
  });

  it("rejects a status event with an unknown or missing state", () => {
    expect(isServerEvent({ type: "status", state: "paused" })).toBe(false);
    expect(isServerEvent({ type: "status" })).toBe(false);
  });
});

describe("isServerEvent final timestamps", () => {
  it("accepts a final event with numeric start/end times", () => {
    expect(
      isServerEvent({
        type: "final",
        segmentId: "seg-1",
        sourceText: "hello",
        translatedText: "你好",
        startTimeMs: 0,
        endTimeMs: 500,
      }),
    ).toBe(true);
  });

  it("rejects a final event missing start/end times", () => {
    expect(
      isServerEvent({
        type: "final",
        segmentId: "seg-1",
        sourceText: "hello",
        translatedText: "你好",
      }),
    ).toBe(false);
  });

  it("rejects a final event with non-numeric times", () => {
    expect(
      isServerEvent({
        type: "final",
        segmentId: "seg-1",
        sourceText: "hello",
        translatedText: "你好",
        startTimeMs: "0",
        endTimeMs: 500,
      }),
    ).toBe(false);
  });
});
