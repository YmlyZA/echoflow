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
};

export type FinalSubtitleEvent = {
  type: "final";
  segmentId: string;
  sourceText: string;
  translatedText: string;
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
          typeof value.translatedText === "string")
      );
    case "final":
      return (
        typeof value.segmentId === "string" &&
        typeof value.sourceText === "string" &&
        typeof value.translatedText === "string"
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
