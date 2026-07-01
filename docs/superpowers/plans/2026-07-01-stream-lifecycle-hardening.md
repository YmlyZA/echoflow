# Provider-Stream Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden both Volcengine adapter streams so audio isn't sent after `end()` (incl. during the drain window), `end()` is single-shot, and `close()` is idempotent — closing the parked interpret in-flight-after-`end()` and double-`close()` minors, symmetrically for the pipeline ASR path.

**Architecture:** Two boolean flags per adapter's returned stream closure — `ending` (set at the start of `end()`, gates `pushFrame` and re-entry) and `disposed` (makes `close()` idempotent). No shared helper; three lines per adapter. No happy-path behavior change.

**Tech Stack:** TypeScript (strict backend tsconfig), Vitest with mock transports + injectable drain timer.

## Global Constraints

- Guards go on the returned stream closure of BOTH `apps/backend/src/providers/volcengineSpeechProvider.ts` (pipeline ASR) and `apps/backend/src/realtime/interpretationSubtitleSource.ts` (interpret AST).
- `ending = true` is set at the **start** of `end()`, before `await drain.wait()`. `pushFrame` no-ops on `closed || ending`; `end()` no-ops on `closed || ending`.
- `close()` no-ops after the first call via `disposed`; it still sets `closed = true` and calls `transport.close()` exactly once. `close()` after `end()` must still close the transport (`end()` never closes it).
- `drain.arm()` still runs before `await drain.wait()`; the `ending` guard blocks only outbound audio + `end()`/`pushFrame` re-entry, NOT the inbound message handling that feeds `drain.onFinal()`.
- The fake speech provider is NOT modified.
- Backend strict tsconfig (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) — the changes are plain booleans, no new optional-property assignment.
- Tests use each file's existing mock-transport harness; add a `closes()` accessor to each mock and use an injectable `setTimer` to control the drain window.

---

### Task 1: Add `ending` + `disposed` guards to both adapters (+ tests)

**Files:**
- Modify: `apps/backend/src/providers/volcengineSpeechProvider.ts`
- Modify: `apps/backend/src/realtime/interpretationSubtitleSource.ts`
- Test: `apps/backend/src/providers/volcengineSpeechProvider.test.ts`
- Test: `apps/backend/src/realtime/interpretationSubtitleSource.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `withReconnect` transport + `createDrainGate` already in both adapters).
- Produces: no signature changes — purely internal stream-closure hardening.

- [ ] **Step 1: Add a `closes()` counter to the pipeline mock transport**

In `apps/backend/src/providers/volcengineSpeechProvider.test.ts`, update `createFakeTransport` to count `close()` calls:

```ts
function createFakeTransport() {
  const sent: Buffer[] = [];
  let closes = 0;
  let callbacks: VolcengineAsrTransportCallbacks | undefined;
  const factory: VolcengineAsrTransportFactory = (_options, cbs) => {
    callbacks = cbs;
    return {
      send: (data: Buffer) => sent.push(data),
      close: () => {
        closes += 1;
      },
    };
  };
  return {
    factory,
    sent,
    emit: (message: Buffer) => callbacks?.onMessage(message),
    fail: (error: Error) => callbacks?.onError(error),
    closes: () => closes,
  };
}
```

- [ ] **Step 2: Write the failing pipeline lifecycle tests**

Add to `apps/backend/src/providers/volcengineSpeechProvider.test.ts` (inside the `describe("VolcengineSpeechProvider", …)` block). The `setTimer: (fn) => fn()` injection makes the drain resolve immediately; the capture-only variant holds the drain open to test the mid-drain window.

```ts
it("stops sending audio during the drain window and after end()", async () => {
  const transport = createFakeTransport();
  let fireDrain: () => void = () => {};
  const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
    setTimer: (fn) => {
      fireDrain = fn;
    },
  });
  const stream = provider.open({ onSegment: () => {} });
  const afterOpen = transport.sent.length; // config frame(s)

  const endPromise = stream.end(); // sends the last frame, arms drain, awaits (timer captured)
  expect(transport.sent.length).toBe(afterOpen + 1); // only the isLast frame

  stream.pushFrame({ data: Buffer.from([1]), sequenceNumber: 1, timestampMs: 0 }); // during drain
  expect(transport.sent.length).toBe(afterOpen + 1); // dropped — no audio after end()

  fireDrain();
  await endPromise;

  stream.pushFrame({ data: Buffer.from([2]), sequenceNumber: 2, timestampMs: 0 }); // after end
  expect(transport.sent.length).toBe(afterOpen + 1); // still dropped
});

