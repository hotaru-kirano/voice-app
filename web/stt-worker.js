// On-device, streaming speech-to-text with Moonshine v2 Small, using the
// official WebAssembly package. Runs off the main thread; everything it
// downloads is cached by the browser, so it works offline after the first load.

import { Transcriber, ModelArch } from 'https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm@0.1.5/dist/index.js';

let transcriber = null;
let loading = null;
let stream = null;
let lines = new Map(); // line id -> text, in the order lines started
let passScheduled = false;
// Audio that arrives while a take is still starting (e.g. the model is still
// loading) is held here so the beginning of what you said isn't lost.
let starting = false;
let early = [];

function load() {
  return (loading ??= Transcriber.load({
    language: 'en',
    modelArch: ModelArch.SmallStreaming,
    // By default the engine force-ends a line after ~10 s of continuous speech,
    // and the next line re-reads audio from before the cut, so the words at the
    // cut came out twice ("…we can't. We can talk…"). With a 60 s limit, lines
    // end at real pauses, where that overlap is only silence.
    options: { vad_max_segment_duration: '60' },
    onProgress: (loaded, total) => postMessage({ type: 'progress', loaded, total }),
  }).then(
    (t) => (transcriber = t),
    (err) => {
      loading = null;
      throw err;
    },
  ));
}

function currentText() {
  return [...lines.values()].map((t) => t.trim()).filter(Boolean).join(' ');
}

function onLine({ line }) {
  lines.set(line.id, line.text);
  postMessage({ type: 'text', text: currentText() });
}

// Audio arrives in small pieces; run at most one transcription pass at a time
// over whatever has arrived since the last one.
function schedulePass() {
  if (passScheduled) return;
  passScheduled = true;
  setTimeout(() => {
    passScheduled = false;
    try {
      stream?.transcribe();
    } catch (err) {
      postMessage({ type: 'streamError', message: err?.message || String(err) });
    }
  }, 0);
}

const handlers = {
  async load() {
    await load();
  },

  // Starts a live take. `context` is the draft being revised: the engine picks
  // names and unusual words out of it and listens for them.
  async start({ context }) {
    await load();
    try {
      transcriber.setContext(context || '');
    } catch {}
    stream?.close();
    lines = new Map();
    stream = transcriber.createStream({ updateInterval: 0.5 });
    stream.addListener({ onLineTextChanged: onLine, onLineCompleted: onLine });
    stream.start();
    for (const pcm of early) stream.addAudio(pcm, 16000);
    early = [];
    starting = false;
    schedulePass();
  },

  audio({ pcm }) {
    if (!stream) {
      if (starting) early.push(pcm);
      return;
    }
    stream.addAudio(pcm, 16000);
    schedulePass();
  },

  // Finishes the take and returns the final transcript.
  async stop() {
    starting = false;
    early = [];
    if (!stream) return { text: '' };
    stream.stop(); // flushes a final pass
    const text = currentText();
    stream.close();
    stream = null;
    return { text };
  },

  // Whole recording at once (used when the cloud request fails, and for retry).
  async transcribe({ pcm, context }) {
    await load();
    try {
      transcriber.setContext(context || '');
    } catch {}
    const result = transcriber.transcribe(pcm, { sampleRate: 16000 });
    return { text: result.lines.map((l) => l.text.trim()).filter(Boolean).join(' ') };
  },
};

// Requests are handled in order; audio is cheap and handled immediately.
let queue = Promise.resolve();

onmessage = ({ data }) => {
  if (data.type === 'audio') return handlers.audio(data);
  if (data.type === 'start') {
    starting = true;
    early = [];
  }
  queue = queue.then(async () => {
    try {
      const result = (await handlers[data.type](data)) || {};
      postMessage({ type: 'ok', id: data.id, ...result });
    } catch (err) {
      postMessage({ type: 'error', id: data.id, message: err?.message || String(err) });
    }
  });
};
