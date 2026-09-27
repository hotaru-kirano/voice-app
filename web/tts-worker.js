// Runs Supertonic off the main thread and streams audio back sentence by
// sentence, so playback can start before the whole draft is synthesized.
import { Supertonic } from './supertonic.js';

let tts = null;
let loading = null;
let job = 0;

function load(device) {
  return (loading ??= Supertonic.load({
    device,
    onProgress: (loaded) => postMessage({ type: 'progress', loaded }),
  }).then(
    (t) => (tts = t),
    (err) => {
      loading = null;
      throw err;
    },
  ));
}

onmessage = async ({ data }) => {
  if (data.type === 'cancel') {
    job = 0;
    return;
  }
  try {
    if (data.type === 'load') {
      await load(data.device);
      // Warm up so the first real request isn't slowed by one-time setup.
      await tts.synthesize('Ready.', { voice: 'F1', lang: 'en' });
      postMessage({ type: 'ready', id: data.id, device: tts.device });
    } else if (data.type === 'speak') {
      job = data.id;
      await load(data.device);
      const signal = { get aborted() { return job !== data.id; } };
      await tts.speak(data.text, { ...data.opts, signal }, (samples, index, count) => {
        if (job !== data.id) return;
        postMessage({ type: 'chunk', id: data.id, samples, index, count, sampleRate: tts.sampleRate }, [samples.buffer]);
      });
      postMessage({ type: 'done', id: data.id, cancelled: job !== data.id });
    }
  } catch (err) {
    postMessage({ type: 'error', id: data.id, message: err?.message || String(err) });
  }
};
