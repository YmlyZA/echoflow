import type { ServerEvent } from "@echoflow/protocol";

const MAX_FINALIZED_TRACKED = 50;

export type SubtitleSegmentStatus = "partial" | "final";

export interface SubtitleDisplaySegment {
  segmentId: string;
  sourceText: string;
  translatedText: string;
  status: SubtitleSegmentStatus;
  speakerId?: string;
}

export interface TransientSubtitleError {
  code: string;
  message: string;
}

export interface SubtitleState {
  currentSegment: SubtitleDisplaySegment | null;
  finalizedSegmentIds: readonly string[];
  detectedSourceLanguage: string | null;
  targetLanguage: string | null;
  transientError: TransientSubtitleError | null;
  seenSpeakerIds: readonly string[];
}

export function createInitialSubtitleState(): SubtitleState {
  return {
    currentSegment: null,
    finalizedSegmentIds: [],
    detectedSourceLanguage: null,
    targetLanguage: null,
    transientError: null,
    seenSpeakerIds: []
  };
}

export function reduceSubtitleEvent(
  state: SubtitleState,
  event: ServerEvent
): SubtitleState {
  switch (event.type) {
    case "partial":
      return reducePartialEvent(state, event);
    case "final":
      return {
        ...state,
        currentSegment: {
          segmentId: event.segmentId,
          sourceText: event.sourceText,
          translatedText: event.translatedText,
          status: "final",
          ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {})
        },
        finalizedSegmentIds: appendFinalizedSegmentId(
          state.finalizedSegmentIds,
          event.segmentId
        ),
        seenSpeakerIds: trackSpeaker(state.seenSpeakerIds, event.speakerId),
        transientError: null
      };
    case "language":
      return {
        ...state,
        detectedSourceLanguage: event.sourceLanguage,
        targetLanguage: event.targetLanguage,
        transientError: null
      };
    case "error":
      return {
        ...state,
        transientError: {
          code: event.code,
          message: event.message
        }
      };
  }
}

function reducePartialEvent(
  state: SubtitleState,
  event: Extract<ServerEvent, { type: "partial" }>
): SubtitleState {
  if (state.finalizedSegmentIds.includes(event.segmentId)) {
    return state;
  }

  const previousSegment =
    state.currentSegment?.segmentId === event.segmentId
      ? state.currentSegment
      : null;

  return {
    ...state,
    currentSegment: {
      segmentId: event.segmentId,
      sourceText: event.sourceText,
      translatedText:
        event.translatedText ?? previousSegment?.translatedText ?? "",
      status: "partial",
      ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {})
    },
    seenSpeakerIds: trackSpeaker(state.seenSpeakerIds, event.speakerId),
    transientError: null
  };
}

function appendFinalizedSegmentId(
  finalizedSegmentIds: readonly string[],
  segmentId: string
): readonly string[] {
  if (finalizedSegmentIds.includes(segmentId)) {
    return finalizedSegmentIds;
  }

  return [...finalizedSegmentIds, segmentId].slice(-MAX_FINALIZED_TRACKED);
}

function trackSpeaker(
  seen: readonly string[],
  speakerId: string | undefined
): readonly string[] {
  if (speakerId === undefined || seen.includes(speakerId)) {
    return seen;
  }
  return [...seen, speakerId];
}
