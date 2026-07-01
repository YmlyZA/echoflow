# Session Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mid-session Volcengine drop transparently reconnects (with backoff, showing the existing "reconnecting" pill) instead of killing the session, and stopping mid-utterance drains the trailing final before close.

**Architecture:** A reusable `withReconnect` transport wrapper re-establishes the WS on retryable drops and re-runs an `initialize` hook; both Volcengine adapters adopt it. A `createDrainGate` helper makes each adapter's `end()` await the trailing final (bounded by a timeout). A new transient `status` `ServerEvent` drives the overlay's existing reconnecting pill.

**Tech Stack:** TypeScript, Vitest (mock transports + injectable timers, no real Volcengine), React 19 (`renderToStaticMarkup`), `ws`.

## Global Constraints

- **Accept-the-gap:** audio arriving while disconnected is **dropped**; the in-flight utterance at drop time is lost. No buffering/replay.
- **`status` event is transient and payload-free:** `{ type: "status"; state: "reconnecting" | "live" }`. It rides the normal `ServerEvent`/`onEvent` path — `session.ts` already forwards any `ServerEvent`, so no session change is needed for forwarding.
- **`"live"` fires on the first message after a reconnect** (the transport hides the socket "open" event); **no status on the first/normal connect** — only after a drop.
- **Reuse ids across reconnects** (do not regenerate session/request ids); regeneration is a documented follow-up.
- **Backoff default:** `[500, 1000, 2000, 4000, 8000, 8000]` ms (~6 attempts); after exhaustion or a fatal classify, propagate `onError` (session tears down as today).
- **Drain timeout default:** 1500 ms; `end()` must never hang.
- **All timers are injectable** (`setTimer` option) so tests never wait on real time. All transports are injectable (adapters already take a `connect` factory).
- **The fake provider path is unchanged** (never disconnects; `onStatus` is optional).
- Contract change (`packages/protocol`): update the guard AND its `.test.ts` in the same task.
- Extension component/pure tests: `renderToStaticMarkup` / pure reducers; assert on class/text, no literal apostrophes.
- This branch is off `main` (post speaker-labels merge): `reducer.ts` already has `speakerId`/`seenSpeakerIds`; `events.ts` already has `speakerId`. Add to those, don't recreate.

---

### Task 1: Protocol `status` event

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Test: `packages/protocol/src/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StatusEvent = { type: "status"; state: "reconnecting" | "live" }` in the `ServerEvent` union; `isServerEvent` validates it. Tasks 3/4 emit it; Task 5 reduces it.

- [ ] **Step 1: Write the failing guard tests**

Add to `packages/protocol/src/events.test.ts` (in the `isServerEvent` describe):

```ts
it("accepts a status event for both connection states", () => {
  expect(isServerEvent({ type: "status", state: "reconnecting" })).toBe(true);
  expect(isServerEvent({ type: "status", state: "live" })).toBe(true);
});

it("rejects a status event with an unknown or missing state", () => {
  expect(isServerEvent({ type: "status", state: "paused" })).toBe(false);
  expect(isServerEvent({ type: "status" })).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @echoflow/protocol test -- events`
Expected: FAIL — `status` falls through to the guard's `default: return false`, so the two accept cases return `false`.

- [ ] **Step 3: Add the type + union member**

In `packages/protocol/src/events.ts`, add before `ErrorEvent`:

```ts
export type StatusEvent = {
  type: "status";
  state: "reconnecting" | "live";
};
```

and add `| StatusEvent` to the `ServerEvent` union.

- [ ] **Step 4: Validate it in the guard**

In `isServerEvent`, add a case before `default`:

```ts
    case "status":
      return value.state === "reconnecting" || value.state === "live";
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @echoflow/protocol test -- events`
Expected: PASS (new + existing green).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/events.test.ts
git commit -m "feat(protocol): transient status event (reconnecting/live)"
```

---

### Task 2: Backend lifecycle utilities — `withReconnect` + `createDrainGate`

**Files:**
- Create: `apps/backend/src/providers/reconnectingTransport.ts`
- Create: `apps/backend/src/providers/drainGate.ts`
- Test: `apps/backend/src/providers/reconnectingTransport.test.ts`
- Test: `apps/backend/src/providers/drainGate.test.ts`

**Interfaces:**
- Consumes: nothing (pure, timer-injectable).
- Produces:
  - `withReconnect(connect: ConnectFn, options: ReconnectOptions): TransportLike`, plus `defaultClassify`, `defaultBackoff`, and the exported types `TransportLike`, `TransportCallbacks`, `ConnectFn`, `TransportStatus`, `ReconnectOptions`.
  - `createDrainGate(options?: { setTimer?; timeoutMs? }): { arm(): void; onFinal(): void; wait(): Promise<void> }`.
  - Both consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing `drainGate` test**

Create `apps/backend/src/providers/drainGate.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createDrainGate } from "./drainGate";

