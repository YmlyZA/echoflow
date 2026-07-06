# Per-Video Cache Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revisiting a video with the same identity loads its prior session's video-timed transcript into the overlay timeline, so scrubbing shows the recorded line across the whole previously-captured range — while live capture at the playhead still streams as in SP2.

**Architecture:** A pure `videoIdentity` canonicalizes the URL to a `videoKey` stored on the session (Dexie v3); `getSegmentsForVideo` loads the most-recent prior session's timed segments; the background sends them as `CACHED_TRANSCRIPT`; the content script seeds its timeline and tracks a separate `liveEdgeSec` so the reworked `chooseDisplaySegment` keeps live-vs-replay correct with a full cache loaded.

**Tech Stack:** TypeScript (ESM), WXT + React 19 extension, Dexie/IndexedDB, Vitest.

## Global Constraints

- All work in `apps/extension` (+ docs). No `packages/protocol` or `apps/backend` change.
- Extension tsconfig is `strict` but NOT `exactOptionalPropertyTypes` — keep the conditional-spread pattern for optional fields.
- SP3 is local IndexedDB cache only (cross-device is SP4). Loads the MOST RECENT prior session (not a merge).
- After each task, the extension package's `typecheck` + `test` stay green.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `videoIdentity` — canonical video key from a URL

**Files:**
- Create: `apps/extension/src/subtitles/videoIdentity.ts`
- Test: `apps/extension/src/subtitles/videoIdentity.test.ts`

**Interfaces:**
- Produces: `videoIdentity(url: string): string` — `youtube:<id>` for YouTube; `origin + pathname + normalized-search` (volatile params stripped, no hash) for generic; the raw string if unparseable.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/subtitles/videoIdentity.test.ts
import { describe, expect, it } from "vitest";
import { videoIdentity } from "./videoIdentity";

