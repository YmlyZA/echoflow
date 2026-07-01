export type LanguageEvent = {
  type: "language";
  sourceLanguage: string;
  targetLanguage: string;
};

export type PartialSubtitleEvent = {
  type: "partial";
  segmentId: string;
  sourceText: string;
  translatedText?: string;
  speakerId?: string;
};

export type FinalSubtitleEvent = {
  type: "final";
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startTimeMs: number;
  endTimeMs: number;
  speakerId?: string;
};

export type ErrorEvent = {
  type: "error";
  code: string;
  message: string;
};

export type ServerEvent =
  | LanguageEvent
  | PartialSubtitleEvent
  | FinalSubtitleEvent
  | ErrorEvent;

export type SubtitleSegment = {
  sessionId: string;
  segmentId: string;
  startTimeMs: number;
  endTimeMs: number;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
  confidence?: number;
  status: "final";
  speakerId?: string;
};

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "language":
      return (
        typeof value.sourceLanguage === "string" &&
        typeof value.targetLanguage === "string"
      );
    case "partial":
      return (
        typeof value.segmentId === "string" &&
        typeof value.sourceText === "string" &&
        (!hasOwn(value, "translatedText") ||
          typeof value.translatedText === "string") &&
        (!hasOwn(value, "speakerId") || typeof value.speakerId === "string")
      );
    case "final":
      return (
        typeof value.segmentId === "string" &&
        typeof value.sourceText === "string" &&
        typeof value.translatedText === "string" &&
        typeof value.startTimeMs === "number" &&
        Number.isFinite(value.startTimeMs) &&
        typeof value.endTimeMs === "number" &&
        Number.isFinite(value.endTimeMs) &&
        (!hasOwn(value, "speakerId") || typeof value.speakerId === "string")
      );
    case "error":
      return typeof value.code === "string" && typeof value.message === "string";
    default:
      return false;
  }
}

export function makeFinalSegment(
  input: Omit<SubtitleSegment, "status">,
): SubtitleSegment {
  return { ...input, status: "final" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
