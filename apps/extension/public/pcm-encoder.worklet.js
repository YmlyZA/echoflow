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
