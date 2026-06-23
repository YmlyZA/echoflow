import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@echoflow/protocol";
import {
  encodeAudioRequest,
  encodeFinishSession,
  encodeStartSession,
  parseAstMessage,
} from "../providers/astProtocol.js";
import {
  connectAstTransport,
  type AstTransportFactory,
} from "../providers/astTransport.js";
import {
  counterpartAstLanguage,
  toAstLanguageCode,
} from "../providers/astLanguages.js";
import { InterpretReconciler } from "../providers/interpretReconciler.js";
import type { AudioFrame } from "../providers/types.js";
import type { SubtitleSource, SubtitleSourceStream } from "./subtitleSource.js";

export type AstSourceConfig = {
  apiKey: string;
  resourceId: string;
  endpoint: string;
};

export class InterpretationSubtitleSource implements SubtitleSource {
  constructor(
    private readonly config: AstSourceConfig,
    private readonly targetLanguage: string,
    private readonly connect: AstTransportFactory = connectAstTransport,
  ) {}

  open(opts: {
    onEvent: (event: ServerEvent) => void;
    onError?: (error: Error) => void;
  }): SubtitleSourceStream {
    const targetLanguage = this.targetLanguage;
    const targetAst = toAstLanguageCode(targetLanguage);
    const sourceAst = counterpartAstLanguage(targetAst);
    const reconciler = new InterpretReconciler();
    const sessionId = randomUUID();
    let languageEmitted = false;
    let closed = false;

    const transport = this.connect(
      {
        endpoint: this.config.endpoint,
        headers: {
          "X-Api-Key": this.config.apiKey,
          "X-Api-Resource-Id": this.config.resourceId,
          "X-Api-Request-Id": sessionId,
        },
      },
      {
        onMessage: (data) => {
          if (closed) return;
          const event = parseAstMessage(data);
          if (event.kind === "error") {
            opts.onError?.(new Error(`AST error ${event.code}: ${event.message}`));
            return;
          }
          if (event.kind === "other" || event.kind === "usage") {
            return;
          }
          if (!languageEmitted) {
            languageEmitted = true;
            opts.onEvent({ type: "language", sourceLanguage: sourceAst, targetLanguage });
          }
          for (const seg of reconciler.reconcile(event)) {
            if (seg.kind === "partial") {
              opts.onEvent({
                type: "partial",
                segmentId: seg.segmentId,
                sourceText: seg.text,
              });
            } else if (seg.kind === "final") {
              opts.onEvent({
                type: "final",
                segmentId: seg.segmentId,
                sourceText: seg.text,
                translatedText: seg.translatedText,
                startTimeMs: seg.startTimeMs,
                endTimeMs: seg.endTimeMs,
              });
            }
          }
        },
        onError: (error) => {
          if (!closed) opts.onError?.(error);
        },
        onClose: () => {
          // session drains via end(); nothing on normal close
        },
      },
    );

    transport.send(
      encodeStartSession({
        sessionId,
        resourceId: this.config.resourceId,
        sourceLanguage: sourceAst,
        targetLanguage: targetAst,
        audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
      }),
    );

    return {
      pushFrame(frame: AudioFrame): void {
        if (closed) return;
        const audio = Buffer.isBuffer(frame.data) ? frame.data : Buffer.from(frame.data);
        transport.send(encodeAudioRequest(audio, sessionId));
      },
      async end(): Promise<void> {
        if (closed) return;
        transport.send(encodeFinishSession(sessionId));
        closed = true;
      },
      async close(): Promise<void> {
        closed = true;
        transport.close();
      },
    };
  }
}
