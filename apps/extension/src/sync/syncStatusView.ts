import type { SyncStatus } from "../history/historyStore";

export interface SyncStatusViewInput {
  /** Capabilities sync.available; null while capabilities are unknown. */
  syncAvailable: boolean | null;
  lastSyncAtMs: number | null;
  sessions: ReadonlyArray<{ id: string; syncStatus: SyncStatus }>;
  /**
   * The currently-capturing session, excluded from waiting/failed counts —
   * mirrors the engine outbox rule (isSessionActive), which never pushes it.
   */
  activeSessionId: string | null;
}

export interface SyncStatusView {
  tone: "unavailable" | "failed" | "waiting" | "ok" | "empty";
  label: string;
  canSyncNow: boolean;
}

const WAITING_STATUSES: ReadonlySet<SyncStatus> = new Set([
  "pending",
  "failed",
  "local-only"
]);

/** Pure derivation of the Options sync-status row from already-loaded state. */
export function deriveSyncStatusView(
  input: SyncStatusViewInput,
  formatTime: (ms: number) => string = defaultFormatTime
): SyncStatusView {
  if (input.syncAvailable !== true) {
    return {
      tone: "unavailable",
      label: "Sync is not available on this server",
      canSyncNow: false
    };
  }

  const relevant = input.sessions.filter(
    (session) => session.id !== input.activeSessionId
  );
  const waiting = relevant.filter((session) =>
    WAITING_STATUSES.has(session.syncStatus)
  ).length;
  const failed = relevant.filter(
    (session) => session.syncStatus === "failed"
  ).length;

  if (failed > 0) {
    return {
      tone: "failed",
      label: `${failed} ${failed === 1 ? "session" : "sessions"} could not sync`,
      canSyncNow: true
    };
  }
  if (waiting > 0) {
    return {
      tone: "waiting",
      label: `${waiting} ${waiting === 1 ? "session" : "sessions"} waiting to sync`,
      canSyncNow: true
    };
  }
  if (input.lastSyncAtMs !== null) {
    return {
      tone: "ok",
      label: `Last synced ${formatTime(input.lastSyncAtMs)}`,
      canSyncNow: true
    };
  }
  return { tone: "empty", label: "Nothing to sync yet", canSyncNow: true };
}

function defaultFormatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
