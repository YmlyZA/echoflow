import { randomUUID } from "node:crypto";
import {
  DEFAULT_VOLCENGINE_ASR_VAD_MS,
  type VolcengineAsrConfig,
} from "./providerConfig.js";
import { createDrainGate } from "./drainGate.js";
import { withReconnect, type ReconnectOptions } from "./reconnectingTransport.js";
import type {
  AudioFrame,
  SegmentEvent,
  SpeechProvider,
  SpeechRecognitionStream,
} from "./types.js";
import { UtteranceReconciler } from "./utteranceReconciler.js";
import {
  encodeAudioRequest,
  encodeFullClientRequest,
  parseServerMessage,
  type VolcengineAsrRequestConfig,
  type VolcengineServerMessage,
} from "./volcengineAsrProtocol.js";
import {
  connectVolcengineAsrTransport,
  type VolcengineAsrTransportFactory,
} from "./volcengineAsrTransport.js";

export class VolcengineSpeechProvider implements SpeechProvider {
  constructor(
    private readonly config: VolcengineAsrConfig,
    private readonly connect: VolcengineAsrTransportFactory = connectVolcengineAsrTransport,
    private readonly deps: { setTimer?: (fn: () => void, ms: number) => void; drainTimeoutMs?: number } = {},
  ) {}

  open(opts: {
    onSegment: (event: SegmentEvent) => void;
    onError?: (error: Error) => void;
    onStatus?: (state: "reconnecting" | "live") => void;
  }): SpeechRecognitionStream {
    const reconciler = new UtteranceReconciler();
    const requestId = randomUUID();
    let languageEmitted = false;
    let sequence = 1;
    let closed = false;
    let ending = false;
    let disposed = false;

    const drainOpts: { setTimer?: (fn: () => void, ms: number) => void; timeoutMs?: number } = {};
    if (this.deps.setTimer !== undefined) drainOpts.setTimer = this.deps.setTimer;
    if (this.deps.drainTimeoutMs !== undefined) drainOpts.timeoutMs = this.deps.drainTimeoutMs;
    const drain = createDrainGate(drainOpts);

    const configFrame = encodeFullClientRequest(
      buildRequestConfig(requestId, this.config.vadSegmentDurationMs ?? DEFAULT_VOLCENGINE_ASR_VAD_MS),
    );

    const handleMessage = (data: Buffer): void => {
      if (closed) return;
      let message: VolcengineServerMessage;
      try {
        message = parseServerMessage(data);
      } catch (error) {
        opts.onError?.(toError(error));
        return;
      }
      if (message.type === "error") {
        opts.onError?.(new Error(`Volcengine ASR error ${message.code}: ${message.message}`));
        return;
      }
      if (!languageEmitted) {
        languageEmitted = true;
        opts.onSegment({ kind: "language", sourceLanguage: message.payload.result?.language ?? "auto" });
      }
      for (const event of reconciler.reconcile(message.payload.result?.utterances ?? [])) {
        opts.onSegment(event);
        if (event.kind === "final") drain.onFinal();
      }
    };

    const reconnectOpts: ReconnectOptions = {
      onMessage: handleMessage,
      onError: (error) => { if (!closed) opts.onError?.(error); },
      initialize: (t) => {
        // Each connection numbers audio from scratch: config is sequence 1, so
        // the first audio frame is 2. Without this, a reconnect keeps the prior
        // connection's counter (advanced even by frames dropped mid-reconnect),
        // producing a mis-sequenced stream the server rejects.
        sequence = 1;
        t.send(configFrame);
      },
      onStatus: (state) => opts.onStatus?.(state),
    };
    if (this.deps.setTimer !== undefined) reconnectOpts.setTimer = this.deps.setTimer;

    const transport = withReconnect(
      (cb) => this.connect(
        {
          endpoint: this.config.endpoint,
          headers: {
            "X-Api-App-Key": this.config.appKey,
            "X-Api-Access-Key": this.config.accessKey,
            "X-Api-Resource-Id": this.config.resourceId,
            "X-Api-Request-Id": requestId,
          },
        },
        cb,
      ),
      reconnectOpts,
    );

    return {
      pushFrame(frame: AudioFrame): void {
        if (closed || ending) {
          return;
        }
        sequence += 1;
        const audio = Buffer.isBuffer(frame.data)
          ? frame.data
          : Buffer.from(frame.data);
        transport.send(encodeAudioRequest(audio, sequence, false));
      },
      async end(): Promise<void> {
        if (closed || ending) return;
        ending = true;
        sequence += 1;
        transport.send(encodeAudioRequest(Buffer.alloc(0), sequence, true));
        drain.arm();
        await drain.wait();
        closed = true;
      },
      async close(): Promise<void> {
        if (disposed) return;
        disposed = true;
        closed = true;
        transport.close();
      },
    };
  }
}

function buildRequestConfig(uid: string, vadMs: number): VolcengineAsrRequestConfig {
  return {
    user: { uid },
    audio: { format: "pcm", sample_rate: 16000, bits: 16, channel: 1, codec: "raw" },
    request: {
      model_name: "bigmodel",
      enable_punc: true,
      result_type: "single",
      show_utterances: true,
      vad_segment_duration: vadMs,
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Volcengine ASR parse failed");
}
