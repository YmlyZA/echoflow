# Session Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Survive an MV3 service-worker restart mid-session and an unexpected WebSocket drop, with a visible reconnect indicator and unique segment ids across reconnects.

**Architecture:** Persist `{ sessionState, detectedSourceLanguage }` to `chrome.storage.session` and rehydrate the background before handling any event. Give `RealtimeClient` a bounded-backoff reconnect state machine that re-sends the handshake, drops audio during the gap, namespaces segment ids per connection epoch, and reports status. Surface "reconnecting" to the overlay over a new `CONNECTION_STATUS` runtime message. Bound `finalizedSegmentIds`.

**Tech Stack:** TypeScript (ESM, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), WXT + React 19, Vitest (`vi.useFakeTimers` for reconnect timing). Spec: `docs/superpowers/specs/2026-06-13-session-robustness-design.md`. Backend is untouched.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/extension/src/session/sessionStore.ts` | Persist/load session state over a `chrome.storage.session` adapter | Create |
| `apps/extension/src/session/sessionStore.test.ts` | Round-trip + default tests | Create |
| `apps/extension/src/messaging/messages.ts` | `ConnectionStatusMessage` + guard | Modify |
| `apps/extension/src/messaging/messages.test.ts` | Guard accepts `CONNECTION_STATUS` | Create |
| `apps/extension/src/realtime/realtimeClient.ts` | `withEpochSegmentId`; reconnect state machine; non-throwing `sendAudioFrame`; epoch | Modify |
| `apps/extension/src/realtime/realtimeClient.test.ts` | epoch helper + reconnect tests | Modify |
| `apps/extension/src/subtitles/reducer.ts` | Bound `finalizedSegmentIds` | Modify |
| `apps/extension/src/subtitles/reducer.test.ts` | Bound test | Modify |
| `apps/extension/src/overlay/SubtitleOverlay.tsx` | `connectionStatus` reconnecting banner | Modify |
| `apps/extension/src/overlay/SubtitleOverlay.test.tsx` | Banner test | Modify |
| `apps/extension/entrypoints/background.ts` | Rehydrate + commit + `CONNECTION_STATUS` + badge | Modify (full rewrite) |
| `apps/extension/entrypoints/offscreen/main.ts` | `onStatus` wiring + terminal stop | Modify |
| `apps/extension/entrypoints/content.tsx` | `connectionStatus` state | Modify |

Sequencing: Tasks 1–6 are tested pure/component units; Tasks 7–9 are chrome-bound wiring verified by typecheck; Task 10 verifies the whole.

---

## Task 1: Session state persistence store

**Files:**
- Create: `apps/extension/src/session/sessionStore.ts`
- Test: `apps/extension/src/session/sessionStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/session/sessionStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createInMemorySessionStorage,
  loadPersistedState,
  persistState,
  type PersistedSessionState,
} from "./sessionStore";

describe("sessionStore", () => {
  it("round-trips a running session state", async () => {
    const storage = createInMemorySessionStorage();
    const running: PersistedSessionState = {
      sessionState: {
        status: "running",
        localSessionId: "local-1",
        tabId: 7,
        streamId: "stream-1",
        targetLanguage: "zh-CN",
      },
      detectedSourceLanguage: "en",
    };

    await persistState(running, storage);

    expect(await loadPersistedState(storage)).toEqual(running);
  });

  it("returns an idle default when nothing is stored", async () => {
    const storage = createInMemorySessionStorage();

    expect(await loadPersistedState(storage)).toEqual({
      sessionState: { status: "idle" },
      detectedSourceLanguage: "unknown",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- -t "sessionStore"`
Expected: FAIL — module `./sessionStore` does not exist.

- [ ] **Step 3: Implement**

Create `apps/extension/src/session/sessionStore.ts`:

```ts
import { createInitialSessionState, type SessionState } from "./sessionState";

export interface PersistedSessionState {
  sessionState: SessionState;
  detectedSourceLanguage: string;
}

export interface SessionStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export const SESSION_STATE_STORAGE_KEY = "echoflow.session";

export async function loadPersistedState(
  storage: SessionStateStorage = createChromeSessionStorageAdapter(),
): Promise<PersistedSessionState> {
  const stored = await storage.get<PersistedSessionState>(
    SESSION_STATE_STORAGE_KEY,
  );

  return (
    stored ?? {
      sessionState: createInitialSessionState(),
      detectedSourceLanguage: "unknown",
    }
  );
}

export async function persistState(
  value: PersistedSessionState,
  storage: SessionStateStorage = createChromeSessionStorageAdapter(),
): Promise<void> {
  await storage.set(SESSION_STATE_STORAGE_KEY, value);
}

export function createInMemorySessionStorage(): SessionStateStorage {
  const map = new Map<string, unknown>();

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
  };
}

export function createChromeSessionStorageAdapter(): SessionStateStorage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const storage = getChromeSessionStorage();

      return new Promise((resolve, reject) => {
        storage.get(key, (items) => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve(items[key] as T | undefined);
        });
      });
    },
    async set<T>(key: string, value: T): Promise<void> {
      const storage = getChromeSessionStorage();

      return new Promise((resolve, reject) => {
        storage.set({ [key]: value }, () => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve();
        });
      });
    },
  };
}

