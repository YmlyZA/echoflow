# Canonical PCM Capture (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the extension's `MediaRecorder`/webm audio capture with an AudioWorklet that streams provider-neutral 16 kHz/16-bit/mono PCM, so any real ASR adapter can consume it.

**Architecture:** A pure DSP module (`src/audio/pcm.ts`) does downmix + linear resample + Float32→Int16, unit-tested in isolation. A hand-written AudioWorklet (`public/pcm-encoder.worklet.js`) taps the tab-capture graph, downmixes to mono, and posts ~100 ms Float32 frames to the offscreen main thread, which encodes them to PCM16 and sends them as binary `audio_frame`s. The backend is unchanged — the fake provider ignores audio content, so the deterministic path keeps working end-to-end.

**Tech Stack:** TypeScript (ESM, strict), WXT + React 19 MV3, Web Audio `AudioWorklet`, Vitest, `@echoflow/protocol`.

**Reference:** `docs/superpowers/specs/2026-06-16-volcengine-asr-design.md` (Half A).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/protocol/src/session.ts` | Shared `CANONICAL_PCM_AUDIO_FORMAT` constant | Modify |
| `packages/protocol/src/session.test.ts` | Test the constant matches the format guard | Modify |
| `apps/extension/src/audio/pcm.ts` | Pure DSP: downmix, resample, Float32→Int16 | Create |
| `apps/extension/src/audio/pcm.test.ts` | Unit tests for the DSP functions | Create |
| `apps/extension/src/audio/audioPipeline.ts` | AudioWorklet capture → PCM16 frames | Modify (rewrite capture) |
| `apps/extension/src/audio/audioPipeline.test.ts` | Pipeline wiring with fake AudioContext/WorkletNode | Modify (rewrite) |
| `apps/extension/public/pcm-encoder.worklet.js` | Worklet processor (downmix + frame buffering) | Create |
| `apps/extension/entrypoints/offscreen/main.ts` | Wire canonical PCM format + worklet URL | Modify |
| `README.md`, `CLAUDE.md` | Note the canonical PCM capture format | Modify |

---

## Task 1: Canonical PCM audio-format constant (protocol)

**Files:**
- Modify: `packages/protocol/src/session.ts` (after the `AudioFormatMetadata` type, lines 1-7)
- Modify: `packages/protocol/src/session.test.ts`
- Verify export: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/session.test.ts` (import the new symbol at the top alongside the existing imports):

```ts
import {
  CANONICAL_PCM_AUDIO_FORMAT,
  isStartSessionMessage,
} from "./session";

describe("CANONICAL_PCM_AUDIO_FORMAT", () => {
  it("describes 16 kHz / 16-bit / mono signed PCM", () => {
    expect(CANONICAL_PCM_AUDIO_FORMAT).toEqual({
      mimeType: "audio/pcm",
      codec: "pcm_s16le",
      sampleRateHz: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
  });

  it("is accepted on a start message by the client-message guard", () => {
    expect(
      isStartSessionMessage({
        type: "start",
        audioFormat: CANONICAL_PCM_AUDIO_FORMAT,
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/protocol test session`
Expected: FAIL — `CANONICAL_PCM_AUDIO_FORMAT` is not exported.

- [ ] **Step 3: Add the constant**

In `packages/protocol/src/session.ts`, immediately after the `AudioFormatMetadata` type (line 7), add:

```ts
export const CANONICAL_PCM_AUDIO_FORMAT: AudioFormatMetadata = {
  mimeType: "audio/pcm",
  codec: "pcm_s16le",
  sampleRateHz: 16000,
  channelCount: 1,
  bitsPerSample: 16,
};
```

