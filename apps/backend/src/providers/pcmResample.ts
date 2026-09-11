export interface PcmResampler {
  /** Converts one frame of Int16LE mono PCM; state carries across frames. */
  push(input: Buffer): Buffer;
}

/**
 * Linear-interpolation resampler for Int16LE mono PCM. Kept stateful so frame
 * boundaries are seamless: the last input sample and the fractional read
 * position carry over, and the output length over many frames converges to
 * exactly `toHz / fromHz` times the input length. Good enough for speech into
 * an ASR model; not a production audio resampler (no anti-alias filter, so
 * downsampling aliases — the only caller upsamples 16 k → 24 k).
 */
export function createPcmResampler(fromHz: number, toHz: number): PcmResampler {
  if (!Number.isFinite(fromHz) || !Number.isFinite(toHz) || fromHz <= 0 || toHz <= 0) {
    throw new Error(`Invalid resample rates: ${fromHz} → ${toHz}`);
  }
  if (fromHz === toHz) {
    return { push: (input) => input };
  }

  const step = fromHz / toHz;
  // Virtual input index space per frame: index 0 is the previous frame's last
  // sample, index k (1..n) is input sample k-1. `pos` is where the next output
  // sample reads from, carried across frames after subtracting n.
  let prev = 0;
  let pos = 1; // no previous sample yet: start exactly on the first real sample

  return {
    push(input: Buffer): Buffer {
      const n = input.length >> 1;
      if (n === 0) {
        return Buffer.alloc(0);
      }
      const sampleAt = (index: number): number =>
        index === 0 ? prev : input.readInt16LE((index - 1) * 2);

      const count = pos <= n ? Math.floor((n - pos) / step) + 1 : 0;
      const out = Buffer.alloc(count * 2);
      let p = pos;
      for (let k = 0; k < count; k += 1) {
        const i = Math.floor(p);
        const frac = p - i;
        const a = sampleAt(i);
        const b = i + 1 <= n ? sampleAt(i + 1) : a;
        const value = Math.round(a + (b - a) * frac);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, value)), k * 2);
        p += step;
      }
      pos = p - n;
      prev = input.readInt16LE((n - 1) * 2);
      return out;
    },
  };
}
