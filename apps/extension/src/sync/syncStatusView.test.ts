import { describe, expect, it } from "vitest";
import { deriveSyncStatusView } from "./syncStatusView";

const fmt = (ms: number) => `T${ms}`;

function session(syncStatus: "local-only" | "pending" | "synced" | "failed") {
  return { syncStatus };
}

describe("deriveSyncStatusView", () => {
  it("is unavailable (button disabled) when the server lacks sync or capabilities are unknown", () => {
    for (const syncAvailable of [false, null] as const) {
      const view = deriveSyncStatusView({ syncAvailable, lastSyncAtMs: null, sessions: [] }, fmt);
      expect(view.tone).toBe("unavailable");
      expect(view.label).toBe("Sync is not available on this server");
      expect(view.canSyncNow).toBe(false);
    }
  });

  it("reports a failed attempt with the waiting count", () => {
    const view = deriveSyncStatusView(
      {
        syncAvailable: true,
        lastSyncAtMs: 1000,
        sessions: [session("failed"), session("pending"), session("synced")]
      },
      fmt
    );
    expect(view.tone).toBe("failed");
    expect(view.label).toBe("Last sync attempt failed · 2 waiting");
    expect(view.canSyncNow).toBe(true);
  });

  it("counts pending, failed and local-only sessions as waiting", () => {
    const view = deriveSyncStatusView(
      {
        syncAvailable: true,
        lastSyncAtMs: null,
        sessions: [session("pending"), session("local-only"), session("synced")]
      },
      fmt
    );
    expect(view.tone).toBe("waiting");
    expect(view.label).toBe("2 sessions waiting to sync");
  });

  it("uses the singular form for one waiting session", () => {
    const view = deriveSyncStatusView(
      { syncAvailable: true, lastSyncAtMs: null, sessions: [session("pending")] },
      fmt
    );
    expect(view.label).toBe("1 session waiting to sync");
  });

  it("shows the last-synced time when nothing is waiting", () => {
    const view = deriveSyncStatusView(
      { syncAvailable: true, lastSyncAtMs: 1234, sessions: [session("synced")] },
      fmt
    );
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("Last synced T1234");
    expect(view.canSyncNow).toBe(true);
  });

  it("shows an empty state before any sync", () => {
    const view = deriveSyncStatusView(
      { syncAvailable: true, lastSyncAtMs: null, sessions: [] },
      fmt
    );
    expect(view.tone).toBe("empty");
    expect(view.label).toBe("Nothing to sync yet");
    expect(view.canSyncNow).toBe(true);
  });
});
