import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyncStatusView } from "./syncStatusView";
import { SyncSection } from "./SyncSection";

const okView: SyncStatusView = {
  tone: "ok",
  label: "Last synced 12:30",
  canSyncNow: true
};

describe("SyncSection", () => {
  it("shows the status label and an enabled Sync now button", () => {
    const html = renderToStaticMarkup(
      <SyncSection view={okView} syncing={false} onSyncNow={() => {}} />
    );
    expect(html).toContain("Last synced 12:30");
    expect(html).toContain("Sync now");
    expect(html).not.toContain("disabled");
  });

  it("disables the button and hides the label behind Syncing while a sync runs", () => {
    const html = renderToStaticMarkup(
      <SyncSection view={okView} syncing={true} onSyncNow={() => {}} />
    );
    expect(html).toContain("Syncing");
    expect(html).toContain("disabled");
  });

  it("disables the button when sync is unavailable", () => {
    const html = renderToStaticMarkup(
      <SyncSection
        view={{
          tone: "unavailable",
          label: "Sync is not available on this server",
          canSyncNow: false
        }}
        syncing={false}
        onSyncNow={() => {}}
      />
    );
    expect(html).toContain("Sync is not available on this server");
    expect(html).toContain("disabled");
  });

  it("carries the tone as a class for styling", () => {
    const html = renderToStaticMarkup(
      <SyncSection
        view={{ tone: "failed", label: "Last sync attempt failed · 1 waiting", canSyncNow: true }}
        syncing={false}
        onSyncNow={() => {}}
      />
    );
    expect(html).toContain("ef-sync-failed");
  });
});
