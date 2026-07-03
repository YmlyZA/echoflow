# Video-Anchored History — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the transcript a complete, identified record — the backend emits every confirmed final (no latest-wins drop), the overlay still shows one clean current line, and each session stores which video it transcribed.

**Architecture:** Backend `pipelineSubtitleSource` translates a bounded FIFO queue and emits every final in order; a pure `compareSegmentId` helper drives a monotonic render guard in the subtitle reducer; the history session record gains `videoUrl`/`videoTitle` (Dexie v2) filled from the tab.

**Tech Stack:** TypeScript (ESM), Fastify backend, WXT + React 19 extension, Dexie/IndexedDB, Vitest.

## Global Constraints

- Backend (`apps/backend`, Task 3): tsconfig `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; `.js` import specifiers; use the conditional-spread for optional `speakerId`.
- Extension (`apps/extension`, Tasks 1/2/4): strict but NOT `exactOptionalPropertyTypes`.
- No wire-protocol (`packages/protocol`) change. No new dependencies.
- After each task, the touched package's `typecheck` + `test` stay green.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `compareSegmentId` ordering helper

**Files:**
- Create: `apps/extension/src/subtitles/compareSegmentId.ts`
- Test: `apps/extension/src/subtitles/compareSegmentId.test.ts`

**Interfaces:**
- Produces: `compareSegmentId(a: string, b: string): number` — negative if `a` is older than `b`, positive if newer, 0 if equal. Orders by parsed `(epoch, ordinal)` from `e{epoch}:seg-{ordinal}` (higher epoch newer; then higher ordinal). Ids that don't parse compare as equal-precedence `(0,0)` so a malformed id never wrongly suppresses rendering.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/subtitles/compareSegmentId.test.ts
import { describe, expect, it } from "vitest";
import { compareSegmentId } from "./compareSegmentId";

describe("compareSegmentId", () => {
  it("orders by ordinal within an epoch", () => {
    expect(compareSegmentId("e1:seg-1", "e1:seg-2")).toBeLessThan(0);
    expect(compareSegmentId("e1:seg-3", "e1:seg-2")).toBeGreaterThan(0);
    expect(compareSegmentId("e1:seg-2", "e1:seg-2")).toBe(0);
  });

  it("orders a later epoch as newer regardless of ordinal", () => {
    expect(compareSegmentId("e1:seg-50", "e2:seg-1")).toBeLessThan(0);
    expect(compareSegmentId("e2:seg-1", "e1:seg-50")).toBeGreaterThan(0);
  });

  it("treats an unparseable id as lowest precedence, never throwing", () => {
    expect(compareSegmentId("garbage", "e1:seg-1")).toBeLessThan(0);
    expect(compareSegmentId("garbage", "also-garbage")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- compareSegmentId`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/extension/src/subtitles/compareSegmentId.ts

/**
 * Orders backend segment ids of the form `e{epoch}:seg-{ordinal}`. Returns <0 if
 * `a` is older than `b`, >0 if newer, 0 if equal precedence. A later reconnect
 * epoch is always newer than an earlier one (ordinals reset per connection); an
 * id that does not parse is treated as (0,0) so it never wrongly outranks a real
 * segment. Used to keep the overlay's current line monotonic even though the
 * backend now emits every final (including a slow-translated older one).
 */
export function compareSegmentId(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa.epoch !== pb.epoch) {
    return pa.epoch - pb.epoch;
  }
  return pa.ordinal - pb.ordinal;
}

