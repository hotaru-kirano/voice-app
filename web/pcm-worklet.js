// Passes raw microphone samples to the main thread for on-device transcription.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
