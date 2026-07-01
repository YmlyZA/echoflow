import type { ServerEvent } from "@echoflow/protocol";
import type {
  AudioFrame,
  SegmentEvent,
  SpeechProvider,
  TranslationProvider,
} from "../providers/types.js";
import type { SubtitleSource, SubtitleSourceStream } from "./subtitleSource.js";

export class PipelineSubtitleSource implements SubtitleSource {
  constructor(
    private readonly speechProvider: SpeechProvider,
    private readonly translationProvider: TranslationProvider,
    private readonly targetLanguage: string,
  ) {}

  open(opts: {
    onEvent: (event: ServerEvent) => void;
    onError?: (error: Error) => void;
  }): SubtitleSourceStream {
    const translationProvider = this.translationProvider;
    const targetLanguage = this.targetLanguage;

    let sourceLanguage = "unknown";
    let latestSegmentId: string | undefined;
    let pendingFinal:
      | { segmentId: string; sourceText: string; startTimeMs: number; endTimeMs: number; speakerId?: string }
      | undefined;
    let translating = false;
    let closed = false;
    let tail: Promise<void> = Promise.resolve();

    const drainTranslations = async (): Promise<void> => {
      if (translating) {
        return;
      }
      translating = true;
      try {
        while (pendingFinal !== undefined) {
          const job = pendingFinal;
          pendingFinal = undefined;
          let translatedText: string;
          try {
            translatedText = await translationProvider.translate({
              text: job.sourceText,
              sourceLanguage,
              targetLanguage,
            });
          } catch (error: unknown) {
            opts.onError?.(toError(error));
            continue;
          }
          if (closed) {
            return;
          }
          if (job.segmentId === latestSegmentId) {
            opts.onEvent({
              type: "final",
              segmentId: job.segmentId,
              sourceText: job.sourceText,
              translatedText,
              startTimeMs: job.startTimeMs,
              endTimeMs: job.endTimeMs,
              ...(job.speakerId !== undefined ? { speakerId: job.speakerId } : {}),
            });
          }
        }
      } finally {
        translating = false;
      }
    };

    const onSegment = (event: SegmentEvent): void => {
      if (event.kind === "partial" || event.kind === "final") {
        latestSegmentId = event.segmentId;
      }
      if (event.kind === "language") {
        sourceLanguage = event.sourceLanguage;
        opts.onEvent({
          type: "language",
          sourceLanguage: event.sourceLanguage,
          targetLanguage,
        });
        return;
      }
      if (event.kind === "partial") {
        tail = tail.then(() => {
          opts.onEvent({
            type: "partial",
            segmentId: event.segmentId,
            sourceText: event.text,
            ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {}),
          });
        });
        return;
      }
      pendingFinal = {
        segmentId: event.segmentId,
        sourceText: event.text,
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
        ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {}),
      };
      void drainTranslations();
    };

    const stream = this.speechProvider.open({
      onSegment,
      onError: (error) => opts.onError?.(error),
      onStatus: (state) => opts.onEvent({ type: "status", state }),
    });

    return {
      pushFrame(frame: AudioFrame): void {
        if (closed) {
          return;
        }
        stream.pushFrame(frame);
      },
      async end(): Promise<void> {
        await stream.end();
        await tail;
      },
      async close(): Promise<void> {
        closed = true;
        await Promise.all([stream.close(), translationProvider.close()]);
      },
    };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Translation failed");
}