function parse(segmentId: string): { epoch: number; ordinal: number } {
  const match = /^e(\d+):seg-(\d+)$/.exec(segmentId);
  if (match === null) {
    return { epoch: 0, ordinal: 0 };
  }
  return { epoch: Number(match[1]), ordinal: Number(match[2]) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- compareSegmentId`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/subtitles/compareSegmentId.ts apps/extension/src/subtitles/compareSegmentId.test.ts
git commit -m "feat(extension): compareSegmentId ordering helper for monotonic render

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Monotonic current-line guard in the reducer

**Files:**
- Modify: `apps/extension/src/subtitles/reducer.ts` (the `final` and `partial` cases)
- Test: `apps/extension/src/subtitles/reducer.test.ts` (extend)

**Interfaces:**
- Consumes: `compareSegmentId` (Task 1).
- Produces: an older-than-current `final`/`partial` no longer replaces `currentSegment` (but a `final` is still counted in `finalizedSegmentIds`).

- [ ] **Step 1: Write the failing tests**

Add to `reducer.test.ts` (match its existing event-dispatch style):

```ts
  it("does not flash back to an older final once a newer one is shown", () => {
    let state = createInitialSubtitleState();
    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "e1:seg-2", sourceText: "two", translatedText: "二",
      startTimeMs: 300, endTimeMs: 600,
    });
    const beforeOld = state.currentSegment;
    // a slow-translated earlier final arrives AFTER seg-2 is shown
    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "e1:seg-1", sourceText: "one", translatedText: "一",
      startTimeMs: 0, endTimeMs: 300,
    });
    expect(state.currentSegment).toEqual(beforeOld); // still showing seg-2
    expect(state.finalizedSegmentIds).toContain("e1:seg-1"); // but seg-1 is tracked
  });

  it("still advances the current line to a newer final", () => {
    let state = createInitialSubtitleState();
    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "e1:seg-1", sourceText: "one", translatedText: "一",
      startTimeMs: 0, endTimeMs: 300,
    });
    state = reduceSubtitleEvent(state, {
      type: "final", segmentId: "e1:seg-2", sourceText: "two", translatedText: "二",
      startTimeMs: 300, endTimeMs: 600,
    });
    expect(state.currentSegment?.segmentId).toBe("e1:seg-2");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test -- reducer`
Expected: FAIL — the first test fails because the reducer currently replaces `currentSegment` with the older seg-1.

- [ ] **Step 3: Implement the guard**

Import the helper at the top of `reducer.ts`:

```ts
import { compareSegmentId } from "./compareSegmentId";
```

In the `final` case, only replace `currentSegment` when the incoming segment is not older than the shown one; always keep tracking it in `finalizedSegmentIds`:

```ts
    case "final": {
      const isOlderThanCurrent =
        state.currentSegment !== null &&
        compareSegmentId(event.segmentId, state.currentSegment.segmentId) < 0;

      return {
        ...state,
        currentSegment: isOlderThanCurrent
          ? state.currentSegment
          : {
              segmentId: event.segmentId,
              sourceText: event.sourceText,
              translatedText: event.translatedText,
              status: "final",
              ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {})
            },
        finalizedSegmentIds: appendFinalizedSegmentId(
          state.finalizedSegmentIds,
          event.segmentId
        ),
        seenSpeakerIds: trackSpeaker(state.seenSpeakerIds, event.speakerId),
        transientError: null
      };
    }
