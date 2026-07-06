# Per-Video Cache Reuse Design (SP3)

> Captured 2026-07-06. Fourth slice of the "history as user data" arc — the culmination of the local
> features. Revisiting a video you've captured before loads its prior transcript, so scrub-replay
> works across the whole previously-captured range from the first frame, not just the current
> session's range.

## Goal

Starting a session on a video with the same identity as a prior session:
- loads that prior session's video-timed transcript into the overlay's timeline, so **scrubbing to
  any previously-captured position shows the recorded line** — immediately, before this session
  re-captures anything there;
- keeps **live capture at the playhead** behaving exactly as SP2 (streaming line + partials),
  without the loaded cache fooling the live-vs-replay decision.

Scope: **local, same-device** cache (IndexedDB). Cross-device is SP4 (accounts/sync).

## The design fork this slice must solve

SP2's live-vs-replay decision used `maxCapturedVideoSec = timeline.maxVideoEndSec()` as "the live
edge." That worked because, with capture-only, the timeline never extended past the playhead. **With
a full cached transcript loaded, the timeline spans the whole video** — so `maxVideoEndSec()` is no
longer the live edge, and the SP2 rule (`currentTime >= maxCaptured - ε → live`) would classify a
user watching live at 0:30 of a 2-hour cached video as "scrubbed back" → replay, breaking live
streaming. The fix (§4) is to track the **live edge separately** from the timeline's extent.

## Design

### 1. Video identity — `videoIdentity(url) → videoKey`

A pure `videoIdentity(url: string): string` produces a canonical key so different URLs for the same
video match:
- **Known providers:** YouTube (`youtube.com/watch?v=…`, `youtu.be/…`, `/embed/…`) → `youtube:<id>`.
- **Generic:** `origin + pathname`, plus the query string with a small denylist of volatile params
  stripped (`t`, `time_continue`, `start`, `end`, `list`, `index`, `feature`, `si`, `utm_*`), and no
  hash. Best-effort — groups the common "same page, different timestamp/tracking params" case.
