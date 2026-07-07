import { describe, expect, it } from "vitest";
import type {
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse
} from "@echoflow/protocol";
import {
  createInMemoryHistoryPersistence,
  type HistorySegmentRecord,
  type HistorySessionRecord
} from "../history/historyStore";
import { createSyncEngine, type SyncCursorStore } from "./syncEngine";
import type { SyncTransport } from "./syncTransport";

function makeCursorStore(initial = 0): SyncCursorStore & { value: number } {
  const store = {
    value: initial,
    async get() {
      return store.value;
    },
    async set(cursor: number) {
      store.value = cursor;
    }
  };
  return store;
}

const EMPTY_PAGE: SyncPullResponse = {
  sessions: [],
  segments: [],
  nextCursor: 0,
  hasMore: false
};

function makeTransport(pullPages: SyncPullResponse[] = []): {
  transport: SyncTransport;
  pushes: SyncPushRequest[];
  pullSinces: number[];
  failPush: boolean;
} {
  const pages = [...pullPages];
  // Single mutable object so tests can flip failPush after construction
  // (a spread copy here would silently disconnect the flag from the closure).
  const bundle = {
    pushes: [] as SyncPushRequest[],
    pullSinces: [] as number[],
    failPush: false,
    transport: undefined as unknown as SyncTransport
  };
  bundle.transport = {
    async push(request): Promise<SyncPushResponse> {
      if (bundle.failPush) {
        throw new Error("sync_push_failed_503");
      }
      bundle.pushes.push(request);
      return {
        accepted: {
          sessions: request.sessions.length,
          segments: request.segments.length
        }
      };
    },
    async pull(since) {
      bundle.pullSinces.push(since);
      return pages.shift() ?? { ...EMPTY_PAGE, nextCursor: since };
    }
  };
  return bundle;
}

function session(
  id: string,
  syncStatus: HistorySessionRecord["syncStatus"],
  updatedAt = 1000
): HistorySessionRecord {
  return { id, startedAt: 1000, updatedAt, syncStatus };
}

function segment(sessionId: string, segmentId: string): HistorySegmentRecord {
  return {
    sessionId,
    segmentId,
    startTimeMs: 0,
    endTimeMs: 500,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    sourceText: "hi",
    translatedText: "你好",
    status: "final"
  };
}

describe("syncEngine push", () => {
  it("pushes pending sessions with their segments and marks them synced", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "pending"));
    await persistence.putSegment(segment("s1", "e0:seg-1"));
    const { transport, pushes } = makeTransport();

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("ok");
    expect(result.pushedSessions).toBe(1);
    expect(result.pushedSegments).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].sessions[0]).toMatchObject({ id: "s1", updatedAtMs: 1000 });
    expect(pushes[0].sessions[0].payload).not.toHaveProperty("syncStatus");
    expect(pushes[0].segments[0]).toMatchObject({
      sessionId: "s1",
      segmentId: "e0:seg-1"
    });
    expect((await persistence.getSession("s1"))?.syncStatus).toBe("synced");
  });

  it("sweeps failed and inactive local-only sessions, skips synced and the active session", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s-failed", "failed"));
    await persistence.addSession(session("s-local", "local-only"));
    await persistence.addSession(session("s-active", "local-only"));
    await persistence.addSession(session("s-done", "synced"));
    const { transport, pushes } = makeTransport();

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport,
      isSessionActive: (id) => id === "s-active"
    });
    const result = await engine.syncNow();

    expect(result.pushedSessions).toBe(2);
    const pushedIds = pushes.flatMap((p) => p.sessions.map((s) => s.id)).sort();
    expect(pushedIds).toEqual(["s-failed", "s-local"]);
    expect((await persistence.getSession("s-active"))?.syncStatus).toBe("local-only");
    expect((await persistence.getSession("s-done"))?.syncStatus).toBe("synced");
  });

  it("marks the session failed and reports failure when push throws", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "pending"));
    const bundle = makeTransport();
    bundle.failPush = true;

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => bundle.transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("failed");
    expect(result.error).toBe("sync_push_failed_503");
    expect((await persistence.getSession("s1"))?.syncStatus).toBe("failed");
    expect(bundle.pullSinces).toHaveLength(0); // pull skipped after push failure
  });
});