```

In `reducePartialEvent`, also ignore a partial older than the current segment (a late partial for a superseded segment must not replace a newer line). Add after the existing finalized-id guard:

```ts
  if (state.finalizedSegmentIds.includes(event.segmentId)) {
    return state;
  }

  if (
    state.currentSegment !== null &&
    compareSegmentId(event.segmentId, state.currentSegment.segmentId) < 0
  ) {
    return state;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- reducer`
Expected: PASS — new tests green; all pre-existing reducer tests still green (a normal forward sequence is unaffected — each new segment has a higher ordinal).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/subtitles/reducer.ts apps/extension/src/subtitles/reducer.test.ts
git commit -m "fix(extension): keep the overlay current line monotonic (no flash-back)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend emits every final via a bounded FIFO queue

**Files:**
- Modify: `apps/backend/src/realtime/pipelineSubtitleSource.ts`
- Test: `apps/backend/src/realtime/pipelineSubtitleSource.test.ts` (extend + update the latest-wins test)

**Interfaces:**
- No signature change. New behavior: every confirmed final is emitted (translated, in order); no latest-wins drop; the queue is bounded.

- [ ] **Step 1: Update the existing latest-wins test + add queue tests**

The existing test that asserts a final is dropped when a newer segment starts (search for the latest-wins / "does not emit" assertion) now contradicts the design — **rewrite it** to assert the earlier final IS still emitted. Add:

```ts
  it("emits every final in order even when two arrive within one translation RTT", async () => {
    const events: ServerEvent[] = [];
    const speech = stubSpeech(); // adapt to the file's existing speech stub
    const translations: string[] = [];
    const translation = {
      translate: vi.fn(async (input: { text: string }) => {
        translations.push(input.text);
        return `[${input.text}]`;
      }),
      close: vi.fn(),
    };
    const source = new PipelineSubtitleSource(speech.provider, translation, "zh-CN");
    const stream = source.open({ onEvent: (e) => events.push(e) });

    speech.emit({ kind: "final", segmentId: "seg-1", text: "one", startTimeMs: 0, endTimeMs: 300 });
    speech.emit({ kind: "final", segmentId: "seg-2", text: "two", startTimeMs: 300, endTimeMs: 600 });
    await stream.end();

    const finals = events.filter((e) => e.type === "final");
    expect(finals.map((e) => (e as { segmentId: string }).segmentId)).toEqual(["seg-1", "seg-2"]);
  });
```

(If the file already constructs a speech stub differently, reuse that; the fixed requirement is: both seg-1 and seg-2 finals are emitted, in order.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/backend test -- pipelineSubtitleSource`
Expected: FAIL — with the single-slot latest-wins code, seg-1 is overwritten/dropped, so only seg-2's final is emitted.

- [ ] **Step 3: Implement the FIFO queue**

Replace the single-slot state and drain logic. At the top of `open()`, replace `let pendingFinal…` with:

```ts
    const MAX_PENDING_FINALS = 64;
    type PendingFinal = {
      segmentId: string;
      sourceText: string;
      startTimeMs: number;
      endTimeMs: number;
      speakerId?: string;
    };
    const pendingFinals: PendingFinal[] = [];
```

Remove the `latestSegmentId` variable entirely (both its declaration and the `event.kind === "partial" || event.kind === "final"` assignment that sets it — it is only used by the emit gates being removed).

`resolveIdleIfDone` and the `end()` idle wait: replace `pendingFinal === undefined` with `pendingFinals.length === 0`.

`drainTranslations` — shift the queue and always emit:

```ts
    const drainTranslations = async (): Promise<void> => {
      if (translating) return;
      translating = true;
      try {
        while (pendingFinals.length > 0) {
          const job = pendingFinals.shift()!;
          let translatedText: string;
          try {
            translatedText = await translationProvider.translate({
              text: job.sourceText,
              sourceLanguage,
              targetLanguage,
            });
          } catch (error: unknown) {
            if (closed) return;
            // Translation failed transiently (audit #1): emit source-only + a
            // non-fatal error, keep the session alive. Now unconditional (every
            // final is recorded), no latest-wins gate.
            opts.onEvent({
              type: "final",
              segmentId: job.segmentId,
              sourceText: job.sourceText,
              translatedText: "",
              startTimeMs: job.startTimeMs,
              endTimeMs: job.endTimeMs,
              ...(job.speakerId !== undefined ? { speakerId: job.speakerId } : {}),
            });
            opts.onEvent({ type: "error", code: "translation_failed", message: toError(error).message });
            continue;
          }
          if (closed) return;
          opts.onEvent({
            type: "final",
            segmentId: job.segmentId,
            sourceText: job.sourceText,
            translatedText,
            startTimeMs: job.startTimeMs,
            endTimeMs: job.endTimeMs,
            ...(job.speakerId !== undefined ? { speakerId: job.speakerId } : {}),
          });
        }
      } finally {
        translating = false;
        resolveIdleIfDone();
      }
    };
```

`onSegment` — push onto the queue with the bound:

```ts
      pendingFinals.push({
        segmentId: event.segmentId,
        sourceText: event.text,
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
        ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {}),
      });
      if (pendingFinals.length > MAX_PENDING_FINALS) {
        pendingFinals.shift(); // drop oldest — bounded memory under a stalled translator
        opts.onEvent({
          type: "error",
          code: "history_truncated",
          message: "Translation backlog exceeded; oldest line dropped",
        });
      }
      void drainTranslations();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test -- pipelineSubtitleSource`
Expected: PASS — new emit-every-final test green; the rewritten former-latest-wins test green; the shipped translation-failure test still green.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/realtime/pipelineSubtitleSource.ts apps/backend/src/realtime/pipelineSubtitleSource.test.ts
git commit -m "fix(backend): emit every final via a bounded queue (complete history, no drop)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Store video identity on the history session

**Files:**
- Modify: `apps/extension/src/history/historyStore.ts` (`HistorySessionRecord`, `CreateLocalSessionInput`, `createLocalSession`)
- Modify: `apps/extension/src/history/db.ts` (Dexie v2 schema)
- Modify: `apps/extension/entrypoints/background.ts` (`startSession` — fetch tab url/title, pass to `createLocalSession`)
- Test: `apps/extension/src/history/historyStore.test.ts` (extend)

**Interfaces:**
- Produces: `HistorySessionRecord` + `CreateLocalSessionInput` gain optional `videoUrl?: string` / `videoTitle?: string`; Dexie schema v2 indexes `videoUrl`.

- [ ] **Step 1: Write the failing test**

Add to `historyStore.test.ts`:

```ts
  it("persists video identity on a created session", async () => {
    const store = createHistoryStore(createInMemoryHistoryPersistence()); // match the file's helper
    const session = await store.createLocalSession({
      now: () => 100,
      randomSuffix: () => "s",
      videoUrl: "https://example.com/watch/123",
      videoTitle: "Example Video",
    });
    const fetched = await store.getSession(session.id);
    expect(fetched?.videoUrl).toBe("https://example.com/watch/123");
    expect(fetched?.videoTitle).toBe("Example Video");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- historyStore`
Expected: FAIL — `videoUrl`/`videoTitle` are not accepted/persisted.

- [ ] **Step 3: Implement the record + input + creation**

In `historyStore.ts`, add to `HistorySessionRecord`:

```ts
  videoUrl?: string;
  videoTitle?: string;
```

Add to `CreateLocalSessionInput`:

```ts
  videoUrl?: string;
  videoTitle?: string;
```

In `createLocalSession`, after building `session`, attach them when present (mirror the existing optional-field pattern in that function):

```ts
      if (input.videoUrl) {
        session.videoUrl = input.videoUrl;
      }
      if (input.videoTitle) {
        session.videoTitle = input.videoTitle;
      }
```

In `db.ts`, add a v2 schema that indexes `videoUrl` (keep v1 for upgrade):

```ts
    this.version(1).stores({
      sessions: "id, startedAt, updatedAt, remoteSessionId, syncStatus",
      segments: "[sessionId+segmentId], sessionId, segmentId, startTimeMs"
    });
    this.version(2).stores({
      sessions: "id, startedAt, updatedAt, remoteSessionId, syncStatus, videoUrl"
    });
```

(Only the `sessions` store changes; Dexie carries `segments` forward. Additive index + additive fields upgrade v1 rows cleanly — missing values stay `undefined`.)

- [ ] **Step 4: Wire the background to capture identity**

In `background.ts` `startSession`, fetch the tab's url/title (readable under the `activeTab` grant) and pass them into `createLocalSession`:

```ts
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);

    const localSession = await historyStore.createLocalSession({
      targetLanguage: settings.targetLanguage,
      ...(tab?.url ? { videoUrl: tab.url } : {}),
      ...(tab?.title ? { videoTitle: tab.title } : {}),
    });
```

(Replace the existing `createLocalSession({ targetLanguage: settings.targetLanguage })` call. The `.catch(() => undefined)` keeps a metadata-permission hiccup from failing the session — identity is best-effort.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- historyStore`
Expected: PASS — new identity test green; all existing history tests still green (the v2 migration is additive; `getSegments` unaffected).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0. Run the full extension suite once: `pnpm --filter @echoflow/extension test` → green.

```bash
git add apps/extension/src/history/historyStore.ts apps/extension/src/history/db.ts apps/extension/entrypoints/background.ts apps/extension/src/history/historyStore.test.ts
git commit -m "feat(extension): store video url/title on the history session (Dexie v2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Update the architecture note

**Files:**
- Modify: `CLAUDE.md` (the backend request-flow paragraph describing latest-wins)

**Interfaces:** docs only.

- [ ] **Step 1: Revise the note**

In `CLAUDE.md`, find the sentence describing the pipeline's latest-wins translation worker ("each `final` is translated by a single-flight, latest-wins worker … so translation never backs up"). Replace it to reflect the new behavior: the pipeline translates a bounded FIFO queue and **emits every confirmed final in order**; the extension's subtitle reducer keeps the overlay's current line monotonic (ignoring a late older final) while the background records every final to history — completeness in history, a clean single line on screen. Keep the surrounding sentences intact.

- [ ] **Step 2: Verify + commit**

Run: `grep -n "latest-wins\|every confirmed final\|monotonic" CLAUDE.md`
Expected: the stale "latest-wins … never backs up" phrasing is gone; the new description is present.

```bash
git add CLAUDE.md
git commit -m "docs: describe emit-every-final + monotonic render (supersedes latest-wins)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Backend emit-every-final via bounded queue → Task 3. ✅
- Monotonic render guard → Task 1 (`compareSegmentId`) + Task 2 (reducer). ✅
- Video identity on the session → Task 4. ✅
- CLAUDE.md note → Task 5. ✅
- Completeness lives in background history (records every received final — unchanged) + backend emit-all; render cleanliness lives in the reducer. ✅

**Placeholder scan:** No TBD/TODO. The two harness-adaptation notes (Task 3 speech stub, Task 4 in-memory persistence helper) are explicit "match the existing file" instructions with the fixed assertions stated.

**Type consistency:** `compareSegmentId(a, b): number` used in Task 2. `PendingFinal` queue replaces the `pendingFinal` slot; `latestSegmentId` removed (its only readers, the two emit gates, are gone). `videoUrl?`/`videoTitle?` added to both `HistorySessionRecord` and `CreateLocalSessionInput` and read in `createLocalSession`; background passes them via conditional spread. Backend uses conditional-spread for optional `speakerId` (exactOptionalPropertyTypes).

**Ordering:** Task 1 → Task 2 (reducer consumes the helper). Task 3 (backend) and Task 4 (history+background) independent. Task 5 docs. Each leaves its package green.
