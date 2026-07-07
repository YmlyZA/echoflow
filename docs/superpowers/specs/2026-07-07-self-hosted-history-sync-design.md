# Self-Hosted History Sync Design (SP4)

> Captured 2026-07-07. Final slice of the "history as user data" arc (SP1a–SP3 shipped the local,
> video-aware half). SP4 makes history a **cross-device** asset: each device's local Dexie history
> syncs bidirectionally with the user's own self-hosted backend, so SP3's per-video cache reuse
> spans devices — start a video on the desktop and the laptop's captured transcript is already in
> the scrub timeline.

## Product decisions (settled with the user)

1. **Single-user, self-hosted.** No user table, no signup/OAuth/reset. The project is permanently
   free and open source; "multi-user" = each person deploys their own backend. The server schema
   keeps a nullable `owner` column as cheap insurance for a future shared-data-plane cloud — a
   column, not a subsystem.
2. **Sync triggers: session end + periodic + manual.** The sync engine only consumes
   `syncStatus: "pending"` rows from Dexie — it never touches the realtime capture path.
3. **Full bidirectional sync.** Devices converge on the union of all sessions/segments. This is
   what makes SP3's `getSegmentsForVideo` cross-device for free.
4. **Storage: `node:sqlite` behind a repository interface.** Zero new npm dependencies (verified
   working unflagged on the repo's Node 22.22; it prints an ExperimentalWarning — acceptable, and
   the repository interface isolates us if the API shifts). Mirrors the provider pattern: an
   interface + an in-memory implementation (tests) + a sqlite implementation (production).
5. **Auth: reuse the existing `x-api-key`.** One secret per deployment; no new settings. In a
   single-user self-hosted deployment both "keys" would guard the same machine and the same
   owner's data, so a second secret adds config friction without a security boundary.

**Cloud-readiness constraints** (from the open-core direction — LiveKit/Supabase/Plausible model;
licensing landed separately):
- The sync HTTP API is part of the public wire contract: versioned under `/v1/`, request/response
  types + runtime guards live in `packages/protocol` like every other wire type.
- Route auth goes through one injectable seam, `verifyApiKey(key) → boolean`, defaulting to the
  existing constant-time compare — a future cloud control plane swaps in key→tenant lookup without
  touching the data plane.
- No `if (cloud)` branches anywhere. Sync is **strictly optional**: with no history DB configured,
  the backend stays exactly as stateless as today and the extension stays purely local.

## Architecture

```
Extension (per device)                          Backend (self-hosted)
┌──────────────────────────────┐               ┌──────────────────────────────┐
│ Dexie history (SP1a–SP3)     │               │ POST /v1/sync/push  ─┐       │
│  syncStatus outbox           │   HTTP        │ GET  /v1/sync/pull  ─┤ auth: │
│      │                       │  (fetch)      │        │             │ x-api-│
│ SyncEngine ──── SyncTransport┼──────────────►│ HistoryRepository    │ key   │
│  (background)   (interface)  │               │  ├ inMemory (tests)  │ seam  │
│      ▲                       │               │  └ node:sqlite       │       │
│ triggers: session end,       │               │    (ECHOFLOW_HISTORY_DB)     │
│ chrome.alarms, manual button │               │ sync_seq cursor per row      │
└──────────────────────────────┘               └──────────────────────────────┘
```

The realtime WS path is untouched. Sync is a separate request/response plane on the same Fastify
app.

## Wire contract (`packages/protocol`)

New module `sync.ts` (types + runtime guards + tests, per the protocol convention):

```ts
// A session/segment as it crosses the wire. Mirrors the extension's history
// records; server treats payloads as opaque-ish documents plus a few
// extracted columns.
export interface SyncSessionRecord {
  id: string;                    // globally unique already: local-<ts>-<uuid>
  updatedAtMs: number;           // LWW clock, client-authored
  payload: Record<string, unknown>; // full HistorySessionRecord (minus syncStatus)
}
export interface SyncSegmentRecord {
  sessionId: string;
  segmentId: string;
  payload: Record<string, unknown>; // full HistorySegmentRecord; immutable once final
}

export interface SyncPushRequest {
  sessions: SyncSessionRecord[];
  segments: SyncSegmentRecord[];
}
export interface SyncPushResponse {
  accepted: { sessions: number; segments: number };
}

export interface SyncPullResponse {
  sessions: SyncSessionRecord[];
  segments: SyncSegmentRecord[];
  nextCursor: number;            // max sync_seq included; pass as ?since= next time
  hasMore: boolean;              // page limit hit; pull again with nextCursor
}
```