describe("syncEngine pull", () => {
  it("applies foreign sessions and segments as synced and persists the cursor", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const cursorStore = makeCursorStore();
    const foreign = session("remote-1", "synced", 5000);
    const { syncStatus: _s, ...payload } = foreign;
    const page: SyncPullResponse = {
      sessions: [{ id: "remote-1", updatedAtMs: 5000, payload }],
      segments: [
        {
          sessionId: "remote-1",
          segmentId: "e0:seg-1",
          payload: { ...segment("remote-1", "e0:seg-1") }
        }
      ],
      nextCursor: 12,
      hasMore: false
    };
    const { transport } = makeTransport([page]);

    const engine = createSyncEngine({
      persistence,
      cursorStore,
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("ok");
    expect(result.pulledSessions).toBe(1);
    expect(result.pulledSegments).toBe(1);
    expect((await persistence.getSession("remote-1"))?.syncStatus).toBe("synced");
    expect(await persistence.getSegments("remote-1")).toHaveLength(1);
    expect(cursorStore.value).toBe(12);
  });

  it("LWW: keeps a local session that is same-or-newer than the incoming record", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "synced", 9000));
    const incoming = session("s1", "synced", 5000);
    const { syncStatus: _s, ...payload } = incoming;
    const page: SyncPullResponse = {
      sessions: [{ id: "s1", updatedAtMs: 5000, payload }],
      segments: [],
      nextCursor: 3,
      hasMore: false
    };
    const { transport } = makeTransport([page]);

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.pulledSessions).toBe(0);
    expect((await persistence.getSession("s1"))?.updatedAt).toBe(9000);
  });

  it("follows hasMore across pages, persisting the cursor per page", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const cursorStore = makeCursorStore();
    const s1 = session("r1", "synced", 100);
    const s2 = session("r2", "synced", 200);
    const { syncStatus: _a, ...p1 } = s1;
    const { syncStatus: _b, ...p2 } = s2;
    const pages: SyncPullResponse[] = [
      {
        sessions: [{ id: "r1", updatedAtMs: 100, payload: p1 }],
        segments: [],
        nextCursor: 1,
        hasMore: true
      },
      {
        sessions: [{ id: "r2", updatedAtMs: 200, payload: p2 }],
        segments: [],
        nextCursor: 2,
        hasMore: false
      }
    ];
    const { transport, pullSinces } = makeTransport(pages);

    const engine = createSyncEngine({
      persistence,
      cursorStore,
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.pulledSessions).toBe(2);
    expect(pullSinces).toEqual([0, 1]);
    expect(cursorStore.value).toBe(2);
  });

  it("skips malformed payloads without failing the run", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const page: SyncPullResponse = {
      sessions: [{ id: "bad", updatedAtMs: 100, payload: { nope: true } }],
      segments: [
        { sessionId: "bad", segmentId: "x", payload: { alsoNope: true } }
      ],
      nextCursor: 4,
      hasMore: false
    };
    const { transport } = makeTransport([page]);

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("ok");
    expect(result.pulledSessions).toBe(0);
    expect(result.pulledSegments).toBe(0);
    expect(await persistence.getSession("bad")).toBeUndefined();
  });
});

describe("syncEngine lifecycle", () => {
  it("reports unavailable and touches nothing when getTransport resolves null", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "pending"));

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => null
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("unavailable");
    expect((await persistence.getSession("s1"))?.syncStatus).toBe("pending");
  });

  it("coalesces concurrent syncNow calls onto one run", async () => {
    const persistence = createInMemoryHistoryPersistence();
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let transportRequests = 0;
    const { transport } = makeTransport();

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => {
        transportRequests += 1;
        await gate;
        return transport;
      }
    });

    const first = engine.syncNow();
    const second = engine.syncNow();
    expect(second).toBe(first); // same in-flight promise
    resolveGate();
    await first;
    expect(transportRequests).toBe(1);

    // After completion a new run starts fresh.
    const third = engine.syncNow();
    expect(third).not.toBe(first);
    await third;
    expect(transportRequests).toBe(2);
  });
});