function getChromeSessionStorage(): chrome.storage.SessionStorageArea {
  if (!globalThis.chrome?.storage?.session) {
    throw new Error("chrome.storage.session is unavailable");
  }

  return globalThis.chrome.storage.session;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "sessionStore"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/session/sessionStore.ts apps/extension/src/session/sessionStore.test.ts
git commit -m "Persist session state to chrome.storage.session"
```

---

## Task 2: `CONNECTION_STATUS` runtime message

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts`
- Test: `apps/extension/src/messaging/messages.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/messaging/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRuntimeMessage } from "./messages";

describe("isRuntimeMessage", () => {
  it("accepts CONNECTION_STATUS messages", () => {
    expect(
      isRuntimeMessage({
        type: "CONNECTION_STATUS",
        localSessionId: "local-1",
        status: "reconnecting",
      }),
    ).toBe(true);
  });

  it("rejects unknown message types", () => {
    expect(isRuntimeMessage({ type: "NOPE" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- -t "isRuntimeMessage"`
Expected: FAIL — `CONNECTION_STATUS` is not yet in the accepted list.

- [ ] **Step 3: Implement**

In `apps/extension/src/messaging/messages.ts`:

(a) Add to the `RuntimeMessage` union (after `OffscreenReadyMessage`):

```ts
export type RuntimeMessage =
  | StartSessionMessage
  | StopSessionMessage
  | SessionStartedMessage
  | SessionErrorMessage
  | ServerEventMessage
  | OffscreenReadyMessage
  | ConnectionStatusMessage;
```

(b) Add the interface (after `OffscreenReadyMessage`):

```ts
export interface ConnectionStatusMessage {
  type: "CONNECTION_STATUS";
  localSessionId: string;
  status: "reconnecting" | "connected";
}
```

(c) Add `"CONNECTION_STATUS"` to the array inside `isRuntimeMessage`:

```ts
  return [
    "START_SESSION",
    "STOP_SESSION",
    "SESSION_STARTED",
    "SESSION_ERROR",
    "SERVER_EVENT",
    "OFFSCREEN_READY",
    "CONNECTION_STATUS"
  ].includes(message.type);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "isRuntimeMessage"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/messaging/messages.ts apps/extension/src/messaging/messages.test.ts
git commit -m "Add a CONNECTION_STATUS runtime message"
```

---

## Task 3: `withEpochSegmentId` helper

**Files:**
- Modify: `apps/extension/src/realtime/realtimeClient.ts`
- Test: `apps/extension/src/realtime/realtimeClient.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/extension/src/realtime/realtimeClient.test.ts` (add `withEpochSegmentId` to the existing import from `./realtimeClient`):

```ts
describe("withEpochSegmentId", () => {
  it("prefixes partial and final segment ids with the epoch", () => {
    expect(
      withEpochSegmentId(
        { type: "partial", segmentId: "seg-1", sourceText: "a" },
        2,
      ),
    ).toEqual({ type: "partial", segmentId: "e2:seg-1", sourceText: "a" });

    expect(
      withEpochSegmentId(
        {
          type: "final",
          segmentId: "seg-1",
          sourceText: "a",
          translatedText: "b",
          startTimeMs: 0,
          endTimeMs: 1,
        },
        1,
      ),
    ).toEqual({
      type: "final",
      segmentId: "e1:seg-1",
      sourceText: "a",
      translatedText: "b",
      startTimeMs: 0,
      endTimeMs: 1,
    });
  });

  it("passes language and error events through unchanged", () => {
    const language = {
      type: "language",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    } as const;
    expect(withEpochSegmentId(language, 3)).toBe(language);
  });
});
```

Update the existing import line at the top of the file to include `withEpochSegmentId`:

```ts
import {
  RealtimeClient,
  parseServerEventMessage,
  withEpochSegmentId,
  type BrowserWebSocket
} from "./realtimeClient";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- -t "withEpochSegmentId"`
Expected: FAIL — `withEpochSegmentId` is not exported.

- [ ] **Step 3: Implement**

In `apps/extension/src/realtime/realtimeClient.ts`, add this exported function (place it next to `parseServerEventMessage`):

```ts
export function withEpochSegmentId(
  event: ServerEvent,
  epoch: number,
): ServerEvent {
  if (event.type === "partial" || event.type === "final") {
    return { ...event, segmentId: `e${epoch}:${event.segmentId}` };
  }

  return event;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "withEpochSegmentId"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/realtime/realtimeClient.ts apps/extension/src/realtime/realtimeClient.test.ts
git commit -m "Namespace segment ids by connection epoch"
```

---

## Task 4: `RealtimeClient` reconnect state machine

**Files:**
- Modify: `apps/extension/src/realtime/realtimeClient.ts`
- Test: `apps/extension/src/realtime/realtimeClient.test.ts`

- [ ] **Step 1: Add the reconnect tests + a `remoteClose` helper to the fake socket**

In `apps/extension/src/realtime/realtimeClient.test.ts`, add a `remoteClose` method to the `FakeWebSocket` class (after its `error()` method):

```ts
  remoteClose(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
```

Then add this describe block (it uses `vi` which is already imported):

```ts
describe("RealtimeClient reconnect", () => {
  it("reconnects with backoff and re-sends the handshake after an unexpected close", async () => {
    vi.useFakeTimers();
    try {
      const onStatus = vi.fn();
      const client = createClient({ onStatus, reconnectBaseDelayMs: 500 });
      const connected = client.connect();
      FakeWebSocket.instances[0].open();
      await connected;

      FakeWebSocket.instances[0].remoteClose();
      expect(onStatus).toHaveBeenCalledWith("reconnecting");
      expect(FakeWebSocket.instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances).toHaveLength(2);

      FakeWebSocket.instances[1].open();
      expect(onStatus).toHaveBeenCalledWith("connected");
      expect(JSON.parse(FakeWebSocket.instances[1].sentText[0])).toMatchObject({
        type: "start",
        sessionId: "local-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxReconnectAttempts and reports connection_lost", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const client = createClient({
        onError,
        maxReconnectAttempts: 2,
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 1000,
      });
      const connected = client.connect();
      FakeWebSocket.instances[0].open();
      await connected;

      FakeWebSocket.instances[0].remoteClose();
      await vi.advanceTimersByTimeAsync(100);
      FakeWebSocket.instances[1].error();
      await vi.advanceTimersByTimeAsync(200);
      FakeWebSocket.instances[2].error();
      await vi.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "connection_lost" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after an intentional stop", async () => {
    const client = createConnectedClient();

    client.stop();
    FakeWebSocket.instances[0].remoteClose();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("drops audio frames while disconnected instead of throwing", () => {
    const client = createClient();

    expect(() =>
      client.sendAudioFrame(new Blob(["x"], { type: "audio/webm" }), {
        sequenceNumber: 0,
        timestampMs: 0,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test -- -t "RealtimeClient reconnect"`
Expected: FAIL — no reconnection (instances stays length 1 after `remoteClose`), `onStatus` option unsupported, `sendAudioFrame` throws when not connected.

- [ ] **Step 3: Rewrite the client**

Overwrite `apps/extension/src/realtime/realtimeClient.ts` with EXACTLY:

```ts
import {
  isServerEvent,
  type AudioFormatMetadata,
  type AudioFrameMetadata,
  type ClientCapabilities,
  type ClientMessage,
  type ServerEvent
} from "@echoflow/protocol";

export interface BrowserWebSocket {
  readonly OPEN: number;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | Blob | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type BrowserWebSocketConstructor = new (url: string) => BrowserWebSocket;

export type ConnectionStatus = "reconnecting" | "connected";

export interface RealtimeClientOptions {
  url: string;
  apiKey: string;
  sessionId: string;
  tabTitle: string;
  tabUrl: string;
  targetLanguage: string;
  audioFormat: AudioFormatMetadata;
  clientCapabilities?: ClientCapabilities;
  maxConnectionAttempts?: number;
  retryDelayMs?: number;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  WebSocketCtor?: BrowserWebSocketConstructor;
  onEvent?: (event: ServerEvent) => void;
  onError?: (error: RealtimeClientError) => void;
  onStatus?: (status: ConnectionStatus) => void;
}

export interface RealtimeClientError {
  code: string;
  message: string;
}

const DEFAULT_MAX_CONNECTION_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 8000;
const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
  binaryAudioFrames: true,
  partialSubtitles: true,
  finalSubtitles: true,
  languageEvents: true,
  errorEvents: true
};

export class RealtimeClient {
  private socket: BrowserWebSocket | undefined;
  private stopped = false;
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: RealtimeClientOptions) {}

  async connect(): Promise<void> {
    const maxAttempts =
      this.options.maxConnectionAttempts ?? DEFAULT_MAX_CONNECTION_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.openSocket();
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          const clientError = toClientError(
            error,
            "connection_failed",
            "Realtime connection failed"
          );
          this.options.onError?.(clientError);
          throw new Error(clientError.message);
        }

        await delay(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      }
    }
  }

  sendAudioFrame(
    data: Blob | ArrayBuffer,
    frame: Omit<AudioFrameMetadata, "byteLength"> & { byteLength?: number }
  ): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      return;
    }

    const byteLength = frame.byteLength ?? getByteLength(data);
    const message: ClientMessage = {
      type: "audio_frame",
      sessionId: this.options.sessionId,
      frame: {
        ...frame,
        byteLength
      }
    };

    socket.send(JSON.stringify(message));
    socket.send(data);
  }

  stop(reason = "client_stop"): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      socket?.close();
      return;
    }

    const message: ClientMessage = {
      type: "stop",
      sessionId: this.options.sessionId,
      reason
    };

    socket.send(JSON.stringify(message));
    socket.close();
  }

  private openSocket(): Promise<void> {
    const WebSocketCtor =
      this.options.WebSocketCtor ??
      (globalThis.WebSocket as unknown as BrowserWebSocketConstructor);

    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = new WebSocketCtor(
        buildAuthenticatedWebSocketUrl(this.options.url, this.options.apiKey)
      );
      this.socket = socket;

      socket.onopen = () => {
        opened = true;
        this.epoch += 1;
        this.reconnectAttempts = 0;
        socket.send(JSON.stringify(this.createStartMessage()));
        if (this.epoch > 1) {
          this.options.onStatus?.("connected");
        }
        resolve();
      };

      socket.onmessage = (event) => {
        this.handleServerMessage(event.data);
      };

      socket.onerror = () => {
        if (!opened) {
          reject(new Error("Realtime connection failed"));
        }
      };

      socket.onclose = () => {
        if (!opened) {
          reject(new Error("Realtime connection closed before opening"));
          return;
        }

        this.handleUnexpectedClose();
      };
    });
  }

  private handleUnexpectedClose(): void {
    if (this.stopped) {
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    const maxAttempts =
      this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (this.reconnectAttempts >= maxAttempts) {
      this.options.onError?.({
        code: "connection_lost",
        message: "Realtime connection lost"
      });
      return;
    }

    const base =
      this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const cap =
      this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delayMs = Math.min(base * 2 ** this.reconnectAttempts, cap);
    this.reconnectAttempts += 1;
    this.options.onStatus?.("reconnecting");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) {
        return;
      }
      this.openSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private createStartMessage(): ClientMessage {
    return {
      type: "start",
      sessionId: this.options.sessionId,
      tabTitle: this.options.tabTitle,
      tabUrl: this.options.tabUrl,
      targetLanguage: this.options.targetLanguage,
      audioFormat: this.options.audioFormat,
      clientCapabilities:
        this.options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES
    };
  }

  private handleServerMessage(data: unknown): void {
    try {
      if (typeof data !== "string") {
        throw new RealtimeProtocolError("Invalid server message");
      }

      const event = parseServerEventMessage(data);
      this.options.onEvent?.(withEpochSegmentId(event, this.epoch));
    } catch (error) {
      this.options.onError?.(
        toClientError(error, "invalid_server_message", "Invalid server message")
      );
    }
  }
}

export function withEpochSegmentId(
  event: ServerEvent,
  epoch: number
): ServerEvent {
  if (event.type === "partial" || event.type === "final") {
    return { ...event, segmentId: `e${epoch}:${event.segmentId}` };
  }

  return event;
}

export function parseServerEventMessage(data: string): ServerEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    throw new RealtimeProtocolError("Invalid server message");
  }

  if (!isServerEvent(parsed)) {
    throw new RealtimeProtocolError("Invalid server message");
  }

  return parsed;
}

export function buildAuthenticatedWebSocketUrl(
  url: string,
  apiKey: string
): string {
  const websocketUrl = new URL(url);
  websocketUrl.searchParams.set("apiKey", apiKey);

  return websocketUrl.toString();
}

function getByteLength(data: Blob | ArrayBuffer): number {
  return data instanceof Blob ? data.size : data.byteLength;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toClientError(
  error: unknown,
  code: string,
  fallbackMessage: string
): RealtimeClientError {
  return {
    code,
    message: error instanceof Error ? error.message : fallbackMessage
  };
}

class RealtimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeProtocolError";
  }
}
```

- [ ] **Step 4: Run the full client test suite + typecheck**

Run: `pnpm --filter @echoflow/extension exec vitest run src/realtime/realtimeClient.test.ts`
Expected: PASS (existing tests + the new epoch and reconnect tests).

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/realtime/realtimeClient.ts apps/extension/src/realtime/realtimeClient.test.ts
git commit -m "Reconnect with backoff and drop frames while disconnected"
```

---

## Task 5: Bound `finalizedSegmentIds`

**Files:**
- Modify: `apps/extension/src/subtitles/reducer.ts`
- Test: `apps/extension/src/subtitles/reducer.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/extension/src/subtitles/reducer.test.ts` (reuse existing imports):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- -t "bounds finalized ids"`
Expected: FAIL — `finalizedSegmentIds` has length 60.

- [ ] **Step 3: Implement**

In `apps/extension/src/subtitles/reducer.ts`, add the constant near the top (after the imports):

```ts
const MAX_FINALIZED_TRACKED = 50;
```

And change `appendFinalizedSegmentId`:

```ts
function appendFinalizedSegmentId(
  finalizedSegmentIds: readonly string[],
  segmentId: string
): readonly string[] {
  if (finalizedSegmentIds.includes(segmentId)) {
    return finalizedSegmentIds;
  }

  return [...finalizedSegmentIds, segmentId].slice(-MAX_FINALIZED_TRACKED);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "bounds finalized ids"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/subtitles/reducer.ts apps/extension/src/subtitles/reducer.test.ts
git commit -m "Bound the finalized segment id window"
```

---

## Task 6: Reconnecting banner in the overlay

**Files:**
- Modify: `apps/extension/src/overlay/SubtitleOverlay.tsx`
- Test: `apps/extension/src/overlay/SubtitleOverlay.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `apps/extension/src/overlay/SubtitleOverlay.test.tsx`:

```ts
describe("SubtitleOverlay connection status", () => {
  it("renders a reconnecting banner", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={null}
        fontSize={24}
        connectionStatus="reconnecting"
      />
    );

    expect(html).toContain("重连中");
  });

  it("hides the banner when connected", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={null}
        fontSize={24}
        connectionStatus="connected"
      />
    );

    expect(html).not.toContain("重连中");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- -t "connection status"`
Expected: FAIL — `connectionStatus` prop unsupported; banner not rendered.

- [ ] **Step 3: Implement**

In `apps/extension/src/overlay/SubtitleOverlay.tsx`:

(a) Add to `SubtitleOverlayProps` (after `transientError`):

```ts
  connectionStatus?: "reconnecting" | "connected" | null;
```

(b) Add `connectionStatus = null` to the destructured props (after `transientError = null`):

```ts
  transientError = null,
  connectionStatus = null,
```

(c) Render the banner inside the `<section>`, immediately before the `{transientError ? (` block:

```tsx
        {connectionStatus === "reconnecting" ? (
          <div className="echoflow-reconnecting" role="status">
            重连中…
          </div>
        ) : null}

```

(d) Add the banner style inside the `<style>` template (after the `.echoflow-error { ... }` rule):

```css
      .echoflow-reconnecting {
        min-height: 20px;
        padding: 4px 8px;
        border-radius: 6px;
        background: rgba(214, 158, 46, 0.24);
        color: #ffe7b3;
        font: 600 12px/1.2 system-ui, sans-serif;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- -t "connection status"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/overlay/SubtitleOverlay.tsx apps/extension/src/overlay/SubtitleOverlay.test.tsx
git commit -m "Show a reconnecting banner in the subtitle overlay"
```

---

## Task 7: Background rehydrate + connection-status forwarding

**Files:**
- Modify (full rewrite): `apps/extension/entrypoints/background.ts`

No unit test — `background.ts` is chrome-bound glue; the persistence logic is covered by Task 1 and the forwarding/segment logic by Spec 1's tests. Verified by typecheck.

- [ ] **Step 1: Rewrite the file**

Overwrite `apps/extension/entrypoints/background.ts` with EXACTLY:

```ts
import {
  isRuntimeMessage,
  type ConnectionStatusMessage,
  type RuntimeMessage,
  type SessionErrorMessage,
  type SessionStartedMessage,
  type ServerEventMessage,
  type StartSessionMessage,
  type StopSessionMessage
} from "../src/messaging/messages";
import { createHistoryStore } from "../src/history/historyStore";
import { finalEventToSegment } from "../src/history/segmentMapping";
import { loadSettings, validateSettings } from "../src/settings/settings";
import {
  createInitialSessionState,
  reduceSessionState,
  type SessionState
} from "../src/session/sessionState";
import { loadPersistedState, persistState } from "../src/session/sessionStore";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const CONTENT_SCRIPT_PATH = "content-scripts/content.js";

const historyStore = createHistoryStore();
let sessionState: SessionState = createInitialSessionState();
let detectedSourceLanguage = "unknown";
let stateLoaded: Promise<void> | undefined;

function ensureStateLoaded(): Promise<void> {
  stateLoaded ??= loadPersistedState().then((persisted) => {
    sessionState = persisted.sessionState;
    detectedSourceLanguage = persisted.detectedSourceLanguage;
  });
  return stateLoaded;
}

async function commitSessionState(next: SessionState): Promise<void> {
  sessionState = next;
  await persistState({ sessionState, detectedSourceLanguage });
}

async function commitDetectedSourceLanguage(language: string): Promise<void> {
  detectedSourceLanguage = language;
  await persistState({ sessionState, detectedSourceLanguage });
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setTitle({ title: "EchoFlow" });
  });

  chrome.action.onClicked.addListener((tab) => {
    void handleActionClick(tab);
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isRuntimeMessage(message)) {
      return;
    }

    void handleRuntimeMessage(message);
  });
});

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  await ensureStateLoaded();

  if (sessionState.status === "connecting" || sessionState.status === "running") {
    await stopSession("action_click");
    return;
  }

  if (sessionState.status === "stopping") {
    return;
  }

  await startSession(tab);
}

