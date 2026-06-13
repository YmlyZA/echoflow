# Realtime Pipeline & Segment-Semantics Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-frame request-response speech pipeline with a streaming provider model so each audio chunk is processed once, segments carry real timestamps, and the exported transcript shows correct times and source language.

**Architecture:** The speech provider becomes a streaming sink (`open({ onSegment }) → { pushFrame, end, close }`). The backend `RealtimeSession` stops processing audio itself — it pumps binary frames into the provider stream and relays the provider's `SegmentEvent`s as wire `ServerEvent`s (translating once per final, never per partial). The wire `final` event gains `startTimeMs`/`endTimeMs`, which the extension persists to history.

**Tech Stack:** TypeScript (ESM), Fastify + `ws` (backend), WXT + React 19 (extension), Vitest, pnpm workspaces. Spec: `docs/superpowers/specs/2026-06-13-realtime-pipeline-segment-refactor-design.md`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/protocol/src/events.ts` | Wire `ServerEvent` types + guards; add timestamps to `final` | Modify |
| `packages/protocol/src/events.test.ts` | Guard tests for new `final` fields | Modify |
| `apps/backend/src/providers/types.ts` | Streaming `SpeechProvider` port + `AudioFrame`/`SegmentEvent`/`SpeechRecognitionStream` | Modify |
| `apps/backend/src/providers/fakeSpeechProvider.ts` | Deterministic multi-segment streaming fake | Rewrite |
| `apps/backend/src/providers/fakeSpeechProvider.test.ts` | Fake streaming behavior | Rewrite |
| `apps/backend/src/realtime/session.ts` | Pump + relay session | Rewrite |
| `apps/backend/src/realtime/session.test.ts` | No-double-processing, pairing, translation, stop-flush | Rewrite |
| `apps/extension/src/history/segmentMapping.ts` | Pure `final` event → history segment mapping | Create |
| `apps/extension/src/history/segmentMapping.test.ts` | Mapping with real timestamps | Create |
| `apps/extension/src/history/historyStore.ts` | Add `updateSessionLanguages` | Modify |
| `apps/extension/src/history/historyStore.test.ts` | `updateSessionLanguages` test | Modify |
| `apps/extension/src/subtitles/reducer.test.ts` | Multi-segment + source-only partial | Modify |
| `apps/extension/entrypoints/background.ts` | Use mapping + persist source language | Modify |

---

## Task 1: Extend the wire `final` event with timestamps

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Test: `packages/protocol/src/events.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isServerEvent } from "./events.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/protocol test -- -t "final timestamps"`
Expected: FAIL — the "missing start/end times" case returns `true` (guard does not yet check the fields).

- [ ] **Step 3: Implement the type + guard change**

In `packages/protocol/src/events.ts`, change `FinalSubtitleEvent`:

```ts
export type FinalSubtitleEvent = {
  type: "final";
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startTimeMs: number;
  endTimeMs: number;
};
```

And update the `"final"` case inside `isServerEvent`:

