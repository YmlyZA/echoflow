import { describe, expect, it } from "vitest";
import { RealtimeSession } from "./session.js";
import type {
  AudioFrame,
  SegmentEvent,
  SpeechProvider,
  SpeechRecognitionStream,
  TranslationInput,
  TranslationProvider,
} from "../providers/types.js";

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private handlers = new Map<string, Handler[]>();

  on(event: string, cb: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      cb(...args);
    }
  }

  events(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

class StubSpeechProvider implements SpeechProvider {
  opened = 0;
  pushed: AudioFrame[] = [];
  emit: ((event: SegmentEvent) => void) | undefined;
  ended = 0;

  open(opts: {
    onSegment: (event: SegmentEvent) => void;
  }): SpeechRecognitionStream {
    this.opened += 1;
    this.emit = opts.onSegment;
    return {
      pushFrame: (frame) => {
        this.pushed.push(frame);
      },
      end: async () => {
        this.ended += 1;
      },
      close: async () => {},
    };
  }
}

class StubTranslationProvider implements TranslationProvider {
  calls: TranslationInput[] = [];
  async translate(input: TranslationInput): Promise<string> {
    this.calls.push(input);
    return `T:${input.text}`;
  }
  close(): void {}
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function startMessage(): string {
  return JSON.stringify({ type: "start", targetLanguage: "zh-CN" });
}

function audioFrameMessage(sequenceNumber: number, timestampMs: number): string {
  return JSON.stringify({
    type: "audio_frame",
    frame: { sequenceNumber, timestampMs },
  });
}

describe("RealtimeSession", () => {
  it("processes each chunk once and pairs binary frames with their metadata", () => {
    const socket = new FakeSocket();
    const speech = new StubSpeechProvider();
    const session = new RealtimeSession({
      socket: socket as never,
      speechProvider: speech,
      translationProvider: new StubTranslationProvider(),
      defaultTargetLanguage: "zh-CN",
    });
    session.start();

    socket.emit("message", startMessage(), false);
    socket.emit("message", audioFrameMessage(0, 250), false);
    socket.emit("message", Buffer.from([1, 2, 3]), true);

    expect(speech.opened).toBe(1);
    expect(speech.pushed).toHaveLength(1);
    expect(speech.pushed[0]).toMatchObject({ sequenceNumber: 0, timestampMs: 250 });
  });

  it("does not process audio on start with no frames", () => {
    const socket = new FakeSocket();
    const speech = new StubSpeechProvider();
    const session = new RealtimeSession({
      socket: socket as never,
      speechProvider: speech,
      translationProvider: new StubTranslationProvider(),
      defaultTargetLanguage: "zh-CN",
    });
    session.start();

    socket.emit("message", startMessage(), false);

    expect(speech.pushed).toHaveLength(0);
  });

  it("translates once per final, never per partial, and carries timestamps", async () => {
    const socket = new FakeSocket();
    const speech = new StubSpeechProvider();
    const translation = new StubTranslationProvider();
    const session = new RealtimeSession({
      socket: socket as never,
      speechProvider: speech,
      translationProvider: translation,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);

    speech.emit?.({ kind: "language", sourceLanguage: "en" });
    speech.emit?.({ kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0 });
    speech.emit?.({
      kind: "final",
      segmentId: "seg-1",
      text: "hello world",
      startTimeMs: 0,
      endTimeMs: 500,
    });
    await flush();

    const events = socket.events();
    expect(translation.calls).toHaveLength(1);
    expect(events.find((e) => e.type === "language")).toMatchObject({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(events.find((e) => e.type === "partial")).toMatchObject({
      segmentId: "seg-1",
      sourceText: "hello",
    });
    expect(events.find((e) => e.type === "partial")).not.toHaveProperty(
      "translatedText",
    );
    expect(events.find((e) => e.type === "final")).toEqual({
      type: "final",
      segmentId: "seg-1",
      sourceText: "hello world",
      translatedText: "T:hello world",
      startTimeMs: 0,
      endTimeMs: 500,
    });
    expect(events).toEqual([
      { type: "language", sourceLanguage: "en", targetLanguage: "zh-CN" },
      { type: "partial", segmentId: "seg-1", sourceText: "hello" },
      {
        type: "final",
        segmentId: "seg-1",
        sourceText: "hello world",
        translatedText: "T:hello world",
        startTimeMs: 0,
        endTimeMs: 500,
      },
    ]);
  });

  it("flushes the stream and closes the socket on stop", async () => {
    const socket = new FakeSocket();
    const speech = new StubSpeechProvider();
    const session = new RealtimeSession({
      socket: socket as never,
      speechProvider: speech,
      translationProvider: new StubTranslationProvider(),
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);

    socket.emit("message", JSON.stringify({ type: "stop" }), false);
    await flush();

    expect(speech.ended).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  it("sends finals flushed during stream end() before closing the socket", async () => {
    const socket = new FakeSocket();
    const speech: SpeechProvider = {
      open(opts) {
        return {
          pushFrame: () => {},
          end: async () => {
            opts.onSegment({
              kind: "final",
              segmentId: "seg-1",
              text: "flushed",
              startTimeMs: 0,
              endTimeMs: 10,
            });
          },
          close: async () => {},
        };
      },
    };
    const session = new RealtimeSession({
      socket: socket as never,
      speechProvider: speech,
      translationProvider: new StubTranslationProvider(),
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);

    socket.emit("message", JSON.stringify({ type: "stop" }), false);
    await flush();

    expect(socket.events().filter((e) => e.type === "final")).toEqual([
      {
        type: "final",
        segmentId: "seg-1",
        sourceText: "flushed",
        translatedText: "T:flushed",
        startTimeMs: 0,
        endTimeMs: 10,
      },
    ]);
    expect(socket.readyState).toBe(3);
  });
});
