import { describe, expect, it } from "vitest";
import { deriveSyncStatusView } from "./syncStatusView";

const fmt = (ms: number) => `T${ms}`;

function session(
  id: string,
  syncStatus: "local-only" | "pending" | "synced" | "failed"
) {
  return { id, syncStatus };
}

function derive(input: {
  syncAvailable?: boolean | null;
  lastSyncAtMs?: number | null;
  sessions?: Array<{ id: string; syncStatus: "local-only" | "pending" | "synced" | "failed" }>;
  activeSessionId?: string | null;
}) {
  return deriveSyncStatusView(
    {
      syncAvailable: input.syncAvailable === undefined ? true : input.syncAvailable,
      lastSyncAtMs: input.lastSyncAtMs ?? null,
      sessions: input.sessions ?? [],
      activeSessionId: input.activeSessionId ?? null
    },
    fmt
  );
}

describe("deriveSyncStatusView", () => {
  it("is unavailable (button disabled) when the server lacks sync or capabilities are unknown", () => {
    for (const syncAvailable of [false, null] as const) {
      const view = derive({ syncAvailable });
      expect(view.tone).toBe("unavailable");
      expect(view.label).toBe("Sync is not available on this server");
      expect(view.canSyncNow).toBe(false);
    }
  });

  it("excludes the actively-capturing session from the waiting count", () => {
    const view = derive({
      sessions: [session("active", "local-only"), session("done", "synced")],
      activeSessionId: "active"
    });
    expect(view.tone).toBe("empty");
    expect(view.label).toBe("Nothing to sync yet");
  });

  it("reports failed sessions with an honest per-session label", () => {
    const view = derive({
      lastSyncAtMs: 1000,
      sessions: [session("a", "failed"), session("b", "pending"), session("c", "synced")]
    });
    expect(view.tone).toBe("failed");
    expect(view.label).toBe("1 session could not sync");
    expect(view.canSyncNow).toBe(true);
  });

  it("pluralizes the failed label", () => {
    const view = derive({
      sessions: [session("a", "failed"), session("b", "failed")]
    });
    expect(view.label).toBe("2 sessions could not sync");
  });

  it("excludes the active session from the failed check too (rule is by id)", () => {
    const view = derive({
      lastSyncAtMs: 500,
      sessions: [session("active", "failed"), session("done", "synced")],
      activeSessionId: "active"
    });
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("Last synced T500");
  });

  it("counts pending, failed and local-only sessions as waiting", () => {
    const view = derive({
      sessions: [session("a", "pending"), session("b", "local-only"), session("c", "synced")]
    });
    expect(view.tone).toBe("waiting");
    expect(view.label).toBe("2 sessions waiting to sync");
  });

  it("uses the singular form for one waiting session", () => {
    const view = derive({ sessions: [session("a", "pending")] });
    expect(view.label).toBe("1 session waiting to sync");
  });

  it("shows the last-synced time when nothing is waiting", () => {
    const view = derive({ lastSyncAtMs: 1234, sessions: [session("a", "synced")] });
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("Last synced T1234");
    expect(view.canSyncNow).toBe(true);
  });

  it("shows an empty state before any sync", () => {
    const view = derive({});
    expect(view.tone).toBe("empty");
    expect(view.label).toBe("Nothing to sync yet");
    expect(view.canSyncNow).toBe(true);
  });
});
