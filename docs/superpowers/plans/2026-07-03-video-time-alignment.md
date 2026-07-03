# Capture → Video-Time Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor every recorded final to the video's playback position (`videoStartSec`/`videoEndSec`), computed accurately via wall-clock correlation, so a transcript can be looked up by video time.

**Architecture:** The content script samples `video.currentTime` → background; the offscreen reports `captureStartedAtMs` on `SESSION_STARTED`; the background correlates each final's spoken wall-clock (`captureStartedAtMs + startTimeMs`) against a bounded `videoTimeIndex` and stores the resulting video times on the history segment. No wire-protocol change — all new data rides the internal bus + history record.

**Tech Stack:** TypeScript (ESM), WXT + React 19 extension, Dexie, Vitest.

## Global Constraints

- All work in `apps/extension` (+ docs). No `packages/protocol` or `apps/backend` change.
- Extension tsconfig is `strict` but NOT `exactOptionalPropertyTypes` — but keep using the conditional-spread pattern for optional fields (matches the codebase).
- `VIDEO_TIME_SAMPLE` is high-frequency (~4 Hz): the background handles it synchronously in the listener (tab-associated, off the serial queue), NOT via `enqueueMessage`.
- Samples are associated by `sender.tab?.id === sessionState.tabId` (content-script messages carry `sender.tab`); the sample message itself needs no `localSessionId`.
- After each task, the extension package's `typecheck` + `test` stay green.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `videoTimeIndex` — bounded sample ring with nearest lookup

**Files:**
- Create: `apps/extension/src/subtitles/videoTimeIndex.ts`
- Test: `apps/extension/src/subtitles/videoTimeIndex.test.ts`

**Interfaces:**
- Produces: `createVideoTimeIndex(opts?: { maxSamples?: number; toleranceMs?: number }) => { addSample(wallClockMs: number, videoSec: number): void; lookup(wallClockMs: number): number | undefined; reset(): void }`. `lookup` returns the nearest sample's `videoSec` when the closest sample is within `toleranceMs` (default 1000), else `undefined`. Ring keeps the newest `maxSamples` (default 1200).

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/subtitles/videoTimeIndex.test.ts
import { describe, expect, it } from "vitest";
import { createVideoTimeIndex } from "./videoTimeIndex";