Guards: `isSyncPushRequest`, `isSyncPullResponse` (the extension validates pull responses; the
backend validates push bodies). `syncStatus` never crosses the wire — it is per-device state.

Why opaque `payload` + extracted columns: the server is a **replication store, not a query
engine**. All merging/video-key logic stays client-side (where it already lives from SP3), so
extension-side record evolution (new optional fields) does not require server migrations.

## Backend (SP4a)

### Repository

`apps/backend/src/history/historyRepository.ts`:

```ts
export interface HistoryRepository {
  upsertSessions(sessions: SyncSessionRecord[], owner: string | null): Promise<void>; // LWW on updatedAtMs
  upsertSegments(segments: SyncSegmentRecord[], owner: string | null): Promise<void>; // insert-if-absent (immutable)
  changesSince(cursor: number, limit: number, owner: string | null): Promise<SyncPullResponse>;
  close(): Promise<void>;
}
```

- `inMemoryHistoryRepository.ts` — Maps; the test double and the contract's reference semantics.
- `sqliteHistoryRepository.ts` — `node:sqlite` `DatabaseSync`. Schema:

```sql
CREATE TABLE IF NOT EXISTS sync_sessions (
  id         TEXT PRIMARY KEY,
  owner      TEXT,                -- NULL in single-user deployments
  updated_at INTEGER NOT NULL,
  sync_seq   INTEGER NOT NULL,
  payload    TEXT NOT NULL        -- JSON
);
CREATE TABLE IF NOT EXISTS sync_segments (
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  sync_seq   INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (session_id, segment_id)
);
CREATE TABLE IF NOT EXISTS sync_state (   -- single-row monotonic cursor
  k TEXT PRIMARY KEY, v INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_seq ON sync_sessions(sync_seq);
CREATE INDEX IF NOT EXISTS idx_segments_seq ON sync_segments(sync_seq);
```

Every accepted upsert assigns the next global `sync_seq` (one transaction per push). A session
upsert with `updated_at <=` the stored row is a no-op (LWW; ties keep the stored row). Segment
upserts on an existing PK are no-ops (segments are immutable once final).

### Routes

Registered on the existing Fastify app **only when a history DB is configured**
(`ECHOFLOW_HISTORY_DB=<path or :memory:>`, following `config.ts` precedence: explicit input →
env → default *off*):

- `POST /v1/sync/push` — body validated by `isSyncPushRequest` (413/400 on bad input; body limit
  ~10 MB), upserts, returns `SyncPushResponse`.
- `GET /v1/sync/pull?since=<cursor>` — returns up to 500 changed rows (sessions + segments merged
  by seq order), `nextCursor`, `hasMore`.
- Auth: same `x-api-key` as the WS route, via a new `verifyApiKey(key) → boolean` seam extracted
  from `wsAuth.ts`'s constant-time compare (WS auth adopts the same function — one auth
  implementation, two call sites). Missing/wrong key → 401.
- `GET /v1/capabilities` gains `sync: { available: boolean }` so the extension discovers whether
  the server it points at has sync enabled (additive, guard updated).

## Extension (SP4b)

### `syncStatus` semantics fix (targeted, in-scope)

Today `recordSessionError` sets `syncStatus: "failed"` — conflating *capture* failure with *sync*
failure. Fix: `syncStatus` tracks sync state only (`local-only | pending | synced | failed`);
capture errors live solely in the existing `error` field. `recordSessionError` stops touching
`syncStatus`. (The Options history panel derives its error badge from `error`, not `syncStatus` —
verify and adjust if needed.)

### Sync engine

`src/sync/syncEngine.ts` — pure logic, injected dependencies (`HistoryPersistence`, a
`SyncTransport`, a clock), unit-tested against the in-memory persistence + a fake transport:

