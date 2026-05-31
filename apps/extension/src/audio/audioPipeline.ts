import type { AudioFrameMetadata } from "@echoflow/protocol";

export interface AudioPipelineClient {
  sendAudioFrame(
    data: Blob,
    frame: Omit<AudioFrameMetadata, "byteLength"> & { byteLength?: number }
  ): void;
  stop(reason?: string): void;
}

export interface AudioPipelineOptions {
  streamId: string;
  client: AudioPipelineClient;
  chunkMs?: number;
  mimeType?: string;
  getUserMedia?: typeof navigator.mediaDevices.getUserMedia;
  AudioContextCtor?: AudioContextConstructor;
  MediaRecorderCtor?: MediaRecorderConstructor;
  now?: () => number;
}

export interface AudioContextConstructor {
  new (): Pick<
    AudioContext,
    "createMediaStreamSource" | "destination" | "close"
  >;
}

export interface MediaRecorderConstructor {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
}

export const DEFAULT_AUDIO_CHUNK_MS = 250;
export const DEFAULT_AUDIO_MIME_TYPE = "audio/webm";

export class OffscreenAudioPipeline {
  private stream: MediaStream | undefined;
  private audioContext:
    | Pick<AudioContext, "createMediaStreamSource" | "destination" | "close">
    | undefined;
  private recorder: MediaRecorder | undefined;
  private startedAtMs = 0;
  private sequenceNumber = 0;

  constructor(private readonly options: AudioPipelineOptions) {}

  async start(): Promise<void> {
    const getUserMedia =
      this.options.getUserMedia ??
      globalThis.navigator.mediaDevices.getUserMedia.bind(
        globalThis.navigator.mediaDevices
      );
    const audioGlobal = globalThis as typeof globalThis & {
      webkitAudioContext?: AudioContextConstructor;
    };
    const AudioContextCtor =
      this.options.AudioContextCtor ??
      ((audioGlobal.AudioContext ??
        audioGlobal.webkitAudioContext) as AudioContextConstructor);
    const MediaRecorderCtor =
      this.options.MediaRecorderCtor ??
      (globalThis.MediaRecorder as MediaRecorderConstructor);

    this.stream = await getUserMedia(
      buildChromeTabCaptureConstraints(this.options.streamId)
    );
    this.audioContext = new AudioContextCtor();
    this.audioContext
      .createMediaStreamSource(this.stream)
      .connect(this.audioContext.destination);

    this.startedAtMs = this.now();
    this.sequenceNumber = 0;
    this.recorder = new MediaRecorderCtor(this.stream, {
      mimeType: this.options.mimeType ?? DEFAULT_AUDIO_MIME_TYPE
    });
    this.recorder.ondataavailable = (event) => {
      this.handleChunk(event.data);
    };
    this.recorder.start(this.options.chunkMs ?? DEFAULT_AUDIO_CHUNK_MS);
  }

  async stop(reason = "client_stop"): Promise<void> {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }

    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });

    await this.audioContext?.close();
    this.options.client.stop(reason);

    this.recorder = undefined;
    this.stream = undefined;
    this.audioContext = undefined;
  }

  private handleChunk(data: Blob): void {
    if (data.size === 0) {
      return;
    }

    this.options.client.sendAudioFrame(data, {
      sequenceNumber: this.sequenceNumber,
      timestampMs: this.now() - this.startedAtMs,
      durationMs: this.options.chunkMs ?? DEFAULT_AUDIO_CHUNK_MS,
      byteLength: data.size
    });
    this.sequenceNumber += 1;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function buildChromeTabCaptureConstraints(
  streamId: string
): MediaStreamConstraints {
  return {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  } as MediaStreamConstraints;
}
