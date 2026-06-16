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
    expect(downmixToMono([mono])).toBe(mono);
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

  it("linearly interpolates between samples at fractional positions", () => {
    // 4 samples at 3 Hz -> 2 samples at 2 Hz. Output index 1 lands at input
    // position 1.5, so the result is the midpoint of samples 1 and 2: 1.5.
    const input = new Float32Array([0, 1, 2, 3]);
    const output = resampleLinear(input, 3, 2);
    expect(Array.from(output)).toEqual([0, 1.5]);
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