```ts
    case "final":
      return (
        typeof value.segmentId === "string" &&
        typeof value.sourceText === "string" &&
        typeof value.translatedText === "string" &&
        typeof value.startTimeMs === "number" &&
        Number.isFinite(value.startTimeMs) &&
        typeof value.endTimeMs === "number" &&
        Number.isFinite(value.endTimeMs)
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/protocol test`
Expected: PASS (all protocol tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/events.test.ts
git commit -m "Carry segment timestamps on the final subtitle event"
```

---

## Task 2: Define the streaming speech provider port

**Files:**
- Modify: `apps/backend/src/providers/types.ts`

No test in this task — it is type-only; Task 3 exercises it. This task must compile only after Task 3 supplies an implementation, so it is committed together with Task 3.

- [ ] **Step 1: Replace the speech provider types**

Overwrite `apps/backend/src/providers/types.ts` with:

```ts
export type AudioFrame = {
  data: Buffer | ArrayBuffer;
  sequenceNumber: number;
  timestampMs: number;
};

export type SegmentEvent =
  | { kind: "language"; sourceLanguage: string }
  | { kind: "partial"; segmentId: string; text: string; startTimeMs: number }
  | {
      kind: "final";
      segmentId: string;
      text: string;
      startTimeMs: number;
      endTimeMs: number;
    };

export interface SpeechRecognitionStream {
  pushFrame(frame: AudioFrame): void;
  end(): Promise<void>;
  close(): Promise<void>;
}

export type SpeechProvider = {
  open(opts: { onSegment: (event: SegmentEvent) => void }): SpeechRecognitionStream;
};

export type TranslationInput = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslationProvider = {
  translate(input: TranslationInput): Promise<string>;
  close(): Promise<void> | void;
};
```

(The old `SpeechSegment` type is removed; nothing references it after Task 3.)

- [ ] **Step 2: Do not commit yet**

Typecheck will fail until Task 3 rewrites the fake provider and Task 4 rewrites the session. Proceed to Task 3; commit happens at the end of Task 3 once the provider compiles, and the session is fixed in Task 4.

---

## Task 3: Rewrite the fake provider as a deterministic streaming source

**Files:**
- Rewrite: `apps/backend/src/providers/fakeSpeechProvider.ts`
- Test: `apps/backend/src/providers/fakeSpeechProvider.test.ts`

- [ ] **Step 1: Write the failing test**

Overwrite `apps/backend/src/providers/fakeSpeechProvider.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { FakeSpeechProvider } from "./fakeSpeechProvider.js";
import type { AudioFrame, SegmentEvent } from "./types.js";

function frame(sequenceNumber: number, timestampMs: number): AudioFrame {
  return { data: Buffer.alloc(0), sequenceNumber, timestampMs };
}

describe("FakeSpeechProvider", () => {
  it("emits language once, progressive partials, then a final per segment", () => {
    const events: SegmentEvent[] = [];
    const stream = new FakeSpeechProvider().open({
      onSegment: (event) => events.push(event),
    });

    stream.pushFrame(frame(0, 0));
    stream.pushFrame(frame(1, 250));
    stream.pushFrame(frame(2, 500));

    expect(events).toEqual([
      { kind: "language", sourceLanguage: "en" },
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0 },
      { kind: "partial", segmentId: "seg-1", text: "hello from", startTimeMs: 0 },
      {
        kind: "final",
        segmentId: "seg-1",
        text: "hello from echoflow",
        startTimeMs: 0,
        endTimeMs: 500,
      },
    ]);
  });

  it("flushes an in-progress segment as a final on end()", async () => {
    const events: SegmentEvent[] = [];
    const stream = new FakeSpeechProvider().open({
      onSegment: (event) => events.push(event),
    });

    stream.pushFrame(frame(0, 0));
    stream.pushFrame(frame(1, 250));
    await stream.end();

    expect(events.at(-1)).toEqual({
      kind: "final",
      segmentId: "seg-1",
      text: "hello from echoflow",
      startTimeMs: 0,
      endTimeMs: 250,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- -t "FakeSpeechProvider"`
Expected: FAIL — `open` is not a function (old fake still has `recognize`).

- [ ] **Step 3: Implement the streaming fake**

Overwrite `apps/backend/src/providers/fakeSpeechProvider.ts` with:

```ts
import type {
  AudioFrame,
  SegmentEvent,
  SpeechProvider,
  SpeechRecognitionStream,
} from "./types.js";

const SCRIPT = [
  "hello from echoflow",
  "this is the second segment",
  "and a third line to finalize",
];

export class FakeSpeechProvider implements SpeechProvider {
  open(opts: {
    onSegment: (event: SegmentEvent) => void;
  }): SpeechRecognitionStream {
    let languageEmitted = false;
    let segmentIndex = 0;
    let wordIndex = 0;
    let segmentStartMs = 0;
    let lastTimestampMs = 0;
    let closed = false;

    function pushFrame(frame: AudioFrame): void {
      if (closed) {
        return;
      }

      if (!languageEmitted) {
        opts.onSegment({ kind: "language", sourceLanguage: "en" });
        languageEmitted = true;
      }

      const sentence = SCRIPT[segmentIndex];
      if (sentence === undefined) {
        return;
      }

      lastTimestampMs = frame.timestampMs;
      const words = sentence.split(" ");
      if (wordIndex === 0) {
        segmentStartMs = frame.timestampMs;
      }
      wordIndex += 1;
      const segmentId = `seg-${segmentIndex + 1}`;

      if (wordIndex < words.length) {
        opts.onSegment({
          kind: "partial",
          segmentId,
          text: words.slice(0, wordIndex).join(" "),
          startTimeMs: segmentStartMs,
        });
        return;
      }

      opts.onSegment({
        kind: "final",
        segmentId,
        text: words.join(" "),
        startTimeMs: segmentStartMs,
        endTimeMs: frame.timestampMs,
      });
      segmentIndex += 1;
      wordIndex = 0;
    }

    return {
      pushFrame,
      // Async so real streaming adapters can drain in-flight audio; the fake resolves immediately.
      async end() {
        if (closed) {
          return;
        }
        const sentence = SCRIPT[segmentIndex];
        if (sentence !== undefined && wordIndex > 0) {
          const words = sentence.split(" ");
          opts.onSegment({
            kind: "final",
            segmentId: `seg-${segmentIndex + 1}`,
            text: words.join(" "),
            startTimeMs: segmentStartMs,
            endTimeMs: lastTimestampMs,
          });
          segmentIndex += 1;
          wordIndex = 0;
        }
        closed = true;
      },
      async close() {
        closed = true;
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- -t "FakeSpeechProvider"`
Expected: PASS (both fake-provider cases).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/types.ts apps/backend/src/providers/fakeSpeechProvider.ts apps/backend/src/providers/fakeSpeechProvider.test.ts
git commit -m "Model the fake speech provider as a streaming segment source"
```

(Backend typecheck still fails here because `session.ts` uses the old provider shape — Task 4 fixes it. That is expected; the commit captures a coherent provider-layer change.)

---

## Task 4: Rewrite `RealtimeSession` as pump + relay

**Files:**
- Rewrite: `apps/backend/src/realtime/session.ts`
- Test: `apps/backend/src/realtime/session.test.ts`
- Rewrite: `apps/backend/src/server.test.ts` (integration test of server+session; the old version asserts the pre-refactor `fake-1` per-frame behavior and must move to the new protocol — drive frames, expect `seg-N` segments with timestamps and source-only partials)

> **Note added during execution:** Task 2+3's code-quality review surfaced that `server.test.ts` (an integration test of `createServer`) still asserts the old protocol and would stay red after this task unless rewritten here. Its rewrite is part of Task 4 — see Step 6 below. The session opens the speech stream only on a `start` control message, so every integration test must send `start` before any audio frame.

- [ ] **Step 1: Write the failing test**

Overwrite `apps/backend/src/realtime/session.test.ts` with:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- -t "RealtimeSession"`
Expected: FAIL — the current session still calls `speechProvider.recognize` and processes both the JSON and binary frames (the first test sees two `pushed` frames / a missing `open`).

- [ ] **Step 3: Implement the pump + relay session**

Overwrite `apps/backend/src/realtime/session.ts` with:

```ts
import {
  type ClientMessage,
  type ServerEvent,
  isClientMessage,
} from "@echoflow/protocol";
import type { WebSocket } from "ws";
import type {
  SegmentEvent,
  SpeechProvider,
  SpeechRecognitionStream,
  TranslationProvider,
} from "../providers/types.js";

export type RealtimeSessionOptions = {
  socket: WebSocket;
  speechProvider: SpeechProvider;
  translationProvider: TranslationProvider;
  defaultTargetLanguage: string;
};

export class RealtimeSession {
  private targetLanguage: string;
  private sourceLanguage = "unknown";
  private closed = false;
  private stream: SpeechRecognitionStream | undefined;
  private pendingFrameMeta:
    | { sequenceNumber: number; timestampMs: number }
    | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RealtimeSessionOptions) {
    this.targetLanguage = options.defaultTargetLanguage;
  }

  start(): void {
    this.options.socket.on("message", (data, isBinary) => {
      void this.handleFrame(data, isBinary).catch((error: unknown) => {
        this.sendError(getErrorCode(error), getErrorMessage(error));
      });
    });

    this.options.socket.on("close", () => {
      void this.close();
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.all([
      this.stream?.close(),
      this.options.translationProvider.close(),
    ]);
  }

  private async handleFrame(
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (this.closed) {
      return;
    }

    if (!isBinary && (typeof data === "string" || Buffer.isBuffer(data))) {
      const message = parseClientMessage(data);
      if (message !== undefined) {
        await this.handleClientMessage(message);
        return;
      }
    }

    this.pushAudio(data);
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "start":
        this.targetLanguage = message.targetLanguage ?? this.targetLanguage;
        this.openStream();
        return;
      case "audio_frame":
        this.pendingFrameMeta = {
          sequenceNumber: message.frame.sequenceNumber,
          timestampMs: message.frame.timestampMs,
        };
        return;
      case "stop":
        if (this.stream !== undefined) {
          await this.stream.end();
        }
        await this.tail;
        await this.close();
        this.options.socket.close();
        return;
    }
  }

  private openStream(): void {
    if (this.stream !== undefined) {
      return;
    }
    this.stream = this.options.speechProvider.open({
      onSegment: (event) => {
        this.enqueueSegment(event);
      },
    });
  }

  private pushAudio(data: WebSocket.RawData): void {
    if (this.stream === undefined) {
      return;
    }
    const meta = this.pendingFrameMeta ?? { sequenceNumber: 0, timestampMs: 0 };
    this.pendingFrameMeta = undefined;
    this.stream.pushFrame({
      data: data as Buffer,
      sequenceNumber: meta.sequenceNumber,
      timestampMs: meta.timestampMs,
    });
  }

  private enqueueSegment(event: SegmentEvent): void {
    this.tail = this.tail
      .then(() => this.dispatchSegment(event))
      .catch((error: unknown) => {
        this.sendError(getErrorCode(error), getErrorMessage(error));
      });
  }

  private async dispatchSegment(event: SegmentEvent): Promise<void> {
    switch (event.kind) {
      case "language":
        this.sourceLanguage = event.sourceLanguage;
        this.send({
          type: "language",
          sourceLanguage: event.sourceLanguage,
          targetLanguage: this.targetLanguage,
        });
        return;
      case "partial":
        this.send({
          type: "partial",
          segmentId: event.segmentId,
          sourceText: event.text,
        });
        return;
      case "final": {
        const translatedText = await this.options.translationProvider.translate({
          text: event.text,
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
        });
        this.send({
          type: "final",
          segmentId: event.segmentId,
          sourceText: event.text,
          translatedText,
          startTimeMs: event.startTimeMs,
          endTimeMs: event.endTimeMs,
        });
        return;
      }
    }
  }

  private sendError(code: string, message: string): void {
    this.send({ type: "error", code, message });
  }

  private send(event: ServerEvent): void {
    if (
      this.closed ||
      this.options.socket.readyState !== this.options.socket.OPEN
    ) {
      return;
    }
    this.options.socket.send(JSON.stringify(event));
  }
}

function parseClientMessage(data: string | Buffer): ClientMessage | undefined {
  const text = data.toString();
  if (!looksLikeJson(text)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolMessageError("Malformed client message");
  }

  if (!isClientMessage(parsed)) {
    throw new ProtocolMessageError("Malformed client message");
  }

  return parsed;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ProtocolMessageError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Realtime provider failed";
}

function getErrorCode(error: unknown): string {
  if (error instanceof ProtocolMessageError) {
    return "invalid_client_message";
  }
  return "provider_error";
}

class ProtocolMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolMessageError";
  }
}
```

- [ ] **Step 4: Rewrite the server integration test for the new protocol**

`apps/backend/src/server.test.ts` currently asserts the pre-refactor behavior (a lone `start` message yields a `fake-1` partial+final). Under the new protocol a `start` opens the stream but emits nothing until binary audio frames arrive, and partials are source-only. Overwrite `apps/backend/src/server.test.ts` with:

```ts
import type { ServerEvent } from "@echoflow/protocol";
import { isServerEvent } from "@echoflow/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { createServer } from "./server.js";

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    socket.terminate();
  }
});

function sendAudioFrame(
  socket: WebSocket,
  sequenceNumber: number,
  timestampMs: number,
): void {
  socket.send(
    JSON.stringify({
      type: "audio_frame",
      frame: { sequenceNumber, timestampMs },
    }),
  );
  socket.send(Buffer.from([1, 2, 3]));
}

const SEGMENT_ONE = [
  { type: "language", sourceLanguage: "en", targetLanguage: "zh-CN" },
  { type: "partial", segmentId: "seg-1", sourceText: "hello" },
  { type: "partial", segmentId: "seg-1", sourceText: "hello from" },
  {
    type: "final",
    segmentId: "seg-1",
    sourceText: "hello from echoflow",
    translatedText: "[zh-CN] hello from echoflow",
    startTimeMs: 0,
    endTimeMs: 500,
  },
];

describe("backend realtime websocket", () => {
  it("emits language, progressive partials, and a final once frames drive a segment", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const events = collectServerEvents(socket, 4);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
      sendAudioFrame(socket, 0, 0);
      sendAudioFrame(socket, 1, 250);
      sendAudioFrame(socket, 2, 500);

      await expect(events).resolves.toEqual(SEGMENT_ONE);
    } finally {
      await server.close();
    }
  });

  it("rejects missing and wrong api keys before websocket work starts", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      await expect(server.injectWS("/v1/realtime")).rejects.toThrow(
        "Unexpected server response: 401",
      );
      await expect(
        server.injectWS("/v1/realtime", {
          headers: { "x-api-key": "wrong-key" },
        }),
      ).rejects.toThrow("Unexpected server response: 401");
    } finally {
      await server.close();
    }
  });

  it("accepts api keys from the websocket query string for browser clients", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime?apiKey=dev-key");
      openSockets.push(socket);

      const events = collectServerEvents(socket, 4);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
      sendAudioFrame(socket, 0, 0);
      sendAudioFrame(socket, 1, 250);
      sendAudioFrame(socket, 2, 500);

      await expect(events).resolves.toEqual(SEGMENT_ONE);
    } finally {
      await server.close();
    }
  });

  it("sends a protocol error for malformed client messages", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const event = collectServerEvents(socket, 1);
      socket.send(JSON.stringify({ type: "definitely-not-supported" }));

      await expect(event).resolves.toEqual([
        {
          type: "error",
          code: "invalid_client_message",
          message: "Malformed client message",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("treats binary frames as audio even when their bytes look like json", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const events = collectServerEvents(socket, 4);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
      socket.send(Buffer.from([0x7b, 0xff, 0x00]));
      socket.send(Buffer.from([0x7b, 0xff, 0x00]));
      socket.send(Buffer.from([0x7b, 0xff, 0x00]));

      await expect(events).resolves.toEqual([
        { type: "language", sourceLanguage: "en", targetLanguage: "zh-CN" },
        { type: "partial", segmentId: "seg-1", sourceText: "hello" },
        { type: "partial", segmentId: "seg-1", sourceText: "hello from" },
        {
          type: "final",
          segmentId: "seg-1",
          sourceText: "hello from echoflow",
          translatedText: "[zh-CN] hello from echoflow",
          startTimeMs: 0,
          endTimeMs: 0,
        },
      ]);
    } finally {
      await server.close();
    }
  });
});

function collectServerEvents(
  socket: WebSocket,
  expectedCount: number,
): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expectedCount} server events`));
    }, 1_000);

    socket.on("error", reject);
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isServerEvent(parsed)) {
        clearTimeout(timeout);
        reject(new Error(`Received invalid server event: ${data.toString()}`));
        return;
      }

      events.push(parsed);
      if (events.length === expectedCount) {
        clearTimeout(timeout);
        resolve(events);
      }
    });
  });
}
```

