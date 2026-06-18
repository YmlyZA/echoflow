# Movie-Style Live Bilingual Subtitle Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 3 is controller-executed (interactive with the human) — do NOT dispatch it to a subagent.**

**Goal:** Make subtitles a single bounded "current line" (source live, translation a beat later) that keeps pace — by letting Volcengine VAD-segment sentences server-side and making backend translation non-blocking and latest-wins.

**Architecture:** Backend-only. The Volcengine adapter requests `result_type:"single"` + `show_utterances:true` + a short `vad_segment_duration`; the reconciler is reworked for the incremental segment model keyed on a monotonic ordinal; `RealtimeSession` delivers source events instantly and runs a single-flight, latest-wins translator so it can never back up. No protocol or extension changes.

**Tech Stack:** TypeScript (ESM, strict), Node, Vitest, the existing `ws`-backed Volcengine adapter.

**Reference:** `docs/superpowers/specs/2026-06-18-movie-subtitle-pipeline-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/src/providers/providerConfig.ts` | `VolcengineAsrConfig.vadSegmentDurationMs` + default | Modify |
| `apps/backend/src/config.ts` | Read `VOLCENGINE_ASR_VAD_MS` | Modify |
| `apps/backend/src/config.test.ts` | Cover the VAD env wiring | Modify |
| `apps/backend/src/providers/volcengineAsrProtocol.ts` | `VolcengineAsrRequestConfig` gains 3 optional fields | Modify |
| `apps/backend/src/providers/volcengineSpeechProvider.ts` | Send `result_type`/`show_utterances`/`vad` (+ debug log in Task 3) | Modify |
| `apps/backend/src/providers/volcengineSpeechProvider.test.ts` | Assert the new request config | Modify |
| `apps/backend/src/providers/utteranceReconciler.ts` | Rework for the incremental "single" model | Rewrite |
| `apps/backend/src/providers/utteranceReconciler.test.ts` | Tests for the new model | Rewrite |
| `apps/backend/src/realtime/session.ts` | Decoupled, single-flight latest-wins translation | Modify |
| `apps/backend/src/realtime/session.test.ts` | Non-blocking + latest-wins tests | Modify |
| `CLAUDE.md` | Note the streaming/segmentation + translation model | Modify |

---

## Task 1: VAD segment-duration config

