# Scrub-Sync Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a live session, the overlay follows the video's `currentTime` — scrubbing back within the captured range shows the recorded line at that position; the live edge shows the streaming line.

**Architecture:** Two pure helpers (`subtitleTimeline`, `chooseDisplaySegment`) carry the logic; the background forwards each final's video times on the internal `SERVER_EVENT`; the content component feeds the timeline and selects live-vs-replay by `currentTime`.

**Tech Stack:** TypeScript (ESM), WXT + React 19 extension, Vitest.

## Global Constraints

- All work in `apps/extension` (+ docs). No `packages/protocol` or `apps/backend` change (the wire `ServerEvent` is unchanged; only the extension-internal `ServerEventMessage` gains optional fields).
- Extension tsconfig is `strict` but NOT `exactOptionalPropertyTypes` — keep using the conditional-spread pattern for optional fields.
- SP2 replays only the CURRENT session's captured range (cross-session load is SP3).
- After each task, the extension package's `typecheck` + `test` stay green.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `subtitleTimeline` — index finals by video time

**Files:**
- Create: `apps/extension/src/subtitles/subtitleTimeline.ts`
- Test: `apps/extension/src/subtitles/subtitleTimeline.test.ts`

**Interfaces:**
- Produces:
  - `type TimelineEntry = { videoStartSec: number; videoEndSec: number; segment: SubtitleDisplaySegment }`
  - `createSubtitleTimeline() => { add(entry: TimelineEntry): void; segmentAt(videoSec: number, holdSec?: number): TimelineEntry | undefined; maxVideoEndSec(): number | undefined; reset(): void }`. `segmentAt` returns the entry with the greatest `videoStartSec <= videoSec`, but only if `videoSec <= videoEndSec + holdSec` (default 1); else `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/subtitles/subtitleTimeline.test.ts
import { describe, expect, it } from "vitest";
import { createSubtitleTimeline } from "./subtitleTimeline";
import type { SubtitleDisplaySegment } from "./reducer";

function seg(id: string): SubtitleDisplaySegment {
  return { segmentId: id, sourceText: id, translatedText: id, status: "final" };
}

describe("createSubtitleTimeline", () => {
  it("returns the segment covering a position", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("a") });
    t.add({ videoStartSec: 3, videoEndSec: 5, segment: seg("b") });
    expect(t.segmentAt(4)?.segment.segmentId).toBe("b");
    expect(t.segmentAt(1)?.segment.segmentId).toBe("a");
  });

  it("holds the last segment briefly past its end, then clears", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("a") });
    expect(t.segmentAt(2.5, 1)?.segment.segmentId).toBe("a"); // within hold
    expect(t.segmentAt(4, 1)).toBeUndefined(); // beyond end+hold (long gap)
  });

  it("returns undefined before any entry", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 10, videoEndSec: 12, segment: seg("a") });
    expect(t.segmentAt(5)).toBeUndefined();
  });

  it("picks the latest entry starting before the position regardless of insert order", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 6, videoEndSec: 8, segment: seg("late") });
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("early") });
    expect(t.segmentAt(7)?.segment.segmentId).toBe("late");
  });

  it("tracks the max video end and resets", () => {
    const t = createSubtitleTimeline();
    expect(t.maxVideoEndSec()).toBeUndefined();
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("a") });
    t.add({ videoStartSec: 3, videoEndSec: 9, segment: seg("b") });
    expect(t.maxVideoEndSec()).toBe(9);
    t.reset();
    expect(t.maxVideoEndSec()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- subtitleTimeline`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/extension/src/subtitles/subtitleTimeline.ts
import type { SubtitleDisplaySegment } from "./reducer";

export interface TimelineEntry {
  videoStartSec: number;
  videoEndSec: number;
  segment: SubtitleDisplaySegment;
}

const DEFAULT_HOLD_SEC = 1;

/**
 * Indexes finals by video-playback time so the overlay can replay the line at a
 * scrubbed position. `segmentAt` returns the latest entry starting at or before
 * the queried time, held briefly past its end (holdSec) to bridge inter-sentence
 * gaps; a longer silence clears to undefined. Entries are not assumed sorted (a
 * mid-capture seek can reorder video-start), so lookup scans — the count is small
 * (one per sentence) and lookups are throttled.
 */
