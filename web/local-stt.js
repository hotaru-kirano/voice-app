// Main-thread side of on-device transcription: a thin wrapper around
// stt-worker.js, which runs Moonshine v2 streaming off the main thread.

export const SAMPLE_RATE = 16000;

// Flags from the earlier Transformers.js engine, whose model is gone.
localStorage.removeItem('localModel:webgpu');
localStorage.removeItem('localModel:wasm');

let worker = null;
let nextId = 0;
const pending = new Map();
const progressListeners = new Set();
let textListener = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('stt-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') return progressListeners.forEach((fn) => fn(data));
    if (data.type === 'text') return textListener?.(data.text);
    if (data.type === 'streamError') return console.warn('On-device transcription:', data.message);
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.type === 'error') p.reject(new Error(data.message));
    else p.resolve(data);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'On-device engine crashed'));
    pending.clear();
    worker = null;
  };
  return worker;
}

function call(msg) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

export function onProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

// Downloads (first time) and loads the model.
export async function load() {
  await call({ type: 'load' });
  localStorage.setItem('localModel', '1');
}

export function isDownloaded() {
  return localStorage.getItem('localModel') === '1';
}

// ---------- Live takes ----------

// Starts streaming transcription. `onText` gets the whole transcript so far,
// every time it changes. Returns a promise that settles once the take has
// started (rejects if the model can't load).
export function startTake({ context, onText }) {
  textListener = onText;
  return call({ type: 'start', context });
}

// Feeds 16 kHz mono samples. Cheap; call as often as audio arrives.
export function addAudio(pcm) {
  if (!worker) return;
  worker.postMessage({ type: 'audio', pcm }, [pcm.buffer]);
}

// Ends the take and resolves with the final transcript.
export async function finishTake() {
  try {
    const { text } = await call({ type: 'stop' });
    localStorage.setItem('localModel', '1');
    return text;
  } finally {
    textListener = null;
  }
}

// ---------- Whole recordings ----------

export async function transcribeBlob(blob, context) {
  const pcm = await decodeToPcm(blob);
  const { text } = await call({ type: 'transcribe', pcm, context });
  return text;
}

// Decodes a recorded blob (webm/opus etc.) to 16 kHz mono samples.
async function decodeToPcm(blob) {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.ceil(buf.duration * SAMPLE_RATE), SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
  } finally {
    ctx.close();
  }
}
