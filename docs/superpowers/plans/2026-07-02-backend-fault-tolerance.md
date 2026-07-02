# Backend Fault Tolerance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a backend realtime session alive and correct under transient provider failures and reconnects — four independent fixes: non-fatal translation failure, ASR sequence reset on reconnect, boundary-based reconciler dedup, and socket-close on fatal provider error.

**Architecture:** Four self-contained edits, each in one backend source file with a colocated test. No shared files between tasks, so ordering is free.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify + `ws`, Vitest.

## Global Constraints

- All work in `apps/backend`. No changes to `packages/protocol` or `apps/extension`.
- Backend tsconfig enables `exactOptionalPropertyTypes` AND `noUncheckedIndexedAccess` (via `tsconfig.base.json`): never assign a possibly-`undefined` value to an optional property (use conditional spread `...(x !== undefined ? { k: x } : {})`), and index access (`arr[i]`) is `T | undefined` — assert with `!` in tests where you know it exists (`sockets[1]!`).
- Backend imports use explicit `.js` specifiers (`./foo.js`) even for `.ts` sources.
- After each task: `pnpm --filter @echoflow/backend typecheck` and `pnpm --filter @echoflow/backend test` stay green.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Translation failure is non-fatal (#1)

**Files:**
- Modify: `apps/backend/src/realtime/pipelineSubtitleSource.ts` (`drainTranslations` catch block)
- Test: `apps/backend/src/realtime/pipelineSubtitleSource.test.ts` (extend)

**Interfaces:**
- No signature change. New behavior: a translation throw emits a source-only `final` + a non-fatal `error` event, and does not call `opts.onError`.

- [ ] **Step 1: Write the failing test**

Open `pipelineSubtitleSource.test.ts`, match its harness (how it fakes the speech + translation providers and drives a `final` segment). Add a test where the translation provider's `translate` rejects:

```ts
  it("keeps the session alive and emits a source-only final when translation fails", async () => {
    const events: ServerEvent[] = [];
    const onError = vi.fn();
    const speech = createFakeSpeechProvider(); // adapt to the file's existing helper
    const translation = {
      translate: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
      close: vi.fn(),
    };
    const source = new PipelineSubtitleSource(speech.provider, translation, "zh-CN");
    const stream = source.open({ onEvent: (e) => events.push(e), onError });

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
```

> Adapt `createFakeSpeechProvider`/`speech.emit` to whatever the file already uses to feed `onSegment`. If the file constructs the speech provider inline, follow that shape. The key assertions (source-only final + `translation_failed` error + no `onError`) are fixed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- pipelineSubtitleSource`
Expected: FAIL — currently the catch calls `onError` (so `onError` IS called) and no source-only final/error event is emitted.

- [ ] **Step 3: Implement**

In `drainTranslations`, replace the `catch` block:

```ts
          } catch (error: unknown) {
            if (closed) {
              return;
            }
            // Translation failed transiently. Do NOT kill the session (that is
            // what opts.onError does). If this segment is still current, surface
            // the source text with an empty translation so the line and history
            // stay complete, plus a non-fatal error event.
            if (job.segmentId === latestSegmentId) {
              opts.onEvent({
                type: "final",
                segmentId: job.segmentId,
                sourceText: job.sourceText,
                translatedText: "",
                startTimeMs: job.startTimeMs,
                endTimeMs: job.endTimeMs,
                ...(job.speakerId !== undefined ? { speakerId: job.speakerId } : {}),
              });
              opts.onEvent({
                type: "error",
                code: "translation_failed",
                message: toError(error).message,
              });
            }
            continue;
          }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- pipelineSubtitleSource`
Expected: PASS — new test green; the existing latest-wins/drain tests still green.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/realtime/pipelineSubtitleSource.ts apps/backend/src/realtime/pipelineSubtitleSource.test.ts
git commit -m "fix(backend): translation failure is non-fatal, keeps the session alive

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Reset ASR audio sequence on every (re)connect (#10)

**Files:**
- Modify: `apps/backend/src/providers/volcengineSpeechProvider.ts` (`open()` — the `reconnectOpts.initialize` callback)
- Test: `apps/backend/src/providers/volcengineSpeechProvider.test.ts` (extend)

**Interfaces:**
- No signature change. New behavior: each connection's first audio frame is sequence 2.

- [ ] **Step 1: Write the failing test**

Add to `volcengineSpeechProvider.test.ts` (reuse the fake-connect + `setTimer` harness from the existing "re-sends the config frame…" test, and import `encodeAudioRequest` from `./volcengineAsrProtocol.js`):

```ts
  it("resets the audio sequence to 2 on the reconnected stream", () => {
    const sockets: Array<{ cb: any; sent: Buffer[] }> = [];
    const connect = (_opts: any, cb: any) => {
      const s = { cb, sent: [] as Buffer[] };
      sockets.push(s);
      return { send: (d: Buffer) => s.sent.push(d), close: () => {} };
    };
    let fireTimer: () => void = () => {};
    const provider = new VolcengineSpeechProvider(CONFIG, connect, {
      setTimer: (fn) => { fireTimer = fn; },
    });
    const stream = provider.open({ onSegment: () => {} });

    // Go live on the first connection and advance the counter.
    sockets[0]!.cb.onMessage(SOME_SERVER_MESSAGE); // adapt: whatever flips withReconnect to "live"
    const audio = Buffer.from([1, 2, 3, 4]);
    stream.pushFrame({ data: audio, sequenceNumber: 0, timestampMs: 0 }); // seq 2 on conn 0
    stream.pushFrame({ data: audio, sequenceNumber: 1, timestampMs: 100 }); // seq 3 on conn 0

    // Drop and reconnect.
    sockets[0]!.cb.onClose(1006, "abnormal");
    fireTimer();
    sockets[1]!.cb.onMessage(SOME_SERVER_MESSAGE); // go live on the new connection

    // First audio frame after reconnect must be sequence 2, not a continued value.
    stream.pushFrame({ data: audio, sequenceNumber: 2, timestampMs: 200 });

    const audioFramesOnConn1 = sockets[1]!.sent.slice(1); // index 0 is the re-sent config frame
    expect(audioFramesOnConn1[0]).toEqual(encodeAudioRequest(audio, 2, false));
  });
