import { describe, expect, it } from "vitest";
import {
  createInitialSubtitleState,
  reduceSubtitleEvent
} from "./reducer";

describe("subtitle reducer", () => {
  it("applies partial updates to the current segment", () => {
    const state = reduceSubtitleEvent(createInitialSubtitleState(), {
      type: "partial",
      segmentId: "s1",
      sourceText: "hello wor"
    });

    const updated = reduceSubtitleEvent(state, {
      type: "partial",
      segmentId: "s1",
      sourceText: "hello world",
      translatedText: "你好，世界"
    });

    expect(updated.currentSegment).toEqual({
      segmentId: "s1",
      sourceText: "hello world",
      translatedText: "你好，世界",
      status: "partial"
    });
  });

  it("locks a segment after a final event", () => {
    const finalized = reduceSubtitleEvent(createInitialSubtitleState(), {
      type: "final",
      segmentId: "s1",
      sourceText: "hello world",
      translatedText: "你好，世界",
      startTimeMs: 0,
      endTimeMs: 1
    });

    const latePartial = reduceSubtitleEvent(finalized, {
      type: "partial",
      segmentId: "s1",
      sourceText: "hello overwritten",
      translatedText: "覆盖"
    });

    expect(latePartial.currentSegment).toEqual({
      segmentId: "s1",
      sourceText: "hello world",
      translatedText: "你好，世界",
      status: "final"
    });
    expect(latePartial.finalizedSegmentIds).toEqual(["s1"]);
  });

  it("allows translation to lag behind source text", () => {
    const translated = reduceSubtitleEvent(createInitialSubtitleState(), {
      type: "partial",
      segmentId: "s1",
      sourceText: "hello",
      translatedText: "你好"
    });

    const laggingTranslation = reduceSubtitleEvent(translated, {
      type: "partial",
      segmentId: "s1",
      sourceText: "hello world"
    });

    expect(laggingTranslation.currentSegment).toEqual({
      segmentId: "s1",
      sourceText: "hello world",
      translatedText: "你好",
      status: "partial"
    });
  });

  it("stores transient error state", () => {
    const state = reduceSubtitleEvent(createInitialSubtitleState(), {
      type: "error",
      code: "stt_unavailable",
      message: "Speech recognition provider unavailable"
    });

    expect(state.transientError).toEqual({
      code: "stt_unavailable",
      message: "Speech recognition provider unavailable"
    });
  });

  it("updates detected source and target language", () => {
    const state = reduceSubtitleEvent(createInitialSubtitleState(), {
      type: "language",
      sourceLanguage: "ja",
      targetLanguage: "en"
    });

    expect(state.detectedSourceLanguage).toBe("ja");
    expect(state.targetLanguage).toBe("en");
  });
});

describe("reducer multi-segment flow", () => {
  it("shows untranslated partials as source-only and advances across segments", () => {
    let state = createInitialSubtitleState();

    state = reduceSubtitleEvent(state, {
      type: "partial",
      segmentId: "seg-1",
      sourceText: "a",
    });
    expect(state.currentSegment).toMatchObject({
      segmentId: "seg-1",
      translatedText: "",
      status: "partial",
    });

    state = reduceSubtitleEvent(state, {
      type: "final",
      segmentId: "seg-1",
      sourceText: "a b",
      translatedText: "甲乙",
      startTimeMs: 0,
      endTimeMs: 1,
    });
    state = reduceSubtitleEvent(state, {
      type: "partial",
      segmentId: "seg-2",
      sourceText: "c",
    });

    expect(state.currentSegment).toMatchObject({
      segmentId: "seg-2",
      status: "partial",
    });
    expect(state.finalizedSegmentIds).toContain("seg-1");
  });
});

describe("reducer bounds finalized ids", () => {
  it("keeps at most the most recent 50 finalized segment ids", () => {
    let state = createInitialSubtitleState();
    for (let index = 0; index < 60; index += 1) {
      state = reduceSubtitleEvent(state, {
        type: "final",
        segmentId: `seg-${index}`,
        sourceText: `s${index}`,
        translatedText: `t${index}`,
        startTimeMs: index,
        endTimeMs: index + 1,
      });
    }

    expect(state.finalizedSegmentIds).toHaveLength(50);
    expect(state.finalizedSegmentIds).toContain("seg-59");
    expect(state.finalizedSegmentIds).not.toContain("seg-0");

    const late = reduceSubtitleEvent(state, {
      type: "partial",
      segmentId: "seg-59",
      sourceText: "late",
    });
    expect(late).toBe(state);
  });
});

describe("reducer status events", () => {
  it("tracks providerConnection from status events", () => {
    let state = createInitialSubtitleState();
    expect(state.providerConnection).toBe("live");
    state = reduceSubtitleEvent(state, { type: "status", state: "reconnecting" });
    expect(state.providerConnection).toBe("reconnecting");
    state = reduceSubtitleEvent(state, { type: "status", state: "live" });
    expect(state.providerConnection).toBe("live");
  });
});

describe("reducer speaker tracking", () => {
  it("copies speakerId onto the current segment and tracks first-seen order", () => {
    let state = createInitialSubtitleState();
    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
      startTimeMs: 0, endTimeMs: 1, speakerId: "spk-a"
    });
    expect(state.currentSegment?.speakerId).toBe("spk-a");
    expect(state.seenSpeakerIds).toEqual(["spk-a"]);

    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "s2", sourceText: "bye", translatedText: "再见",
      startTimeMs: 1, endTimeMs: 2, speakerId: "spk-b"
    });
    expect(state.seenSpeakerIds).toEqual(["spk-a", "spk-b"]);

    // A returning speaker is not re-added.
    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "s3", sourceText: "hi again", translatedText: "又见",
      startTimeMs: 2, endTimeMs: 3, speakerId: "spk-a"
    });
    expect(state.seenSpeakerIds).toEqual(["spk-a", "spk-b"]);
  });

  it("leaves seenSpeakerIds empty when events carry no speaker", () => {
    let state = createInitialSubtitleState();
    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
      startTimeMs: 0, endTimeMs: 1
    });
    expect(state.seenSpeakerIds).toEqual([]);
    expect(state.currentSegment?.speakerId).toBeUndefined();
  });
});
