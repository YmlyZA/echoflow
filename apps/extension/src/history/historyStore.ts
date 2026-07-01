import type { SubtitleSegment } from "@echoflow/protocol";
import { createDexieHistoryPersistence } from "./db";
import { assignSpeakerNumbers } from "../subtitles/speakerDisplay";

export type SyncStatus = "local-only" | "pending" | "synced" | "failed";

export interface HistorySessionError {
  code: string;
  message: string;
  occurredAt: number;
}

export interface HistorySessionRecord {
  id: string;
  startedAt: number;
  updatedAt: number;
  sourceLanguage?: string;
  targetLanguage?: string;
  remoteSessionId?: string;
  syncStatus: SyncStatus;
  error?: HistorySessionError;
}

export type HistorySegmentRecord = SubtitleSegment;

export type AppendableSubtitleSegment =
  | SubtitleSegment
  | (Omit<SubtitleSegment, "status"> & { status: "partial" });

export interface CreateLocalSessionInput {
  startedAt?: number;
  sourceLanguage?: string;
  targetLanguage?: string;
  remoteSessionId?: string;
  syncStatus?: SyncStatus;
  now?: () => number;
}

export interface RecordSessionErrorInput {
  code: string;
  message: string;
  occurredAt?: number;
}

export interface HistoryPersistence {
  addSession(session: HistorySessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<HistorySessionRecord | undefined>;
  listSessions(): Promise<HistorySessionRecord[]>;
  updateSession(
    sessionId: string,
    changes: Partial<HistorySessionRecord>
  ): Promise<void>;
  putSegment(segment: HistorySegmentRecord): Promise<void>;
  getSegments(sessionId: string): Promise<HistorySegmentRecord[]>;
}

export interface HistoryStore {
  createLocalSession(
    input?: CreateLocalSessionInput
  ): Promise<HistorySessionRecord>;
  listSessions(): Promise<HistorySessionRecord[]>;
  getSession(sessionId: string): Promise<HistorySessionRecord | undefined>;
  appendSegment(segment: AppendableSubtitleSegment): Promise<void>;
  getSessionSegments(sessionId: string): Promise<HistorySegmentRecord[]>;
  recordSessionError(
    sessionId: string,
    error: RecordSessionErrorInput
  ): Promise<void>;
  updateSessionLanguages(
    sessionId: string,
    changes: { sourceLanguage?: string; targetLanguage?: string; updatedAt?: number }
  ): Promise<void>;
  exportSessionAsText(sessionId: string): Promise<string>;
  exportSessionAsJson(sessionId: string): Promise<string>;
}

export function createHistoryStore(
  persistence: HistoryPersistence = createDexieHistoryPersistence()
): HistoryStore {
  return {
    async createLocalSession(input = {}) {
      const timestamp = input.startedAt ?? input.now?.() ?? Date.now();
      const session: HistorySessionRecord = {
        id: `local-${timestamp}`,
        startedAt: timestamp,
        updatedAt: timestamp,
        syncStatus: input.syncStatus ?? "local-only"
      };

      if (input.sourceLanguage) {
        session.sourceLanguage = input.sourceLanguage;
      }

      if (input.targetLanguage) {
        session.targetLanguage = input.targetLanguage;
      }

      if (input.remoteSessionId) {
        session.remoteSessionId = input.remoteSessionId;
      }

      await persistence.addSession(session);

      return session;
    },
    listSessions() {
      return persistence.listSessions();
    },
    getSession(sessionId) {
      return persistence.getSession(sessionId);
    },
    async appendSegment(segment) {
      if (segment.status !== "final") {
        return;
      }

      await persistence.putSegment(segment);
    },
    getSessionSegments(sessionId) {
      return persistence.getSegments(sessionId);
    },
    async recordSessionError(sessionId, error) {
      const occurredAt = error.occurredAt ?? Date.now();

      await persistence.updateSession(sessionId, {
        error: {
          code: error.code,
          message: error.message,
          occurredAt
        },
        syncStatus: "failed",
        updatedAt: occurredAt
      });
    },
    async updateSessionLanguages(sessionId, changes) {
      const updatedAt = changes.updatedAt ?? Date.now();
      const update: Partial<HistorySessionRecord> = { updatedAt };

      if (changes.sourceLanguage !== undefined) {
        update.sourceLanguage = changes.sourceLanguage;
      }
      if (changes.targetLanguage !== undefined) {
        update.targetLanguage = changes.targetLanguage;
      }

      await persistence.updateSession(sessionId, update);
    },
    async exportSessionAsText(sessionId) {
      const { session, segments } = await loadSessionExportData(
        persistence,
        sessionId
      );

      return formatSessionText(session, segments);
    },
    async exportSessionAsJson(sessionId) {
      const { session, segments } = await loadSessionExportData(
        persistence,
        sessionId
      );
      const speakerNumbers = assignSpeakerNumbers(
        segments
          .map((s) => s.speakerId)
          .filter((id): id is string => id !== undefined)
      );
      const enriched = segments.map((segment) =>
        segment.speakerId !== undefined
          ? { ...segment, speakerNumber: speakerNumbers.get(segment.speakerId) }
          : segment
      );

      return JSON.stringify({ session, segments: enriched }, null, 2);
    }
  };
}

export function createInMemoryHistoryPersistence(): HistoryPersistence {
  const sessions = new Map<string, HistorySessionRecord>();
  const segments = new Map<string, HistorySegmentRecord>();

  return {
    async addSession(session) {
      sessions.set(session.id, { ...session });
    },
    async getSession(sessionId) {
      const session = sessions.get(sessionId);

      return session ? cloneSession(session) : undefined;
    },
    async listSessions() {
      return Array.from(sessions.values())
        .map(cloneSession)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    },
    async updateSession(sessionId, changes) {
      const session = sessions.get(sessionId);

      if (!session) {
        return;
      }

      sessions.set(sessionId, {
        ...session,
        ...changes
      });
    },
    async putSegment(segment) {
      segments.set(getSegmentKey(segment), { ...segment });
    },
    async getSegments(sessionId) {
      return Array.from(segments.values())
        .filter((segment) => segment.sessionId === sessionId)
        .sort((left, right) => left.startTimeMs - right.startTimeMs)
        .map((segment) => ({ ...segment }));
    }
  };
}

async function loadSessionExportData(
  persistence: HistoryPersistence,
  sessionId: string
): Promise<{
  session: HistorySessionRecord;
  segments: HistorySegmentRecord[];
}> {
  const session = await persistence.getSession(sessionId);

  if (!session) {
    throw new Error("History session not found");
  }

  const segments = await persistence.getSegments(sessionId);

  return { session, segments };
}

function formatSessionText(
  session: HistorySessionRecord,
  segments: HistorySegmentRecord[]
): string {
  const lines = [
    "EchoFlow transcript",
    `Session: ${session.id}`,
    `Languages: ${session.sourceLanguage ?? "unknown"} -> ${
      session.targetLanguage ?? "unknown"
    }`,
    ""
  ];

  const speakerNumbers = assignSpeakerNumbers(
    segments.map((s) => s.speakerId).filter((id): id is string => id !== undefined)
  );
  const multiSpeaker = speakerNumbers.size >= 2;

  segments.forEach((segment, index) => {
    if (index > 0) {
      lines.push("");
    }

    const prefix =
      multiSpeaker && segment.speakerId
        ? `Speaker ${speakerNumbers.get(segment.speakerId)}: `
        : "";

    lines.push(
      `[${formatTimestamp(segment.startTimeMs)} - ${formatTimestamp(
        segment.endTimeMs
      )}]`,
      `${prefix}${segment.sourceText}`,
      segment.translatedText
    );
  });

  return lines.join("\n");
}

function formatTimestamp(timeMs: number): string {
  const totalSeconds = Math.floor(timeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor(timeMs % 1000);

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}.${String(milliseconds).padStart(3, "0")}`;
}

function getSegmentKey(segment: HistorySegmentRecord): string {
  return `${segment.sessionId}:${segment.segmentId}`;
}

function cloneSession(session: HistorySessionRecord): HistorySessionRecord {
  const clone = { ...session };

  if (session.error) {
    clone.error = { ...session.error };
  }

  return clone;
}