async function startSession(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") {
    return;
  }

  const settings = await loadSettings();
  const validation = validateSettings(settings);

  if (!validation.valid) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  let localSessionId: string | undefined;

  try {
    await injectRuntimeContentScript(tab.id);

    const localSession = await historyStore.createLocalSession({
      targetLanguage: settings.targetLanguage
    });
    localSessionId = localSession.id;
    await commitDetectedSourceLanguage("unknown");

    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "START_CONNECTING",
        localSessionId: localSession.id,
        tabId: tab.id,
        streamId: "",
        settings
      })
    );

    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });

    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "STREAM_READY",
        streamId
      })
    );

    await setBadge("...");

    await chrome.runtime.sendMessage({
      type: "START_SESSION",
      localSessionId,
      tabId: tab.id,
      streamId,
      settings
    } satisfies StartSessionMessage);
  } catch (error) {
    await handleSessionError({
      type: "SESSION_ERROR",
      localSessionId:
        localSessionId ??
        (sessionState.status === "idle" ? undefined : sessionState.localSessionId),
      code: "start_failed",
      message: error instanceof Error ? error.message : "Failed to start session"
    });
  }
}

async function stopSession(reason: string): Promise<void> {
  if (sessionState.status !== "connecting" && sessionState.status !== "running") {
    await clearBadge();
    await commitSessionState(
      reduceSessionState(sessionState, { type: "STOP_COMPLETED" })
    );
    return;
  }

  const localSessionId = sessionState.localSessionId;
  await commitSessionState(
    reduceSessionState(sessionState, { type: "STOP_REQUESTED" })
  );

  await chrome.runtime.sendMessage({
    type: "STOP_SESSION",
    localSessionId,
    reason
  } satisfies StopSessionMessage);

  await clearBadge();
  await commitSessionState(
    reduceSessionState(sessionState, { type: "STOP_COMPLETED" })
  );
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<void> {
  await ensureStateLoaded();

  switch (message.type) {
    case "STOP_SESSION":
      await stopSession(message.reason ?? "content_request");
      return;
    case "SESSION_STARTED":
      await handleSessionStarted(message);
      return;
    case "SESSION_ERROR":
      await handleSessionError(message);
      return;
    case "SERVER_EVENT":
      await forwardServerEvent(message);
      return;
    case "CONNECTION_STATUS":
      await forwardConnectionStatus(message);
      return;
    case "OFFSCREEN_READY":
    case "START_SESSION":
      return;
  }
}

async function handleSessionStarted(
  message: SessionStartedMessage
): Promise<void> {
  if (
    sessionState.status !== "connecting" ||
    message.localSessionId !== sessionState.localSessionId
  ) {
    return;
  }

  await commitSessionState(
    reduceSessionState(sessionState, {
      type: "SESSION_STARTED",
      remoteSessionId: message.remoteSessionId
    })
  );

  await setBadge("ON");
}

async function handleSessionError(message: SessionErrorMessage): Promise<void> {
  if (sessionState.status !== "idle") {
    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "SESSION_ERROR",
        error: {
          code: message.code,
          message: message.message
        }
      })
    );
  }

  const localSessionId =
    message.localSessionId ??
    (sessionState.status === "idle" ? undefined : sessionState.localSessionId);

  if (localSessionId) {
    await historyStore.recordSessionError(localSessionId, {
      code: message.code,
      message: message.message
    });
  }

  await clearBadge();
}

