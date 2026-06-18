# Pluggable Subtitle-Mode Architecture (Cycle 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the subtitle engine a per-session, client-selected, entitlement-gated mode via a `SubtitleSource` seam — shipping the toggle UX on the free `pipeline` mode, with the paid `interpret` mode gated/erroring until Cycle 2.

**Architecture:** A `SubtitleSource` emits wire-ready `ServerEvent`s; `RealtimeSession` becomes a thin forwarder that asks a factory for the source named by `start.mode`. Today's in-session translation/latest-wins logic relocates into `PipelineSubtitleSource`. `interpret` throws `ModeUnavailableError` → `mode_unavailable` error event. The extension gains a remembered `mode` setting sent in `start`.

**Tech Stack:** TypeScript (ESM, strict), Vitest, `@echoflow/protocol`, WXT/React extension.

**Reference:** `docs/superpowers/specs/2026-06-18-pluggable-subtitle-mode-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/protocol/src/session.ts` | `SubtitleMode` + `start.mode` + guard | Modify |
| `packages/protocol/src/session.test.ts` | Guard test for `mode` | Modify |
| `apps/backend/src/realtime/subtitleSource.ts` | `SubtitleSource`/`SubtitleSourceStream` types + `ModeUnavailableError` | Create |
| `apps/backend/src/realtime/pipelineSubtitleSource.ts` | Mode A logic relocated (speech + latest-wins translation → `ServerEvent`s) | Create |
| `apps/backend/src/realtime/pipelineSubtitleSource.test.ts` | Relocated session-logic tests | Create |
| `apps/backend/src/realtime/subtitleSourceFactory.ts` | `createSubtitleSourceFactory` (pipeline builds, interpret throws) | Create |
| `apps/backend/src/realtime/subtitleSourceFactory.test.ts` | Factory tests | Create |
| `apps/backend/src/realtime/session.ts` | Thin forwarder over `SubtitleSource` | Rewrite |
| `apps/backend/src/realtime/session.test.ts` | Thin-session tests via stub factory | Rewrite |
| `apps/backend/src/server.ts` | Pass `createSubtitleSourceFactory(config.providers)` | Modify |
| `apps/extension/src/settings/settings.ts` | `mode` setting (default `pipeline`), persisted | Modify |
| `apps/extension/src/settings/settings.test.ts` | `mode` round-trip/validation | Modify |
| `apps/extension/src/realtime/realtimeClient.ts` | Send `mode` in `start` | Modify |
| `apps/extension/entrypoints/offscreen/main.ts` | Pass `settings.mode` to the client | Modify |
| `apps/extension/entrypoints/options/main.tsx` | Mode toggle bound to the setting | Modify |

---

## Task 1: Protocol `SubtitleMode` + `start.mode`

**Files:**
- Modify: `packages/protocol/src/session.ts`
- Modify: `packages/protocol/src/session.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/protocol/src/session.test.ts`, add `SubtitleMode` to the `./session` import is not needed for tests; add these cases:

```ts
import { isStartSessionMessage } from "./session";

describe("start mode field", () => {
  it("accepts a start message with a valid mode", () => {
    expect(isStartSessionMessage({ type: "start", mode: "pipeline" })).toBe(true);
    expect(isStartSessionMessage({ type: "start", mode: "interpret" })).toBe(true);
  });

  it("accepts a start message with no mode", () => {
    expect(isStartSessionMessage({ type: "start" })).toBe(true);
  });

  it("rejects a start message with an invalid mode", () => {
    expect(isStartSessionMessage({ type: "start", mode: "turbo" })).toBe(false);
    expect(isStartSessionMessage({ type: "start", mode: 1 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/protocol test session`
Expected: FAIL — `mode: "turbo"` is currently accepted (mode unvalidated).

- [ ] **Step 3: Implement**

In `packages/protocol/src/session.ts`, add the type and field, and validate it.

Add near the top types:
```ts
export type SubtitleMode = "pipeline" | "interpret";

export const SUBTITLE_MODES: readonly SubtitleMode[] = ["pipeline", "interpret"];
```

Change `StartSessionMessage`:
```ts
export type StartSessionMessage = {
  type: "start";
  mode?: SubtitleMode;
} & Partial<SessionHandshakeRequest>;
```

In `isStartSessionMessage`, add a `mode` check to the returned conjunction:
```ts
    isOptionalSubtitleMode(value, "mode") &&
```

