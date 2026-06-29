import type { HistorySessionRecord } from "../history/historyStore";

export function recentSessions(
  sessions: HistorySessionRecord[],
  limit: number
): HistorySessionRecord[] {
  return [...sessions]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}