async function forwardServerEvent(message: ServerEventMessage): Promise<void> {
  if (
    sessionState.status === "idle" ||
    message.localSessionId !== sessionState.localSessionId
  ) {
    return;
  }

  if (message.event.type === "language") {
    await commitDetectedSourceLanguage(message.event.sourceLanguage);
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

  await sendMessageToTab(sessionState.tabId, {
    type: "SERVER_EVENT",
    localSessionId: message.localSessionId,
    event: message.event
  });
}

async function forwardConnectionStatus(
  message: ConnectionStatusMessage
): Promise<void> {
  if (
    sessionState.status === "idle" ||
    message.localSessionId !== sessionState.localSessionId
  ) {
    return;
  }

  await setBadge(message.status === "reconnecting" ? "..." : "ON");
  await sendMessageToTab(sessionState.tabId, message);
}

async function injectRuntimeContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_PATH]
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for realtime subtitles."
  });
}

async function sendMessageToTab(
  tabId: number,
  message: Extract<RuntimeMessage, { type: "SERVER_EVENT" | "CONNECTION_STATUS" }>
): Promise<void> {
  await chrome.tabs.sendMessage(tabId, message);
}

async function setBadge(text: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

async function clearBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: "" });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS.

- [ ] **Step 3: Run the extension test suite (no regressions)**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "Rehydrate session state and forward connection status"
```

---

## Task 8: Offscreen status wiring + terminal teardown

**Files:**
- Modify: `apps/extension/entrypoints/offscreen/main.ts`

No unit test — chrome-bound glue; verified by typecheck.

- [ ] **Step 1: Add the imports**

In `apps/extension/entrypoints/offscreen/main.ts`, add `ConnectionStatusMessage` to the existing import from `../../src/messaging/messages`:

```ts
import {
  isRuntimeMessage,
  type ConnectionStatusMessage,
  type ServerEventMessage,
  type SessionErrorMessage,
  type SessionStartedMessage,
  type StartSessionMessage
} from "../../src/messaging/messages";
```

- [ ] **Step 2: Wire `onStatus` and terminal teardown into the client**

In `startSession`, replace the `onError` handler in the `RealtimeClient` construction:

```ts
      onError: (error) => {
        void chrome.runtime.sendMessage({
          type: "SESSION_ERROR",
          localSessionId: message.localSessionId,
          code: error.code,
          message: error.message
        } satisfies SessionErrorMessage);
      }
