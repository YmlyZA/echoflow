/**
 * History sync wire contract (SP4). The backend is a replication store, not a
 * query engine: records cross the wire as an opaque `payload` document plus
 * the few fields the server needs for ordering and conflict resolution.
 * Device-local state (`syncStatus`) never crosses the wire.
 */

export type SyncSessionRecord = {
  /** Globally unique already: `local-<timestamp>-<uuid>`. */
  id: string;
  /** Last-writer-wins clock, client-authored. */
  updatedAtMs: number;
  /** Full HistorySessionRecord (minus syncStatus). */
  payload: Record<string, unknown>;
};

export type SyncSegmentRecord = {
  sessionId: string;
  segmentId: string;
  /** Full HistorySegmentRecord; immutable once final. */
  payload: Record<string, unknown>;
};

export type SyncPushRequest = {
  sessions: SyncSessionRecord[];
  segments: SyncSegmentRecord[];
};

export type SyncPushResponse = {
  accepted: { sessions: number; segments: number };
};

export type SyncPullResponse = {
  sessions: SyncSessionRecord[];
  segments: SyncSegmentRecord[];
  /** Max sync_seq included in this page; pass as ?since= on the next pull. */
  nextCursor: number;
  /** True when the page limit was hit; pull again with nextCursor. */
  hasMore: boolean;
};

export function isSyncSessionRecord(value: unknown): value is SyncSessionRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.updatedAtMs === "number" &&
    Number.isFinite(value.updatedAtMs) &&
    isRecord(value.payload)
  );
}

export function isSyncSegmentRecord(value: unknown): value is SyncSegmentRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sessionId === "string" &&
    typeof value.segmentId === "string" &&
    isRecord(value.payload)
  );
}

export function isSyncPushRequest(value: unknown): value is SyncPushRequest {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.sessions) &&
    value.sessions.every(isSyncSessionRecord) &&
    Array.isArray(value.segments) &&
    value.segments.every(isSyncSegmentRecord)
  );
}

export function isSyncPullResponse(value: unknown): value is SyncPullResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.sessions) &&
    value.sessions.every(isSyncSessionRecord) &&
    Array.isArray(value.segments) &&
    value.segments.every(isSyncSegmentRecord) &&
    typeof value.nextCursor === "number" &&
    Number.isFinite(value.nextCursor) &&
    typeof value.hasMore === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