**Files:**
- Modify: `apps/backend/src/providers/providerConfig.ts`
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/config.test.ts`, add a case (match the existing env-reset pattern; remember to add `VOLCENGINE_ASR_VAD_MS` to the file's env snapshot/reset list so it does not leak):

```ts
it("reads the Volcengine ASR VAD segment duration from env (default 1000)", () => {
  process.env.ECHOFLOW_ASR_PROVIDER = "volcengine";
  process.env.VOLCENGINE_ASR_APP_KEY = "app";
  process.env.VOLCENGINE_ASR_ACCESS_KEY = "secret";

  expect(createConfig().providers.asr.volcengine?.vadSegmentDurationMs).toBe(1000);

  process.env.VOLCENGINE_ASR_VAD_MS = "800";
  expect(createConfig().providers.asr.volcengine?.vadSegmentDurationMs).toBe(800);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test config`
Expected: FAIL — `vadSegmentDurationMs` is undefined.

- [ ] **Step 3: Implement**

In `apps/backend/src/providers/providerConfig.ts`, add the field to `VolcengineAsrConfig` and a default constant:

```ts
export type VolcengineAsrConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
  vadSegmentDurationMs?: number;
};
```

```ts
export const DEFAULT_VOLCENGINE_ASR_VAD_MS = 1000;
```

In `apps/backend/src/config.ts`, import `DEFAULT_VOLCENGINE_ASR_VAD_MS` (add to the existing `./providers/providerConfig.js` import) and set the field inside the existing `asrProvider === "volcengine"` block:

```ts
    config.asr.volcengine = {
      appKey: process.env.VOLCENGINE_ASR_APP_KEY,
      accessKey: process.env.VOLCENGINE_ASR_ACCESS_KEY,
      resourceId:
        process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
      endpoint:
        process.env.VOLCENGINE_ASR_ENDPOINT ?? DEFAULT_VOLCENGINE_ASR_ENDPOINT,
      vadSegmentDurationMs: readVadSegmentDurationMs(process.env.VOLCENGINE_ASR_VAD_MS),
    };
```

Add this helper near the bottom of `config.ts` (next to `readPort`):

```ts
function readVadSegmentDurationMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_VOLCENGINE_ASR_VAD_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid VOLCENGINE_ASR_VAD_MS value: ${value}`);
  }
  return parsed;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test config`
Expected: PASS.

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/providerConfig.ts apps/backend/src/config.ts apps/backend/src/config.test.ts
git commit -m "feat(backend): add VOLCENGINE_ASR_VAD_MS config"
```

---

## Task 2: Send the segmentation request fields

**Files:**
- Modify: `apps/backend/src/providers/volcengineAsrProtocol.ts` (the `VolcengineAsrRequestConfig` type)
- Modify: `apps/backend/src/providers/volcengineSpeechProvider.ts` (`buildRequestConfig` + its call site)
- Modify: `apps/backend/src/providers/volcengineSpeechProvider.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/providers/volcengineSpeechProvider.test.ts`, add `gunzipSync` to the `node:zlib` import (it already imports `gzipSync`), and add this case inside the `describe("VolcengineSpeechProvider", …)` block:

```ts
  it("requests incremental VAD-segmented results in the full client request", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(
      { ...CONFIG, vadSegmentDurationMs: 800 },
      transport.factory,
    );
    provider.open({ onSegment: () => {} });

    const frame = transport.sent[0]!;
    const size = frame.readUInt32BE(8);
    const config = JSON.parse(gunzipSync(frame.subarray(12, 12 + size)).toString("utf8"));
    expect(config.request).toEqual({
      model_name: "bigmodel",
      enable_punc: true,
      result_type: "single",
      show_utterances: true,
      vad_segment_duration: 800,
    });
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test volcengineSpeechProvider`
Expected: FAIL — `request` lacks the new fields (and `vad_segment_duration` is absent).

- [ ] **Step 3: Implement**

In `apps/backend/src/providers/volcengineAsrProtocol.ts`, extend `VolcengineAsrRequestConfig`:

```ts
export type VolcengineAsrRequestConfig = {
  user: { uid: string };
  audio: {
    format: string;
    sample_rate: number;
    bits: number;
    channel: number;
    codec: string;
  };
  request: {
    model_name: string;
    enable_punc: boolean;
    result_type?: string;
    show_utterances?: boolean;
    vad_segment_duration?: number;
  };
};
```

In `apps/backend/src/providers/volcengineSpeechProvider.ts`:

Add the default import at the top (alongside the existing `VolcengineAsrConfig` import):

```ts
import {
  DEFAULT_VOLCENGINE_ASR_VAD_MS,
  type VolcengineAsrConfig,
} from "./providerConfig.js";
```

Change `buildRequestConfig` to take a `vadMs` argument and emit the fields:

```ts
function buildRequestConfig(uid: string, vadMs: number): VolcengineAsrRequestConfig {
  return {
    user: { uid },
    audio: { format: "pcm", sample_rate: 16000, bits: 16, channel: 1, codec: "raw" },
    request: {
      model_name: "bigmodel",
      enable_punc: true,
      result_type: "single",
      show_utterances: true,
      vad_segment_duration: vadMs,
    },
  };
}
```

Update its call site in `open()` (the `transport.send(encodeFullClientRequest(...))` line):

```ts
    transport.send(
      encodeFullClientRequest(
        buildRequestConfig(
          requestId,
          this.config.vadSegmentDurationMs ?? DEFAULT_VOLCENGINE_ASR_VAD_MS,
        ),
      ),
    );
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test volcengineSpeechProvider`
Expected: PASS (the new case + the existing 6).

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/volcengineAsrProtocol.ts apps/backend/src/providers/volcengineSpeechProvider.ts apps/backend/src/providers/volcengineSpeechProvider.test.ts
git commit -m "feat(backend): request incremental VAD-segmented ASR results"
```

---

## Task 3: Capture real `result_type:"single"` frames (CONTROLLER-EXECUTED, interactive)

**This task is run by the controller together with the human — NOT a subagent.** Its purpose is to confirm the exact frame shape SeedASR emits under `result_type:"single"` before the reconciler (Task 4) is finalized.

**Files:**
- Modify (temporary): `apps/backend/src/providers/volcengineSpeechProvider.ts`

- [ ] **Step 1: Add a temporary debug log**

In `volcengineSpeechProvider.ts`, inside the transport `onMessage` handler, right after `message = parseServerMessage(data);` succeeds and before the `message.type === "error"` check, add:

```ts
          if (process.env.ECHOFLOW_ASR_DEBUG === "1" && message.type === "response") {
            console.log("[asr-debug]", JSON.stringify(message.payload));
          }
```

- [ ] **Step 2: Run a short real session and capture frames**

Restart the backend with `ECHOFLOW_ASR_DEBUG=1` and the real ASR env, have the human play ~10–20 s of clear speech through the extension, and collect the `[asr-debug]` lines from the backend log.

- [ ] **Step 3: Record findings**

Note, from the captured frames: (a) how many entries `result.utterances` has per frame under `single`, (b) whether the index resets per sentence, (c) how/when `definite` appears, (d) field names actually present (`text`, `definite`, `start_time`, `end_time`). These adjust the Task 4 fixtures if reality differs from the documented model.

- [ ] **Step 4: Remove the debug log and commit the removal (leave the tree clean)**

Revert the `[asr-debug]` line so `volcengineSpeechProvider.ts` matches its Task 2 state.

Run: `git diff --stat apps/backend/src/providers/volcengineSpeechProvider.ts`
Expected: no output (file unchanged from the committed Task 2 version).

(No commit needed if the file is unchanged. If a commit was made to add the log, commit its removal too.)

---

## Task 4: Reconciler for the incremental "single" model

**Files:**
- Rewrite: `apps/backend/src/providers/utteranceReconciler.ts`
- Rewrite: `apps/backend/src/providers/utteranceReconciler.test.ts`

The reconciler keeps the same public surface — `reconcile(utterances: VolcengineUtterance[]): SegmentEvent[]` — so `volcengineSpeechProvider.ts` is untouched. Only the internal model changes: segment identity comes from a monotonic ordinal advanced on `definite` transitions, not the Volcengine utterance index.

> **Adjust the fixtures below to the frames captured in Task 3 if they differ** (e.g., if a frame carries multiple utterances, or the index does not reset). The logic keys off "the active (last) utterance in the frame," which holds for either shape.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `apps/backend/src/providers/utteranceReconciler.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { UtteranceReconciler } from "./utteranceReconciler.js";

describe("UtteranceReconciler (incremental single model)", () => {
  it("emits a growing partial for the active sentence", () => {
    const reconciler = new UtteranceReconciler();
    expect(reconciler.reconcile([{ text: "hello", start_time: 0 }])).toEqual([
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0 },
    ]);
    expect(reconciler.reconcile([{ text: "hello world", start_time: 0 }])).toEqual([
      { kind: "partial", segmentId: "seg-1", text: "hello world", startTimeMs: 0 },
    ]);
  });

  it("dedupes an unchanged partial", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello" }]);
    expect(reconciler.reconcile([{ text: "hello" }])).toEqual([]);
  });

  it("emits one final when the sentence becomes definite", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello world" }]);
    expect(
      reconciler.reconcile([
        { text: "hello world", definite: true, start_time: 0, end_time: 800 },
      ]),
    ).toEqual([
      { kind: "final", segmentId: "seg-1", text: "hello world", startTimeMs: 0, endTimeMs: 800 },
    ]);
  });

  it("does not re-emit a definite sentence that is re-sent", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hi", definite: true, end_time: 500 }]);
    expect(
      reconciler.reconcile([{ text: "hi", definite: true, end_time: 500 }]),
    ).toEqual([]);
  });

  it("starts a new monotonic segment for the next sentence", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "first", definite: true, start_time: 0, end_time: 500 }]);
    expect(reconciler.reconcile([{ text: "second", start_time: 1000 }])).toEqual([
      { kind: "partial", segmentId: "seg-2", text: "second", startTimeMs: 1000 },
    ]);
    expect(
      reconciler.reconcile([
        { text: "second", definite: true, start_time: 1000, end_time: 1600 },
      ]),
    ).toEqual([
      { kind: "final", segmentId: "seg-2", text: "second", startTimeMs: 1000, endTimeMs: 1600 },
    ]);
  });

  it("handles a sentence that arrives already definite", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "one", definite: true, end_time: 300 }]);
    expect(
      reconciler.reconcile([{ text: "two", definite: true, start_time: 400, end_time: 700 }]),
    ).toEqual([
      { kind: "final", segmentId: "seg-2", text: "two", startTimeMs: 400, endTimeMs: 700 },
    ]);
  });

  it("uses the last utterance when a frame carries several", () => {
    const reconciler = new UtteranceReconciler();
    expect(
      reconciler.reconcile([
        { text: "earlier", definite: true },
        { text: "current", start_time: 100 },
      ]),
    ).toEqual([
      { kind: "partial", segmentId: "seg-1", text: "current", startTimeMs: 100 },
    ]);
  });

  it("returns nothing for an empty frame", () => {
    const reconciler = new UtteranceReconciler();
    expect(reconciler.reconcile([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test utteranceReconciler`
Expected: FAIL — the current index-keyed reconciler produces different output (e.g., wrong segment ids / re-emits).

- [ ] **Step 3: Implement**

Replace the entire contents of `apps/backend/src/providers/utteranceReconciler.ts` with:

```ts
import type { SegmentEvent } from "./types.js";
import type { VolcengineUtterance } from "./volcengineAsrProtocol.js";

// Under result_type:"single" each frame carries only the current sentence
// (previous ones are dropped), so segment identity cannot come from the vendor
// utterance index. We advance a monotonic ordinal on each definite transition.
export class UtteranceReconciler {
  private ordinal = 0;
  private finalized = false;
  private lastText = "";

  reconcile(utterances: VolcengineUtterance[]): SegmentEvent[] {
    const active = utterances[utterances.length - 1];
    if (active === undefined) {
      return [];
    }

    const text = active.text ?? "";
    const startTimeMs = active.start_time ?? 0;
    const isDefinite = active.definite === true;

    // A re-sent definite sentence (same text after we already finalized) is a
    // no-op.
    if (this.finalized && isDefinite && text === this.lastText) {
      return [];
    }

    // Begin a new segment at session start, or when fresh content arrives after
    // the previous sentence finalized.
    if (this.ordinal === 0 || this.finalized) {
      this.ordinal += 1;
      this.finalized = false;
      this.lastText = "";
    }

    const segmentId = `seg-${this.ordinal}`;

    if (isDefinite) {
      this.finalized = true;
      this.lastText = text;
      return [
        {
          kind: "final",
          segmentId,
          text,
          startTimeMs,
          endTimeMs: active.end_time ?? startTimeMs,
        },
      ];
    }

    if (text === this.lastText) {
      return [];
    }
    this.lastText = text;
    return [{ kind: "partial", segmentId, text, startTimeMs }];
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test utteranceReconciler`
Expected: PASS (all eight cases).

Run: `pnpm --filter @echoflow/backend test volcengineSpeechProvider`
Expected: still PASS — the provider's `language`-then-segments test must still hold (the provider feeds `reconcile(message.payload.result?.utterances ?? [])`; with the existing provider test fixtures — single-utterance frames going partial→definite — the new reconciler emits the same partial then final for `seg-1`).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/utteranceReconciler.ts apps/backend/src/providers/utteranceReconciler.test.ts
git commit -m "feat(backend): reconcile incremental single-mode ASR segments"
```

---

## Task 5: Decoupled, single-flight latest-wins translation

**Files:**
- Modify: `apps/backend/src/realtime/session.ts`
- Modify: `apps/backend/src/realtime/session.test.ts`

Source events (`language`/`partial`) deliver immediately and in order; finals run through a single-flight, latest-wins translator that emits a `final` only if its segment is still the latest — so the pipeline can never accumulate a translation backlog.

- [ ] **Step 1: Write the failing tests**

In `apps/backend/src/realtime/session.test.ts`, add two cases (reuse the file's existing fake-socket / stub-provider helpers; read the file first to match their names — the snippets below assume a `createFakeSocket`-style helper exposing the events sent to the socket, and a stub speech provider whose `open({onSegment})` returns a stream and lets the test drive `onSegment`. Adapt names to what the file actually defines, and import `vi` if needed):

```ts
it("delivers partials without waiting on a slow translation", async () => {
  // A translation provider that never resolves must not block partial delivery.
  const neverResolves = { translate: () => new Promise<string>(() => {}), close: () => {} };
  const { session, socket, emitSegment } = makeSession({ translationProvider: neverResolves });
  session.start();
  startSession(socket); // deliver a `start` control message the way other tests do

  emitSegment({ kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0 });

  await vi.waitFor(() => {
    expect(sentEvents(socket)).toContainEqual(
      expect.objectContaining({ type: "partial", segmentId: "seg-1", sourceText: "hello" }),
    );
  });
});

it("drops a stale final's translation when a newer segment has arrived", async () => {
  let resolveFirst: (value: string) => void = () => {};
  const calls: string[] = [];
  const translationProvider = {
    translate: (input: { text: string }) => {
      calls.push(input.text);
      if (calls.length === 1) {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(`[zh] ${input.text}`);
    },
    close: () => {},
  };
  const { session, socket, emitSegment } = makeSession({ translationProvider });
  session.start();
  startSession(socket);

  emitSegment({ kind: "final", segmentId: "seg-1", text: "one", startTimeMs: 0, endTimeMs: 1 });
  // A newer segment arrives while seg-1 is still translating.
  emitSegment({ kind: "partial", segmentId: "seg-2", text: "two", startTimeMs: 2 });
  resolveFirst("[zh] one"); // seg-1 translation resolves AFTER seg-2 became latest

  await vi.waitFor(() => {
    expect(sentEvents(socket)).toContainEqual(
      expect.objectContaining({ type: "partial", segmentId: "seg-2" }),
    );
  });
  // seg-1's final is stale and must NOT be emitted.
  expect(
    sentEvents(socket).some((event) => event.type === "final" && event.segmentId === "seg-1"),
  ).toBe(false);
});
```

If the existing suite has no helper that injects segment events directly, add a minimal stub speech provider in the test whose `open(opts)` stores `opts.onSegment` so the test can call it (`emitSegment`), mirroring the existing translation-error test added in the Volcengine ASR plan.

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm --filter @echoflow/backend test session`
Expected: FAIL — the current `dispatchSegment` awaits translation inside the ordered `tail`, so a never-resolving translation blocks the partial, and stale finals are not dropped.

- [ ] **Step 3: Implement**

In `apps/backend/src/realtime/session.ts`, add fields to the class (next to `tail`):

```ts
  private latestSegmentId: string | undefined;
  private pendingFinal:
    | { segmentId: string; sourceText: string; startTimeMs: number; endTimeMs: number }
    | undefined;
  private translating = false;
```

Replace `enqueueSegment` and `dispatchSegment` with the following methods:

```ts
  private enqueueSegment(event: SegmentEvent): void {
    if (event.kind === "partial" || event.kind === "final") {
      this.latestSegmentId = event.segmentId;
    }

    if (event.kind === "final") {
      this.pendingFinal = {
        segmentId: event.segmentId,
        sourceText: event.text,
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
      };
      void this.drainTranslations();
      return;
    }

    // language + partial: ordered, immediate, never blocked by translation.
    this.tail = this.tail
      .then(() => {
        this.dispatchImmediate(event);
      })
      .catch((error: unknown) => {
        this.sendError(getErrorCode(error), getErrorMessage(error));
      });
  }

  private dispatchImmediate(event: SegmentEvent): void {
    if (event.kind === "language") {
      this.sourceLanguage = event.sourceLanguage;
      this.send({
        type: "language",
        sourceLanguage: event.sourceLanguage,
        targetLanguage: this.targetLanguage,
      });
      return;
    }
    if (event.kind === "partial") {
      this.send({
        type: "partial",
        segmentId: event.segmentId,
        sourceText: event.text,
      });
    }
  }

  private async drainTranslations(): Promise<void> {
    if (this.translating) {
      return;
    }
    this.translating = true;
    try {
      while (this.pendingFinal !== undefined) {
        const job = this.pendingFinal;
        this.pendingFinal = undefined;

        let translatedText: string;
        try {
          translatedText = await this.options.translationProvider.translate({
            text: job.sourceText,
            sourceLanguage: this.sourceLanguage,
            targetLanguage: this.targetLanguage,
          });
        } catch (error: unknown) {
          this.sendError(getErrorCode(error), getErrorMessage(error));
          continue;
        }

        if (this.closed) {
          return;
        }
        // Latest-wins: only show this final if no newer segment has appeared.
        if (job.segmentId === this.latestSegmentId) {
          this.send({
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
      this.translating = false;
    }
  }
```

Note: `openStream`'s `onSegment` already calls `this.enqueueSegment(event)`, so no change is needed there. The `stop` path still does `await this.stream.end(); await this.tail; await this.close();` — in-flight translation is intentionally not awaited (consistent with the existing "no drain on stop" limitation).

- [ ] **Step 4: Run them to confirm they pass**

Run: `pnpm --filter @echoflow/backend test session`
Expected: PASS (new cases + all existing session tests, including the provider-error test). Finals are now emitted from the async worker rather than the `tail` chain, so any existing test that asserted a `final` event right after driving it may need to wrap the assertion in `await vi.waitFor(...)`; update those (the behavior — a translated `final` for the latest segment — is unchanged).

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/realtime/session.ts apps/backend/src/realtime/session.test.ts
git commit -m "feat(backend): non-blocking latest-wins subtitle translation"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`, in the "Backend request flow" paragraph, replace the per-frame description so it reflects the new model. Change the clause describing the speech→translate flow to:

```
For each audio frame the streaming `speechProvider` emits `language`/`partial`/`final` segment events; `language`/`partial` are sent immediately, and each `final` is translated by a single-flight, latest-wins worker that emits the translated `final` only if its segment is still the latest (so translation never backs up). The Volcengine adapter requests `result_type:"single"` + `show_utterances` + `vad_segment_duration` so sentences are VAD-segmented server-side into a bounded current line.
```

Keep the rest of the paragraph (providers split, config precedence, etc.) intact.

- [ ] **Step 2: Commit the docs**

```bash
git add CLAUDE.md
git commit -m "docs: note VAD segmentation and latest-wins translation"
```

- [ ] **Step 3: Full workspace verification**

Run: `pnpm test`
Expected: all packages green.

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: all succeed.

- [ ] **Step 4: Manual e2e (record outcome)**

With the real ASR + translation env, restart the backend and run a session through the extension on a non-Chinese video. Confirm:
- The source line is a **bounded current sentence** that resets per pause (no longer grows unbounded).
- The Chinese translation appears a beat after each sentence and **keeps pace** (no longer falls progressively behind).

Tune `VOLCENGINE_ASR_VAD_MS` (e.g. 800–1200) if the line changes too fast/slow.

---

## Notes

- Backend-only: no protocol or extension changes. The reducer/overlay already render a single replaceable current line.
- Out of scope (per spec): translating partials, backend↔Volcengine auto-reconnect / `end()` drain, exposing VAD in the extension UI.
