interface Sample {
  wallClockMs: number;
  videoSec: number;
}

/**
 * A bounded ring of (wall-clock, video-position) samples with a nearest-sample
 * lookup. Used to turn a final's spoken wall-clock into the video position where
 * it was heard. Nearest (not interpolation) is deliberate: interpolating across a
 * seek would invent a position between two discontinuous samples. Only recent
 * samples matter (finals arrive within seconds of being spoken), so the ring is
 * small and evicts the oldest.
 */
export function createVideoTimeIndex(opts: { maxSamples?: number; toleranceMs?: number } = {}): {
  addSample(wallClockMs: number, videoSec: number): void;
  lookup(wallClockMs: number): number | undefined;
  reset(): void;
} {
  const maxSamples = opts.maxSamples ?? 1200;
  const toleranceMs = opts.toleranceMs ?? 1000;
  let samples: Sample[] = [];

  return {
    addSample(wallClockMs: number, videoSec: number): void {
      samples.push({ wallClockMs, videoSec });
      if (samples.length > maxSamples) {
        samples = samples.slice(samples.length - maxSamples);
      }
    },
    lookup(wallClockMs: number): number | undefined {
      let best: Sample | undefined;
      let bestDelta = Infinity;
      for (const sample of samples) {
        const delta = Math.abs(sample.wallClockMs - wallClockMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = sample;
        }
      }
      if (best === undefined || bestDelta > toleranceMs) {
        return undefined;
      }
      return best.videoSec;
    },
    reset(): void {
      samples = [];
    }
  };
}