describe("videoIdentity", () => {
  it("canonicalizes YouTube watch/short/embed URLs to the same key", () => {
    const key = "youtube:dQw4w9WgXcQ";
    expect(videoIdentity("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe(key);
    expect(videoIdentity("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(key);
    expect(videoIdentity("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(key);
  });

  it("strips volatile params and the hash for a generic video page", () => {
    const a = videoIdentity("https://example.com/course/lesson-5?t=120&utm_source=news#notes");
    const b = videoIdentity("https://example.com/course/lesson-5");
    expect(a).toBe(b);
  });

  it("keeps a meaningful query param that identifies the video", () => {
    const a = videoIdentity("https://vid.example.com/player?id=abc123&t=30");
    const b = videoIdentity("https://vid.example.com/player?id=abc123");
    expect(a).toBe(b);
    expect(a).not.toBe(videoIdentity("https://vid.example.com/player?id=different"));
  });

  it("returns the raw string for an unparseable url", () => {
    expect(videoIdentity("not a url")).toBe("not a url");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- videoIdentity`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/extension/src/subtitles/videoIdentity.ts

// Query params that vary between visits to the same video (timestamps, playlist
// position, tracking) and must not split its identity.
const VOLATILE_PARAMS = new Set([
  "t", "time_continue", "start", "end", "list", "index", "feature", "si"
]);

/**
 * Canonical key for "the same video", so different URLs (timestamp, tracking,
 * playlist params) for one video share a cache. Best-effort: known providers get
 * a stable id; generic pages normalize to origin+path plus non-volatile query.
 */
export function videoIdentity(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const youtube = youtubeId(parsed);
  if (youtube !== undefined) {
    return `youtube:${youtube}`;
  }

  const params = new URLSearchParams();
  const keys = [...parsed.searchParams.keys()].sort();
  for (const key of keys) {
    if (VOLATILE_PARAMS.has(key) || key.startsWith("utm_")) {
      continue;
    }
    params.set(key, parsed.searchParams.get(key) ?? "");
  }
  const search = params.toString();
  return `${parsed.origin}${parsed.pathname}${search ? `?${search}` : ""}`;
}

function youtubeId(parsed: URL): string | undefined {
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1);
    return id || undefined;
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    const v = parsed.searchParams.get("v");
    if (v) {
      return v;
    }
    const embed = /^\/embed\/([^/]+)/.exec(parsed.pathname);
    if (embed) {
      return embed[1];
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- videoIdentity`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/subtitles/videoIdentity.ts apps/extension/src/subtitles/videoIdentity.test.ts
git commit -m "feat(extension): videoIdentity — canonical key for per-video cache matching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rework `chooseDisplaySegment` for a loaded cache (live-edge band)

**Files:**
- Modify: `apps/extension/src/subtitles/chooseDisplaySegment.ts`
- Test: `apps/extension/src/subtitles/chooseDisplaySegment.test.ts`
- Modify: `apps/extension/entrypoints/content.tsx` (the single call site — rename the arg to keep it compiling; behavior preserved)

**Interfaces:**
- Produces: `chooseDisplaySegment({ currentTimeSec, liveEdgeSec, liveSegment, replaySegment })` — `maxCapturedVideoSec` is renamed to `liveEdgeSec`; a symmetric band decides live-vs-replay; a null `liveEdgeSec` with a `replaySegment` shows the cached line.

- [ ] **Step 1: Rewrite the test to the new semantics**

Replace `chooseDisplaySegment.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { chooseDisplaySegment } from "./chooseDisplaySegment";
import type { SubtitleDisplaySegment } from "./reducer";

const live: SubtitleDisplaySegment = { segmentId: "live", sourceText: "l", translatedText: "l", status: "final" };
const replay: SubtitleDisplaySegment = { segmentId: "replay", sourceText: "r", translatedText: "r", status: "final" };

describe("chooseDisplaySegment", () => {
  it("shows the live segment when there is no video time", () => {
    expect(chooseDisplaySegment({ currentTimeSec: null, liveEdgeSec: 10, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("with no live final yet, shows the cached line if present, else the live line", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: null, liveSegment: live, replaySegment: replay })).toBe(replay);
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: null, liveSegment: live, replaySegment: null })).toBe(live);
  });

  it("shows the live segment within the band of the live edge", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 102, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(live); // ahead by ASR lag
    expect(chooseDisplaySegment({ currentTimeSec: 98, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("shows the replay segment when scrubbed back out of the band", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(replay);
  });

  it("shows the replay segment when scrubbed forward into cached territory past the band", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 500, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(replay);
  });

  it("shows nothing when scrubbed into a gap", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: 100, liveSegment: live, replaySegment: null })).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- chooseDisplaySegment`
Expected: FAIL — the forward-scrub-into-cache test (currentTime 500 ≫ 100) fails under the old `>=`-only rule (returns live), and the `liveEdgeSec` arg name doesn't exist yet.

- [ ] **Step 3: Implement the rework**

```ts
// apps/extension/src/subtitles/chooseDisplaySegment.ts
import type { SubtitleDisplaySegment } from "./reducer";

// Symmetric tolerance (seconds) around the live capture front: within this of the
// front (ahead by ASR lag, or slightly behind), the user is watching live.
const EDGE_BAND_SEC = 4;

/**
 * Picks what the overlay shows. `liveEdgeSec` is the current session's live capture
 * front (max videoEnd of LIVE finals) — NOT the timeline extent, which with a
 * loaded cache spans the whole video. Watching near the front → the streaming line;
 * scrubbed away (back, or forward into cached territory) → the recorded line.
 */
export function chooseDisplaySegment(input: {
  currentTimeSec: number | null;
  liveEdgeSec: number | null;
  liveSegment: SubtitleDisplaySegment | null;
  replaySegment: SubtitleDisplaySegment | null;
}): SubtitleDisplaySegment | null {
  if (input.currentTimeSec === null) {
    return input.liveSegment;
  }
  if (input.liveEdgeSec === null) {
    // No live final yet: show the cached line at this position if we have one,
    // otherwise the streaming line (partials at the start of capture).
    return input.replaySegment ?? input.liveSegment;
  }
  if (Math.abs(input.currentTimeSec - input.liveEdgeSec) <= EDGE_BAND_SEC) {
    return input.liveSegment;
  }
  return input.replaySegment;
}
```

- [ ] **Step 4: Keep the caller compiling (behavior-preserving)**

In `content.tsx`, the current call passes `maxCapturedVideoSec: timelineRef.current.maxVideoEndSec() ?? null`. Rename the property to `liveEdgeSec` (same value for now — with no cache the timeline extent IS the live edge; Task 6 replaces it with the true live-only edge):

```ts
  const displayedSegment = chooseDisplaySegment({
    currentTimeSec,
    liveEdgeSec: timelineRef.current.maxVideoEndSec() ?? null,
    liveSegment: subtitleState.currentSegment,
    replaySegment
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @echoflow/extension test -- chooseDisplaySegment`
Expected: PASS (6 tests).

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0 (content.tsx compiles with the renamed arg).

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — full suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/subtitles/chooseDisplaySegment.ts apps/extension/src/subtitles/chooseDisplaySegment.test.ts apps/extension/entrypoints/content.tsx
git commit -m "feat(extension): live-edge band in chooseDisplaySegment (cache-aware replay)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Store `videoKey`; query prior segments by video

**Files:**
- Modify: `apps/extension/src/history/historyStore.ts` (`HistorySessionRecord`, `CreateLocalSessionInput`, `createLocalSession`, `HistoryPersistence`, `HistoryStore`, new `getSegmentsForVideo`)
- Modify: `apps/extension/src/history/db.ts` (Dexie v3 + `getSessionsByVideoKey`; in-memory factory if present)
- Test: `apps/extension/src/history/historyStore.test.ts` (extend)

**Interfaces:**
- Produces: `videoKey?` on the record + input; `HistoryPersistence.getSessionsByVideoKey(videoKey): Promise<HistorySessionRecord[]>`; `HistoryStore.getSegmentsForVideo(videoKey, excludeSessionId): Promise<HistorySegmentRecord[]>` — the most-recent prior matching session's segments that carry video times.

- [ ] **Step 1: Write the failing test**

Add to `historyStore.test.ts` (match the file's in-memory persistence helper):

```ts
  it("returns the most recent prior session's timed segments for a video", async () => {
    const store = createHistoryStore(createInMemoryHistoryPersistence()); // match the file's helper
    const older = await store.createLocalSession({ now: () => 1, randomSuffix: () => "a", videoKey: "youtube:X" });
    const newer = await store.createLocalSession({ now: () => 2, randomSuffix: () => "b", videoKey: "youtube:X" });
    const current = await store.createLocalSession({ now: () => 3, randomSuffix: () => "c", videoKey: "youtube:X" });

    await store.appendSegment({ sessionId: older.id, segmentId: "s1", startTimeMs: 0, endTimeMs: 1, sourceLanguage: "en", targetLanguage: "zh-CN", sourceText: "old", translatedText: "旧", status: "final", videoStartSec: 1, videoEndSec: 2 });
    await store.appendSegment({ sessionId: newer.id, segmentId: "s1", startTimeMs: 0, endTimeMs: 1, sourceLanguage: "en", targetLanguage: "zh-CN", sourceText: "new-timed", translatedText: "新", status: "final", videoStartSec: 10, videoEndSec: 11 });
    await store.appendSegment({ sessionId: newer.id, segmentId: "s2", startTimeMs: 0, endTimeMs: 1, sourceLanguage: "en", targetLanguage: "zh-CN", sourceText: "new-untimed", translatedText: "无", status: "final" });

    const cached = await store.getSegmentsForVideo("youtube:X", current.id);
    // most recent prior session is `newer`; only its timed segment is returned
    expect(cached.map((s) => s.sourceText)).toEqual(["new-timed"]);
  });

  it("returns nothing when no prior session matches the video", async () => {
    const store = createHistoryStore(createInMemoryHistoryPersistence());
    const current = await store.createLocalSession({ now: () => 1, randomSuffix: () => "a", videoKey: "youtube:Y" });
    expect(await store.getSegmentsForVideo("youtube:Y", current.id)).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- historyStore`
Expected: FAIL — `videoKey` not accepted; `getSegmentsForVideo` missing.

- [ ] **Step 3: Implement**

In `historyStore.ts`:
- add `videoKey?: string` to `HistorySessionRecord` and `CreateLocalSessionInput`; set it in `createLocalSession` (mirror the `videoUrl` `if (input.videoKey) session.videoKey = input.videoKey;`).
- add to `HistoryPersistence`: `getSessionsByVideoKey(videoKey: string): Promise<HistorySessionRecord[]>;`.
- add to `HistoryStore` + implement:

```ts
    async getSegmentsForVideo(videoKey, excludeSessionId) {
      const sessions = (await persistence.getSessionsByVideoKey(videoKey))
        .filter((s) => s.id !== excludeSessionId)
        .sort((a, b) => b.startedAt - a.startedAt);
      const mostRecent = sessions[0];
      if (mostRecent === undefined) {
        return [];
      }
      const segments = await persistence.getSegments(mostRecent.id);
      return segments.filter(
        (s) => s.videoStartSec !== undefined && s.videoEndSec !== undefined
      );
    },
```

(Add `getSegmentsForVideo(videoKey: string, excludeSessionId: string): Promise<HistorySegmentRecord[]>` to the `HistoryStore` interface.)

In `db.ts`:
- bump to Dexie v3, indexing `videoKey` on `sessions`:

```ts
    this.version(3).stores({
      sessions: "id, startedAt, updatedAt, remoteSessionId, syncStatus, videoUrl, videoKey"
    });
```

- implement `getSessionsByVideoKey` in the Dexie persistence:

```ts
    async getSessionsByVideoKey(videoKey) {
      return database.sessions.where("videoKey").equals(videoKey).toArray();
    },
```

- If there is an in-memory persistence factory (used by tests), implement `getSessionsByVideoKey` there too (filter `sessions` by `videoKey`). READ the test file to find/extend the exact helper (`createInMemoryHistoryPersistence` or equivalent).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @echoflow/extension test -- historyStore`
Expected: PASS — new tests green; existing history tests still green (additive migration).

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/history/historyStore.ts apps/extension/src/history/db.ts apps/extension/src/history/historyStore.test.ts
git commit -m "feat(extension): store videoKey (Dexie v3); getSegmentsForVideo for cache reuse

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `CACHED_TRANSCRIPT` runtime message

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts`
- Test: `apps/extension/src/messaging/messages.test.ts`

**Interfaces:**
- Produces: `CachedTranscriptMessage { type: "CACHED_TRANSCRIPT"; localSessionId: string; entries: TimelineEntry[] }` in the union + `isRuntimeMessage`.

- [ ] **Step 1: Write the failing test**

```ts
  it("accepts a CACHED_TRANSCRIPT message", () => {
    expect(
      isRuntimeMessage({
        type: "CACHED_TRANSCRIPT",
        localSessionId: "local-1",
        entries: [{ videoStartSec: 1, videoEndSec: 2, segment: { segmentId: "e1:seg-1", sourceText: "x", translatedText: "y", status: "final" } }]
      })
    ).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: FAIL — unknown type.

- [ ] **Step 3: Implement**

Add `import type { TimelineEntry } from "../subtitles/subtitleTimeline";`. Add to the `RuntimeMessage` union: `| CachedTranscriptMessage`. Add the interface:

```ts
export interface CachedTranscriptMessage {
  type: "CACHED_TRANSCRIPT";
  localSessionId: string;
  entries: TimelineEntry[];
}
```

Add `"CACHED_TRANSCRIPT"` to the `isRuntimeMessage` type array.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: PASS.

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/messaging/messages.ts apps/extension/src/messaging/messages.test.ts
git commit -m "feat(extension): CACHED_TRANSCRIPT message to seed the overlay timeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Background computes `videoKey`, loads + sends the cache

**Files:**
- Modify: `apps/extension/entrypoints/background.ts` (`startSession`)

**Interfaces:**
- Consumes: `videoIdentity` (Task 1), `getSegmentsForVideo` (Task 3), `CachedTranscriptMessage` (Task 4).
- Produces: entrypoint wiring — on start, the tab receives `CACHED_TRANSCRIPT` when a prior session for the same video exists.

- [ ] **Step 1: Compute videoKey + load and send cache**

READ `startSession` in `background.ts`. It fetches the tab and calls `createLocalSession({ targetLanguage, videoUrl?, videoTitle? })`, and injects the content script via `injectRuntimeContentScript(tabId)`.

- compute the key when the tab url is known and pass it in:

```ts
    const videoKey = tab?.url ? videoIdentity(tab.url) : undefined;

    const localSession = await historyStore.createLocalSession({
      targetLanguage: settings.targetLanguage,
      ...(tab?.url ? { videoUrl: tab.url } : {}),
      ...(tab?.title ? { videoTitle: tab.title } : {}),
      ...(videoKey !== undefined ? { videoKey } : {})
    });
    localSessionId = localSession.id;
```

- after the content script is injected (so its listener is registered), load and send the cache. Add near the end of the successful start path, after `injectRuntimeContentScript` has resolved and the session is committed:

```ts
    if (videoKey !== undefined) {
      const cached = await historyStore.getSegmentsForVideo(videoKey, localSession.id);
      if (cached.length > 0) {
        await sendCachedTranscript(tabId, localSession.id, cached);
      }
    }
```

Add the helper (best-effort — a closed/navigated tab is fine to ignore), mapping the timed segments to `TimelineEntry`s:

```ts
async function sendCachedTranscript(
  tabId: number,
  localSessionId: string,
  segments: HistorySegmentRecord[]
): Promise<void> {
  const entries = segments
    .filter((s) => s.videoStartSec !== undefined && s.videoEndSec !== undefined)
    .map((s) => ({
      videoStartSec: s.videoStartSec as number,
      videoEndSec: s.videoEndSec as number,
      segment: {
        segmentId: s.segmentId,
        sourceText: s.sourceText,
        translatedText: s.translatedText,
        status: "final" as const,
        ...(s.speakerId !== undefined ? { speakerId: s.speakerId } : {})
      }
    }));
  if (entries.length === 0) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "CACHED_TRANSCRIPT",
      localSessionId,
      entries
    } satisfies CachedTranscriptMessage);
  } catch {
    // Tab closed/navigated — nothing to seed.
  }
}
```

Import `videoIdentity`, `HistorySegmentRecord`, and `CachedTranscriptMessage`. Place the load-and-send AFTER `injectRuntimeContentScript(tabId)` in the flow so the content listener exists. (Sending it before `START_SESSION`/first events is fine — the content just seeds its timeline; ordering vs live events doesn't matter because replay reads the timeline by video time.)

- [ ] **Step 2: Verify (entrypoint — no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — full suite green (Tasks 1-4's tests + all pre-existing).

Run: `grep -n "videoIdentity\|getSegmentsForVideo\|CACHED_TRANSCRIPT\|sendCachedTranscript" apps/extension/entrypoints/background.ts`
Expected: videoKey computed + passed, cache loaded + sent.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "feat(extension): load a prior session's transcript and send it to the overlay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Content seeds the cache and tracks the true live edge

**Files:**
- Modify: `apps/extension/entrypoints/content.tsx`

**Interfaces:**
- Consumes: `CachedTranscriptMessage` (Task 4), the reworked `chooseDisplaySegment` (Task 2).
- Produces: entrypoint wiring — the timeline is seeded from the cache; `liveEdgeSec` tracks live-only.

- [ ] **Step 1: Track the live edge (live finals only)**

READ the full `content.tsx`. Add `const [liveEdgeSec, setLiveEdgeSec] = useState<number | null>(null);`.

In the `SERVER_EVENT` handler, where a `final` with video times is added to the timeline, ALSO advance the live edge (this is the current session's own capture, so it defines the live front):

```ts
        if (
          message.event.type === "final" &&
          message.videoStartSec !== undefined &&
          message.videoEndSec !== undefined
        ) {
          timelineRef.current.add({ /* …unchanged… */ });
          setLiveEdgeSec((prev) =>
            prev === null ? message.videoEndSec! : Math.max(prev, message.videoEndSec!)
          );
        }
```

- [ ] **Step 2: Handle `CACHED_TRANSCRIPT` (seed the timeline only)**

In the runtime-message handler, add a branch that seeds the timeline WITHOUT touching `liveEdgeSec` (cache is not the live front). It must also flip `hasSignal` so the overlay shows (a cached-only session before any live event should still render on scrub):

```ts
      if (message.type === "CACHED_TRANSCRIPT") {
        currentSessionIdRef.current = message.localSessionId;
        for (const entry of message.entries) {
          timelineRef.current.add(entry);
        }
        setHasSignal(true);
        return;
      }
```

- [ ] **Step 3: Pass `liveEdgeSec` to the selection**

Change the `chooseDisplaySegment` call to pass the tracked `liveEdgeSec` instead of the timeline extent:

```ts
  const displayedSegment = chooseDisplaySegment({
    currentTimeSec,
    liveEdgeSec,
    liveSegment: subtitleState.currentSegment,
    replaySegment
  });
```

(`replaySegment` still comes from `timelineRef.current.segmentAt(currentTimeSec)` — the full timeline including cache. Keep the speaker computation based on `displayedSegment`, as in SP2.)

- [ ] **Step 4: Verify (entrypoint — no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — full suite green.

Run: `grep -n "CACHED_TRANSCRIPT\|liveEdgeSec\|setLiveEdgeSec" apps/extension/entrypoints/content.tsx`
Expected: cache seed, live-edge state, and the updated selection call all present.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/content.tsx
git commit -m "feat(extension): seed overlay timeline from cache; track live edge for replay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/superpowers/backlog.md` (SP3 shipped; the local arc complete)
- Modify: `CLAUDE.md` (note cache reuse)

- [ ] **Step 1: Backlog + CLAUDE.md**

In `backlog.md`, change the SP3 arc line from `⬜ **SP3 — …**` to `✅ **SP3 — per-video cache reuse** (PR #30)` with a one-line description (revisiting a video with the same `videoIdentity` key loads the most-recent prior session's timed transcript via `CACHED_TRANSCRIPT`; the overlay replays across the whole previously-captured range; `liveEdgeSec` keeps live streaming correct with a full cache loaded). Add a short "Local arc complete (SP1a–SP3); only SP4 (accounts/sync) remains, parked." note.

In `CLAUDE.md`, extend the content-script note: on start the background computes a `videoIdentity` key, loads the most-recent prior session's timed transcript, and sends it as `CACHED_TRANSCRIPT`; the content seeds its `subtitleTimeline` so scrubbing replays across prior captures, while a separately-tracked `liveEdgeSec` (live finals only) keeps `chooseDisplaySegment`'s live-vs-replay correct even though the timeline now spans the whole video.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/backlog.md CLAUDE.md
git commit -m "docs: SP3 shipped (per-video cache reuse); local arc complete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `videoIdentity` → Task 1. ✅
- Live-edge rework (band, cache-aware) → Task 2. ✅
- `videoKey` storage (Dexie v3) + `getSegmentsForVideo` → Task 3. ✅
- `CACHED_TRANSCRIPT` message → Task 4. ✅
- Background compute-key + load + send → Task 5. ✅
- Content seed + `liveEdgeSec` + selection → Task 6. ✅
- Docs → Task 7. ✅

**Placeholder scan:** No TBD/TODO. The read-the-file notes (in-memory persistence helper name, content call site) are explicit with fixed assertions/grep checks.

**Type consistency:** `videoIdentity(url): string` used in Task 5. `videoKey?` added to record + input (Task 3), passed in Task 5. `getSegmentsForVideo(videoKey, excludeSessionId): Promise<HistorySegmentRecord[]>` used in Task 5. `CachedTranscriptMessage.entries: TimelineEntry[]` produced Task 4, sent Task 5, consumed Task 6. `chooseDisplaySegment` signature (`liveEdgeSec`) reworked Task 2, caller updated Task 2 (behavior-preserving) then Task 6 (true live edge). Task 2 keeps the package green by renaming the one call site.

**Ordering:** Tasks 1-4 are independent testable additions (Task 2 also touches the one content call site to stay green). Task 5 (background) depends on 1/3/4; Task 6 (content) depends on 2/4. Task 7 docs. Each task leaves the package green.
