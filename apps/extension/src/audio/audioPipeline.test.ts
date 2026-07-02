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

  it("invokes onCaptureEnded once when a captured track ends", async () => {
    const onCaptureEnded = vi.fn();
    const { endTrack } = await startPipelineWithFakes({ onCaptureEnded });

    endTrack(); // fire the track's "ended" event
    endTrack(); // a second end must not double-report

    expect(onCaptureEnded).toHaveBeenCalledTimes(1);
    expect(onCaptureEnded).toHaveBeenCalledWith("capture_ended");
  });

  it("does not invoke onCaptureEnded for an ended event after stop", async () => {
    const onCaptureEnded = vi.fn();
    const { pipeline, endTrack } = await startPipelineWithFakes({ onCaptureEnded });

    await pipeline.stop();
    endTrack();

    expect(onCaptureEnded).not.toHaveBeenCalled();
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

async function startPipelineWithFakes(
  overrides: Partial<ConstructorParameters<typeof OffscreenAudioPipeline>[0]> = {},
): Promise<{ pipeline: OffscreenAudioPipeline; endTrack: () => void }> {
  const track = createFakeTrack();
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const pipeline = createPipeline({
    getUserMedia: vi.fn(async () => stream),
    ...overrides,
  });

  await pipeline.start();

  return { pipeline, endTrack: () => track.emitEnded() };
}

function createClient(): AudioPipelineClient {
  return {
    sendAudioFrame: vi.fn(),
    stop: vi.fn(),
  };
}

interface FakeMediaStreamTrack {
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  emitEnded: () => void;
}

function createFakeTrack(): FakeMediaStreamTrack {
  let endedHandler: (() => void) | undefined;

  return {
    stop: vi.fn(),
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (event === "ended") {
        endedHandler = handler;
      }
    }),
    removeEventListener: vi.fn((event: string, handler: () => void) => {
      if (event === "ended" && endedHandler === handler) {
        endedHandler = undefined;
      }
    }),
    emitEnded: () => {
      endedHandler?.();
    },
  };
}

function createStream(): MediaStream {
  const tracks = [createFakeTrack()];
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