export function createSubtitleTimeline(): {
  add(entry: TimelineEntry): void;
  segmentAt(videoSec: number, holdSec?: number): TimelineEntry | undefined;
  maxVideoEndSec(): number | undefined;
  reset(): void;
} {
  let entries: TimelineEntry[] = [];

  return {
    add(entry: TimelineEntry): void {
      entries.push(entry);
    },
    segmentAt(videoSec: number, holdSec: number = DEFAULT_HOLD_SEC): TimelineEntry | undefined {
      let best: TimelineEntry | undefined;
      for (const entry of entries) {
        if (entry.videoStartSec <= videoSec) {
          if (best === undefined || entry.videoStartSec > best.videoStartSec) {
            best = entry;
          }
        }
      }
      if (best === undefined || videoSec > best.videoEndSec + holdSec) {
        return undefined;
      }
      return best;
    },
    maxVideoEndSec(): number | undefined {
      let max: number | undefined;
      for (const entry of entries) {
        if (max === undefined || entry.videoEndSec > max) {
          max = entry.videoEndSec;
        }
      }
      return max;
    },
    reset(): void {
      entries = [];
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- subtitleTimeline`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/subtitles/subtitleTimeline.ts apps/extension/src/subtitles/subtitleTimeline.test.ts
git commit -m "feat(extension): subtitleTimeline — index finals by video time for replay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `chooseDisplaySegment` — live-vs-replay decision

**Files:**
- Create: `apps/extension/src/subtitles/chooseDisplaySegment.ts`
- Test: `apps/extension/src/subtitles/chooseDisplaySegment.test.ts`

**Interfaces:**
- Produces: `chooseDisplaySegment(input: { currentTimeSec: number | null; maxCapturedVideoSec: number | null; liveSegment: SubtitleDisplaySegment | null; replaySegment: SubtitleDisplaySegment | null }): SubtitleDisplaySegment | null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/subtitles/chooseDisplaySegment.test.ts
import { describe, expect, it } from "vitest";
import { chooseDisplaySegment } from "./chooseDisplaySegment";
import type { SubtitleDisplaySegment } from "./reducer";

const live: SubtitleDisplaySegment = { segmentId: "live", sourceText: "l", translatedText: "l", status: "final" };
const replay: SubtitleDisplaySegment = { segmentId: "replay", sourceText: "r", translatedText: "r", status: "final" };

describe("chooseDisplaySegment", () => {
  it("shows the live segment when there is no video-time info yet", () => {
    expect(chooseDisplaySegment({ currentTimeSec: null, maxCapturedVideoSec: null, liveSegment: live, replaySegment: replay })).toBe(live);
    expect(chooseDisplaySegment({ currentTimeSec: 5, maxCapturedVideoSec: null, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("shows the live segment at/near the live edge", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 99, maxCapturedVideoSec: 100, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("shows the replay segment when scrubbed back", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, maxCapturedVideoSec: 100, liveSegment: live, replaySegment: replay })).toBe(replay);
  });

  it("shows nothing when scrubbed back into a gap", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, maxCapturedVideoSec: 100, liveSegment: live, replaySegment: null })).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- chooseDisplaySegment`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/extension/src/subtitles/chooseDisplaySegment.ts
import type { SubtitleDisplaySegment } from "./reducer";

// Tolerance (seconds) between the live playhead and the latest recorded final:
// within this of the captured edge, treat the user as watching live.
const EDGE_EPSILON_SEC = 2;

/**
 * Picks what the overlay shows: the live streaming line when watching at the
 * captured edge (or when there is no video-time info), the recorded line for the
 * scrubbed-back position otherwise (which may be null in a silence gap).
 */
export function chooseDisplaySegment(input: {
  currentTimeSec: number | null;
  maxCapturedVideoSec: number | null;
  liveSegment: SubtitleDisplaySegment | null;
  replaySegment: SubtitleDisplaySegment | null;
}): SubtitleDisplaySegment | null {
  if (input.currentTimeSec === null || input.maxCapturedVideoSec === null) {
    return input.liveSegment;
  }
  if (input.currentTimeSec >= input.maxCapturedVideoSec - EDGE_EPSILON_SEC) {
    return input.liveSegment;
  }
  return input.replaySegment;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- chooseDisplaySegment`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/subtitles/chooseDisplaySegment.ts apps/extension/src/subtitles/chooseDisplaySegment.test.ts
git commit -m "feat(extension): chooseDisplaySegment — live-vs-replay overlay selection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `SERVER_EVENT` message carries the final's video times

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts` (`ServerEventMessage`)
- Test: `apps/extension/src/messaging/messages.test.ts`

**Interfaces:**
- Produces: `ServerEventMessage` gains `videoStartSec?: number; videoEndSec?: number` (set only for `final` events).

- [ ] **Step 1: Write the failing test**

```ts
  it("accepts a SERVER_EVENT carrying final video times", () => {
    expect(
      isRuntimeMessage({
        type: "SERVER_EVENT",
        localSessionId: "local-1",
        mode: "pipeline",
        event: { type: "final", segmentId: "e1:seg-1", sourceText: "x", translatedText: "y", startTimeMs: 0, endTimeMs: 1 },
        videoStartSec: 12.5,
        videoEndSec: 13.0,
      })
    ).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: The runtime test passes already (guard only checks `type`), but the TYPE addition is needed for the message to compile at the send/consume sites. Confirm by proceeding — this test pins that the shape is accepted; the type change lands in Step 3. (If the test is green pre-change because the guard ignores extra fields, treat Step 3 as the real deliverable and rely on typecheck.)

- [ ] **Step 3: Implement**

Add the optional fields to `ServerEventMessage`:

```ts
export interface ServerEventMessage {
  type: "SERVER_EVENT";
  localSessionId: string;
  mode: SubtitleMode;
  event: ServerEvent;
  videoStartSec?: number;
  videoEndSec?: number;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: PASS.

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/messaging/messages.ts apps/extension/src/messaging/messages.test.ts
git commit -m "feat(extension): SERVER_EVENT carries final video times for replay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Background attaches video times to the forwarded final

**Files:**
- Modify: `apps/extension/entrypoints/background.ts` (`forwardServerEvent`)

**Interfaces:**
- Consumes: the `videoStartSec`/`videoEndSec` already computed in `forwardServerEvent`'s `final` branch (SP1b), plus the extended `ServerEventMessage` (Task 3).
- Produces: entrypoint wiring — the `SERVER_EVENT` sent to the tab carries the final's video times.

- [ ] **Step 1: Attach the video times**

READ the current `forwardServerEvent`. It already computes `videoStartSec`/`videoEndSec` for the history append (SP1b). Hoist those two `const`s so they are in scope for the `sendMessageToTab` call at the end, and include them (conditional spread) on the outgoing `SERVER_EVENT`:

```ts
  await sendMessageToTab(sessionState.tabId, {
    type: "SERVER_EVENT",
    localSessionId: message.localSessionId,
    mode: sessionState.mode,
    event: message.event,
    ...(videoStartSec !== undefined ? { videoStartSec } : {}),
    ...(videoEndSec !== undefined ? { videoEndSec } : {})
  });
```

(The `videoStartSec`/`videoEndSec` locals are only defined inside the `final` branch today; move their declaration so both the history append and this tab-send use them, defaulting to `undefined` for non-final events. Keep the language-branch and history logic otherwise unchanged.)

- [ ] **Step 2: Verify (entrypoint — no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — full suite green (Tasks 1-3's new tests + all pre-existing).

Run: `grep -n "videoStartSec" apps/extension/entrypoints/background.ts`
Expected: video times computed AND included on the forwarded `SERVER_EVENT`.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "feat(extension): forward final video times to the content overlay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Content overlay follows the video timeline

**Files:**
- Modify: `apps/extension/entrypoints/content.tsx`

**Interfaces:**
- Consumes: `createSubtitleTimeline` (Task 1), `chooseDisplaySegment` (Task 2), the extended `SERVER_EVENT` (Task 3).
- Produces: entrypoint wiring — the overlay shows the replay line when scrubbed back.

- [ ] **Step 1: Feed the timeline + track current time**

READ the full `content.tsx`. Add:

- a timeline ref: `const timelineRef = useRef(createSubtitleTimeline());` (import `createSubtitleTimeline`).
- a current-time state: `const [currentTimeSec, setCurrentTimeSec] = useState<number | null>(null);`.

In the runtime-message handler, when a `SERVER_EVENT` `final` carries `videoStartSec`/`videoEndSec`, add it to the timeline (alongside the existing `dispatchSubtitleEvent`):

```ts
      if (message.type === "SERVER_EVENT") {
        currentSessionIdRef.current = message.localSessionId;
        setHasSignal(true);
        setMode(message.mode);
        setSessionError(null);
        dispatchSubtitleEvent(message.event);
        if (
          message.event.type === "final" &&
          message.videoStartSec !== undefined &&
          message.videoEndSec !== undefined
        ) {
          timelineRef.current.add({
            videoStartSec: message.videoStartSec,
            videoEndSec: message.videoEndSec,
            segment: {
              segmentId: message.event.segmentId,
              sourceText: message.event.sourceText,
              translatedText: message.event.translatedText,
              status: "final",
              ...(message.event.speakerId !== undefined ? { speakerId: message.event.speakerId } : {})
            }
          });
        }
        return;
      }
```

In the existing video-sampling effect (the one that sends `VIDEO_TIME_SAMPLE`), also update React state so rendering reacts — set `currentTimeSec` from the same sampled value (reuse the throttle; a discontinuity/`seeked` should update immediately so a scrub reflects at once):

```ts
      lastSentAt = wallClockMs;
      setCurrentTimeSec(video.currentTime);
      void chrome.runtime.sendMessage({ /* VIDEO_TIME_SAMPLE, unchanged */ });
```

(Ensure the `seeked`/`play`/`pause` `force` path also calls `setCurrentTimeSec` so a scrub updates the overlay immediately.)

- [ ] **Step 2: Select the displayed segment**

Before the `return (<SubtitleOverlay … />)`, compute the displayed segment and speaker from it:

```ts
  const replaySegment =
    currentTimeSec !== null
      ? timelineRef.current.segmentAt(currentTimeSec)?.segment ?? null
      : null;
  const displayedSegment = chooseDisplaySegment({
    currentTimeSec,
    maxCapturedVideoSec: timelineRef.current.maxVideoEndSec() ?? null,
    liveSegment: subtitleState.currentSegment,
    replaySegment
  });
```

Replace the `segment={subtitleState.currentSegment}` prop on `<SubtitleOverlay>` with `segment={displayedSegment}`. Keep the existing `speaker` computation but base it on `displayedSegment` instead of `subtitleState.currentSegment` (so a replayed line still shows its speaker chip — the `seenSpeakerIds`/`assignSpeakerNumbers` inputs are unchanged; only the segment whose `speakerId` is looked up changes). Import `chooseDisplaySegment`.

- [ ] **Step 3: Verify (entrypoint — no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — full suite green (content has no unit test; the pure helpers carry the contract).

Run: `grep -n "createSubtitleTimeline\|chooseDisplaySegment\|currentTimeSec\|setCurrentTimeSec" apps/extension/entrypoints/content.tsx`
Expected: timeline feed, current-time state, and the selection wiring are all present.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/content.tsx
git commit -m "feat(extension): overlay replays the recorded line when the video is scrubbed back

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/superpowers/backlog.md` (SP2 shipped)
- Modify: `CLAUDE.md` (note replay)

- [ ] **Step 1: Backlog + CLAUDE.md**

In `backlog.md`, change the SP2 arc line from `⬜ **SP2 — …**` to `✅ **SP2 — scrub-sync playback** (PR #29)` with a one-line description (the content overlay follows `video.currentTime`; scrubbing back within the captured range shows the recorded line via `subtitleTimeline` + `chooseDisplaySegment`; the live edge shows the streaming line).

In `CLAUDE.md`, add a sentence to the content-script note: the overlay also follows the video's `currentTime` — scrubbing back within the captured range replays the recorded line for that position (the background forwards each final's `videoStartSec`/`videoEndSec` on `SERVER_EVENT`; the content builds a `subtitleTimeline` and `chooseDisplaySegment` picks live vs replay).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/backlog.md CLAUDE.md
git commit -m "docs: SP2 shipped (scrub-sync playback)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `subtitleTimeline` (index + segmentAt + hold + maxVideoEndSec) → Task 1. ✅
- `chooseDisplaySegment` (live-vs-replay) → Task 2. ✅
- `SERVER_EVENT` video times → Task 3 (type) + Task 4 (background sets them). ✅
- Content wiring (timeline feed, currentTime state, selection) → Task 5. ✅
- Docs → Task 6. ✅

**Placeholder scan:** No TBD/TODO. Task 4/5 read-the-file notes are explicit with fixed grep assertions.

**Type consistency:** `TimelineEntry.segment` is `SubtitleDisplaySegment` (from reducer); `chooseDisplaySegment` takes/returns `SubtitleDisplaySegment | null`; `ServerEventMessage.videoStartSec?/videoEndSec?` set in Task 4, consumed in Task 5. `timelineRef.current.segmentAt(...)?.segment ?? null` yields `SubtitleDisplaySegment | null`. `maxVideoEndSec() ?? null` yields `number | null`.

**Ordering:** Tasks 1-3 independent testable `src`/message additions. Task 4 (background) depends on 3; Task 5 (content) depends on 1/2/3. Task 6 docs. Each leaves the package green.
