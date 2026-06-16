import { beforeEach, describe, expect, it, vi } from "vitest";
import { OffscreenAudioPipeline, type AudioPipelineClient } from "./audioPipeline";

describe("OffscreenAudioPipeline", () => {
  beforeEach(() => {
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
          chromeMediaSourceId: "stream-1",
        },
      },
      video: false,
    });
  });

  it("connects captured audio to the destination to preserve playback", async () => {
    const pipeline = createPipeline();

    await pipeline.start();

    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.source.connections).toContain(ctx.destination);
  });

  it("loads the worklet module and taps the source into the worklet node", async () => {
    const pipeline = createPipeline();

    await pipeline.start();

    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith(
      "chrome-extension://test/pcm-encoder.worklet.js",
    );
    expect(ctx.source.connections).toContain(ctx.workletNode);
  });

  it("encodes worklet PCM frames and sends them with sequence metadata", async () => {
    const client = createClient();
    const pipeline = createPipeline({ client });

    await pipeline.start();
    // 48 mono samples at the fake 48 kHz context rate -> 16 PCM samples at 16 kHz.
    FakeAudioContext.instances[0]!.workletNode.emit(new Float32Array(48).fill(1));

    expect(client.sendAudioFrame).toHaveBeenCalledTimes(1);
    const [data, frame] = vi.mocked(client.sendAudioFrame).mock.calls[0]!;
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect((data as ArrayBuffer).byteLength).toBe(16 * 2); // 16 Int16 samples
    expect(frame).toEqual(
      expect.objectContaining({ sequenceNumber: 0, timestampMs: expect.any(Number) }),
    );
  });

  it("stops the worklet node, stream tracks, audio context, and realtime client", async () => {
    const stream = createStream();
    const client = createClient();
    const pipeline = createPipeline({
      client,
      getUserMedia: vi.fn(async () => stream),
    });

    await pipeline.start();
    await pipeline.stop("user_stop");

    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.workletNode.disconnect).toHaveBeenCalled();
    expect(stream.getTracks()[0]!.stop).toHaveBeenCalled();
    expect(ctx.closed).toBe(true);
    expect(client.stop).toHaveBeenCalledWith("user_stop");
  });
});

function createPipeline(
  overrides: Partial<ConstructorParameters<typeof OffscreenAudioPipeline>[0]> = {},
): OffscreenAudioPipeline {
  return new OffscreenAudioPipeline({
    streamId: "stream-1",
    client: createClient(),
    getUserMedia: vi.fn(async () => createStream()),
    AudioContextCtor: FakeAudioContext,
    workletModuleUrl: "chrome-extension://test/pcm-encoder.worklet.js",
    now: () => 1000,
    ...overrides,
  });
}

function createClient(): AudioPipelineClient {
  return {
    sendAudioFrame: vi.fn(),
    stop: vi.fn(),
  };
}

function createStream(): MediaStream {
  const tracks = [{ stop: vi.fn() }];
  return { getTracks: () => tracks } as unknown as MediaStream;
}

class FakeWorkletNode {
  port: { onmessage: ((event: MessageEvent) => void) | null } = { onmessage: null };
  connect = vi.fn();
  disconnect = vi.fn();

  emit(mono: Float32Array): void {
    this.port.onmessage?.({ data: mono } as MessageEvent);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  sampleRate = 48000;
  destination = { id: "destination" };
  workletNode = new FakeWorkletNode();
  source = {
    connections: [] as unknown[],
    connect: vi.fn((destination: unknown) => {
      this.source.connections.push(destination);
    }),
  };
  audioWorklet = { addModule: vi.fn(async () => {}) };
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(): typeof this.source {
    return this.source;
  }

  createWorkletNode(): FakeWorkletNode {
    return this.workletNode;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
