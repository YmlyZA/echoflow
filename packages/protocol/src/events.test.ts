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
});
