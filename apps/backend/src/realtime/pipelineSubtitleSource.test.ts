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

  it("forwards speakerId from the segment onto the emitted final", async () => {
    const speech = stubSpeech();
    const events = buildSource(
      { translate: async () => "你好", close: () => {} },
      speech.provider,
    );
    speech.emit({ kind: "language", sourceLanguage: "en" });
    speech.emit({
      kind: "final", segmentId: "s1", text: "hi", startTimeMs: 0, endTimeMs: 1, speakerId: "spk-b",
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "final", segmentId: "s1", speakerId: "spk-b" }),
      ),
    );
  });

  it("end() awaits in-flight translation before resolving (trailing final survives close)", async () => {
    const speech = stubSpeech();

    let resolveTranslation!: (value: string) => void;
    const translation: TranslationProvider = {
      translate: () => new Promise<string>((resolve) => { resolveTranslation = resolve; }),
      close: () => {},
    };

    const events: ServerEvent[] = [];
    const source = new PipelineSubtitleSource(speech.provider, translation, "zh-CN");
    const stream = source.open({ onEvent: (event) => events.push(event) });

    // Emit a final segment so a translation is now in-flight
    speech.emit({ kind: "final", segmentId: "seg-1", text: "hello", startTimeMs: 0, endTimeMs: 1 });

    // Call end() — it must NOT resolve while the translation is still pending
    let endResolved = false;
    const endPromise = stream.end().then(() => { endResolved = true; });

    // Flush enough microtask turns for end()'s internal awaits to settle
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(endResolved).toBe(false); // translation still in-flight, end() must block

    // Resolve the deferred translation; now end() should resolve AND the final event emitted
    resolveTranslation("你好");
    await endPromise;

    expect(endResolved).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "final", segmentId: "seg-1", translatedText: "你好" }),
    );
  });

  it("keeps the session alive and emits a source-only final when translation fails", async () => {
    const speech = stubSpeech();
    const onError = vi.fn();
    const translation: TranslationProvider = {
      translate: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
      close: vi.fn(),
    };
    const events: ServerEvent[] = [];
    const source = new PipelineSubtitleSource(speech.provider, translation, "zh-CN");
    const stream = source.open({ onEvent: (event) => events.push(event), onError });

    speech.emit({ kind: "final", segmentId: "seg-1", text: "hello", startTimeMs: 0, endTimeMs: 500 });
    await stream.end();

    // final is still delivered (source text, empty translation) so the line + history survive
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "final",
        segmentId: "seg-1",
        sourceText: "hello",
        translatedText: "",
      }),
    );
    // a non-fatal error event is surfaced
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", code: "translation_failed" }),
    );
    // the session is NOT killed
    expect(onError).not.toHaveBeenCalled();
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