- Unparseable url → the raw string (still deterministic; just won't match variants).

This is deliberately simple and testable; identity refinement (more providers) can evolve without
touching the rest.

### 2. Store `videoKey` on the session + query prior segments

`HistorySessionRecord` gains `videoKey?: string`; `createLocalSession` accepts + stores it; Dexie
schema bumps to **v3** indexing `videoKey` (additive migration). The background computes it via
`videoIdentity(tab.url)` and passes it in alongside `videoUrl`/`videoTitle`.

`HistoryStore` gains `getSegmentsForVideo(videoKey, excludeSessionId): Promise<HistorySegmentRecord[]>`
— finds the **most recent prior session** (by `startedAt` desc) with `videoKey === key` and
`id !== excludeSessionId`, and returns its segments **filtered to those carrying `videoStartSec`/
`videoEndSec`** (pre-SP1b segments lack them and can't be placed on the timeline). One session bounds
the volume and means "resume the last transcript"; merging multiple partial sessions for fuller
coverage is a documented refinement, not v1.

### 3. Load the cache and seed the content timeline

A new runtime message `CACHED_TRANSCRIPT { type; localSessionId; entries: TimelineEntry[] }`
(`TimelineEntry` = `{ videoStartSec, videoEndSec, segment }`, the same shape the content timeline
already uses). On session start, after the background injects the content script, it calls
`getSegmentsForVideo(videoKey, currentSessionId)`, maps the timed segments to `TimelineEntry`s, and
— if any — sends `CACHED_TRANSCRIPT` to the tab. The content script, on receipt (matching its
`currentSessionId` or accepting since it's freshly injected), adds every entry to its
`subtitleTimeline` (for replay lookup) **without** touching the live edge. If there's no prior
session / no timed segments, nothing is sent (behaves exactly as SP2).

### 4. Live-vs-replay with a loaded cache (the rework)

The content script tracks a new `liveEdgeSec` — the max `videoEndSec` among **live** finals of the
current session only (updated when a live `SERVER_EVENT` final is added; cached entries do NOT update
it). `chooseDisplaySegment` is reworked to take `liveEdgeSec` (replacing `maxCapturedVideoSec`) and a
band:

```
chooseDisplaySegment({ currentTimeSec, liveEdgeSec, liveSegment, replaySegment }):
  if currentTimeSec === null → liveSegment                              // no video → today's behavior
  if liveEdgeSec === null → replaySegment ?? liveSegment                // no live final yet: cached line if any, else the streaming line (partials)
  if |currentTimeSec - liveEdgeSec| <= EDGE_BAND_SEC → liveSegment      // watching the live capture front → streaming line
  return replaySegment                                                  // scrubbed away (back, or forward into cached territory) → recorded line (may be null in a gap)
```

`EDGE_BAND_SEC` (~4 s) is a symmetric tolerance around the live front (covers ASR lag ahead + minor
jitter behind). This makes replay fire whenever the user is *away from the live front* — including
scrubbing **forward** into cached-but-not-yet-recaptured territory, which the SP2 rule couldn't
express. No-cache behavior is preserved: with capture only, `liveEdgeSec` equals the timeline extent,
so the band around it behaves like SP2's edge check.

## Components (units)

- `src/subtitles/videoIdentity.ts` — pure `videoIdentity(url)`.
- `src/history/historyStore.ts` + `db.ts` — `videoKey` on the record (Dexie v3), `getSegmentsForVideo`.
- `src/messaging/messages.ts` — `CachedTranscriptMessage`.
- `src/subtitles/chooseDisplaySegment.ts` — reworked signature (`liveEdgeSec` + band).
- `entrypoints/background.ts` — compute `videoKey`, load cache, send `CACHED_TRANSCRIPT`.
- `entrypoints/content.tsx` — receive `CACHED_TRANSCRIPT` (seed timeline), track `liveEdgeSec`, pass it to `chooseDisplaySegment`.

## Testing

- **`videoIdentity.test.ts`**: YouTube watch/short/embed URLs → same `youtube:<id>`; generic URL with
  volatile params (`?t=…&utm_source=…`) → same key as without them; hash ignored; unparseable → raw.
- **`historyStore.test.ts`**: `createLocalSession` stores `videoKey`; `getSegmentsForVideo` returns
  the most-recent matching prior session's timed segments, excludes the current session, excludes
  untimed segments, and returns `[]` when no prior match.
- **`messages.test.ts`**: `isRuntimeMessage` accepts `CACHED_TRANSCRIPT`.
- **`chooseDisplaySegment.test.ts`** (rework): null current → live; `liveEdgeSec` null with a replay
  segment → replay, without → live; within band of the live edge → live; scrubbed back → replay;
  scrubbed **forward** past the band into cache (`currentTime` ≫ `liveEdgeSec`, `replaySegment` set) →
  replay (the new capability); gap → null.
- Background cache-load/send and content seed/`liveEdgeSec` tracking are entrypoint wiring
  (smoke-covered); the pure helpers + the store query carry the unit contract.

## Non-goals (later / out of scope)

- **SP4 — accounts / cloud sync** (cross-device). SP3 is local IndexedDB only.
- Merging multiple prior sessions for fuller coverage (v1 loads the most recent one).
- Chunking the `CACHED_TRANSCRIPT` message (one message is fine for typical videos; revisit if a very
  long transcript strains messaging).
- A transcript panel / click-to-seek UI; identity beyond YouTube + generic normalization.
- Any wire-protocol change.

## Rollout

1. Land on `feat/per-video-cache-reuse` via PR (CI `check` gates the merge).
2. Manual check post-merge: capture a video end-to-end once; start a new session on the same video;
   scrub to an earlier position — the recorded line appears immediately (from cache), before this
   session re-captures there; watching live at the playhead still streams normally; scrubbing forward
   into a cached-but-not-yet-recaptured region shows the cached line.
3. Docs: mark SP3 shipped in `docs/superpowers/backlog.md`; note cache reuse in `CLAUDE.md`. The local
   arc (SP1a/SP1b/SP2/SP3) is then complete; only SP4 (accounts) remains, parked.