it("end() is single-shot (last frame sent once)", async () => {
  const transport = createFakeTransport();
  const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
    setTimer: (fn) => fn(),
  });
  const stream = provider.open({ onSegment: () => {} });
  const afterOpen = transport.sent.length;
  await stream.end();
  await stream.end();
  expect(transport.sent.length).toBe(afterOpen + 1);
});

it("close() is idempotent", async () => {
  const transport = createFakeTransport();
  const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
    setTimer: (fn) => fn(),
  });
  const stream = provider.open({ onSegment: () => {} });
  await stream.close();
  await stream.close();
  expect(transport.closes()).toBe(1);
});

it("close() after end() still closes the transport once", async () => {
  const transport = createFakeTransport();
  const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
    setTimer: (fn) => fn(),
  });
  const stream = provider.open({ onSegment: () => {} });
  await stream.end();
  await stream.close();
  expect(transport.closes()).toBe(1);
});
```

- [ ] **Step 3: Run to verify the pipeline tests fail**

Run: `pnpm --filter @echoflow/backend test -- volcengineSpeechProvider`
Expected: FAIL — the "during the drain window" test sends the audio frame (no `ending` guard), and "close() is idempotent" sees `closes() === 2`.

- [ ] **Step 4: Add the guards to the pipeline adapter**

In `apps/backend/src/providers/volcengineSpeechProvider.ts`, add the two flags beside `let closed = false;` (currently line ~43):

```ts
    let closed = false;
    let ending = false;
    let disposed = false;
```

Then update the returned stream's three methods:

```ts
      pushFrame(frame: AudioFrame): void {
        if (closed || ending) {
          return;
        }
        sequence += 1;
        const audio = Buffer.isBuffer(frame.data)
          ? frame.data
          : Buffer.from(frame.data);
        transport.send(encodeAudioRequest(audio, sequence, false));
      },
      async end(): Promise<void> {
        if (closed || ending) return;
        ending = true;
        sequence += 1;
        transport.send(encodeAudioRequest(Buffer.alloc(0), sequence, true));
        drain.arm();
        await drain.wait();
        closed = true;
      },
      async close(): Promise<void> {
        if (disposed) return;
        disposed = true;
        closed = true;
        transport.close();
      },
```

- [ ] **Step 5: Run to verify the pipeline tests pass**

Run: `pnpm --filter @echoflow/backend test -- volcengineSpeechProvider`
Expected: PASS (new + existing green).

- [ ] **Step 6: Add a `closes()` counter to the interpret mock transport**

In `apps/backend/src/realtime/interpretationSubtitleSource.test.ts`, update `stubTransport` to count closes:

```ts
function stubTransport(): {
  factory: AstTransportFactory;
  emit: (data: Buffer) => void;
  fail: (error: Error) => void;
  sent: Buffer[];
  options: () => AstConnectOptions | undefined;
  closes: () => number;
} {
  let cbs: AstTransportCallbacks | undefined;
  let opts: AstConnectOptions | undefined;
  const sent: Buffer[] = [];
  let closes = 0;
  const factory: AstTransportFactory = (options, callbacks) => {
    opts = options;
    cbs = callbacks;
    const transport: AstTransport = {
      send: (d) => sent.push(d),
      close: () => {
        closes += 1;
      },
    };
    return transport;
  };
  return {
    factory,
    emit: (data) => cbs?.onMessage(data),
    fail: (error) => cbs?.onError(error),
    sent,
    options: () => opts,
    closes: () => closes,
  };
}
```

- [ ] **Step 7: Write the failing interpret lifecycle tests**

Add to `apps/backend/src/realtime/interpretationSubtitleSource.test.ts` (inside the `describe("InterpretationSubtitleSource", …)` block). Source built as `new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, { setTimer })`:

```ts
it("stops sending audio during the drain window and after end()", async () => {
  const t = stubTransport();
  let fireDrain: () => void = () => {};
  const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
    setTimer: (fn) => {
      fireDrain = fn;
    },
  });
  const stream = source.open({ onEvent: () => {} });
  const afterOpen = t.sent.length; // StartSession

  const endPromise = stream.end(); // sends FinishSession, arms drain, awaits
  expect(t.sent.length).toBe(afterOpen + 1); // only FinishSession

  stream.pushFrame({ data: Buffer.from([1]), sequenceNumber: 1, timestampMs: 0 }); // during drain
  expect(t.sent.length).toBe(afterOpen + 1); // dropped

  fireDrain();
  await endPromise;

  stream.pushFrame({ data: Buffer.from([2]), sequenceNumber: 2, timestampMs: 0 }); // after end
  expect(t.sent.length).toBe(afterOpen + 1); // still dropped
});

