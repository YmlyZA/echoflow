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
import { toAstLanguageCode } from "../providers/astLanguages.js";
import { InterpretReconciler } from "../providers/interpretReconciler.js";
import type { AudioFrame } from "../providers/types.js";
import type { SubtitleSource, SubtitleSourceStream } from "./subtitleSource.js";
import { withReconnect, type ReconnectOptions } from "../providers/reconnectingTransport.js";
import { createDrainGate } from "../providers/drainGate.js";

export type AstSourceConfig = {
  apiKey: string;
  resourceId: string;
  endpoint: string;
};

export class InterpretationSubtitleSource implements SubtitleSource {
  constructor(
    private readonly config: AstSourceConfig,
    private readonly sourceLanguage: string,
    private readonly targetLanguage: string,
    private readonly connect: AstTransportFactory = connectAstTransport,
    private readonly deps: { setTimer?: (fn: () => void, ms: number) => void; drainTimeoutMs?: number } = {},
  ) {}

  open(opts: {
    onEvent: (event: ServerEvent) => void;
    onError?: (error: Error) => void;
  }): SubtitleSourceStream {
    const targetLanguage = this.targetLanguage;
    const targetAst = toAstLanguageCode(targetLanguage);
    const sourceAst = toAstLanguageCode(this.sourceLanguage);
    const reconciler = new InterpretReconciler();
    const sessionId = randomUUID();
    let languageEmitted = false;
    let closed = false;

    const drainOpts: { setTimer?: (fn: () => void, ms: number) => void; timeoutMs?: number } = {};
    if (this.deps.setTimer !== undefined) drainOpts.setTimer = this.deps.setTimer;
    if (this.deps.drainTimeoutMs !== undefined) drainOpts.timeoutMs = this.deps.drainTimeoutMs;
    const drain = createDrainGate(drainOpts);

    const startFrame = encodeStartSession({
      sessionId,
      resourceId: this.config.resourceId,
      sourceLanguage: sourceAst,
      targetLanguage: targetAst,
      audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
    });

    const handleMessage = (data: Buffer): void => {
      if (closed) return;
      const event = parseAstMessage(data);
      if (event.kind === "error") {
        opts.onError?.(new Error(`AST error ${event.code}: ${event.message}`));
        return;
      }
      if (event.kind === "other" || event.kind === "usage") return;
      if (!languageEmitted) {
        languageEmitted = true;
        opts.onEvent({ type: "language", sourceLanguage: sourceAst, targetLanguage });
      }
      for (const seg of reconciler.reconcile(event)) {
        if (seg.kind === "partial") {
          opts.onEvent({ type: "partial", segmentId: seg.segmentId, sourceText: seg.text });
        } else if (seg.kind === "final") {
          opts.onEvent({
            type: "final",
            segmentId: seg.segmentId,
            sourceText: seg.text,
            translatedText: seg.translatedText,
            startTimeMs: seg.startTimeMs,
            endTimeMs: seg.endTimeMs,
          });
          drain.onFinal();
        }
      }
    };

    const reconnectOpts: ReconnectOptions = {
      onMessage: handleMessage,
      onError: (error) => { if (!closed) opts.onError?.(error); },
      initialize: (t) => t.send(startFrame),
      onStatus: (state) => opts.onEvent({ type: "status", state }),
    };
    if (this.deps.setTimer !== undefined) reconnectOpts.setTimer = this.deps.setTimer;

    const transport = withReconnect(
      (cb) => this.connect(
        {
          endpoint: this.config.endpoint,
          headers: {
            "X-Api-Key": this.config.apiKey,
            "X-Api-Resource-Id": this.config.resourceId,
            "X-Api-Request-Id": sessionId,
          },
        },
        cb,
      ),
      reconnectOpts,
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
        drain.arm();
        await drain.wait();
        closed = true;
      },
      async close(): Promise<void> {
        closed = true;
        transport.close();
      },
    };
  }
}
