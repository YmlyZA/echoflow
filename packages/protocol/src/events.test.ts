import { describe, expect, it } from "vitest";
import { isServerEvent, makeFinalSegment } from "./events";

describe("protocol events", () => {
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

  it("rejects unknown event types", () => {
    expect(isServerEvent({ type: "unknown" })).toBe(false);
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