Confirm `packages/protocol/src/index.ts` re-exports `./session` (it does via `export * from "./session"`). No change needed if so.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/protocol test session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/session.ts packages/protocol/src/session.test.ts
git commit -m "feat(protocol): add canonical PCM audio format constant"
```

---

## Task 2: Pure PCM DSP module

**Files:**
- Create: `apps/extension/src/audio/pcm.ts`
- Create: `apps/extension/src/audio/pcm.test.ts`

These are pure functions (no Web Audio APIs) so they run under Vitest/jsdom directly.

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/audio/pcm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  downmixToMono,
  encodePcm16Mono,
  floatToInt16,
  resampleLinear,
} from "./pcm";

describe("downmixToMono", () => {
  it("returns the single channel unchanged", () => {
    const mono = new Float32Array([0.1, -0.2, 0.3]);
    expect(Array.from(downmixToMono([mono]))).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(-0.2),
      expect.closeTo(0.3),
    ]);
  });

  it("averages multiple channels sample-by-sample", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 0, 1]);
    expect(Array.from(downmixToMono([left, right]))).toEqual([0.5, 0, 0]);
  });

  it("returns an empty buffer when given no channels", () => {
    expect(downmixToMono([]).length).toBe(0);
  });
});

describe("resampleLinear", () => {
  it("returns a copy when input and output rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const output = resampleLinear(input, 16000, 16000);
    expect(Array.from(output)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ]);
    expect(output).not.toBe(input);
  });

  it("downsamples 48k to 16k by a factor of three in length", () => {
    const input = new Float32Array(48);
    const output = resampleLinear(input, 48000, 16000);
    expect(output.length).toBe(16);
  });

  it("linearly interpolates between samples", () => {
    // 4 samples at 4 Hz -> 2 samples at 2 Hz: picks positions 0 and 2.
    const input = new Float32Array([0, 1, 2, 3]);
    const output = resampleLinear(input, 4, 2);
    expect(Array.from(output)).toEqual([0, 2]);
  });
});

describe("floatToInt16", () => {
  it("maps full-scale floats to the Int16 range and clamps overshoot", () => {
    const input = new Float32Array([0, 1, -1, 2, -2]);
    expect(Array.from(floatToInt16(input))).toEqual([
      0, 32767, -32768, 32767, -32768,
    ]);
  });
});

describe("encodePcm16Mono", () => {
  it("downmixes, resamples, and converts to Int16 in one pass", () => {
    const left = new Float32Array(48).fill(1);
    const right = new Float32Array(48).fill(-1);
    const pcm = encodePcm16Mono([left, right], 48000, 16000);
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(pcm.length).toBe(16); // 48 @ 48k -> 16 @ 16k
    expect(pcm[0]).toBe(0); // (1 + -1) / 2 = 0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test pcm`
Expected: FAIL — `./pcm` module not found.

- [ ] **Step 3: Implement the DSP module**

Create `apps/extension/src/audio/pcm.ts`:

```ts
/**
 * Average all channels into a single mono channel. Returns the input channel
 * directly when already mono, and an empty buffer when given no channels.
 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(0);
  }
  if (channels.length === 1) {
    return channels[0]!;
  }

  const frames = channels[0]!.length;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[i] ?? 0;
    }
    mono[i] = sum / channels.length;
  }
  return mono;
}

/**
 * Linear-interpolation resample from inputRate to outputRate. Returns a copy
 * when the rates match.
 */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) {
    return input.slice();
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const sample = input[index] ?? 0;
    const next = input[index + 1] ?? sample;
    output[i] = sample + (next - sample) * frac;
  }
  return output;
}

/** Clamp [-1, 1] floats to signed 16-bit PCM. */
export function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
    output[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return output;
}

/** Downmix to mono, resample to outputRate, and encode as signed 16-bit PCM. */
export function encodePcm16Mono(
  channels: Float32Array[],
  inputRate: number,
  outputRate: number,
): Int16Array {
  const mono = downmixToMono(channels);
  const resampled = resampleLinear(mono, inputRate, outputRate);
  return floatToInt16(resampled);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test pcm`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/audio/pcm.ts apps/extension/src/audio/pcm.test.ts
