import type {
  SyncPullResponse,
  SyncSegmentRecord,
  SyncSessionRecord,
} from "@echoflow/protocol";

/**
 * Server-side replication store for extension history. Mirrors the provider
 * pattern: an interface with an in-memory implementation (tests) and a
 * node:sqlite implementation (production).
 *
 * `owner` is nullable cloud insurance: stored on session upserts, ignored on
 * reads (single-user deployments pass null everywhere).
 */
export interface HistoryRepository {
  /** LWW per record: incoming updatedAtMs <= stored is a no-op (ties keep stored). */
  upsertSessions(sessions: SyncSessionRecord[], owner: string | null): Promise<void>;
  /** Segments are immutable: an existing (sessionId, segmentId) is a no-op. */
  upsertSegments(segments: SyncSegmentRecord[], owner: string | null): Promise<void>;
  /**
   * Rows with sync_seq > cursor in seq order, at most `limit` rows total
   * (sessions + segments combined). nextCursor = max seq returned, or the
   * cursor itself when nothing changed.
   */
  changesSince(
    cursor: number,
    limit: number,
    owner: string | null,
  ): Promise<SyncPullResponse>;
  close(): Promise<void>;
}