And add the helper near the other `isOptional*` helpers:
```ts
function isOptionalSubtitleMode(
  value: Record<string, unknown>,
  key: string,
): boolean {
  if (!hasOwn(value, key)) {
    return true;
  }
  const mode = value[key];
  return (
    typeof mode === "string" &&
    (SUBTITLE_MODES as readonly string[]).includes(mode)
  );
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/protocol test session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/session.ts packages/protocol/src/session.test.ts
git commit -m "feat(protocol): add subtitle mode to start message"
```

---

## Task 2: `SubtitleSource` seam + `ModeUnavailableError`

**Files:**
- Create: `apps/backend/src/realtime/subtitleSource.ts`

Pure types + one error class; no dedicated test (exercised by Tasks 3–5).

- [ ] **Step 1: Create the module**

Create `apps/backend/src/realtime/subtitleSource.ts`:

```ts
import type { ServerEvent, SubtitleMode } from "@echoflow/protocol";
import type { AudioFrame } from "../providers/types.js";

export type { SubtitleMode };

export interface SubtitleSourceStream {
  pushFrame(frame: AudioFrame): void;
  end(): Promise<void>;
  close(): Promise<void>;
}

export interface SubtitleSource {
  open(opts: {
    onEvent: (event: ServerEvent) => void;
    onError?: (error: Error) => void;
  }): SubtitleSourceStream;
}

export type SubtitleSourceFactory = (
  mode: SubtitleMode,
  targetLanguage: string,
) => SubtitleSource;

export class ModeUnavailableError extends Error {
  constructor(public readonly mode: string) {
    super(`Subtitle mode "${mode}" is not available`);
    this.name = "ModeUnavailableError";
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean (note: `ServerEvent` and `SubtitleMode` are exported from `@echoflow/protocol`; `AudioFrame` from `../providers/types.js`).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/realtime/subtitleSource.ts
git commit -m "feat(backend): add SubtitleSource seam and ModeUnavailableError"
```

---

## Task 3: `PipelineSubtitleSource` (Mode A relocated)

**Files:**
- Create: `apps/backend/src/realtime/pipelineSubtitleSource.ts`
- Create: `apps/backend/src/realtime/pipelineSubtitleSource.test.ts`

This is today's `RealtimeSession` translation logic, moved behind the seam: forward `language`/`partial` immediately; single-flight latest-wins translation of `final`s; emit `ServerEvent`s.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/realtime/pipelineSubtitleSource.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test pipelineSubtitleSource`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/backend/src/realtime/pipelineSubtitleSource.ts`:

```ts
import type { ServerEvent } from "@echoflow/protocol";
import type {
  AudioFrame,
  SegmentEvent,
  SpeechProvider,
  TranslationProvider,
} from "../providers/types.js";
import type { SubtitleSource, SubtitleSourceStream } from "./subtitleSource.js";

export class PipelineSubtitleSource implements SubtitleSource {
  constructor(
    private readonly speechProvider: SpeechProvider,
    private readonly translationProvider: TranslationProvider,
    private readonly targetLanguage: string,
  ) {}

  open(opts: {
    onEvent: (event: ServerEvent) => void;
    onError?: (error: Error) => void;
  }): SubtitleSourceStream {
    const translationProvider = this.translationProvider;
    const targetLanguage = this.targetLanguage;

    let sourceLanguage = "unknown";
    let latestSegmentId: string | undefined;
    let pendingFinal:
      | { segmentId: string; sourceText: string; startTimeMs: number; endTimeMs: number }
      | undefined;
    let translating = false;
    let closed = false;
    let tail: Promise<void> = Promise.resolve();

    const drainTranslations = async (): Promise<void> => {
      if (translating) {
        return;
      }
      translating = true;
      try {
        while (pendingFinal !== undefined) {
          const job = pendingFinal;
          pendingFinal = undefined;
          let translatedText: string;
          try {
            translatedText = await translationProvider.translate({
              text: job.sourceText,
              sourceLanguage,
              targetLanguage,
            });
          } catch (error: unknown) {
            opts.onError?.(toError(error));
            continue;
          }
          if (closed) {
            return;
          }
          if (job.segmentId === latestSegmentId) {
            opts.onEvent({
              type: "final",
              segmentId: job.segmentId,
              sourceText: job.sourceText,
              translatedText,
              startTimeMs: job.startTimeMs,
              endTimeMs: job.endTimeMs,
            });
          }
        }
      } finally {
        translating = false;
      }
    };

    const onSegment = (event: SegmentEvent): void => {
      if (event.kind === "partial" || event.kind === "final") {
        latestSegmentId = event.segmentId;
      }
      if (event.kind === "language") {
        sourceLanguage = event.sourceLanguage;
        opts.onEvent({
          type: "language",
          sourceLanguage: event.sourceLanguage,
          targetLanguage,
        });
        return;
      }
      if (event.kind === "partial") {
        tail = tail.then(() => {
          opts.onEvent({
            type: "partial",
            segmentId: event.segmentId,
            sourceText: event.text,
          });
        });
        return;
      }
      pendingFinal = {
        segmentId: event.segmentId,
        sourceText: event.text,
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
      };
      void drainTranslations();
    };

    const stream = this.speechProvider.open({
      onSegment,
      onError: (error) => opts.onError?.(error),
    });

    return {
      pushFrame(frame: AudioFrame): void {
        if (closed) {
          return;
        }
        stream.pushFrame(frame);
      },
      async end(): Promise<void> {
        await stream.end();
        await tail;
      },
      async close(): Promise<void> {
        closed = true;
        await Promise.all([stream.close(), translationProvider.close()]);
      },
    };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Translation failed");
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test pipelineSubtitleSource`
Expected: PASS.
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/realtime/pipelineSubtitleSource.ts apps/backend/src/realtime/pipelineSubtitleSource.test.ts
git commit -m "feat(backend): add PipelineSubtitleSource (pipeline mode)"
```

---

## Task 4: Subtitle-source factory + entitlement gate

**Files:**
- Create: `apps/backend/src/realtime/subtitleSourceFactory.ts`
- Create: `apps/backend/src/realtime/subtitleSourceFactory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/realtime/subtitleSourceFactory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/providerConfig.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import { ModeUnavailableError } from "./subtitleSource.js";
import { createSubtitleSourceFactory } from "./subtitleSourceFactory.js";