describe("createVideoTimeIndex", () => {
  it("returns the nearest sample within tolerance", () => {
    const idx = createVideoTimeIndex({ toleranceMs: 1000 });
    idx.addSample(1000, 10);
    idx.addSample(1250, 10.25);
    idx.addSample(1500, 10.5);
    expect(idx.lookup(1240)).toBe(10.25); // closest to 1250
    expect(idx.lookup(1000)).toBe(10);
  });

  it("returns undefined when the nearest sample is beyond tolerance or empty", () => {
    const idx = createVideoTimeIndex({ toleranceMs: 500 });
    expect(idx.lookup(1000)).toBeUndefined(); // empty
    idx.addSample(1000, 10);
    expect(idx.lookup(3000)).toBeUndefined(); // 2000ms away > 500 tolerance
  });

  it("resolves a seek to the nearest wall-clock sample, not an interpolation across the jump", () => {
    const idx = createVideoTimeIndex({ toleranceMs: 1000 });
    idx.addSample(1000, 10); // playing at 10s
    idx.addSample(1250, 90); // user seeked to 90s at wall-clock 1250
    expect(idx.lookup(1240)).toBe(90); // nearest is the post-seek sample, not ~50
    expect(idx.lookup(1010)).toBe(10);
  });

  it("evicts oldest beyond maxSamples", () => {
    const idx = createVideoTimeIndex({ maxSamples: 2, toleranceMs: 100000 });
    idx.addSample(1000, 1);
    idx.addSample(2000, 2);
    idx.addSample(3000, 3); // evicts the 1000 sample
    expect(idx.lookup(1000)).toBe(2); // 1000 gone; nearest kept is 2000 -> 2
    expect(idx.lookup(3000)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- videoTimeIndex`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/extension/src/subtitles/videoTimeIndex.ts

interface Sample {
  wallClockMs: number;
  videoSec: number;
}

/**
 * A bounded ring of (wall-clock, video-position) samples with a nearest-sample
 * lookup. Used to turn a final's spoken wall-clock into the video position where
 * it was heard. Nearest (not interpolation) is deliberate: interpolating across a
 * seek would invent a position between two discontinuous samples. Only recent
 * samples matter (finals arrive within seconds of being spoken), so the ring is
 * small and evicts the oldest.
 */
export function createVideoTimeIndex(opts: { maxSamples?: number; toleranceMs?: number } = {}): {
  addSample(wallClockMs: number, videoSec: number): void;
  lookup(wallClockMs: number): number | undefined;
  reset(): void;
} {
  const maxSamples = opts.maxSamples ?? 1200;
  const toleranceMs = opts.toleranceMs ?? 1000;
  let samples: Sample[] = [];

  return {
    addSample(wallClockMs: number, videoSec: number): void {
      samples.push({ wallClockMs, videoSec });
      if (samples.length > maxSamples) {
        samples = samples.slice(samples.length - maxSamples);
      }
    },
    lookup(wallClockMs: number): number | undefined {
      let best: Sample | undefined;
      let bestDelta = Infinity;
      for (const sample of samples) {
        const delta = Math.abs(sample.wallClockMs - wallClockMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = sample;
        }
      }
      if (best === undefined || bestDelta > toleranceMs) {
        return undefined;
      }
      return best.videoSec;
    },
    reset(): void {
      samples = [];
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- videoTimeIndex`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/subtitles/videoTimeIndex.ts apps/extension/src/subtitles/videoTimeIndex.test.ts
git commit -m "feat(extension): videoTimeIndex — nearest-sample wall-clock to video-time lookup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Runtime messages — `VIDEO_TIME_SAMPLE` + `captureStartedAtMs`

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts`
- Test: `apps/extension/src/messaging/messages.test.ts`

**Interfaces:**
- Produces: `VideoTimeSampleMessage { type: "VIDEO_TIME_SAMPLE"; wallClockMs: number; videoSec: number }` in the `RuntimeMessage` union + `isRuntimeMessage`; `SessionStartedMessage` gains `captureStartedAtMs?: number`.

- [ ] **Step 1: Write the failing test**

```ts
  it("accepts a VIDEO_TIME_SAMPLE message", () => {
    expect(
      isRuntimeMessage({ type: "VIDEO_TIME_SAMPLE", wallClockMs: 1000, videoSec: 12.5 })
    ).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to the `RuntimeMessage` union: `| VideoTimeSampleMessage`. Add the interface:

```ts
export interface VideoTimeSampleMessage {
  type: "VIDEO_TIME_SAMPLE";
  wallClockMs: number;
  videoSec: number;
}
```

Add `"VIDEO_TIME_SAMPLE"` to the `isRuntimeMessage` type array. Add the optional field to `SessionStartedMessage`:

```ts
export interface SessionStartedMessage {
  type: "SESSION_STARTED";
  localSessionId: string;
  remoteSessionId?: string;
  captureStartedAtMs?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/messaging/messages.ts apps/extension/src/messaging/messages.test.ts
git commit -m "feat(extension): VIDEO_TIME_SAMPLE message + captureStartedAtMs on SESSION_STARTED

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: History segment carries optional video times

**Files:**
- Modify: `apps/extension/src/history/historyStore.ts` (`HistorySegmentRecord`, `AppendableSubtitleSegment`)
- Modify: `apps/extension/src/history/segmentMapping.ts` (`finalEventToSegment` optional args)
- Test: `apps/extension/src/history/segmentMapping.test.ts` + `historyStore.test.ts` (extend)

**Interfaces:**
- Produces: `HistorySegmentRecord = SubtitleSegment & { videoStartSec?: number; videoEndSec?: number }`; `finalEventToSegment` accepts optional `videoStartSec`/`videoEndSec` and spreads them onto the result.

- [ ] **Step 1: Write the failing test**

Add to `segmentMapping.test.ts`:

```ts
  it("carries video times onto the segment when supplied", () => {
    const segment = finalEventToSegment({
      localSessionId: "local-1",
      event: {
        type: "final", segmentId: "e1:seg-1", sourceText: "hi", translatedText: "你好",
        startTimeMs: 0, endTimeMs: 500,
      },
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      videoStartSec: 42.0,
      videoEndSec: 42.5,
    });
    expect(segment.videoStartSec).toBe(42.0);
    expect(segment.videoEndSec).toBe(42.5);
  });

  it("omits video times when not supplied", () => {
    const segment = finalEventToSegment({
      localSessionId: "local-1",
      event: {
        type: "final", segmentId: "e1:seg-1", sourceText: "hi", translatedText: "你好",
        startTimeMs: 0, endTimeMs: 500,
      },
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(segment.videoStartSec).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- segmentMapping`
Expected: FAIL — the args type rejects `videoStartSec`, and the field is absent on the result.

- [ ] **Step 3: Implement**

In `historyStore.ts`, change the record + appendable types:

```ts
export type HistorySegmentRecord = SubtitleSegment & {
  videoStartSec?: number;
  videoEndSec?: number;
};

export type AppendableSubtitleSegment =
  | HistorySegmentRecord
  | (Omit<SubtitleSegment, "status"> & { status: "partial" });
```

In `segmentMapping.ts`, add the optional args and spread them; return `HistorySegmentRecord`:

```ts
import {
  makeFinalSegment,
  type FinalSubtitleEvent,
} from "@echoflow/protocol";
import type { HistorySegmentRecord } from "./historyStore";

export function finalEventToSegment(args: {
  localSessionId: string;
  event: FinalSubtitleEvent;
  sourceLanguage: string;
  targetLanguage: string;
  videoStartSec?: number;
  videoEndSec?: number;
}): HistorySegmentRecord {
  return {
    ...makeFinalSegment({
      sessionId: args.localSessionId,
      segmentId: args.event.segmentId,
      startTimeMs: args.event.startTimeMs,
      endTimeMs: args.event.endTimeMs,
      sourceLanguage: args.sourceLanguage,
      targetLanguage: args.targetLanguage,
      sourceText: args.event.sourceText,
      translatedText: args.event.translatedText,
      ...(args.event.speakerId !== undefined ? { speakerId: args.event.speakerId } : {}),
    }),
    ...(args.videoStartSec !== undefined ? { videoStartSec: args.videoStartSec } : {}),
    ...(args.videoEndSec !== undefined ? { videoEndSec: args.videoEndSec } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- segmentMapping historyStore`
Expected: PASS — new mapping tests green; existing history/mapping tests still green (video fields are additive/optional).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/history/historyStore.ts apps/extension/src/history/segmentMapping.ts apps/extension/src/history/segmentMapping.test.ts apps/extension/src/history/historyStore.test.ts
git commit -m "feat(extension): history segment carries optional video-time fields

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Content script samples the video timeline

**Files:**
- Modify: `apps/extension/entrypoints/content.tsx`

**Interfaces:**
- Consumes: `VideoTimeSampleMessage` shape (Task 2).
- Produces: entrypoint wiring — a `useEffect` in `EchoFlowMount` that samples the page video and sends `VIDEO_TIME_SAMPLE`.

- [ ] **Step 1: Add a video-sampling effect**

READ the current `content.tsx`. Add a new `useEffect` (deps `[]`) in `EchoFlowMount` that:
- finds the primary `<video>`: `const video = document.querySelector("video");` (re-query on each event via a helper, since the element can appear after mount);
- throttles `timeupdate` to ~4 Hz and also samples on `seeked`/`play`/`pause`, sending each as a message:

```ts
  useEffect(() => {
    const THROTTLE_MS = 250;
    let lastSentAt = 0;

    function sample(force: boolean): void {
      const video = document.querySelector("video");
      if (video === null || Number.isNaN(video.currentTime)) {
        return;
      }
      const wallClockMs = Date.now();
      if (!force && wallClockMs - lastSentAt < THROTTLE_MS) {
        return;
      }
      lastSentAt = wallClockMs;
      void chrome.runtime.sendMessage({
        type: "VIDEO_TIME_SAMPLE",
        wallClockMs,
        videoSec: video.currentTime,
      } satisfies VideoTimeSampleMessage);
    }

    const onTimeUpdate = (): void => sample(false);
    const onDiscontinuity = (): void => sample(true);

    // Listen at the document level (capture) so a <video> inserted after mount is
    // still covered without re-binding.
    document.addEventListener("timeupdate", onTimeUpdate, true);
    document.addEventListener("seeked", onDiscontinuity, true);
    document.addEventListener("play", onDiscontinuity, true);
    document.addEventListener("pause", onDiscontinuity, true);

    return () => {
      document.removeEventListener("timeupdate", onTimeUpdate, true);
      document.removeEventListener("seeked", onDiscontinuity, true);
      document.removeEventListener("play", onDiscontinuity, true);
      document.removeEventListener("pause", onDiscontinuity, true);
    };
  }, []);
```

Import `VideoTimeSampleMessage` from `../src/messaging/messages`. (`timeupdate`/`seeked`/`play`/`pause` are media events that bubble/are-capturable at the document with the `true` capture flag, so a video added later is still sampled.)

- [ ] **Step 2: Verify (entrypoint — no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — all pre-existing tests + Tasks 1-3's new tests green.

Run: `grep -n "VIDEO_TIME_SAMPLE\|timeupdate" apps/extension/entrypoints/content.tsx`
Expected: the sampling effect is present.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/entrypoints/content.tsx
git commit -m "feat(extension): content script samples the page video timeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Offscreen reports capture start; background correlates and stores

**Files:**
- Modify: `apps/extension/entrypoints/offscreen/main.ts` (record `captureStartedAtMs`, send on `SESSION_STARTED`)
- Modify: `apps/extension/entrypoints/background.ts` (video-time index, capture-start, alignment on final)

**Interfaces:**
- Consumes: `createVideoTimeIndex` (Task 1), `VideoTimeSampleMessage` + `captureStartedAtMs` (Task 2), `finalEventToSegment` video args (Task 3).
- Produces: entrypoint wiring.

- [ ] **Step 1: Offscreen — record + send `captureStartedAtMs`**

In `offscreen/main.ts` `startSession`, capture the wall-clock at pipeline start and include it on `SESSION_STARTED`:

```ts
    await client.connect();
    const captureStartedAtMs = Date.now();
    await pipeline.start();

    await chrome.runtime.sendMessage({
      type: "SESSION_STARTED",
      localSessionId: message.localSessionId,
      captureStartedAtMs
    } satisfies SessionStartedMessage);
```

(Record it immediately before `pipeline.start()` — `startTimeMs=0` corresponds to the first audio frame, which flows once the pipeline starts; the few-ms offset is negligible vs 4 Hz sampling.)

- [ ] **Step 2: Background — index, capture-start, and alignment**

In `background.ts`:

Add module state next to `sessionState`:

```ts
import { createVideoTimeIndex } from "../src/subtitles/videoTimeIndex";
// ...
const videoTimeIndex = createVideoTimeIndex();
let captureStartedAtMs: number | undefined;
```

Handle `VIDEO_TIME_SAMPLE` synchronously in the listener (tab-associated, off the serial queue), and reset per session. Update the `onMessage` listener:

```ts
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isInternalSender(sender, chrome.runtime.id)) {
      return;
    }
    if (
      isRuntimeMessage(message) &&
      message.type === "VIDEO_TIME_SAMPLE" &&
      sender.tab?.id !== undefined &&
      sessionState.status !== "idle" &&
      sender.tab.id === sessionState.tabId
    ) {
      videoTimeIndex.addSample(message.wallClockMs, message.videoSec);
      return;
    }
    if (!isRuntimeMessage(message)) {
      return;
    }
    enqueueMessage(() => handleRuntimeMessage(message));
  });
```

In `startSession`, reset the index + clear capture-start for the new session (right after the `START_CONNECTING` commit):

```ts
    videoTimeIndex.reset();
    captureStartedAtMs = undefined;
```

In `handleSessionStarted`, remember the capture-start:

```ts
    if (message.captureStartedAtMs !== undefined) {
      captureStartedAtMs = message.captureStartedAtMs;
    }
```

In `forwardServerEvent`'s `final` branch, compute video times and pass them to `finalEventToSegment`:

```ts
  if (message.event.type === "final") {
    const videoStartSec =
      captureStartedAtMs !== undefined
        ? videoTimeIndex.lookup(captureStartedAtMs + message.event.startTimeMs)
        : undefined;
    const videoEndSec =
      captureStartedAtMs !== undefined
        ? videoTimeIndex.lookup(captureStartedAtMs + message.event.endTimeMs)
        : undefined;

    await historyStore.appendSegment(
      finalEventToSegment({
        localSessionId: message.localSessionId,
        event: message.event,
        sourceLanguage: detectedSourceLanguage,
        targetLanguage: sessionState.targetLanguage,
        ...(videoStartSec !== undefined ? { videoStartSec } : {}),
        ...(videoEndSec !== undefined ? { videoEndSec } : {}),
      })
    );
  }
```

(Read the current `forwardServerEvent` to keep the surrounding `sendMessageToTab` and language-branch logic unchanged.)

- [ ] **Step 3: Verify (entrypoints — no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — full suite green (no new unit tests; the `videoTimeIndex` + mapping carry the contract).

Grep checks:

Run: `grep -n "captureStartedAtMs" apps/extension/entrypoints/offscreen/main.ts apps/extension/entrypoints/background.ts`
Expected: recorded+sent in offscreen; stored+used in background.

Run: `grep -n "videoTimeIndex\|VIDEO_TIME_SAMPLE\|videoStartSec" apps/extension/entrypoints/background.ts`
Expected: index feed, sample handling, and alignment-on-final all present.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/offscreen/main.ts apps/extension/entrypoints/background.ts
git commit -m "feat(extension): align finals to video time and store on history

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/superpowers/backlog.md` (SP1b shipped; fix `#9 → PR #TBD` to `#27`)
- Modify: `CLAUDE.md` (note `VIDEO_TIME_SAMPLE` + video-time history)

**Interfaces:** docs only.

- [ ] **Step 1: Backlog**

In `backlog.md`: change the `#9` line's `PR #TBD` to `PR #27`. Change the SP1b arc line from `⬜ **SP1b — …**` to `✅ **SP1b — capture→video-time alignment**` with a one-line description (content-script `video.currentTime` sampling → background aligns via `captureStartedAtMs + startTimeMs` → `videoStartSec`/`videoEndSec` on the history segment; nearest-sample, seek-safe).

- [ ] **Step 2: CLAUDE.md**

In the extension messaging/history section, add a sentence: the content script also samples the page `<video>`'s `currentTime` and sends `VIDEO_TIME_SAMPLE`; the background correlates each final's spoken wall-clock (`captureStartedAtMs + startTimeMs`) against a `videoTimeIndex` and stores `videoStartSec`/`videoEndSec` on the history segment (client-side only — the wire `SubtitleSegment` is unchanged).

- [ ] **Step 3: Verify + commit**

Run: `grep -n "PR #TBD" docs/superpowers/backlog.md`
Expected: no match (fixed to #27).

```bash
git add docs/superpowers/backlog.md CLAUDE.md
git commit -m "docs: SP1b shipped (video-time alignment); fix #9 PR reference; note VIDEO_TIME_SAMPLE

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `videoTimeIndex` (nearest, bounded, seek-safe) → Task 1. ✅
- `VIDEO_TIME_SAMPLE` + `captureStartedAtMs` → Task 2. ✅
- Video times on the history record (no protocol change) → Task 3. ✅
- Content-script sampling → Task 4. ✅
- Offscreen capture-start + background correlation/store → Task 5. ✅
- Docs (incl. #TBD→#27) → Task 6. ✅

**Placeholder scan:** No TBD/TODO in the plan. Task 4/5 read-the-current-file notes are explicit, with the fixed grep assertions stated.

**Type consistency:** `createVideoTimeIndex(...).lookup(wallClockMs): number | undefined` used in Task 5. `VideoTimeSampleMessage { wallClockMs, videoSec }` produced in Task 2, sent in Task 4, consumed in Task 5. `captureStartedAtMs?` on `SessionStartedMessage` set in Task 5 offscreen, read in Task 5 background. `finalEventToSegment` video args (Task 3) passed via conditional spread in Task 5. `HistorySegmentRecord` extended; `AppendableSubtitleSegment` updated to accept it.

**Ordering:** Tasks 1-3 are independent testable `src` additions. Task 4 (content) and Task 5 (offscreen+background) consume them; Task 5 depends on 1/2/3. Task 6 docs. Each task leaves the package green.
