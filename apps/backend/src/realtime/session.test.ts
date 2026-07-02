import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@echoflow/protocol";
import { ModeLanguageUnsupportedError, ModeUnavailableError, type SubtitleSource, type SubtitleSourceFactory } from "./subtitleSource.js";
import { RealtimeSession } from "./session.js";

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

function stubSource(): {
  source: SubtitleSource;
  emit: (e: ServerEvent) => void;
  error: (e: Error) => void;
  ended: () => boolean;
} {
  let onEvent: ((e: ServerEvent) => void) | undefined;
  let onError: ((e: Error) => void) | undefined;
  let ended = false;
  const source: SubtitleSource = {
    open: (opts) => {
      onEvent = opts.onEvent;
      onError = opts.onError;
      return {
        pushFrame: () => {},
        end: async () => {
          ended = true;
        },
        close: async () => {},
      };
    },
  };
  return {
    source,
    emit: (e) => onEvent?.(e),
    error: (e) => onError?.(e),
    ended: () => ended,
  };
}

function stubSourceWithRejectingClose(): {
  source: SubtitleSource;
  error: (e: Error) => void;
} {
  let onError: ((e: Error) => void) | undefined;
  const source: SubtitleSource = {
    open: (opts) => {
      onError = opts.onError;
      return {
        pushFrame: () => {},
        end: async () => {},
        close: async () => {
          throw new Error("teardown failed");
        },
      };
    },
  };
  return {
    source,
    error: (e) => onError?.(e),
  };
}

function startMessage(mode?: string, sourceLanguage?: string): string {
  return JSON.stringify({
    type: "start",
    targetLanguage: "zh-CN",
    ...(mode !== undefined ? { mode } : {}),
    ...(sourceLanguage !== undefined ? { sourceLanguage } : {}),
  });
}