git commit -m "feat(extension): add pure PCM downmix/resample/int16 DSP"
```

---

## Task 3: Rewrite the offscreen pipeline to AudioWorklet PCM

**Files:**
- Modify: `apps/extension/src/audio/audioPipeline.ts` (full rewrite of the capture mechanics)
- Modify: `apps/extension/src/audio/audioPipeline.test.ts` (replace the MediaRecorder fakes)

The pipeline keeps `source → destination` (so tab audio still plays) and adds a parallel `source → workletNode` tap. The worklet posts mono Float32 frames; the pipeline encodes them to PCM16 and sends them. All Web Audio constructors are injectable so the unit test uses fakes.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `apps/extension/src/audio/audioPipeline.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test audioPipeline`
Expected: FAIL — current pipeline uses `MediaRecorder`/`mimeType`, has no `workletModuleUrl`/`createWorkletNode`, and sends a `Blob`.

- [ ] **Step 3: Rewrite the pipeline**

Replace the entire contents of `apps/extension/src/audio/audioPipeline.ts` with:

```ts
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
    this.options.client.sendAudioFrame(pcm.buffer, {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test audioPipeline`
Expected: PASS (all five cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/audio/audioPipeline.ts apps/extension/src/audio/audioPipeline.test.ts
git commit -m "feat(extension): capture PCM via AudioWorklet instead of MediaRecorder"
```

---

## Task 4: Author the AudioWorklet processor asset

**Files:**
- Create: `apps/extension/public/pcm-encoder.worklet.js`

WXT copies `public/` to the output root, so the offscreen document (extension origin) loads this via `chrome.runtime.getURL("pcm-encoder.worklet.js")` — no `web_accessible_resources` entry needed. The worklet runs in the audio thread where `sampleRate`, `AudioWorkletProcessor`, and `registerProcessor` are globals; it is hand-written plain JS (no bundler involvement) and is verified by build + e2e, not unit tests.

- [ ] **Step 1: Create the worklet**

Create `apps/extension/public/pcm-encoder.worklet.js`:

```js
// Downmixes the input to mono and posts fixed-size Float32 frames (~frameMs of
// audio at the context sample rate) to the main thread. Resampling and Int16
// encoding happen on the main thread (see src/audio/pcm.ts) to keep this
// processor minimal and the DSP unit-testable.
class PcmEncoderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const fromOptions = options && options.processorOptions
      ? options.processorOptions.frameSamples
      : undefined;
    this.frameSamples = fromOptions && fromOptions > 0
      ? fromOptions
      : Math.round(sampleRate * 0.1);
    this.buffer = new Float32Array(this.frameSamples);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelCount = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let c = 0; c < channelCount; c += 1) {
        sum += input[c][i];
      }
      this.buffer[this.offset] = sum / channelCount;
      this.offset += 1;
      if (this.offset >= this.frameSamples) {
        this.port.postMessage(this.buffer.slice(0, this.offset));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-encoder", PcmEncoderProcessor);
```

- [ ] **Step 2: Verify it ships in the build**

Run: `pnpm --filter @echoflow/extension build`
Expected: build succeeds and `apps/extension/.output/chrome-mv3/pcm-encoder.worklet.js` exists.

Run: `test -f apps/extension/.output/chrome-mv3/pcm-encoder.worklet.js && echo PRESENT`
Expected: `PRESENT`.

- [ ] **Step 3: Commit**

```bash
git add apps/extension/public/pcm-encoder.worklet.js
git commit -m "feat(extension): add PCM encoder AudioWorklet asset"
```

---

## Task 5: Wire the offscreen document to canonical PCM

**Files:**
- Modify: `apps/extension/entrypoints/offscreen/main.ts` (lines 9-13 imports, 60-64 audioFormat, 92-97 pipeline options)

- [ ] **Step 1: Update imports**

In `apps/extension/entrypoints/offscreen/main.ts`, replace the audioPipeline import block (lines 9-13):

```ts
import { OffscreenAudioPipeline } from "../../src/audio/audioPipeline";
```

And add `CANONICAL_PCM_AUDIO_FORMAT` to the protocol import (it is not currently imported here; add a new import line near the top):

```ts
import { CANONICAL_PCM_AUDIO_FORMAT } from "@echoflow/protocol";
```

- [ ] **Step 2: Use the canonical format on the start handshake**

Replace the `audioFormat` object (lines 60-64) with:

```ts
      audioFormat: CANONICAL_PCM_AUDIO_FORMAT,
```

- [ ] **Step 3: Update the pipeline construction**

Replace the `OffscreenAudioPipeline` construction (lines 92-97) with:

```ts
    const pipeline = new OffscreenAudioPipeline({
      streamId: message.streamId,
      client,
      workletModuleUrl: chrome.runtime.getURL("pcm-encoder.worklet.js"),
    });
```

- [ ] **Step 4: Typecheck the extension**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS — no references to the removed `DEFAULT_AUDIO_MIME_TYPE` / `DEFAULT_AUDIO_CHUNK_MS` remain.

If typecheck reports leftover references, remove them (the symbols no longer exist in `audioPipeline.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/offscreen/main.ts
git commit -m "feat(extension): send canonical PCM format from offscreen session"
```

---

## Task 6: Document the canonical PCM capture format

**Files:**
- Modify: `README.md` (the "Load the Extension in Chrome" / development area)
- Modify: `CLAUDE.md` (the "Extension: three execution contexts" section, offscreen bullet)

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`, in the `entrypoints/offscreen/main.ts` bullet, append a sentence:

```
The pipeline captures via an `AudioWorklet` (`public/pcm-encoder.worklet.js`) and streams provider-neutral 16 kHz/16-bit/mono PCM (`CANONICAL_PCM_AUDIO_FORMAT`) — not webm — so any real ASR adapter can consume the bytes.
```

- [ ] **Step 2: Update README.md**

In `README.md`, under the development/architecture notes, add a short line:

```
The extension captures tab audio as 16 kHz/16-bit/mono PCM (via an AudioWorklet) so the backend can feed it to any streaming ASR provider.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: note canonical PCM capture format"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole workspace**

Run: `pnpm test`
Expected: all packages green (protocol + backend unchanged; extension includes the new `pcm` and rewritten `audioPipeline` suites).

- [ ] **Step 2: Build, typecheck, lint**

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: all succeed.

- [ ] **Step 3: Smoke test the deterministic path**

Run: `bash scripts/dev-smoke.sh`
Expected: backend health + extension startup path pass (the fake provider still emits the scripted subtitles; PCM frames flow but content is ignored by the fake).

- [ ] **Step 4: Manual end-to-end (record outcome)**

1. `pnpm --filter @echoflow/backend dev`
2. `pnpm --filter @echoflow/extension build`, load `apps/extension/.output/chrome-mv3`, set backend `http://127.0.0.1:8787`, key `dev-key`.
3. Play a video, click the EchoFlow action.
4. Confirm the fake subtitles still render (the scripted three lines) — proving PCM capture works end-to-end through the offscreen AudioWorklet.
5. In the offscreen document's DevTools console, confirm no AudioWorklet load errors.

- [ ] **Step 5: Final commit (if any docs/notes changed during verification)**

```bash
git add -A
git commit -m "chore: verify canonical PCM capture end-to-end" || echo "nothing to commit"
```

---

## Notes for the next plan (Plan B — backend Volcengine adapter)

Plan A establishes the canonical-PCM contract end-to-end with the fake provider still green. Plan B (separate plan) adds the real Volcengine `sauc/bigmodel` `SpeechProvider` behind an injectable transport seam, the `onError` contract addition, config/env, and the cumulative→incremental utterance reconciler — see the spec's Half B. Write Plan B after Plan A merges, against the real shipped contract.
