import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncStatusBadge } from "./SyncStatusBadge";

describe("SyncStatusBadge", () => {
  it("maps each sync status to a label and a tone class", () => {
    const cases = [
      { status: "local-only" as const, label: "Local", cls: "ef-badge-neutral" },
      { status: "pending" as const, label: "Waiting", cls: "ef-badge-waiting" },
      { status: "synced" as const, label: "Synced", cls: "ef-badge-ok" },
      { status: "failed" as const, label: "Sync failed", cls: "ef-badge-failed" }
    ];
    for (const { status, label, cls } of cases) {
      const html = renderToStaticMarkup(<SyncStatusBadge status={status} />);
      expect(html).toContain(label);
      expect(html).toContain(cls);
    }
  });
});
