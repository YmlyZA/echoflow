import { describe, expect, it } from "vitest";
import { createPcmResampler } from "./pcmResample.js";

function sine(freqHz: number, rateHz: number, samples: number, phase = 0): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = (phase + i) / rateHz;
    buf.writeInt16LE(Math.round(10_000 * Math.sin(2 * Math.PI * freqHz * t)), i * 2);
  }
  return buf;
}

function samplesOf(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

function zeroCrossings(values: number[]): number {
  let count = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i - 1]! < 0) !== (values[i]! < 0)) count += 1;
  }
  return count;
}

describe("createPcmResampler", () => {
  it("passes frames through untouched when the rates match", () => {
    const frame = sine(440, 16_000, 160);
    expect(createPcmResampler(16_000, 16_000).push(frame)).toBe(frame);
  });

  it("produces exactly 3 output samples per 2 input samples over many frames", () => {
    const resampler = createPcmResampler(16_000, 24_000);
    let inSamples = 0;
    let outSamples = 0;
    for (let frame = 0; frame < 50; frame += 1) {
      const input = sine(440, 16_000, 1600, frame * 1600); // 100 ms frames
      inSamples += 1600;
      outSamples += resampler.push(input).length / 2;
    }
    expect(Math.abs(outSamples - (inSamples * 3) / 2)).toBeLessThanOrEqual(1);
  });

  it("keeps a 1 kHz tone at 1 kHz", () => {
    const resampler = createPcmResampler(16_000, 24_000);
    const output: number[] = [];
    for (let frame = 0; frame < 5; frame += 1) {
      output.push(...samplesOf(resampler.push(sine(1000, 16_000, 1600, frame * 1600))));
    }
    // 0.5 s of a 1 kHz tone crosses zero 1000 times.
    const seconds = output.length / 24_000;
    expect(zeroCrossings(output) / seconds).toBeCloseTo(2000, -1);
  });

  it("is continuous across frame boundaries", () => {
    const resampler = createPcmResampler(16_000, 24_000);
    const frames = [0, 1, 2, 3].map((k) => samplesOf(resampler.push(sine(300, 16_000, 160, k * 160))));
    for (let k = 1; k < frames.length; k += 1) {
      const last = frames[k - 1]!.at(-1)!;
      const first = frames[k]![0]!;
      // Adjacent 24 k samples of a 300 Hz tone at 10 000 amplitude differ by < 800.
      expect(Math.abs(first - last)).toBeLessThan(800);
    }
  });

  it("tolerates an empty frame", () => {
    const resampler = createPcmResampler(16_000, 24_000);
    expect(resampler.push(Buffer.alloc(0))).toHaveLength(0);
    expect(resampler.push(sine(440, 16_000, 16)).length).toBeGreaterThan(0);
  });

  it("rejects nonsensical rates", () => {
    expect(() => createPcmResampler(0, 24_000)).toThrow(/Invalid resample rates/);
  });
});
