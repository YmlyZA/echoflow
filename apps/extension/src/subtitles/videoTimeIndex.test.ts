import { describe, expect, it } from "vitest";
import { createVideoTimeIndex } from "./videoTimeIndex";

describe("createVideoTimeIndex", () => {
  it("returns the nearest sample within tolerance", () => {
    const idx = createVideoTimeIndex({ toleranceMs: 1000 });
    idx.addSample(1000, 10);
    idx.addSample(1250, 10.25);
    idx.addSample(1500, 10.5);
    expect(idx.lookup(1240)).toBe(10.25); // closest to 1250
    expect(idx.lookup(1000)).toBe(10);
  });

  it("returns undefined when the nearest sample is beyond tolerance or empty", () => {
    const idx = createVideoTimeIndex({ toleranceMs: 500 });
    expect(idx.lookup(1000)).toBeUndefined(); // empty
    idx.addSample(1000, 10);
    expect(idx.lookup(3000)).toBeUndefined(); // 2000ms away > 500 tolerance
  });

  it("resolves a seek to the nearest wall-clock sample, not an interpolation across the jump", () => {
    const idx = createVideoTimeIndex({ toleranceMs: 1000 });
    idx.addSample(1000, 10); // playing at 10s
    idx.addSample(1250, 90); // user seeked to 90s at wall-clock 1250
    expect(idx.lookup(1240)).toBe(90); // nearest is the post-seek sample, not ~50
    expect(idx.lookup(1010)).toBe(10);
  });

  it("evicts oldest beyond maxSamples", () => {
    const idx = createVideoTimeIndex({ maxSamples: 2, toleranceMs: 100000 });
    idx.addSample(1000, 1);
    idx.addSample(2000, 2);
    idx.addSample(3000, 3); // evicts the 1000 sample
    expect(idx.lookup(1000)).toBe(2); // 1000 gone; nearest kept is 2000 -> 2
    expect(idx.lookup(3000)).toBe(3);
  });
});