it("end() is single-shot (FinishSession sent once)", async () => {
  const t = stubTransport();
  const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
    setTimer: (fn) => fn(),
  });
  const stream = source.open({ onEvent: () => {} });
  const afterOpen = t.sent.length;
  await stream.end();
  await stream.end();
  expect(t.sent.length).toBe(afterOpen + 1);
});

it("close() is idempotent", async () => {
  const t = stubTransport();
  const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
    setTimer: (fn) => fn(),
  });
  const stream = source.open({ onEvent: () => {} });
  await stream.close();
  await stream.close();
  expect(t.closes()).toBe(1);
});

it("close() after end() still closes the transport once", async () => {
  const t = stubTransport();
  const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
    setTimer: (fn) => fn(),
  });
  const stream = source.open({ onEvent: () => {} });
  await stream.end();
  await stream.close();
  expect(t.closes()).toBe(1);
});
```

- [ ] **Step 8: Run to verify the interpret tests fail**

Run: `pnpm --filter @echoflow/backend test -- interpretationSubtitleSource`
Expected: FAIL — mid-drain audio is sent; `closes() === 2`.

- [ ] **Step 9: Add the guards to the interpret adapter**

In `apps/backend/src/realtime/interpretationSubtitleSource.ts`, add the flags beside `let closed = false;`:

```ts
    let closed = false;
    let ending = false;
    let disposed = false;
```

Then update the returned stream's three methods:

```ts
      pushFrame(frame: AudioFrame): void {
        if (closed || ending) return;
        const audio = Buffer.isBuffer(frame.data) ? frame.data : Buffer.from(frame.data);
        transport.send(encodeAudioRequest(audio, sessionId));
      },
      async end(): Promise<void> {
        if (closed || ending) return;
        ending = true;
        transport.send(encodeFinishSession(sessionId));
        drain.arm();
        await drain.wait();
        closed = true;
      },
      async close(): Promise<void> {
        if (disposed) return;
        disposed = true;
        closed = true;
        transport.close();
      },
```

- [ ] **Step 10: Run to verify the interpret tests pass**

Run: `pnpm --filter @echoflow/backend test -- interpretationSubtitleSource`
Expected: PASS.

- [ ] **Step 11: Typecheck + full backend suite**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.
Run: `pnpm --filter @echoflow/backend test`
Expected: all green (existing + 8 new tests).

- [ ] **Step 12: Commit**

```bash
git add apps/backend/src/providers/volcengineSpeechProvider.ts apps/backend/src/realtime/interpretationSubtitleSource.ts apps/backend/src/providers/volcengineSpeechProvider.test.ts apps/backend/src/realtime/interpretationSubtitleSource.test.ts
git commit -m "fix(backend): harden provider-stream lifecycle (ending + disposed guards)"
```

---

## Self-Review

**Spec coverage:**
- `ending` guard (no audio after/ during `end()`, `end()` single-shot) → Steps 4 & 9. ✅
- `disposed` guard (`close()` idempotent, closes once after `end()`) → Steps 4 & 9. ✅
- Both adapters → pipeline (Steps 1–5), interpret (Steps 6–10). ✅
- Drain still works (guard doesn't touch inbound message handling / `drain.onFinal`) — the `end()` change keeps `drain.arm(); await drain.wait();` intact. ✅
- Fake provider untouched → not in the file list. ✅
- Tests for all four behaviors per adapter → Steps 2 & 7. ✅

**Placeholder scan:** No TBD/TODO. All code + test bodies are complete and reference the exact existing fixtures (`CONFIG`, `createFakeTransport`, `stubTransport`) and constructor arities.

**Type consistency:** `ending`/`disposed` are plain `boolean`s in the same closure scope as `closed`; no signature or type changes. Test mocks add a `closes: () => number` accessor consistently in both helpers. `setTimer` injection matches the adapters' existing `deps: { setTimer?; drainTimeoutMs? }` arg (added in the reconnect work). `pushFrame` uses the `AudioFrame` shape `{ data, sequenceNumber, timestampMs }` both files already import.
