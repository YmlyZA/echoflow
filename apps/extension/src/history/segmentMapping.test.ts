import { describe, expect, it } from "vitest";
import { finalEventToSegment } from "./segmentMapping";

describe("finalEventToSegment", () => {
  it("maps a final event to a history segment using the event's timestamps", () => {
    const segment = finalEventToSegment({
      localSessionId: "local-1",
      event: {
        type: "final",
        segmentId: "seg-1",
        sourceText: "hi",
        translatedText: "你好",
        startTimeMs: 0,
        endTimeMs: 500,
      },
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(segment).toEqual({
      sessionId: "local-1",
      segmentId: "seg-1",
      startTimeMs: 0,
      endTimeMs: 500,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      sourceText: "hi",
      translatedText: "你好",
      status: "final",
    });
  });

  it("carries speakerId onto the stored segment when present", () => {
    const segment = finalEventToSegment({
      localSessionId: "local-1",
      event: {
        type: "final",
        segmentId: "s1",
        sourceText: "hi",
        translatedText: "你好",
        startTimeMs: 0,
        endTimeMs: 1,
        speakerId: "spk-a",
      },
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(segment.speakerId).toBe("spk-a");
  });

  it("omits speakerId when the event has none", () => {
    const segment = finalEventToSegment({
      localSessionId: "local-1",
      event: {
        type: "final",
        segmentId: "s1",
        sourceText: "hi",
        translatedText: "你好",
        startTimeMs: 0,
        endTimeMs: 1,
      },
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(segment.speakerId).toBeUndefined();
  });

  it("carries video times onto the segment when supplied", () => {
    const segment = finalEventToSegment({
      localSessionId: "local-1",
      event: {
        type: "final", segmentId: "e1:seg-1", sourceText: "hi", translatedText: "你好",
        startTimeMs: 0, endTimeMs: 500,
      },
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      videoStartSec: 42.0,
      videoEndSec: 42.5,
    });
    expect(segment.videoStartSec).toBe(42.0);
    expect(segment.videoEndSec).toBe(42.5);
  });

  it("omits video times when not supplied", () => {
    const segment = finalEventToSegment({
      localSessionId: "local-1",
      event: {
        type: "final", segmentId: "e1:seg-1", sourceText: "hi", translatedText: "你好",
        startTimeMs: 0, endTimeMs: 500,
      },
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(segment.videoStartSec).toBeUndefined();
  });
});