- [ ] **Step 5: Run the full backend suite + typecheck**

Run: `pnpm --filter @echoflow/backend test`
Expected: PASS (RealtimeSession + fake provider + config + server tests).

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/realtime/session.ts apps/backend/src/realtime/session.test.ts apps/backend/src/server.test.ts
git commit -m "Pump audio into a streaming provider and relay its segments"
```

---

## Task 5: Add `updateSessionLanguages` to the history store

**Files:**
- Modify: `apps/extension/src/history/historyStore.ts`
- Test: `apps/extension/src/history/historyStore.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/extension/src/history/historyStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createHistoryStore,
  createInMemoryHistoryPersistence,
} from "./historyStore";

describe("updateSessionLanguages", () => {
  it("persists the detected source language and bumps updatedAt", async () => {
    const store = createHistoryStore(createInMemoryHistoryPersistence());
    const session = await store.createLocalSession({
      startedAt: 1000,
      targetLanguage: "zh-CN",
    });

    await store.updateSessionLanguages(session.id, {
      sourceLanguage: "en",
      updatedAt: 2000,
    });

    const updated = await store.getSession(session.id);
    expect(updated?.sourceLanguage).toBe("en");
    expect(updated?.updatedAt).toBe(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- -t "updateSessionLanguages"`
Expected: FAIL — `store.updateSessionLanguages is not a function`.

- [ ] **Step 3: Implement the method**

In `apps/extension/src/history/historyStore.ts`, add to the `HistoryStore` interface (after `recordSessionError`):

```ts
  updateSessionLanguages(
    sessionId: string,
    changes: { sourceLanguage?: string; targetLanguage?: string; updatedAt?: number }
  ): Promise<void>;
```

And add the implementation to the object returned by `createHistoryStore` (after `recordSessionError`):

```ts
    async updateSessionLanguages(sessionId, changes) {
      const updatedAt = changes.updatedAt ?? Date.now();
      const update: Partial<HistorySessionRecord> = { updatedAt };

      if (changes.sourceLanguage !== undefined) {
        update.sourceLanguage = changes.sourceLanguage;
      }
      if (changes.targetLanguage !== undefined) {
        update.targetLanguage = changes.targetLanguage;
      }

      await persistence.updateSession(sessionId, update);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "updateSessionLanguages"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/history/historyStore.ts apps/extension/src/history/historyStore.test.ts
git commit -m "Persist the detected source language onto history sessions"
```

---

## Task 6: Pure mapping from a final event to a history segment

**Files:**
- Create: `apps/extension/src/history/segmentMapping.ts`
- Test: `apps/extension/src/history/segmentMapping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/history/segmentMapping.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- -t "finalEventToSegment"`
Expected: FAIL — module `./segmentMapping` does not exist.

- [ ] **Step 3: Implement the mapping**

Create `apps/extension/src/history/segmentMapping.ts`:

```ts
import {
  makeFinalSegment,
  type FinalSubtitleEvent,
  type SubtitleSegment,
} from "@echoflow/protocol";

export function finalEventToSegment(args: {
  localSessionId: string;
  event: FinalSubtitleEvent;
  sourceLanguage: string;
  targetLanguage: string;
}): SubtitleSegment {
  return makeFinalSegment({
    sessionId: args.localSessionId,
    segmentId: args.event.segmentId,
    startTimeMs: args.event.startTimeMs,
    endTimeMs: args.event.endTimeMs,
    sourceLanguage: args.sourceLanguage,
    targetLanguage: args.targetLanguage,
    sourceText: args.event.sourceText,
    translatedText: args.event.translatedText,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "finalEventToSegment"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/history/segmentMapping.ts apps/extension/src/history/segmentMapping.test.ts
git commit -m "Map final subtitle events to history segments with real timestamps"
```

---

## Task 7: Wire the background to real timestamps and source language

**Files:**
- Modify: `apps/extension/entrypoints/background.ts`

No new unit test — the substance is covered by Tasks 5 and 6; this task is wiring, verified by typecheck.

- [ ] **Step 1: Import the mapping helper**

In `apps/extension/entrypoints/background.ts`, replace the `makeFinalSegment` import line:

```ts
import { makeFinalSegment } from "@echoflow/protocol";
```

with:

```ts
import { finalEventToSegment } from "../src/history/segmentMapping";
```

- [ ] **Step 2: Use the event's timestamps and persist source language**

In `forwardServerEvent`, replace this block:

```ts
  if (message.event.type === "language") {
    detectedSourceLanguage = message.event.sourceLanguage;
  }

  if (message.event.type === "final") {
    const timestamp = Date.now();

    await historyStore.appendSegment(
      makeFinalSegment({
        sessionId: message.localSessionId,
        segmentId: message.event.segmentId,
        startTimeMs: timestamp,
        endTimeMs: timestamp,
        sourceLanguage: detectedSourceLanguage,
        targetLanguage: sessionState.targetLanguage,
        sourceText: message.event.sourceText,
        translatedText: message.event.translatedText
      })
    );
  }
```

with:

```ts
  if (message.event.type === "language") {
    detectedSourceLanguage = message.event.sourceLanguage;
    await historyStore.updateSessionLanguages(message.localSessionId, {
      sourceLanguage: message.event.sourceLanguage
    });
  }

  if (message.event.type === "final") {
    await historyStore.appendSegment(
      finalEventToSegment({
        localSessionId: message.localSessionId,
        event: message.event,
        sourceLanguage: detectedSourceLanguage,
        targetLanguage: sessionState.targetLanguage
      })
    );
  }
```

(Note: `forwardServerEvent` already returns early when `sessionState.status === "idle"`, so `sessionState.targetLanguage` is in scope here, exactly as before.)

- [ ] **Step 3: Typecheck the extension**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS — `makeFinalSegment` is no longer referenced; `finalEventToSegment` resolves; `message.event` narrows to `FinalSubtitleEvent` in the `final` branch.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "Record real segment timestamps and source language in history"
```

---

## Task 8: Cover multi-segment + source-only partial in the reducer

**Files:**
- Modify: `apps/extension/src/subtitles/reducer.test.ts`

The reducer already supports this; the test locks the behavior now that segment ids are distinct and partials arrive untranslated.

- [ ] **Step 1: Write the test**

Add to `apps/extension/src/subtitles/reducer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialSubtitleState, reduceSubtitleEvent } from "./reducer";

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
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "reducer multi-segment"`
Expected: PASS (reducer already handles this; the `final` event now requires the timestamp fields, which the test supplies).

- [ ] **Step 3: Commit**

```bash
git add apps/extension/src/subtitles/reducer.test.ts
git commit -m "Lock the multi-segment source-only partial reducer flow"
```

---

## Task 9: Full workspace verification

**Files:** none (verification only).

- [ ] **Step 1: Build, test, typecheck across the workspace**

Run: `pnpm build`
Expected: PASS — all three packages compile.

Run: `pnpm test`
Expected: PASS — protocol, backend, extension suites green.

Run: `pnpm typecheck`
Expected: PASS — no type errors.

Run: `pnpm lint`
Expected: PASS (lint == tsc --noEmit).

- [ ] **Step 2: Commit only if anything was adjusted**

If any fix was needed to make the above green, stage and commit it:

```bash
git add -A
git commit -m "Green the workspace after the pipeline refactor"
```

Otherwise this task produces no commit.

---

## Self-Review

**Spec coverage:**
- §1 streaming provider interface → Task 2 (types) + Task 3 (fake impl).
- §2 backend pump/relay, frame pairing, once-per-final translation, stop flush → Task 4.
- §3 wire `final` timestamps + guard → Task 1.
- §4 fake multi-segment + progressive partials + frame-derived timestamps + incrementing `segmentId` → Task 3.
- §5 timestamp closure + `sourceLanguage` persistence → Task 5 (store method) + Task 6 (mapping) + Task 7 (wiring).
- §6 testing matrix → protocol (Task 1), fake provider (Task 3), session (Task 4), background mapping (Task 6) + store (Task 5), reducer (Task 8). Background's chrome-bound wiring is covered indirectly via the extracted pure helper rather than a chrome mock — a deliberate, documented substitution.
- Non-goals (SW restart, reconnect, `apiKey` query string, `finalizedSegmentIds` growth) → untouched, as specified.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step states expected output.

**Type consistency:** `SpeechProvider.open({ onSegment })` / `SpeechRecognitionStream.{pushFrame,end,close}` / `SegmentEvent` (`kind` discriminant) / `AudioFrame` are used identically in Tasks 2, 3, 4. `finalEventToSegment` signature matches between Task 6 (definition) and Task 7 (call site). `updateSessionLanguages` signature matches between Task 5 (definition) and Task 7 (call site). The wire `FinalSubtitleEvent` shape (with `startTimeMs`/`endTimeMs`) from Task 1 is consumed consistently in Tasks 4, 6, 8.
