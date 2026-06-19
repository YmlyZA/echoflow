import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@echoflow/protocol";
import type {
  SegmentEvent,
  SpeechProvider,
  TranslationProvider,
} from "../providers/types.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";

function stubSpeech(): {
  provider: SpeechProvider;
  emit: (event: SegmentEvent) => void;
} {
  let onSegment: ((event: SegmentEvent) => void) | undefined;
  const provider: SpeechProvider = {
    open: (opts) => {
      onSegment = opts.onSegment;
      return { pushFrame: () => {}, end: async () => {}, close: async () => {} };
    },
  };
  return { provider, emit: (event) => onSegment?.(event) };
}

function buildSource(translation: TranslationProvider, speech: SpeechProvider) {
  const events: ServerEvent[] = [];
  const source = new PipelineSubtitleSource(speech, translation, "zh-CN");
  source.open({ onEvent: (event) => events.push(event) });
  return events;
}

describe("PipelineSubtitleSource", () => {
  it("emits a language event with the target language", () => {
    const speech = stubSpeech();
    const events = buildSource(
      { translate: async () => "x", close: () => {} },
      speech.provider,
    );
    speech.emit({ kind: "language", sourceLanguage: "en" });
    expect(events).toContainEqual({
      type: "language",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
  });

  it("forwards a partial immediately without waiting on translation", async () => {
    const speech = stubSpeech();
    const events = buildSource(
      { translate: () => new Promise<string>(() => {}), close: () => {} },
      speech.provider,
    );
    speech.emit({ kind: "partial", segmentId: "seg-1", text: "hi", startTimeMs: 0 });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "partial",
        segmentId: "seg-1",
        sourceText: "hi",
      }),
    );
  });

  it("emits a translated final and drops a stale one (latest-wins)", async () => {
    const speech = stubSpeech();
    let resolveFirst: (value: string) => void = () => {};
    let calls = 0;
    const translation: TranslationProvider = {
      translate: () => {
        calls += 1;
        return calls === 1
          ? new Promise<string>((resolve) => (resolveFirst = resolve))
          : Promise.resolve("done");
      },
      close: () => {},
    };
    const events = buildSource(translation, speech.provider);

    speech.emit({ kind: "final", segmentId: "seg-1", text: "one", startTimeMs: 0, endTimeMs: 1 });
    speech.emit({ kind: "partial", segmentId: "seg-2", text: "two", startTimeMs: 2 });
    resolveFirst("late");

    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "partial" && e.segmentId === "seg-2")).toBe(true),
    );
    expect(events.some((e) => e.type === "final" && e.segmentId === "seg-1")).toBe(false);
  });
});