```

with:

```ts
      onError: (error) => {
        void chrome.runtime.sendMessage({
          type: "SESSION_ERROR",
          localSessionId: message.localSessionId,
          code: error.code,
          message: error.message
        } satisfies SessionErrorMessage);

        if (error.code === "connection_lost") {
          void stopActiveSession("connection_lost");
        }
      },
      onStatus: (status) => {
        void chrome.runtime.sendMessage({
          type: "CONNECTION_STATUS",
          localSessionId: message.localSessionId,
          status
        } satisfies ConnectionStatusMessage);
      }
```

(Note the trailing comma after the `onError` block now that `onStatus` follows it.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS — `onStatus` is a valid `RealtimeClientOptions` field; `stopActiveSession` is already defined in this file.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/offscreen/main.ts
git commit -m "Forward connection status and tear down on terminal loss"
```

---

## Task 9: Content script connection-status state

**Files:**
- Modify: `apps/extension/entrypoints/content.tsx`

No unit test — chrome-bound glue; the banner render is covered by Task 6. Verified by typecheck.

- [ ] **Step 1: Add the state and handle `CONNECTION_STATUS`**

In `apps/extension/entrypoints/content.tsx`:

(a) Inside `EchoFlowMount`, add a state hook after the existing `position` state:

```ts
  const [connectionStatus, setConnectionStatus] = useState<
    "reconnecting" | "connected" | null
  >(null);
```