describe("createSubtitleSourceFactory", () => {
  it("builds a PipelineSubtitleSource for pipeline mode", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(factory("pipeline", "zh-CN")).toBeInstanceOf(PipelineSubtitleSource);
  });

  it("throws ModeUnavailableError for interpret mode (not yet available)", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(() => factory("interpret", "zh-CN")).toThrow(ModeUnavailableError);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test subtitleSourceFactory`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/backend/src/realtime/subtitleSourceFactory.ts`:

```ts
import {
  createSpeechProvider,
  createTranslationProvider,
} from "../providers/providerFactory.js";
import type { ProviderConfig } from "../providers/providerConfig.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import {
  ModeUnavailableError,
  type SubtitleSourceFactory,
} from "./subtitleSource.js";

export function createSubtitleSourceFactory(
  config: ProviderConfig,
): SubtitleSourceFactory {
  return (mode, targetLanguage) => {
    if (mode === "pipeline") {
      return new PipelineSubtitleSource(
        createSpeechProvider(config.asr),
        createTranslationProvider(config.translation),
        targetLanguage,
      );
    }
    // "interpret" is the paid tier — implemented in Cycle 2.
    throw new ModeUnavailableError(mode);
  };
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test subtitleSourceFactory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/realtime/subtitleSourceFactory.ts apps/backend/src/realtime/subtitleSourceFactory.test.ts
git commit -m "feat(backend): add subtitle-source factory with mode gate"
```

---

## Task 5: Thin `RealtimeSession` + server wiring

**Files:**
- Rewrite: `apps/backend/src/realtime/session.ts`
- Rewrite: `apps/backend/src/realtime/session.test.ts`
- Modify: `apps/backend/src/server.ts:42-51`

The session becomes a forwarder over a `SubtitleSource` chosen by `start.mode`. The `server.ts` wiring is updated in the **same task** so the backend always compiles.

- [ ] **Step 1: Write the failing test**

READ the current `session.test.ts` first to reuse its `FakeSocket`/`startMessage` helpers and message-delivery pattern. Rewrite it to drive the session through a **stub `createSubtitleSource`**. Cover: (a) events from the source are forwarded to the socket; (b) a factory throwing `ModeUnavailableError` produces a `mode_unavailable` error event and the socket is NOT closed; (c) the requested `mode` (and the `"pipeline"` default) is passed to the factory; (d) `stop` calls `end()` then closes. Use this shape, adapting helper names to the file's actual ones:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@echoflow/protocol";
import { ModeUnavailableError, type SubtitleSource } from "./subtitleSource.js";
import { RealtimeSession } from "./session.js";

function stubSource(): { source: SubtitleSource; emit: (e: ServerEvent) => void; ended: () => boolean } {
  let onEvent: ((e: ServerEvent) => void) | undefined;
  let ended = false;
  const source: SubtitleSource = {
    open: (opts) => {
      onEvent = opts.onEvent;
      return {
        pushFrame: () => {},
        end: async () => { ended = true; },
        close: async () => {},
      };
    },
  };
  return { source, emit: (e) => onEvent?.(e), ended: () => ended };
}

// Build a session with FakeSocket (reuse the suite's helper) + the stub factory,
// start it, and deliver `start` (with/without mode) the way existing tests do.
```

Write the four behaviors above as `it(...)` cases. For (b), assert `sentEvents()` contains `{ type: "error", code: "mode_unavailable", ... }` and that the socket close was not called. For (c), capture the `(mode, targetLanguage)` the stub factory was invoked with.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test session`
Expected: FAIL — the session still uses `speechProvider`/`translationProvider`, not `createSubtitleSource`.

- [ ] **Step 3: Rewrite the session**

Replace the entire contents of `apps/backend/src/realtime/session.ts` with:

```ts
import {
  type ClientMessage,
  type ServerEvent,
  isClientMessage,
} from "@echoflow/protocol";
import type { WebSocket } from "ws";
import {
  ModeUnavailableError,
  type SubtitleSourceFactory,
  type SubtitleSourceStream,
} from "./subtitleSource.js";

export type RealtimeSessionOptions = {
  socket: WebSocket;
  createSubtitleSource: SubtitleSourceFactory;
  defaultTargetLanguage: string;
};

export class RealtimeSession {
  private targetLanguage: string;
  private closed = false;
  private stream: SubtitleSourceStream | undefined;
  private pendingFrameMeta:
    | { sequenceNumber: number; timestampMs: number }
    | undefined;

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
    await this.stream?.close();
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
        this.openSource(message.mode ?? "pipeline");
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
        await this.close();
        this.options.socket.close();
        return;
    }
  }

  private openSource(mode: "pipeline" | "interpret"): void {
    if (this.stream !== undefined) {
      return;
    }
    let source;
    try {
      source = this.options.createSubtitleSource(mode, this.targetLanguage);
    } catch (error: unknown) {
      if (error instanceof ModeUnavailableError) {
        this.sendError("mode_unavailable", error.message);
        return;
      }
      this.sendError("provider_error", getErrorMessage(error));
      return;
    }
    this.stream = source.open({
      onEvent: (event) => {
        this.send(event);
      },
      onError: (error) => {
        this.sendError("provider_error", error.message);
        void this.close();
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
      // ws delivers binary messages as a single Buffer (no binaryType override).
      data: data as Buffer,
      sequenceNumber: meta.sequenceNumber,
      timestampMs: meta.timestampMs,
    });
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
  return "Realtime session failed";
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

- [ ] **Step 4: Update the server wiring (same task)**

In `apps/backend/src/server.ts`, replace the `createSpeechProvider`/`createTranslationProvider` import with the factory, and update the session construction (lines 42-51):

Replace the provider-factory import line with:
```ts
import { createSubtitleSourceFactory } from "./realtime/subtitleSourceFactory.js";
```

Replace the session construction:
```ts
      (socket) => {
        const session = new RealtimeSession({
          socket,
          createSubtitleSource: createSubtitleSourceFactory(config.providers),
          defaultTargetLanguage: "zh-CN",
        });

        session.start();
      },
```

- [ ] **Step 5: Run the full backend suite + typecheck**

Run: `pnpm --filter @echoflow/backend test`
Expected: all green. NOTE: `server.test.ts` drives the real fake-provider path through the WS; with `pipeline` the default mode it behaves identically to before — the order-agnostic assertions from the prior cycle remain valid.
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/realtime/session.ts apps/backend/src/realtime/session.test.ts apps/backend/src/server.ts
git commit -m "feat(backend): thin RealtimeSession over SubtitleSource via mode factory"
```

---

## Task 6: Extension `mode` setting + toggle + send in start

**Files:**
- Modify: `apps/extension/src/settings/settings.ts`
- Modify: `apps/extension/src/settings/settings.test.ts`
- Modify: `apps/extension/src/realtime/realtimeClient.ts`
- Modify: `apps/extension/entrypoints/offscreen/main.ts`
- Modify: `apps/extension/entrypoints/options/main.tsx`

- [ ] **Step 1: Write the failing test (settings)**

In `apps/extension/src/settings/settings.test.ts`, add cases (match the file's style):

```ts
it("defaults mode to pipeline and round-trips a stored mode", async () => {
  const storage = createMemoryStorage(); // reuse the suite's in-memory storage helper
  await saveSettings(
    { serverUrl: "http://127.0.0.1:8787", apiKey: "k", targetLanguage: "zh-CN", subtitleFontSize: 24, mode: "interpret" },
    storage,
  );
  const loaded = await loadSettings(storage, "en-US");
  expect(loaded.mode).toBe("interpret");
});

it("resolves mode to pipeline when unset", () => {
  expect(resolveSettings(undefined, "en-US").mode).toBe("pipeline");
});
```

If the suite has no in-memory storage helper, build a minimal `SettingsStorageAdapter` backed by a `Map` inline.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/extension test settings`
Expected: FAIL — `mode` is not on `ExtensionSettings`.

- [ ] **Step 3: Implement settings**

In `apps/extension/src/settings/settings.ts`:

Add to `ExtensionSettings` (import `SubtitleMode` from the protocol):
```ts
import type { SubtitleMode } from "@echoflow/protocol";
```
```ts
export interface ExtensionSettings {
  serverUrl: string;
  apiKey: string;
  targetLanguage: string;
  subtitleFontSize: number;
  mode: SubtitleMode;
}
```
Add a default + options list:
```ts
const DEFAULT_SUBTITLE_MODE: SubtitleMode = "pipeline";

export const SUBTITLE_MODE_OPTIONS = [
  { value: "pipeline", label: "一致 (免费)" },
  { value: "interpret", label: "实时 (付费)" },
] as const;
```
In `resolveSettings`, add:
```ts
    mode: storedSettings?.mode ?? DEFAULT_SUBTITLE_MODE,
```
In `saveSettings`'s persisted object, add:
```ts
    mode: settings.mode,
```
(`validateSettings` needs no rule — both values are valid; `resolveSettings` guarantees a default.)

- [ ] **Step 4: Run settings test**

Run: `pnpm --filter @echoflow/extension test settings`
Expected: PASS.

- [ ] **Step 5: Send mode in the start message**

In `apps/extension/src/realtime/realtimeClient.ts`: add `mode: SubtitleMode` to `RealtimeClientOptions` (import `SubtitleMode` from `@echoflow/protocol`), and include it in `createStartMessage`:
```ts
  private createStartMessage(): ClientMessage {
    return {
      type: "start",
      mode: this.options.mode,
      sessionId: this.options.sessionId,
      tabTitle: this.options.tabTitle,
      tabUrl: this.options.tabUrl,
      targetLanguage: this.options.targetLanguage,
      audioFormat: this.options.audioFormat,
      clientCapabilities:
        this.options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
    };
  }
```

In `apps/extension/entrypoints/offscreen/main.ts`, pass `mode` when constructing the `RealtimeClient`:
```ts
      mode: message.settings.mode,
```
(placed alongside `targetLanguage` in the `new RealtimeClient({...})` options.)

- [ ] **Step 6: Add the options toggle**

In `apps/extension/entrypoints/options/main.tsx`: add a labeled `<select>` (or two-button toggle) for the mode, bound to `settings.mode` via the existing `updateSetting` pattern (mirror the `targetLanguage` field), populated from `SUBTITLE_MODE_OPTIONS`. Ensure the default state includes `mode: "pipeline"` (line ~23 where the initial settings object is built — add `mode: "pipeline"`). Save persists it via `saveSettings`.

- [ ] **Step 7: Typecheck + tests**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: clean.
Run: `pnpm --filter @echoflow/extension test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/extension/src/settings/settings.ts apps/extension/src/settings/settings.test.ts apps/extension/src/realtime/realtimeClient.ts apps/extension/entrypoints/offscreen/main.ts apps/extension/entrypoints/options/main.tsx
git commit -m "feat(extension): subtitle mode setting, toggle, and start payload"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Whole workspace**

Run: `pnpm test`
Expected: all packages green.

- [ ] **Step 2: Build/typecheck/lint**

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: all succeed; `apps/extension/.output/chrome-mv3` builds (options page includes the toggle).

- [ ] **Step 3: Manual e2e (record outcome)**

With the real backend (`pipeline` mode default), confirm the free path is unchanged (finalized bilingual subtitles). Then toggle the options to **实时 (付费)**, re-trigger a session, and confirm the overlay shows a `mode_unavailable` error banner (interpret is gated until Cycle 2). Toggle back to **一致** and confirm normal operation resumes.

---

## Notes

- Wire `ServerEvent` shape is unchanged; the overlay/reducer need no changes beyond the new setting.
- `interpret` is intentionally gated (`ModeUnavailableError`) in Cycle 1; Cycle 2 implements `InterpretationSubtitleSource` (Doubao 同传) behind the same gate.
- Real auth/billing for the paid tier attaches at the factory's gate; out of scope here.
