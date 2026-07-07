import type { SyncStatus } from "../history/historyStore";

export interface SyncStatusViewInput {
  /** Capabilities sync.available; null while capabilities are unknown. */
  syncAvailable: boolean | null;
  lastSyncAtMs: number | null;
  sessions: ReadonlyArray<{ syncStatus: SyncStatus }>;
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

  const waiting = input.sessions.filter((session) =>
    WAITING_STATUSES.has(session.syncStatus)
  ).length;

  if (input.sessions.some((session) => session.syncStatus === "failed")) {
    return {
      tone: "failed",
      label: `Last sync attempt failed · ${waiting} waiting`,
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
