import type { AudioFrameMetadata } from "@echoflow/protocol";
import { encodePcm16Mono } from "./pcm";

export interface AudioPipelineClient {
  sendAudioFrame(
    data: ArrayBuffer,
    frame: Omit<AudioFrameMetadata, "byteLength"> & { byteLength?: number },
  ): void;
  stop(reason?: string): void;
}

export interface AudioWorkletNodeLike {
  port: { onmessage: ((event: MessageEvent) => void) | null };
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface PcmAudioContextLike {
  readonly sampleRate: number;
  readonly destination: unknown;
  audioWorklet: { addModule(moduleUrl: string): Promise<void> };
  createMediaStreamSource(stream: MediaStream): { connect(destination: unknown): void };
  createWorkletNode(frameSamples: number): AudioWorkletNodeLike;
  close(): Promise<void>;
}

export interface PcmAudioContextConstructor {
  new (): PcmAudioContextLike;
}

export interface AudioPipelineOptions {
  streamId: string;
  client: AudioPipelineClient;
  outputSampleRateHz?: number;
  frameMs?: number;
  workletModuleUrl: string;
  getUserMedia?: typeof navigator.mediaDevices.getUserMedia;
  AudioContextCtor?: PcmAudioContextConstructor;
  now?: () => number;
  onCaptureEnded?: (reason: string) => void;
}

export const DEFAULT_OUTPUT_SAMPLE_RATE_HZ = 16000;
export const DEFAULT_FRAME_MS = 100;
export const PCM_WORKLET_NAME = "pcm-encoder";

export class OffscreenAudioPipeline {
  private stream: MediaStream | undefined;
  private audioContext: PcmAudioContextLike | undefined;
  private workletNode: AudioWorkletNodeLike | undefined;
  private startedAtMs = 0;
  private sequenceNumber = 0;
  private captureEndedHandler: (() => void) | undefined;
  private captureEndedFired = false;

  constructor(private readonly options: AudioPipelineOptions) {}

  async start(): Promise<void> {
    const getUserMedia =
      this.options.getUserMedia ??
      globalThis.navigator.mediaDevices.getUserMedia.bind(
        globalThis.navigator.mediaDevices,
      );
    const AudioContextCtor =
      this.options.AudioContextCtor ?? createDefaultAudioContextConstructor();
    const outputRate = this.options.outputSampleRateHz ?? DEFAULT_OUTPUT_SAMPLE_RATE_HZ;
    const frameMs = this.options.frameMs ?? DEFAULT_FRAME_MS;

    this.stream = await getUserMedia(
      buildChromeTabCaptureConstraints(this.options.streamId),
    );

    this.captureEndedHandler = () => {
      if (this.captureEndedFired) {
        return;
      }
      this.captureEndedFired = true;
      this.options.onCaptureEnded?.("capture_ended");
    };
    this.stream.getTracks().forEach((track) => {
      track.addEventListener("ended", this.captureEndedHandler!);
    });

    const context = new AudioContextCtor();
    this.audioContext = context;
    await context.audioWorklet.addModule(this.options.workletModuleUrl);

    const source = context.createMediaStreamSource(this.stream);
    // Keep original tab audio audible.
    source.connect(context.destination);

    const frameSamples = Math.round((context.sampleRate * frameMs) / 1000);
    const node = context.createWorkletNode(frameSamples);
    this.workletNode = node;
    source.connect(node);

    this.startedAtMs = this.now();
    this.sequenceNumber = 0;
    node.port.onmessage = (event) => {
      this.handlePcmFrame(event.data as Float32Array, context.sampleRate, outputRate, frameMs);
    };
  }

  async stop(reason = "client_stop"): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
    }

    if (this.captureEndedHandler) {
      this.stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", this.captureEndedHandler!);
      });
      this.captureEndedHandler = undefined;
    }

    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });

    await this.audioContext?.close();
    this.options.client.stop(reason);

    this.workletNode = undefined;
    this.stream = undefined;
    this.audioContext = undefined;
  }

  private handlePcmFrame(
    mono: Float32Array,
    inputRate: number,
    outputRate: number,
    frameMs: number,
  ): void {
    if (mono.length === 0) {
      return;
    }

    const pcm = encodePcm16Mono([mono], inputRate, outputRate);
    // pcm is a freshly allocated Int16Array, so its buffer is always a plain
    // ArrayBuffer (never SharedArrayBuffer); narrow the ArrayBufferLike type.
    const buffer = pcm.buffer as ArrayBuffer;
    this.options.client.sendAudioFrame(buffer, {
      sequenceNumber: this.sequenceNumber,
      timestampMs: this.now() - this.startedAtMs,
      durationMs: frameMs,
      byteLength: pcm.byteLength,
    });
    this.sequenceNumber += 1;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function buildChromeTabCaptureConstraints(
  streamId: string,
): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  } as MediaStreamConstraints;
}

function createDefaultAudioContextConstructor(): PcmAudioContextConstructor {
  const audioGlobal = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const NativeAudioContext = (audioGlobal.AudioContext ??
    audioGlobal.webkitAudioContext) as typeof AudioContext;

  return class implements PcmAudioContextLike {
    private readonly context = new NativeAudioContext();

    get sampleRate(): number {
      return this.context.sampleRate;
    }

    get destination(): unknown {
      return this.context.destination;
    }

    get audioWorklet(): { addModule(moduleUrl: string): Promise<void> } {
      return this.context.audioWorklet;
    }

    createMediaStreamSource(stream: MediaStream): { connect(destination: unknown): void } {
      return this.context.createMediaStreamSource(stream);
    }

    createWorkletNode(frameSamples: number): AudioWorkletNodeLike {
      return new AudioWorkletNode(this.context, PCM_WORKLET_NAME, {
        processorOptions: { frameSamples },
      }) as unknown as AudioWorkletNodeLike;
    }

    async close(): Promise<void> {
      await this.context.close();
    }
  };
}
