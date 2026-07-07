import { afterEach, describe, expect, it } from "vitest";
import type { SyncSegmentRecord, SyncSessionRecord } from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

function session(id: string, updatedAtMs: number, extra = {}): SyncSessionRecord {
  return { id, updatedAtMs, payload: { id, updatedAt: updatedAtMs, ...extra } };
}

function segment(sessionId: string, segmentId: string): SyncSegmentRecord {
  return { sessionId, segmentId, payload: { sessionId, segmentId, sourceText: "hi" } };
}

/** Behavioral contract every HistoryRepository implementation must satisfy. */
export function describeHistoryRepositoryContract(
  makeRepository: () => Promise<HistoryRepository> | HistoryRepository,
): void {
  describe("HistoryRepository contract", () => {
    let repository: HistoryRepository;

    afterEach(async () => {
      await repository.close();
    });

    async function make(): Promise<HistoryRepository> {
      repository = await makeRepository();
      return repository;
    }

    it("returns pushed sessions and segments from changesSince(0)", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100)], null);
      await repo.upsertSegments([segment("s1", "e0:seg-1")], null);

      const page = await repo.changesSince(0, 500, null);
      expect(page.sessions.map((s) => s.id)).toEqual(["s1"]);
      expect(page.segments.map((s) => s.segmentId)).toEqual(["e0:seg-1"]);
      expect(page.nextCursor).toBeGreaterThan(0);
      expect(page.hasMore).toBe(false);
    });

    it("round-trips the payload verbatim", async () => {
      const repo = await make();
      const original = session("s1", 100, { videoKey: "youtube:x", nested: { a: [1, 2] } });
      await repo.upsertSessions([original], null);

      const page = await repo.changesSince(0, 500, null);
      expect(page.sessions[0]?.payload).toEqual(original.payload);
      expect(page.sessions[0]?.updatedAtMs).toBe(100);
    });

    it("applies LWW: newer wins, older and equal are no-ops", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100, { v: "first" })], null);
      const afterFirst = (await repo.changesSince(0, 500, null)).nextCursor;

      await repo.upsertSessions([session("s1", 50, { v: "stale" })], null);
      await repo.upsertSessions([session("s1", 100, { v: "tie" })], null);
      const unchanged = await repo.changesSince(0, 500, null);
      expect(unchanged.sessions[0]?.payload.v).toBe("first");
      expect(unchanged.nextCursor).toBe(afterFirst);

      await repo.upsertSessions([session("s1", 200, { v: "second" })], null);
      const changed = await repo.changesSince(afterFirst, 500, null);
      expect(changed.sessions.map((s) => s.id)).toEqual(["s1"]);
      expect(changed.sessions[0]?.payload.v).toBe("second");
    });

    it("treats segments as immutable (duplicate upsert is a no-op)", async () => {
      const repo = await make();
      await repo.upsertSegments([segment("s1", "e0:seg-1")], null);
      const afterFirst = (await repo.changesSince(0, 500, null)).nextCursor;

      const dupe = { ...segment("s1", "e0:seg-1"), payload: { mutated: true } };
      await repo.upsertSegments([dupe], null);

      const page = await repo.changesSince(0, 500, null);
      expect(page.segments).toHaveLength(1);
      expect(page.segments[0]?.payload).toEqual({
        sessionId: "s1",
        segmentId: "e0:seg-1",
        sourceText: "hi",
      });
      expect(page.nextCursor).toBe(afterFirst);
    });

    it("paginates in seq order with hasMore and a resumable cursor", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100)], null);
      await repo.upsertSegments(
        [segment("s1", "e0:seg-1"), segment("s1", "e0:seg-2")],
        null,
      );

      const first = await repo.changesSince(0, 2, null);
      expect(first.sessions).toHaveLength(1);
      expect(first.segments).toHaveLength(1);
      expect(first.hasMore).toBe(true);

      const second = await repo.changesSince(first.nextCursor, 2, null);
      expect(second.sessions).toHaveLength(0);
      expect(second.segments.map((s) => s.segmentId)).toEqual(["e0:seg-2"]);
      expect(second.hasMore).toBe(false);

      const third = await repo.changesSince(second.nextCursor, 2, null);
      expect(third.sessions).toHaveLength(0);
      expect(third.segments).toHaveLength(0);
      expect(third.nextCursor).toBe(second.nextCursor);
      expect(third.hasMore).toBe(false);
    });

    it("excludes rows at or below the cursor", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100)], null);
      const cursor = (await repo.changesSince(0, 500, null)).nextCursor;
      await repo.upsertSessions([session("s2", 100)], null);

      const page = await repo.changesSince(cursor, 500, null);
      expect(page.sessions.map((s) => s.id)).toEqual(["s2"]);
    });
  });
}
