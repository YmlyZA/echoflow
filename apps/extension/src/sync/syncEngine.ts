import type {
  SyncPushRequest,
  SyncSegmentRecord,
  SyncSessionRecord
} from "@echoflow/protocol";
import type {
  HistoryPersistence,
  HistorySegmentRecord,
  HistorySessionRecord
} from "../history/historyStore";
import type { SyncTransport } from "./syncTransport";

export interface SyncCursorStore {
  get(): Promise<number>;
  set(cursor: number): Promise<void>;
}

export interface SyncResult {
  status: "ok" | "failed" | "unavailable";
  pushedSessions: number;
  pushedSegments: number;
  pulledSessions: number;
  pulledSegments: number;
  error?: string;
}

export interface SyncEngineOptions {
  persistence: HistoryPersistence;
  cursorStore: SyncCursorStore;
  /** Resolved per run; null = sync unavailable right now (unconfigured server / capability off). */
  getTransport: () => Promise<SyncTransport | null>;
  /** True for the session currently being captured — excluded from the outbox. */
  isSessionActive?: (sessionId: string) => boolean;
}

export interface SyncEngine {
  syncNow(): Promise<SyncResult>;
}

const OUTBOX_STATUSES: ReadonlySet<HistorySessionRecord["syncStatus"]> = new Set([
  "pending",
  "failed",
  "local-only"
]);

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  let inFlight: Promise<SyncResult> | null = null;

  return {
    syncNow() {
      if (inFlight !== null) {
        return inFlight; // coalesce concurrent triggers onto the running sync
      }
      inFlight = run(options).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
}

async function run(options: SyncEngineOptions): Promise<SyncResult> {
  const result: SyncResult = {
    status: "ok",
    pushedSessions: 0,
    pushedSegments: 0,
    pulledSessions: 0,
    pulledSegments: 0
  };

  const transport = await options.getTransport();
  if (transport === null) {
    return { ...result, status: "unavailable" };
  }

  try {
    await pushOutbox(options, transport, result);
    await pullChanges(options, transport, result);
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

async function pushOutbox(
  options: SyncEngineOptions,
  transport: SyncTransport,
  result: SyncResult
): Promise<void> {
  const sessions = await options.persistence.listSessions();
  const outbox = sessions.filter(
    (session) =>
      OUTBOX_STATUSES.has(session.syncStatus) &&
      !(options.isSessionActive?.(session.id) ?? false)
  );

  for (const session of outbox) {
    const segments = await options.persistence.getSegments(session.id);
    try {
      await transport.push(toPushRequest(session, segments));
    } catch (error) {
      // Server likely unreachable: mark, stop pushing, skip pull (it would
      // fail the same way). The next trigger retries.
      await options.persistence.updateSession(session.id, { syncStatus: "failed" });
      throw error;
    }
    await options.persistence.updateSession(session.id, { syncStatus: "synced" });
    result.pushedSessions += 1;
    result.pushedSegments += segments.length;
  }
}

function toPushRequest(
  session: HistorySessionRecord,
  segments: HistorySegmentRecord[]
): SyncPushRequest {
  const { syncStatus: _syncStatus, ...payload } = session;
  return {
    sessions: [
      { id: session.id, updatedAtMs: session.updatedAt, payload: toWirePayload(payload) }
    ],
    segments: segments.map((segment) => ({
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      payload: toWirePayload(segment)
    }))
  };
}

/** Interfaces lack index signatures; the spread + assertion bridges to the wire's opaque payload. */
function toWirePayload(value: object): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}

async function pullChanges(
  options: SyncEngineOptions,
  transport: SyncTransport,
  result: SyncResult
): Promise<void> {
  let cursor = await options.cursorStore.get();

  for (;;) {
    const page = await transport.pull(cursor);

    for (const record of page.sessions) {
      if (await applySession(options.persistence, record)) {
        result.pulledSessions += 1;
      }
    }
    for (const record of page.segments) {
      if (await applySegment(options.persistence, record)) {
        result.pulledSegments += 1;
      }
    }

    if (page.nextCursor > cursor) {
      cursor = page.nextCursor;
      await options.cursorStore.set(cursor);
    } else if (page.hasMore) {
      // Defensive: refuse to loop without cursor progress.
      return;
    }
    if (!page.hasMore) {
      return;
    }
  }
}

async function applySession(
  persistence: HistoryPersistence,
  record: SyncSessionRecord
): Promise<boolean> {
  const payload = record.payload;
  if (
    payload.id !== record.id ||
    typeof payload.startedAt !== "number" ||
    typeof payload.updatedAt !== "number"
  ) {
    return false; // malformed foreign payload: skip, never corrupt local history
  }

  const local = await persistence.getSession(record.id);
  if (local !== undefined && local.updatedAt >= record.updatedAtMs) {
    return false; // LWW: local same-or-newer wins (a device's own echo lands here)
  }

  await persistence.putSession({
    ...(payload as unknown as Omit<HistorySessionRecord, "syncStatus">),
    syncStatus: "synced"
  });
  return true;
}

async function applySegment(
  persistence: HistoryPersistence,
  record: SyncSegmentRecord
): Promise<boolean> {
  const payload = record.payload;
  if (
    payload.sessionId !== record.sessionId ||
    payload.segmentId !== record.segmentId ||
    typeof payload.sourceText !== "string" ||
    payload.status !== "final"
  ) {
    return false;
  }

  await persistence.putSegment(payload as unknown as HistorySegmentRecord);
  return true;
}
