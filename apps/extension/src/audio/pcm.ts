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
