import { randomUUID } from "node:crypto";
import type { VolcengineAsrConfig } from "./providerConfig.js";
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
  ) {}

  open(opts: {
    onSegment: (event: SegmentEvent) => void;
    onError?: (error: Error) => void;
  }): SpeechRecognitionStream {
    const reconciler = new UtteranceReconciler();
    const requestId = randomUUID();
    let languageEmitted = false;
    let sequence = 1;
    let closed = false;

    const transport = this.connect(
      {
        endpoint: this.config.endpoint,
        headers: {
          "X-Api-App-Key": this.config.appKey,
          "X-Api-Access-Key": this.config.accessKey,
          "X-Api-Resource-Id": this.config.resourceId,
          "X-Api-Request-Id": requestId,
        },
      },
      {
        onMessage: (data) => {
          if (closed) {
            return;
          }
          let message: VolcengineServerMessage;
          try {
            message = parseServerMessage(data);
          } catch (error) {
            opts.onError?.(toError(error));
            return;
          }
          if (message.type === "error") {
            opts.onError?.(
              new Error(`Volcengine ASR error ${message.code}: ${message.message}`),
            );
            return;
          }
          if (!languageEmitted) {
            languageEmitted = true;
            opts.onSegment({
              kind: "language",
              sourceLanguage: message.payload.result?.language ?? "auto",
            });
          }
          for (const event of reconciler.reconcile(
            message.payload.result?.utterances ?? [],
          )) {
            opts.onSegment(event);
          }
        },
        onError: (error) => {
          if (!closed) {
            opts.onError?.(error);
          }
        },
        onClose: () => {
          // The session drains via end(); nothing to do on a normal close.
        },
      },
    );

    transport.send(encodeFullClientRequest(buildRequestConfig(requestId)));

    return {
      pushFrame(frame: AudioFrame): void {
        if (closed) {
          return;
        }
        sequence += 1;
        const audio = Buffer.isBuffer(frame.data)
          ? frame.data
          : Buffer.from(frame.data);
        transport.send(encodeAudioRequest(audio, sequence, false));
      },
      async end(): Promise<void> {
        if (closed) {
          return;
        }
        sequence += 1;
        transport.send(encodeAudioRequest(Buffer.alloc(0), sequence, true));
        closed = true;
      },
      async close(): Promise<void> {
        closed = true;
        transport.close();
      },
    };
  }
}

function buildRequestConfig(uid: string): VolcengineAsrRequestConfig {
  return {
    user: { uid },
    audio: { format: "pcm", sample_rate: 16000, bits: 16, channel: 1, codec: "raw" },
    request: { model_name: "bigmodel", enable_punc: true },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Volcengine ASR parse failed");
}
