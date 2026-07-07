import type { SyncStatusView } from "./syncStatusView";

export interface SyncSectionProps {
  view: SyncStatusView;
  syncing: boolean;
  onSyncNow: () => void;
}

/** Presentational sync-status row for the Options history panel. */
export function SyncSection({ view, syncing, onSyncNow }: SyncSectionProps) {
  return (
    <div className="ef-sync-row">
      <span className={`ef-sync-status ef-sync-${view.tone}`} role="status">
        {syncing ? "Syncing…" : view.label}
      </span>
      <button
        type="button"
        className="ef-secondary"
        disabled={!view.canSyncNow || syncing}
        onClick={onSyncNow}
      >
        Sync now
      </button>
    </div>
  );
}
