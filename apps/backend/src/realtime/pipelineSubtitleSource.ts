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
    const MAX_PENDING_FINALS = 64;
    type PendingFinal = {
      segmentId: string;
      sourceText: string;
      startTimeMs: number;
      endTimeMs: number;
      speakerId?: string;
    };
    const pendingFinals: PendingFinal[] = [];
    let translating = false;
    let closed = false;
    let tail: Promise<void> = Promise.resolve();
    let idleResolvers: Array<() => void> = [];

    const resolveIdleIfDone = (): void => {
      if (pendingFinals.length === 0 && !translating) {
        const resolvers = idleResolvers;
        idleResolvers = [];
        for (const resolve of resolvers) {
          resolve();
        }
      }
    };

    const drainTranslations = async (): Promise<void> => {
      if (translating) {
        return;
      }
      translating = true;
      try {
        while (pendingFinals.length > 0) {
          const job = pendingFinals.shift()!;
          let translatedText: string;
          try {
            translatedText = await translationProvider.translate({
              text: job.sourceText,
              sourceLanguage,
              targetLanguage,
            });
          } catch (error: unknown) {
            if (closed) {
              return;
            }
            // Translation failed transiently (audit #1): emit source-only + a
            // non-fatal error, keep the session alive. Now unconditional (every
            // final is recorded), no latest-wins gate.
            opts.onEvent({
              type: "final",
              segmentId: job.segmentId,
              sourceText: job.sourceText,
              translatedText: "",
              startTimeMs: job.startTimeMs,
              endTimeMs: job.endTimeMs,
              ...(job.speakerId !== undefined ? { speakerId: job.speakerId } : {}),
            });
            opts.onEvent({
              type: "error",
              code: "translation_failed",
              message: toError(error).message,
            });
            continue;
          }
          if (closed) {
            return;
          }
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
      } finally {
        translating = false;
        resolveIdleIfDone();
      }
    };

    const onSegment = (event: SegmentEvent): void => {
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
      pendingFinals.push({
        segmentId: event.segmentId,
        sourceText: event.text,
        startTimeMs: event.startTimeMs,
        endTimeMs: event.endTimeMs,
        ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {}),
      });
      if (pendingFinals.length > MAX_PENDING_FINALS) {
        pendingFinals.shift(); // drop oldest — bounded memory under a stalled translator
        opts.onEvent({
          type: "error",
          code: "history_truncated",
          message: "Translation backlog exceeded; oldest line dropped",
        });
      }
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
        await new Promise<void>((resolve) => {
          if (pendingFinals.length === 0 && !translating) { resolve(); return; }
          idleResolvers.push(resolve);
        });
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