```

> `SOME_SERVER_MESSAGE` and the exact `cb` method names (`onMessage`/`onClose`) must match the file's existing reconnect test and the `ReconnectOptions`/connect-callback contract. Read the existing "re-sends the config frame…" test and `reconnectingTransport.ts` to get the callback shape and what flips the transport to "live" (sending audio requires the live state). If flipping live in a unit test is awkward, instead assert on the buffer equality after the minimal steps the existing harness already supports — the fixed requirement is: **the first audio frame sent on `sockets[1]` equals `encodeAudioRequest(audio, 2, false)`**.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- volcengineSpeechProvider`
Expected: FAIL — without the reset, the reconnected frame carries a continued sequence (e.g. 4+), so it does not equal the seq-2 encoding.

- [ ] **Step 3: Implement**

In `open()`, change the `initialize` in `reconnectOpts` to reset the counter first:

```ts
      initialize: (t) => {
        // Each connection numbers audio from scratch: config is sequence 1, so
        // the first audio frame is 2. Without this, a reconnect keeps the prior
        // connection's counter (advanced even by frames dropped mid-reconnect),
        // producing a mis-sequenced stream the server rejects.
        sequence = 1;
        t.send(configFrame);
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- volcengineSpeechProvider`
Expected: PASS — new test green; the existing "re-sends the config frame", drain, and lifecycle tests still green.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/providers/volcengineSpeechProvider.ts apps/backend/src/providers/volcengineSpeechProvider.test.ts
git commit -m "fix(backend): reset ASR audio sequence on reconnect

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Reconciler dedupes by utterance boundary, not text (#11)

**Files:**
- Modify: `apps/backend/src/providers/utteranceReconciler.ts`
- Test: `apps/backend/src/providers/utteranceReconciler.test.ts` (extend)

**Interfaces:**
- No signature change. New behavior: a repeated sentence at a later `start_time` emits a new final.

- [ ] **Step 1: Write the failing test**

Add to `utteranceReconciler.test.ts`:

```ts
  it("emits a second final when the same text is spoken again at a later time", () => {
    const r = new UtteranceReconciler();
    r.reconcile([{ text: "好的。", definite: true, start_time: 0, end_time: 500 }]);
    expect(
      r.reconcile([{ text: "好的。", definite: true, start_time: 600, end_time: 1100 }]),
    ).toEqual([
      { kind: "final", segmentId: "seg-2", text: "好的。", startTimeMs: 600, endTimeMs: 1100 },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- utteranceReconciler`
Expected: FAIL — the current text-equality dedup drops the repeated "好的。".

- [ ] **Step 3: Implement**

Replace the text-based dedup with a monotonic start-time guard. Change the field:

```ts
export class UtteranceReconciler {
  private ordinal = 0;
  private lastEmittedStartTime = -1;

  reconcile(utterances: VolcengineUtterance[]): SegmentEvent[] {
    const events: SegmentEvent[] = [];

    for (const utterance of utterances) {
      if (utterance.definite !== true) {
        continue;
      }
      const text = utterance.text ?? "";
      const startTimeMs = utterance.start_time ?? 0;
      // Dedupe by utterance boundary: SeedASR re-sends a confirmed sentence with
      // the same start_time, but a genuinely repeated sentence is a later VAD
      // segment with a later start_time — so a verbatim repeat still surfaces.
      if (text === "" || startTimeMs <= this.lastEmittedStartTime) {
        continue;
      }

      this.lastEmittedStartTime = startTimeMs;
      this.ordinal += 1;
      events.push({
        kind: "final",
        segmentId: `seg-${this.ordinal}`,
        text,
        startTimeMs,
        endTimeMs: utterance.end_time ?? startTimeMs,
      });
    }

    return events;
  }
}
```

> Remove the now-unused `lastFinalText` field. Note the existing "dedupes a re-sent definite sentence" test uses two utterances with no `start_time` (both default to 0): the first emits (0 > -1), the second is skipped (0 ≤ 0) — still green.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- utteranceReconciler`
Expected: PASS — new test green; all seven existing reconciler tests still green.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/providers/utteranceReconciler.ts apps/backend/src/providers/utteranceReconciler.test.ts
git commit -m "fix(backend): reconcile dedupes by utterance boundary, not text

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Fatal provider error closes the socket (#12)

**Files:**
- Modify: `apps/backend/src/realtime/session.ts` (the `onError` inside `openSource`'s `source.open({ … })`)
- Test: `apps/backend/src/realtime/session.test.ts` (extend; extend the `stubSource` helper to expose `onError`)

**Interfaces:**
- No signature change. New behavior: a runtime provider-stream `onError` closes the client socket. Factory-error paths remain untouched (socket stays open — existing tests pin this).

- [ ] **Step 1: Write the failing test**

The existing `stubSource` helper only captures `onEvent`. Extend it to also capture `onError` (add an `error: (e: Error) => void` to its return), then add a test:

```ts
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
```

Extend `stubSource` so `open` also stores `opts.onError` and the helper returns `error: (e) => onErrorCaptured?.(e)`:

```ts
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
        end: async () => { ended = true; },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- session`
Expected: FAIL — `socket.readyState` stays 1 (current `onError` calls `close()` which never closes the socket).

- [ ] **Step 3: Implement**

In `session.ts` `openSource`, change the stream's `onError`:

```ts
    this.stream = source.open({
      onEvent: (event) => {
        this.send(event);
      },
      onError: (error) => {
        this.sendError("provider_error", error.message);
        // A mid-session provider-stream failure is terminal: tear down and close
        // the client socket so it stops streaming audio into a dead session.
        // (Factory-open errors above intentionally leave the socket open.)
        void this.close().then(() => {
          this.options.socket.close();
        });
      },
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- session`
Expected: PASS — new test green; the two factory-error tests still assert `readyState === 1`, and the stop test still asserts `readyState === 3`.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/realtime/session.ts apps/backend/src/realtime/session.test.ts
git commit -m "fix(backend): close the client socket on a fatal provider-stream error

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- #1 (translation non-fatal) → Task 1. ✅
- #10 (sequence reset) → Task 2. ✅
- #11 (boundary dedup) → Task 3. ✅
- #12 (socket close on fatal) → Task 4. ✅
- Deferred #9 noted in spec, not in plan. ✅

**Placeholder scan:** No TBD/TODO. The two harness-adaptation notes (Task 1's `createFakeSpeechProvider`, Task 2's `SOME_SERVER_MESSAGE`/live-flip) are explicit "match the existing file" instructions with the fixed assertion stated, not blanks.

**Type consistency:** Task 1's emitted `final` uses the conditional-spread for the optional `speakerId` (backend `exactOptionalPropertyTypes`). Task 2 compares to `encodeAudioRequest(audio, 2, false)` (imported). Task 3 renames `lastFinalText` → `lastEmittedStartTime: number`. Task 4 extends `stubSource` to expose `error` and the `onError` callback closes the socket after `close()`.

**Ordering:** All four tasks touch disjoint files (pipelineSubtitleSource / volcengineSpeechProvider / utteranceReconciler / session) — independent, each leaves the backend package green.
