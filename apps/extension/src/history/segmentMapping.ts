import {
  makeFinalSegment,
  type FinalSubtitleEvent,
} from "@echoflow/protocol";
import type { HistorySegmentRecord } from "./historyStore";

export function finalEventToSegment(args: {
  localSessionId: string;
  event: FinalSubtitleEvent;
  sourceLanguage: string;
  targetLanguage: string;
  videoStartSec?: number;
  videoEndSec?: number;
}): HistorySegmentRecord {
  return {
    ...makeFinalSegment({
      sessionId: args.localSessionId,
      segmentId: args.event.segmentId,
      startTimeMs: args.event.startTimeMs,
      endTimeMs: args.event.endTimeMs,
      sourceLanguage: args.sourceLanguage,
      targetLanguage: args.targetLanguage,
      sourceText: args.event.sourceText,
      translatedText: args.event.translatedText,
      ...(args.event.speakerId !== undefined
        ? { speakerId: args.event.speakerId }
        : {}),
    }),
    ...(args.videoStartSec !== undefined
      ? { videoStartSec: args.videoStartSec }
      : {}),
    ...(args.videoEndSec !== undefined
      ? { videoEndSec: args.videoEndSec }
      : {}),
  };
}