(b) In the `handleRuntimeMessage` function (inside the second `useEffect`), replace:

```ts
    function handleRuntimeMessage(message: unknown) {
      if (!isRuntimeMessage(message) || message.type !== "SERVER_EVENT") {
        return;
      }

      window.dispatchEvent(
        new CustomEvent("echoflow:server-event", {
          detail: (message as ServerEventMessage).event
        })
      );
    }
```

with:

```ts
    function handleRuntimeMessage(message: unknown) {
      if (!isRuntimeMessage(message)) {
        return;
      }

      if (message.type === "SERVER_EVENT") {
        window.dispatchEvent(
          new CustomEvent("echoflow:server-event", {
            detail: message.event
          })
        );
        return;
      }

      if (message.type === "CONNECTION_STATUS") {
        setConnectionStatus(message.status);
      }
    }
```

(The `as ServerEventMessage` cast is no longer needed — narrowing on `message.type` gives the right type.)

(c) Pass the prop to `<SubtitleOverlay>` (add after the `transientError` prop):

```tsx
      transientError={subtitleState.transientError}
      connectionStatus={connectionStatus}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS. If the `ServerEventMessage` import is now unused, remove it from the import list to keep the typecheck clean.

- [ ] **Step 3: Build the extension (entrypoints compile under WXT)**

Run: `pnpm --filter @echoflow/extension build`
Expected: PASS — `chrome-mv3` build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/content.tsx
git commit -m "Surface reconnecting status in the subtitle overlay"
```

