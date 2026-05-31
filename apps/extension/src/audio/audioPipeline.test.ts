import { beforeEach, describe, expect, it, vi } from "vitest";
import { OffscreenAudioPipeline, type AudioPipelineClient } from "./audioPipeline";

describe("OffscreenAudioPipeline", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    FakeAudioContext.instances = [];
  });

  it("resolves a Chrome tab capture stream id with desktop media constraints", async () => {
    const getUserMedia = vi.fn(async () => createStream());
    const pipeline = createPipeline({ getUserMedia });

    await pipeline.start();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: "stream-1"
        }
      },
      video: false
    });
  });

  it("connects captured audio to the destination to preserve playback", async () => {
    const pipeline = createPipeline();

    await pipeline.start();

    expect(FakeAudioContext.instances[0].source.connectedTo).toBe(
      FakeAudioContext.instances[0].destination
    );
  });

  it("sends recorder chunks to the realtime client with sequence metadata", async () => {
    const client = createClient();
    const pipeline = createPipeline({ client });

    await pipeline.start();
    FakeMediaRecorder.instances[0].emitChunk(new Blob(["audio"]));

    expect(client.sendAudioFrame).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        sequenceNumber: 0,
        timestampMs: expect.any(Number)
      })
    );
  });

  it("stops recorder, stream tracks, audio context, and realtime client", async () => {
    const stream = createStream();
    const client = createClient();
    const pipeline = createPipeline({
      client,
      getUserMedia: vi.fn(async () => stream)
    });

    await pipeline.start();
    await pipeline.stop("user_stop");

    expect(FakeMediaRecorder.instances[0].state).toBe("inactive");
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
    expect(FakeAudioContext.instances[0].closed).toBe(true);
    expect(client.stop).toHaveBeenCalledWith("user_stop");
  });
});

function createPipeline(
  overrides: Partial<ConstructorParameters<typeof OffscreenAudioPipeline>[0]> = {}
): OffscreenAudioPipeline {
  return new OffscreenAudioPipeline({
    streamId: "stream-1",
    client: createClient(),
    getUserMedia: vi.fn(async () => createStream()),
    AudioContextCtor: FakeAudioContext,
    MediaRecorderCtor: FakeMediaRecorder,
    chunkMs: 250,
    now: () => 1000,
    ...overrides
  });
}

function createClient(): AudioPipelineClient {
  return {
    sendAudioFrame: vi.fn(),
    stop: vi.fn()
  };
}

function createStream(): MediaStream {
  const tracks = [{ stop: vi.fn() }];

  return {
    getTracks: () => tracks
  } as unknown as MediaStream;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  destination = {};
  source = {
    connectedTo: undefined as unknown,
    connect: vi.fn((destination: unknown) => {
      this.source.connectedTo = destination;
    })
  };
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(): { connect(destination: unknown): void } {
    return this.source;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;

  constructor(
    readonly stream: MediaStream,
    readonly options?: MediaRecorderOptions
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
  }

  emitChunk(data: Blob): void {
    this.ondataavailable?.({ data } as BlobEvent);
  }
}