```ts
export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  pull(since: number): Promise<SyncPullResponse>;
}
export interface SyncEngine {
  syncNow(): Promise<SyncResult>;   // push outbox, then pull-to-drain; serialized (single-flight)
}
```

- **Outbox (push):** sessions with `syncStatus` `pending` or `failed` (and their segments) are
  pushed in bounded batches; on success → `synced`, on failure → `failed` (retried on the next
  trigger — trigger cadence is the backoff; no timer loop of its own).
- **Marking pending:** when the background finalizes a session (the existing session-end path),
  it sets `syncStatus: "pending"`. Pre-SP4 rows stay `local-only` and are swept into the first
  sync too (`local-only` sessions that are not the currently-active session count as outbox).
- **Pull:** `pull(lastCursor)` loops while `hasMore`; incoming sessions are written via a new
  `HistoryPersistence.putSession` (upsert; LWW on `updatedAt` against any local row), incoming
  segments via the existing `putSegment`; applied rows get `syncStatus: "synced"`. The cursor
  persists in `chrome.storage.local`. Pulling back rows this device pushed is harmless
  (idempotent, LWW-equal → no-op).
- **Triggers (background):** ① session teardown; ② a `chrome.alarms` period (15 min) — only fires
  work when sync is available; ③ `SYNC_NOW` runtime message from Options. All funnel into the
  single-flight `syncNow()`.
- **Availability:** engine no-ops unless the server's `/v1/capabilities` reports
  `sync.available` (cached, refreshed per trigger); server unreachable → quiet no-op (next
  trigger retries). Sync must never surface errors into the capture UX.

### Conflict model

Last-writer-wins per session record on `updatedAtMs`. Sessions are single-authored (one device
creates and finishes a session; other devices only ever *receive* it), so real conflicts require
the same record edited on two devices — which the product cannot express today. Segments are
immutable. Cross-device clock skew therefore cannot corrupt anything: LWW only ever compares
writes from the same authoring device.

## UI (SP4c)

Options page additions, minimal:
- **Sync row** in settings: status line (unavailable on this server / last synced HH:MM / N
  sessions waiting / last attempt failed) + a "Sync now" button (`SYNC_NOW` message).
- **History panel:** per-session sync badge driven by `syncStatus` (already stored; the panel
  gains the display).
- No new credentials UI (decision 5) and no new permissions (`host_permissions` already covers
  the localhost backend; `alarms` permission is added to the manifest).

## Sub-slice rollout (each its own plan + PR behind `check`)

| Slice | Contents | Proves |
|-------|----------|--------|
| **SP4a** | protocol `sync.ts` + guards; `HistoryRepository` (in-memory + sqlite); push/pull routes; `verifyApiKey` seam (WS adopts it); capabilities flag | Route integration tests (Fastify inject) against both repository impls; repository contract test suite runs on both |
| **SP4b** | `syncStatus` semantics fix; `putSession` upsert; `SyncEngine` + fetch `SyncTransport`; background triggers + cursor persistence | Engine unit tests (fake transport): outbox drain, pull apply w/ LWW, single-flight, failure→retry, availability gating |
| **SP4c** | Options sync row + history badges + `SYNC_NOW` | Component tests (existing Options test patterns) |

Manual end-to-end after SP4c: two Chrome profiles against one backend — capture on profile A,
"Sync now" on both, open the same video on profile B → the timeline replays A's transcript.

## Non-goals (deferred)

- Accounts, signup, tokens-per-user, cloud control plane (future closed-source cloud repo; this
  design only keeps its seams — `owner` column, `verifyApiKey`, protocol-typed sync API).
- Deletion propagation (tombstones) — the product has no session deletion yet; add tombstones
  when deletion ships.
- Encryption at rest / E2E encryption (the DB lives on the user's own machine; document that the
  history DB contains transcript text).
- Merge-of-multiple-prior-sessions in cache reuse (unchanged from SP3), media/audio sync (never —
  only transcripts sync), realtime sync during capture (session-end granularity is enough).
- HTTPS/remote-server support in the extension (`host_permissions` stays localhost; a self-hosted
  remote backend via port-forward/tunnel already appears local — genuine remote origins are a
  separate slice if ever needed).
