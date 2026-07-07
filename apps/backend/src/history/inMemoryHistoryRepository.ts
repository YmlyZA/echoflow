import type { SyncSegmentRecord, SyncSessionRecord } from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

type StoredSession = { record: SyncSessionRecord; owner: string | null; seq: number };
type StoredSegment = { record: SyncSegmentRecord; seq: number };

/** Reference implementation of the repository contract; the test double. */
export function createInMemoryHistoryRepository(): HistoryRepository {
  const sessions = new Map<string, StoredSession>();
  const segments = new Map<string, StoredSegment>();
  let seq = 0;

  return {
    async upsertSessions(records, owner) {
      for (const record of records) {
        const existing = sessions.get(record.id);
        if (existing && existing.record.updatedAtMs >= record.updatedAtMs) {
          continue;
        }
        seq += 1;
        sessions.set(record.id, { record, owner, seq });
      }
    },
    async upsertSegments(records) {
      for (const record of records) {
        const key = `${record.sessionId}:${record.segmentId}`;
        if (segments.has(key)) {
          continue;
        }
        seq += 1;
        segments.set(key, { record, seq });
      }
    },
    async changesSince(cursor, limit) {
      const rows = [
        ...[...sessions.values()].map((s) => ({
          seq: s.seq,
          session: s.record,
          segment: undefined,
        })),
        ...[...segments.values()].map((s) => ({
          seq: s.seq,
          session: undefined,
          segment: s.record,
        })),
      ]
        .filter((row) => row.seq > cursor)
        .sort((a, b) => a.seq - b.seq);

      const page = rows.slice(0, limit);
      return {
        sessions: page.flatMap((row) => (row.session ? [row.session] : [])),
        segments: page.flatMap((row) => (row.segment ? [row.segment] : [])),
        nextCursor: page.at(-1)?.seq ?? cursor,
        hasMore: rows.length > limit,
      };
    },
    async close() {
      sessions.clear();
      segments.clear();
    },
  };
}
