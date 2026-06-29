import { describe, expect, it } from "vitest";
import { recentSessions } from "./recentSessions";
import type { HistorySessionRecord } from "../history/historyStore";

function session(id: string, startedAt: number): HistorySessionRecord {
  return { id, startedAt, updatedAt: startedAt, syncStatus: "local-only" };
}

describe("recentSessions", () => {
  it("returns newest first, capped at the limit", () => {
    const out = recentSessions(
      [session("a", 100), session("b", 300), session("c", 200)],
      2
    );
    expect(out.map((s) => s.id)).toEqual(["b", "c"]);
  });
  it("returns an empty array for no sessions", () => {
    expect(recentSessions([], 3)).toEqual([]);
  });
});