function audioFrameMessage(sequenceNumber: number, timestampMs: number): string {
  return JSON.stringify({
    type: "audio_frame",
    frame: { sequenceNumber, timestampMs },
  });
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("RealtimeSession", () => {
  it("forwards events from the source to the socket", async () => {
    const socket = new FakeSocket();
    const stub = stubSource();
    const factory: SubtitleSourceFactory = () => stub.source;

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);

    const event: ServerEvent = {
      type: "partial",
      segmentId: "seg-1",
      sourceText: "hello",
    };
    stub.emit(event);

    await vi.waitFor(() => {
      expect(socket.events()).toContainEqual(
        expect.objectContaining({ type: "partial", segmentId: "seg-1", sourceText: "hello" }),
      );
    });
  });

  it("closes the socket when a runtime provider-stream error occurs", async () => {
    const socket = new FakeSocket();
    const stub = stubSource();
    const factory: SubtitleSourceFactory = () => stub.source;

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);

    stub.error(new Error("upstream ASR died"));
    await flush();

    expect(socket.events()).toContainEqual(
      expect.objectContaining({ type: "error", code: "provider_error" }),
    );
    expect(socket.readyState).toBe(3); // socket closed, not left half-open
  });

  it("still closes the socket when the provider stream's close() rejects", async () => {
    const socket = new FakeSocket();
    const stub = stubSourceWithRejectingClose();
    const factory: SubtitleSourceFactory = () => stub.source;

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);

    stub.error(new Error("upstream ASR died"));
    await flush();
    await flush(); // extra microtask hop for the .catch().then() chain

    expect(socket.events()).toContainEqual(
      expect.objectContaining({ type: "error", code: "provider_error" }),
    );
    expect(socket.readyState).toBe(3); // socket still closes even though close() rejected
  });

  it("sends mode_unavailable error and does NOT close the socket when factory throws ModeUnavailableError", () => {
    const socket = new FakeSocket();
    const factory: SubtitleSourceFactory = (mode) => {
      throw new ModeUnavailableError(mode);
    };

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage("interpret"), false);

    expect(socket.events()).toContainEqual(
      expect.objectContaining({ type: "error", code: "mode_unavailable" }),
    );
    // Socket must NOT be closed
    expect(socket.readyState).toBe(1);
  });

  it("maps ModeLanguageUnsupportedError to a non-fatal mode_language_unsupported error", () => {
    const socket = new FakeSocket();
    const factory: SubtitleSourceFactory = (_mode, sourceLanguage, targetLanguage) => {
      throw new ModeLanguageUnsupportedError(sourceLanguage, targetLanguage);
    };

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage("interpret"), false);

    expect(socket.events()).toContainEqual(
      expect.objectContaining({ type: "error", code: "mode_language_unsupported" }),
    );
    // Socket must NOT be closed (non-fatal)
    expect(socket.readyState).toBe(1);
  });

  it("passes the requested mode and target language to the factory", () => {
    const socket = new FakeSocket();
    const calls: Array<{ mode: string; sourceLanguage: string; targetLanguage: string }> = [];
    const stub = stubSource();
    const factory: SubtitleSourceFactory = (mode, sourceLanguage, targetLanguage) => {
      calls.push({ mode, sourceLanguage, targetLanguage });
      return stub.source;
    };

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();

    // With explicit mode
    socket.emit("message", startMessage("pipeline"), false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ mode: "pipeline", sourceLanguage: "", targetLanguage: "zh-CN" });
  });

  it("passes the default pipeline mode when mode is omitted in start message", () => {
    const socket = new FakeSocket();
    const calls: Array<{ mode: string; sourceLanguage: string; targetLanguage: string }> = [];
    const stub = stubSource();
    const factory: SubtitleSourceFactory = (mode, sourceLanguage, targetLanguage) => {
      calls.push({ mode, sourceLanguage, targetLanguage });
      return stub.source;
    };

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();

    // Without mode — should default to "pipeline"
    socket.emit("message", startMessage(), false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ mode: "pipeline", sourceLanguage: "", targetLanguage: "zh-CN" });
  });

  it("threads sourceLanguage from start message into the factory", () => {
    const socket = new FakeSocket();
    const calls: Array<{ mode: string; sourceLanguage: string; targetLanguage: string }> = [];
    const stub = stubSource();
    const factory: SubtitleSourceFactory = (mode, sourceLanguage, targetLanguage) => {
      calls.push({ mode, sourceLanguage, targetLanguage });
      return stub.source;
    };

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();

    socket.emit("message", startMessage("pipeline", "en"), false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ mode: "pipeline", sourceLanguage: "en", targetLanguage: "zh-CN" });
  });

  it("calls stream end() then closes on stop", async () => {
    const socket = new FakeSocket();
    const stub = stubSource();
    const factory: SubtitleSourceFactory = () => stub.source;

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);

    socket.emit("message", JSON.stringify({ type: "stop" }), false);
    await flush();

    expect(stub.ended()).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it("processes audio frames and pairs binary frames with their metadata", () => {
    const socket = new FakeSocket();
    const pushedFrames: Array<{ sequenceNumber: number; timestampMs: number }> = [];
    const source: SubtitleSource = {
      open: () => ({
        pushFrame: (frame) => {
          pushedFrames.push({ sequenceNumber: frame.sequenceNumber, timestampMs: frame.timestampMs });
        },
        end: async () => {},
        close: async () => {},
      }),
    };
    const factory: SubtitleSourceFactory = () => source;

    const session = new RealtimeSession({
      socket: socket as never,
      createSubtitleSource: factory,
      defaultTargetLanguage: "zh-CN",
    });
    session.start();
    socket.emit("message", startMessage(), false);
    socket.emit("message", audioFrameMessage(0, 250), false);
    socket.emit("message", Buffer.from([1, 2, 3]), true);

    expect(pushedFrames).toHaveLength(1);
    expect(pushedFrames[0]).toMatchObject({ sequenceNumber: 0, timestampMs: 250 });
  });
});