describe("createDrainGate", () => {
  it("resolves when a final arrives after arming", async () => {
    const gate = createDrainGate({ setTimer: () => {}, timeoutMs: 1000 });
    gate.arm();
    const waited = gate.wait();
    gate.onFinal();
    await expect(waited).resolves.toBeUndefined();
  });

  it("resolves via the timeout when no final arrives", async () => {
    let fire: () => void = () => {};
    const gate = createDrainGate({ setTimer: (fn) => { fire = fn; }, timeoutMs: 1000 });
    gate.arm();
    const waited = gate.wait();
    fire(); // simulate the timeout elapsing
    await expect(waited).resolves.toBeUndefined();
  });

  it("ignores finals emitted before arming", async () => {
    let fire: () => void = () => {};
    const gate = createDrainGate({ setTimer: (fn) => { fire = fn; }, timeoutMs: 1000 });
    gate.onFinal(); // pre-arm final must NOT satisfy the wait
    gate.arm();
    const waited = gate.wait();
    let settled = false;
    void waited.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    fire();
    await expect(waited).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- drainGate`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `createDrainGate`**

Create `apps/backend/src/providers/drainGate.ts`:

```ts
export interface DrainGateOptions {
  /** Injectable timer (tests pass a manual trigger). Default setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void;
  /** Max time to wait for the trailing final. Default 1500ms. */
  timeoutMs?: number;
}

/**
 * A one-shot gate for draining the trailing final on stop. `arm()` starts
 * caring about finals; `wait()` resolves on the next `onFinal()` after arming,
 * or when the timeout elapses — whichever first. Finals before `arm()` are
 * ignored (they are normal in-stream finals, not the trailing one).
 */
export function createDrainGate(options: DrainGateOptions = {}): {
  arm(): void;
  onFinal(): void;
  wait(): Promise<void>;
} {
  const setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));
  const timeoutMs = options.timeoutMs ?? 1500;
  let armed = false;
  let resolved = false;
  let resolve: (() => void) | undefined;

  const settle = (): void => {
    if (resolved) return;
    resolved = true;
    resolve?.();
  };

  return {
    arm(): void {
      armed = true;
    },
    onFinal(): void {
      if (armed) settle();
    },
    wait(): Promise<void> {
      return new Promise<void>((res) => {
        resolve = res;
        if (resolved) {
          res();
          return;
        }
        setTimer(settle, timeoutMs);
      });
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- drainGate`
Expected: PASS.

- [ ] **Step 5: Write the failing `withReconnect` test**

Create `apps/backend/src/providers/reconnectingTransport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { withReconnect, defaultClassify, type TransportCallbacks, type TransportLike } from "./reconnectingTransport";

/** A mock transport whose callbacks the test drives directly. */
function makeMock() {
  const sockets: Array<{ cb: TransportCallbacks; sent: Buffer[]; closed: boolean }> = [];
  const connect = (cb: TransportCallbacks): TransportLike => {
    const socket = { cb, sent: [] as Buffer[], closed: false };
    sockets.push(socket);
    return {
      send: (d) => socket.sent.push(d),
      close: () => { socket.closed = true; }
    };
  };
  return { connect, sockets };
}

const B = (s: string) => Buffer.from(s);

describe("withReconnect", () => {
  it("does not emit status on the first connect and runs initialize once", () => {
    const { connect, sockets } = makeMock();
    const statuses: string[] = [];
    withReconnect(connect, {
      onMessage: () => {}, onError: () => {},
      initialize: (t) => t.send(B("init")),
      onStatus: (s) => statuses.push(s),
      setTimer: () => {}
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.map(String)).toEqual(["init"]);
    expect(statuses).toEqual([]);
  });

  it("reconnects on a retryable close: reconnecting → re-init → live on first message", () => {
    const { connect, sockets } = makeMock();
    const statuses: string[] = [];
    const messages: string[] = [];
    let fireTimer: () => void = () => {};
    withReconnect(connect, {
      onMessage: (d) => messages.push(String(d)), onError: () => {},
      initialize: (t) => t.send(B("init")),
      onStatus: (s) => statuses.push(s),
      setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "abnormal");   // retryable drop
    expect(statuses).toEqual(["reconnecting"]);
    fireTimer();                                 // backoff elapses → reconnect
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent.map(String)).toEqual(["init"]); // re-initialized
    expect(statuses).toEqual(["reconnecting"]);  // not live until data flows
    sockets[1]!.cb.onMessage(B("hello"));
    expect(statuses).toEqual(["reconnecting", "live"]);
    expect(messages).toEqual(["hello"]);
  });

  it("drops sends while reconnecting and resumes after recovery", () => {
    const { connect, sockets } = makeMock();
    let fireTimer: () => void = () => {};
    const t = withReconnect(connect, {
      onMessage: () => {}, onError: () => {},
      initialize: () => {}, onStatus: () => {},
      setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "x");
    t.send(B("dropped"));                         // during gap → dropped
    fireTimer();
    sockets[1]!.cb.onMessage(B("m"));             // back to live
    t.send(B("kept"));
    expect(sockets[1]!.sent.map(String)).toEqual(["kept"]);
  });

  it("propagates a fatal (non-retryable) close without retrying", () => {
    const { connect, sockets } = makeMock();
    const errors: string[] = [];
    withReconnect(connect, {
      onMessage: () => {}, onError: (e) => errors.push(e.message),
      initialize: () => {}, onStatus: () => {}, setTimer: () => {}
    });
    sockets[0]!.cb.onClose(4401, "unauthorized"); // fatal code
    expect(sockets).toHaveLength(1);              // no reconnect
    expect(errors).toHaveLength(1);
  });

  it("gives up after the backoff schedule is exhausted", () => {
    const { connect, sockets } = makeMock();
    const errors: string[] = [];
    let fireTimer: () => void = () => {};
    withReconnect(connect, {
      onMessage: () => {}, onError: (e) => errors.push(e.message),
      initialize: () => {}, onStatus: () => {},
      backoff: [10, 10], setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "x"); fireTimer(); // attempt 1
    sockets[1]!.cb.onClose(1006, "x"); fireTimer(); // attempt 2
    sockets[2]!.cb.onClose(1006, "x");              // exhausted → fatal
    expect(errors).toHaveLength(1);
    expect(sockets).toHaveLength(3);
  });

  it("stops reconnecting after close()", () => {
    const { connect, sockets } = makeMock();
    let fireTimer: () => void = () => {};
    const t = withReconnect(connect, {
      onMessage: () => {}, onError: () => {},
      initialize: () => {}, onStatus: () => {},
      setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "x");
    t.close();
    fireTimer();                                   // must NOT reconnect
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("defaultClassify: network errors + abnormal codes retryable, clean/app codes fatal", () => {
    expect(defaultClassify({ error: new Error("net") })).toBe(true);
    expect(defaultClassify({ code: 1006 })).toBe(true);
    expect(defaultClassify({ code: 1000 })).toBe(false);
    expect(defaultClassify({ code: 4401 })).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- reconnectingTransport`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement `withReconnect`**

Create `apps/backend/src/providers/reconnectingTransport.ts`:

```ts
export type TransportCallbacks = {
  onMessage: (data: Buffer) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string) => void;
};

export interface TransportLike {
  send(data: Buffer): void;
  close(): void;
}

export type ConnectFn = (callbacks: TransportCallbacks) => TransportLike;
export type TransportStatus = "reconnecting" | "live";

export interface ReconnectOptions {
  /** Consumer message sink (protocol-level parsing lives here). */
  onMessage: (data: Buffer) => void;
  /** Fatal error sink — called on a non-retryable failure or exhausted backoff. */
  onError: (error: Error) => void;
  /** (Re)send the session-init frame(s) on each fresh socket, incl. the first. */
  initialize: (transport: TransportLike) => void;
  /** Emitted on drop ("reconnecting") and on first message after reconnect ("live"). */
  onStatus: (status: TransportStatus) => void;
  /** true → retry with backoff; false → fatal. Default: defaultClassify. */
  classify?: (info: { code?: number; error?: Error }) => boolean;
  /** Backoff schedule (ms per attempt). Default: defaultBackoff. */
  backoff?: readonly number[];
  /** Injectable timer. Default setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void;
}

export const defaultBackoff: readonly number[] = [500, 1000, 2000, 4000, 8000, 8000];

const RETRYABLE_CLOSE_CODES = new Set([1005, 1006, 1011, 1012, 1013]);

export function defaultClassify(info: { code?: number; error?: Error }): boolean {
  if (info.error) return true; // raw socket/network error
  if (info.code === undefined) return true;
  return RETRYABLE_CLOSE_CODES.has(info.code);
}

export function withReconnect(connect: ConnectFn, options: ReconnectOptions): TransportLike {
  const classify = options.classify ?? defaultClassify;
  const backoff = options.backoff ?? defaultBackoff;
  const setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));

  let state: "live" | "reconnecting" = "live";
  let attempt = 0;
  let attemptSettled = false; // guards double-handling (onError + onClose) per socket
  let closedByUser = false;
  let current: TransportLike;

  const open = (): void => {
    attemptSettled = false;
    current = connect({
      onMessage: (data) => {
        if (state === "reconnecting") {
          state = "live";
          attempt = 0;
          options.onStatus("live");
        }
        options.onMessage(data);
      },
      onError: (error) => fail({ error }),
      onClose: (code) => fail({ code })
    });
    options.initialize(current);
  };

  const fail = (info: { code?: number; error?: Error }): void => {
    if (closedByUser || attemptSettled) return;
    attemptSettled = true;
    if (!classify(info) || attempt >= backoff.length) {
      options.onError(info.error ?? new Error(`transport closed: ${info.code ?? "unknown"}`));
      return;
    }
    if (state === "live") {
      state = "reconnecting";
      options.onStatus("reconnecting");
    }
    const delay = backoff[attempt] ?? backoff[backoff.length - 1] ?? 0;
    attempt += 1;
    setTimer(() => {
      if (!closedByUser) open();
    }, delay);
  };

  open();

  return {
    send(data: Buffer): void {
      if (state === "live") current.send(data);
    },
    close(): void {
      closedByUser = true;
      current.close();
    }
  };
}
```

- [ ] **Step 8: Run both utility test files to verify pass**

Run: `pnpm --filter @echoflow/backend test -- reconnectingTransport drainGate`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: PASS.

```bash
git add apps/backend/src/providers/reconnectingTransport.ts apps/backend/src/providers/drainGate.ts apps/backend/src/providers/reconnectingTransport.test.ts apps/backend/src/providers/drainGate.test.ts
git commit -m "feat(backend): withReconnect transport wrapper + drain gate utilities"
```

---

### Task 3: Pipeline adapter — reconnect + drain + status

**Files:**
- Modify: `apps/backend/src/providers/types.ts` (add optional `onStatus` to `SpeechProvider.open` opts)
- Modify: `apps/backend/src/providers/volcengineSpeechProvider.ts`
- Modify: `apps/backend/src/realtime/pipelineSubtitleSource.ts`
- Test: `apps/backend/src/providers/volcengineSpeechProvider.test.ts`

**Interfaces:**
- Consumes: `withReconnect`, `createDrainGate` (Task 2); protocol `status` (Task 1).
- Produces: `SpeechProvider.open` opts gain `onStatus?: (state: "reconnecting" | "live") => void`; `VolcengineSpeechProvider` reconnects + drains and calls `onStatus`; `PipelineSubtitleSource` forwards `onStatus` as `onEvent({ type: "status", state })`. The `VolcengineSpeechProvider` constructor gains an optional deps arg for timer injection.

- [ ] **Step 1: Extend the `SpeechProvider` type**

In `apps/backend/src/providers/types.ts`, add to the `SpeechProvider.open` opts object:

```ts
export type SpeechProvider = {
  open(opts: {
    onSegment: (event: SegmentEvent) => void;
    onError?: (error: Error) => void;
    onStatus?: (state: "reconnecting" | "live") => void;
  }): SpeechRecognitionStream;
};
```

- [ ] **Step 2: Write the failing provider test**

Add to `apps/backend/src/providers/volcengineSpeechProvider.test.ts` a reconnect test using an injectable mock transport (the constructor's 2nd arg is the `connect` factory). Mirror the file's existing setup for building the provider with a mock transport; the new cases:

```ts
it("re-sends the config frame and reports status on a retryable drop", () => {
  const sockets: Array<{ cb: any; sent: Buffer[] }> = [];
  const connect = (_opts: any, cb: any) => {
    const s = { cb, sent: [] as Buffer[] };
    sockets.push(s);
    return { send: (d: Buffer) => s.sent.push(d), close: () => {} };
  };
  const statuses: string[] = [];
  let fireTimer: () => void = () => {};
  const provider = new VolcengineSpeechProvider(CONFIG, connect, {
    setTimer: (fn) => { fireTimer = fn; }
  });
  provider.open({ onSegment: () => {}, onStatus: (s) => statuses.push(s) });
  expect(sockets[0]!.sent).toHaveLength(1);      // initial config frame
  sockets[0]!.cb.onClose(1006, "abnormal");
  expect(statuses).toEqual(["reconnecting"]);
  fireTimer();
  expect(sockets[1]!.sent).toHaveLength(1);      // config re-sent on reconnect
});
```

(The file's existing config fixture is the module-level `CONFIG` const; reuse it. This test builds its OWN inline `connect` mock — the file's existing `transport.factory` helper tracks a single socket, but reconnect needs multiple, so the inline `sockets[]` mock above is the right shape. The third constructor arg `{ setTimer }` is added in Step 3.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- volcengineSpeechProvider`
Expected: FAIL — third constructor arg unsupported / no reconnect / no status.

- [ ] **Step 4: Adopt `withReconnect` + drain + status in the provider**

Rewrite `apps/backend/src/providers/volcengineSpeechProvider.ts`'s `open` to route the transport through `withReconnect` and drain on `end()`. Key changes (keep the rest of the file — imports, `buildRequestConfig`, `toError` — intact; add imports for `withReconnect` and `createDrainGate`):

```ts
import { withReconnect } from "./reconnectingTransport.js";
import { createDrainGate } from "./drainGate.js";
```

Constructor gains an optional deps arg:

```ts
constructor(
  private readonly config: VolcengineAsrConfig,
  private readonly connect: VolcengineAsrTransportFactory = connectVolcengineAsrTransport,
  private readonly deps: { setTimer?: (fn: () => void, ms: number) => void; drainTimeoutMs?: number } = {},
) {}
```

Inside `open`, replace the direct `this.connect(...)` + `transport.send(initFrame)` with:

```ts
const drain = createDrainGate({ setTimer: this.deps.setTimer, timeoutMs: this.deps.drainTimeoutMs });
const configFrame = encodeFullClientRequest(
  buildRequestConfig(requestId, this.config.vadSegmentDurationMs ?? DEFAULT_VOLCENGINE_ASR_VAD_MS),
);

const handleMessage = (data: Buffer): void => {
  if (closed) return;
  let message: VolcengineServerMessage;
  try {
    message = parseServerMessage(data);
  } catch (error) {
    opts.onError?.(toError(error));
    return;
  }
  if (message.type === "error") {
    opts.onError?.(new Error(`Volcengine ASR error ${message.code}: ${message.message}`));
    return;
  }
  if (!languageEmitted) {
    languageEmitted = true;
    opts.onSegment({ kind: "language", sourceLanguage: message.payload.result?.language ?? "auto" });
  }
  for (const event of reconciler.reconcile(message.payload.result?.utterances ?? [])) {
    opts.onSegment(event);
    if (event.kind === "final") drain.onFinal();
  }
};

const transport = withReconnect(
  (cb) => this.connect(
    {
      endpoint: this.config.endpoint,
      headers: {
        "X-Api-App-Key": this.config.appKey,
        "X-Api-Access-Key": this.config.accessKey,
        "X-Api-Resource-Id": this.config.resourceId,
        "X-Api-Request-Id": requestId,
      },
    },
    cb,
  ),
  {
    onMessage: handleMessage,
    onError: (error) => { if (!closed) opts.onError?.(error); },
    initialize: (t) => t.send(configFrame),
    onStatus: (state) => opts.onStatus?.(state),
    setTimer: this.deps.setTimer,
  },
);
```

Note: `VolcengineAsrTransportCallbacks.onMessage` takes a `Buffer`; `withReconnect`'s `ConnectFn` uses the same `{ onMessage, onError, onClose }` shape, so `(cb) => this.connect(options, cb)` type-checks directly.

Update `end()` to drain the trailing final:

```ts
async end(): Promise<void> {
  if (closed) return;
  sequence += 1;
  transport.send(encodeAudioRequest(Buffer.alloc(0), sequence, true));
  drain.arm();
  await drain.wait();
  closed = true;
},
```

`pushFrame` and `close` are unchanged (they call `transport.send` / `transport.close`, now the reconnecting transport).

- [ ] **Step 5: Forward `onStatus` from `PipelineSubtitleSource`**

In `apps/backend/src/realtime/pipelineSubtitleSource.ts`, where it opens the speech provider (`this.speechProvider.open({ onSegment, onError })`), add an `onStatus` that emits the status `ServerEvent`:

```ts
const stream = this.speechProvider.open({
  onSegment,
  onError: (error) => opts.onError?.(error),
  onStatus: (state) => opts.onEvent({ type: "status", state }),
});
```

- [ ] **Step 6: Run the provider test + typecheck**

Run: `pnpm --filter @echoflow/backend test -- volcengineSpeechProvider pipelineSubtitleSource`
Expected: PASS.
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/providers/types.ts apps/backend/src/providers/volcengineSpeechProvider.ts apps/backend/src/realtime/pipelineSubtitleSource.ts apps/backend/src/providers/volcengineSpeechProvider.test.ts
git commit -m "feat(backend): pipeline ASR auto-reconnect + drain-final + status"
```

---

### Task 4: Interpret adapter — reconnect + drain + status

**Files:**
- Modify: `apps/backend/src/realtime/interpretationSubtitleSource.ts`
- Test: `apps/backend/src/realtime/interpretationSubtitleSource.test.ts`

**Interfaces:**
- Consumes: `withReconnect`, `createDrainGate` (Task 2); protocol `status` (Task 1).
- Produces: `InterpretationSubtitleSource` reconnects + drains and emits `onEvent({ type: "status", state })`. Its constructor gains an optional deps arg for timer injection.

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/src/realtime/interpretationSubtitleSource.test.ts` a reconnect case using the injectable `connect` factory (4th constructor arg) + the new deps arg. Mirror the file's existing harness; the new case:

```ts
it("re-sends StartSession and emits a status event on a retryable drop", () => {
  const sockets: Array<{ cb: any; sent: Buffer[] }> = [];
  const connect = (_opts: any, cb: any) => {
    const s = { cb, sent: [] as Buffer[] };
    sockets.push(s);
    return { send: (d: Buffer) => s.sent.push(d), close: () => {} };
  };
  const events: ServerEvent[] = [];
  let fireTimer: () => void = () => {};
  const source = new InterpretationSubtitleSource(
    CONFIG, "en", "zh-CN", connect, { setTimer: (fn) => { fireTimer = fn; } }
  );
  source.open({ onEvent: (e) => events.push(e) });
  expect(sockets[0]!.sent).toHaveLength(1);       // initial StartSession
  sockets[0]!.cb.onClose(1006, "abnormal");
  fireTimer();
  expect(sockets[1]!.sent).toHaveLength(1);        // StartSession re-sent
  expect(events).toContainEqual({ type: "status", state: "reconnecting" });
});
```

(The file's existing config fixture is the module-level `CONFIG` const, and existing tests build the source as `new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory)`. This test uses its own inline `sockets[]` mock `connect` (reconnect needs multiple sockets). The 5th constructor arg `{ setTimer }` is added in Step 2.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- interpretationSubtitleSource`
Expected: FAIL — 5th constructor arg unsupported / no reconnect / no status event.

- [ ] **Step 3: Adopt `withReconnect` + drain + status**

In `apps/backend/src/realtime/interpretationSubtitleSource.ts`, add imports:

```ts
import { withReconnect } from "../providers/reconnectingTransport.js";
import { createDrainGate } from "../providers/drainGate.js";
```

Constructor gains the deps arg:

```ts
constructor(
  private readonly config: AstSourceConfig,
  private readonly sourceLanguage: string,
  private readonly targetLanguage: string,
  private readonly connect: AstTransportFactory = connectAstTransport,
  private readonly deps: { setTimer?: (fn: () => void, ms: number) => void; drainTimeoutMs?: number } = {},
) {}
```

In `open`, build the drain gate + the StartSession frame, extract the current `onMessage` body into a `handleMessage`, and route through `withReconnect`. The `handleMessage` is the existing message handler; add `drain.onFinal()` after emitting a `final`:

```ts
const drain = createDrainGate({ setTimer: this.deps.setTimer, timeoutMs: this.deps.drainTimeoutMs });
const startFrame = encodeStartSession({
  sessionId,
  resourceId: this.config.resourceId,
  sourceLanguage: sourceAst,
  targetLanguage: targetAst,
  audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
});

const handleMessage = (data: Buffer): void => {
  if (closed) return;
  const event = parseAstMessage(data);
  if (event.kind === "error") {
    opts.onError?.(new Error(`AST error ${event.code}: ${event.message}`));
    return;
  }
  if (event.kind === "other" || event.kind === "usage") return;
  if (!languageEmitted) {
    languageEmitted = true;
    opts.onEvent({ type: "language", sourceLanguage: sourceAst, targetLanguage });
  }
  for (const seg of reconciler.reconcile(event)) {
    if (seg.kind === "partial") {
      opts.onEvent({ type: "partial", segmentId: seg.segmentId, sourceText: seg.text });
    } else if (seg.kind === "final") {
      opts.onEvent({
        type: "final",
        segmentId: seg.segmentId,
        sourceText: seg.text,
        translatedText: seg.translatedText,
        startTimeMs: seg.startTimeMs,
        endTimeMs: seg.endTimeMs,
      });
      drain.onFinal();
    }
  }
};

const transport = withReconnect(
  (cb) => this.connect(
    {
      endpoint: this.config.endpoint,
      headers: {
        "X-Api-Key": this.config.apiKey,
        "X-Api-Resource-Id": this.config.resourceId,
        "X-Api-Request-Id": sessionId,
      },
    },
    cb,
  ),
  {
    onMessage: handleMessage,
    onError: (error) => { if (!closed) opts.onError?.(error); },
    initialize: (t) => t.send(startFrame),
    onStatus: (state) => opts.onEvent({ type: "status", state }),
    setTimer: this.deps.setTimer,
  },
);
```

Update `end()`:

```ts
async end(): Promise<void> {
  if (closed) return;
  transport.send(encodeFinishSession(sessionId));
  drain.arm();
  await drain.wait();
  closed = true;
},
```

`pushFrame` and `close` are unchanged.

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm --filter @echoflow/backend test -- interpretationSubtitleSource`
Expected: PASS.
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/realtime/interpretationSubtitleSource.ts apps/backend/src/realtime/interpretationSubtitleSource.test.ts
git commit -m "feat(backend): interpret AST auto-reconnect + drain-final + status"
```

---

### Task 5: Extension — status → reconnecting pill

**Files:**
- Modify: `apps/extension/src/subtitles/reducer.ts`
- Modify: `apps/extension/src/overlay/overlayStatus.ts`
- Modify: `apps/extension/entrypoints/content.tsx`
- Test: `apps/extension/src/subtitles/reducer.test.ts`
- Test: `apps/extension/src/overlay/overlayStatus.test.ts`

**Interfaces:**
- Consumes: protocol `status` event (Task 1).
- Produces: `SubtitleState.providerConnection: "live" | "reconnecting"`; `deriveOverlayStatus` gains a `providerReconnecting: boolean` input.

- [ ] **Step 1: Write the failing reducer test**

Add to `apps/extension/src/subtitles/reducer.test.ts`:

```ts
it("tracks providerConnection from status events", () => {
  let state = createInitialSubtitleState();
  expect(state.providerConnection).toBe("live");
  state = reduceSubtitleEvent(state, { type: "status", state: "reconnecting" });
  expect(state.providerConnection).toBe("reconnecting");
  state = reduceSubtitleEvent(state, { type: "status", state: "live" });
  expect(state.providerConnection).toBe("live");
});
```

- [ ] **Step 2: Write the failing overlayStatus test**

Add to `apps/extension/src/overlay/overlayStatus.test.ts`:

```ts
it("shows reconnecting when the provider is reconnecting", () => {
  expect(
    deriveOverlayStatus({ connectionStatus: "connected", hasError: false, hasSignal: true, providerReconnecting: true })
  ).toBe("reconnecting");
});

it("lets an error outrank provider reconnecting", () => {
  expect(
    deriveOverlayStatus({ connectionStatus: "connected", hasError: true, hasSignal: true, providerReconnecting: true })
  ).toBe("error");
});
```

(The existing overlayStatus tests will need `providerReconnecting: false` added to their input objects — update them so they still type-check and pass.)

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm --filter @echoflow/extension test -- "subtitles/reducer" overlayStatus`
Expected: FAIL — `providerConnection` undefined; `providerReconnecting` not an accepted input / not honored.

- [ ] **Step 4: Extend the reducer**

In `apps/extension/src/subtitles/reducer.ts`:
1. Add `providerConnection: "live" | "reconnecting";` to `SubtitleState`.
2. In `createInitialSubtitleState`, add `providerConnection: "live"`.
3. Add a `"status"` case to `reduceSubtitleEvent`:

```ts
    case "status":
      return { ...state, providerConnection: event.state };
```

- [ ] **Step 5: Extend `deriveOverlayStatus`**

In `apps/extension/src/overlay/overlayStatus.ts`, add `providerReconnecting: boolean` to `OverlayStatusInput`, and honor it (error still first):

```ts
export function deriveOverlayStatus(input: OverlayStatusInput): OverlayLifecycle {
  if (input.hasError) {
    return "error";
  }
  if (input.connectionStatus === "reconnecting" || input.providerReconnecting) {
    return "reconnecting";
  }
  if (input.hasSignal || input.connectionStatus === "connected") {
    return "live";
  }
  return "connecting";
}
```

- [ ] **Step 6: Wire it in content.tsx**

In `apps/extension/entrypoints/content.tsx`, pass the new input into the existing `deriveOverlayStatus` call:

```tsx
const lifecycle = deriveOverlayStatus({
  connectionStatus,
  hasError: subtitleState.transientError !== null || sessionError !== null,
  hasSignal,
  providerReconnecting: subtitleState.providerConnection === "reconnecting"
});
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @echoflow/extension test -- "subtitles/reducer" overlayStatus`
Expected: PASS.
Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS (content.tsx included).

- [ ] **Step 8: Commit**

```bash
git add apps/extension/src/subtitles/reducer.ts apps/extension/src/overlay/overlayStatus.ts apps/extension/entrypoints/content.tsx apps/extension/src/subtitles/reducer.test.ts apps/extension/src/overlay/overlayStatus.test.ts
git commit -m "feat(extension): drive the reconnecting pill from backend status events"
```

---

## Self-Review

**Spec coverage:**
- `StatusEvent` contract + guard → Task 1. ✅
- `withReconnect` (classify/backoff/status/drop-during-gap/give-up/close) → Task 2. ✅
- `createDrainGate` (trailing-final + timeout) → Task 2. ✅
- Pipeline adapter reconnect + drain + `onStatus` threading (`SpeechProvider.onStatus`, `PipelineSubtitleSource`) → Task 3. ✅
- Interpret adapter reconnect + drain + status via `onEvent` → Task 4. ✅
- Extension reducer `providerConnection` + `deriveOverlayStatus` + content.tsx → Task 5. ✅
- Session forwarding: no change needed (verified — `session.ts` forwards any `ServerEvent`). ✅
- Deferred (audio replay, popup e2e, id-regeneration, parked minors) → not implemented, per spec. ✅

**Placeholder scan:** No TBD/TODO. The "mirror the file's existing fixture/harness" notes (Tasks 3, 4) name the exact fixture (`TEST_CONFIG`/`TEST_AST_CONFIG`) and give the complete new test body; they adapt to the file's existing constructor-call form rather than leaving anything unspecified.

**Type consistency:** `status`/`state: "reconnecting" | "live"` identical across protocol (Task 1), `SpeechProvider.onStatus` (Task 3), `TransportStatus` (Task 2), and the reducer `"status"` case (Task 5). `withReconnect`'s `ConnectFn` callbacks (`onMessage/onError/onClose`) match both `VolcengineAsrTransportCallbacks` and `AstTransportCallbacks` exactly, so `(cb) => this.connect(options, cb)` type-checks. `createDrainGate` `arm/onFinal/wait` used identically in Tasks 3 and 4. `deriveOverlayStatus`'s new `providerReconnecting` input is supplied in content.tsx (Task 5) and both new tests. Backoff/classify defaults live only in Task 2 and are reused by injection.

**Backend strictness note:** the backend enables `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. `backoff[attempt]` is guarded (`?? backoff[backoff.length - 1] ?? 0`); mock-socket array access in tests uses `!` (test files, acceptable). Optional `onStatus?`/`deps` are called with `?.`/defaulted, never assigned `undefined`.
