import {
  makeFinalSegment,
  type FinalSubtitleEvent,
  type SubtitleSegment,
} from "@echoflow/protocol";

export function finalEventToSegment(args: {
  localSessionId: string;
  event: FinalSubtitleEvent;
  sourceLanguage: string;
  targetLanguage: string;
}): SubtitleSegment {
  return makeFinalSegment({
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
  });
}
