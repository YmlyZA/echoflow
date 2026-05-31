import Dexie, { type Table } from "dexie";
import type {
  HistoryPersistence,
  HistorySegmentRecord,
  HistorySessionRecord
} from "./historyStore";

export class EchoFlowHistoryDatabase extends Dexie {
  sessions!: Table<HistorySessionRecord, string>;
  segments!: Table<HistorySegmentRecord, [string, string]>;

  constructor(name = "echoflow-history") {
    super(name);

    this.version(1).stores({
      sessions: "id, startedAt, updatedAt, remoteSessionId, syncStatus",
      segments: "[sessionId+segmentId], sessionId, segmentId, startTimeMs"
    });
  }
}

export function createHistoryDatabase(
  name?: string
): EchoFlowHistoryDatabase {
  return new EchoFlowHistoryDatabase(name);
}

export function createDexieHistoryPersistence(
  database = createHistoryDatabase()
): HistoryPersistence {
  return {
    async addSession(session) {
      await database.sessions.add(session);
    },
    async getSession(sessionId) {
      return database.sessions.get(sessionId);
    },
    async listSessions() {
      const sessions = await database.sessions
        .orderBy("updatedAt")
        .reverse()
        .toArray();

      return sessions;
    },
    async updateSession(sessionId, changes) {
      await database.sessions.update(sessionId, changes);
    },
    async putSegment(segment) {
      await database.segments.put(segment);
    },
    async getSegments(sessionId) {
      const segments = await database.segments
        .where("sessionId")
        .equals(sessionId)
        .sortBy("startTimeMs");

      return segments;
    }
  };
}
