import { DatabaseSync } from "node:sqlite";
import type { SyncSegmentRecord, SyncSessionRecord } from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_sessions (
  id         TEXT PRIMARY KEY,
  owner      TEXT,
  updated_at INTEGER NOT NULL,
  sync_seq   INTEGER NOT NULL,
  payload    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_segments (
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  sync_seq   INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (session_id, segment_id)
);
CREATE TABLE IF NOT EXISTS sync_state (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_seq ON sync_sessions(sync_seq);
CREATE INDEX IF NOT EXISTS idx_sync_segments_seq ON sync_segments(sync_seq);
`;

/**
 * Production HistoryRepository on node:sqlite (built-in; zero npm deps).
 * DatabaseSync is synchronous — methods are async only to satisfy the
 * interface. Single-process access is assumed (one backend per deployment).
 */
export function createSqliteHistoryRepository(path: string): HistoryRepository {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec(`INSERT OR IGNORE INTO sync_state (k, v) VALUES ('seq', 0);`);

  const bumpSeq = db.prepare(`UPDATE sync_state SET v = v + 1 WHERE k = 'seq'`);
  const readSeq = db.prepare(`SELECT v FROM sync_state WHERE k = 'seq'`);
  const readSessionUpdatedAt = db.prepare(
    `SELECT updated_at FROM sync_sessions WHERE id = ?`,
  );
  const writeSession = db.prepare(
    `INSERT INTO sync_sessions (id, owner, updated_at, sync_seq, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       owner = excluded.owner,
       updated_at = excluded.updated_at,
       sync_seq = excluded.sync_seq,
       payload = excluded.payload`,
  );
  const segmentExists = db.prepare(
    `SELECT 1 FROM sync_segments WHERE session_id = ? AND segment_id = ?`,
  );
  const writeSegment = db.prepare(
    `INSERT INTO sync_segments (session_id, segment_id, sync_seq, payload)
     VALUES (?, ?, ?, ?)`,
  );
  const readChanges = db.prepare(
    `SELECT kind, sync_seq, id, updated_at, session_id, segment_id, payload FROM (
       SELECT 'session' AS kind, sync_seq, id, updated_at,
              NULL AS session_id, NULL AS segment_id, payload
       FROM sync_sessions WHERE sync_seq > ?
       UNION ALL
       SELECT 'segment' AS kind, sync_seq, NULL, NULL,
              session_id, segment_id, payload
       FROM sync_segments WHERE sync_seq > ?
     )
     ORDER BY sync_seq ASC
     LIMIT ?`,
  );

  function nextSeq(): number {
    bumpSeq.run();
    const row = readSeq.get() as { v: number | bigint } | undefined;
    return Number(row?.v ?? 0);
  }

  function inTransaction(fn: () => void): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    async upsertSessions(records, owner) {
      inTransaction(() => {
        for (const record of records) {
          const existing = readSessionUpdatedAt.get(record.id) as
            | { updated_at: number | bigint }
            | undefined;
          if (existing && Number(existing.updated_at) >= record.updatedAtMs) {
            continue;
          }
          writeSession.run(
            record.id,
            owner,
            record.updatedAtMs,
            nextSeq(),
            JSON.stringify(record.payload),
          );
        }
      });
    },
    async upsertSegments(records) {
      inTransaction(() => {
        for (const record of records) {
          if (segmentExists.get(record.sessionId, record.segmentId) !== undefined) {
            continue;
          }
          writeSegment.run(
            record.sessionId,
            record.segmentId,
            nextSeq(),
            JSON.stringify(record.payload),
          );
        }
      });
    },
    async changesSince(cursor, limit) {
      // Fetch limit + 1 to learn whether another page exists.
      const rows = readChanges.all(cursor, cursor, limit + 1) as Array<{
        kind: string;
        sync_seq: number | bigint;
        id: string | null;
        updated_at: number | bigint | null;
        session_id: string | null;
        segment_id: string | null;
        payload: string;
      }>;
      const page = rows.slice(0, limit);
      const sessions: SyncSessionRecord[] = [];
      const segments: SyncSegmentRecord[] = [];
      for (const row of page) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        if (row.kind === "session" && row.id !== null && row.updated_at !== null) {
          sessions.push({ id: row.id, updatedAtMs: Number(row.updated_at), payload });
        } else if (row.session_id !== null && row.segment_id !== null) {
          segments.push({
            sessionId: row.session_id,
            segmentId: row.segment_id,
            payload,
          });
        }
      }
      return {
        sessions,
        segments,
        nextCursor: page.length > 0 ? Number(page[page.length - 1]!.sync_seq) : cursor,
        hasMore: rows.length > limit,
      };
    },
    async close() {
      db.close();
    },
  };
}