---

## Task 10: Full workspace verification

**Files:** none (verification only).

- [ ] **Step 1: Build, test, typecheck, lint**

Run: `pnpm build`
Expected: PASS — all packages compile, `chrome-mv3` built.

Run: `pnpm test`
Expected: PASS — protocol, backend, extension suites green.

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 2: Commit only if anything was adjusted**

If a fix was needed to make the above green, stage and commit it:

```bash
git add -A
git commit -m "Green the workspace after the session-robustness work"
```

Otherwise this task produces no commit.

---

## Self-Review

**Spec coverage:**
- §1 Part A (storage.session persistence + rehydrate-before-handle + commit) → Task 1 (store) + Task 7 (background rehydrate/commit, incl. `commitDetectedSourceLanguage` for the language-only persist).
- §2 Part B (reconnect state machine, backoff, give-up→`connection_lost`, drop-frames `sendAudioFrame`, re-handshake) → Task 4. Terminal teardown → Task 8.
- §3 (CONNECTION_STATUS message → offscreen → background+badge → content → overlay banner) → Task 2 (message) + Task 8 (offscreen emit) + Task 7 (background forward+badge) + Task 9 (content state) + Task 6 (overlay banner).
- §4 (epoch namespacing) → Task 3 (`withEpochSegmentId`) + Task 4 (epoch counter + application in `handleServerMessage`).
- §5 (bound `finalizedSegmentIds`) → Task 5.
- §6 testing → store (Task 1), message guard (Task 2), epoch (Task 3), reconnect via `vi.useFakeTimers` (Task 4), bound reducer (Task 5), banner (Task 6); chrome-bound wiring (Tasks 7–9) typecheck-verified.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step states expected output.

**Type consistency:** `PersistedSessionState`/`SessionStateStorage`/`loadPersistedState`/`persistState`/`createInMemorySessionStorage` match between Task 1 (definition) and Task 7 (use). `ConnectionStatusMessage { type, localSessionId, status: "reconnecting"|"connected" }` matches across Tasks 2, 7, 8, 9. `withEpochSegmentId(event, epoch)` matches Task 3 (def) and Task 4 (call in `handleServerMessage`). `RealtimeClientOptions.onStatus: (status: ConnectionStatus) => void` matches Task 4 (def) and Task 8 (use). `SubtitleOverlay`'s `connectionStatus?: "reconnecting"|"connected"|null` matches Task 6 (def) and Task 9 (use). The `sendMessageToTab` param widened to `Extract<RuntimeMessage, { type: "SERVER_EVENT" | "CONNECTION_STATUS" }>` in Task 7 covers both forwarders.
