import type { SyncStatus } from "../history/historyStore";

const BADGES: Record<SyncStatus, { label: string; className: string }> = {
  "local-only": { label: "Local", className: "ef-badge ef-badge-neutral" },
  pending: { label: "Waiting", className: "ef-badge ef-badge-waiting" },
  synced: { label: "Synced", className: "ef-badge ef-badge-ok" },
  failed: { label: "Sync failed", className: "ef-badge ef-badge-failed" }
};

/** Per-session sync-state pill for the Options history list. */
export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const badge = BADGES[status];
  return <span className={badge.className}>{badge.label}</span>;
}
