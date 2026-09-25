// Main-thread side of on-device transcription: talks to stt-worker.js and cuts
// live microphone audio into pieces at natural pauses, so most of a take is
// already transcribed by the time you stop talking.

export const SAMPLE_RATE = 16000;

// ---------- Worker wrapper ----------

let worker = null;
let nextId = 0;
const pending = new Map();
const progressListeners = new Set();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('stt-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') return progressListeners.forEach((fn) => fn(data));
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

function call(msg, transfer) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

export function onProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

// Downloads (first time) and loads the model. `device` is the preference:
// 'auto' (GPU if available) or 'cpu'. Resolves with the device actually used.
export async function load(device) {
  const { device: used } = await call({ type: 'load', device });
  markDownloaded(used);
  return used;
}

export function transcribe(audio, device) {
  const result = call({ type: 'transcribe', audio, device }, [audio.buffer]);
  result.then((r) => markDownloaded(r.device), () => {});
  return result;
}

// GPU and CPU use different model files, so they're tracked separately.
function markDownloaded(used) {
  localStorage.setItem(`localModel:${used}`, '1');
}

export function downloadedOn() {
  return ['webgpu', 'wasm'].filter((d) => localStorage.getItem(`localModel:${d}`));
}

export function isDownloaded(device) {
  const on = downloadedOn();
  return device === 'cpu' ? on.includes('wasm') : on.length > 0;
}

// ---------- Pause-based chunking ----------

const FRAME = SAMPLE_RATE / 50; // 20 ms
const MIN_CHUNK = SAMPLE_RATE * 3; // don't cut pieces shorter than 3 s
const MAX_CHUNK = SAMPLE_RATE * 20; // always cut by 20 s
const PAUSE_FRAMES = 20; // 400 ms of quiet counts as a pause

export class Chunker {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.parts = [];
    this.length = 0;
    this.frameLevels = []; // RMS per 20 ms frame of the current chunk
    this.carry = new Float32Array(0);
    this.floor = 0.002;
  }

  push(samples) {
    this.parts.push(samples);
    this.length += samples.length;

    // Measure loudness per 20 ms frame.
    let buf = this.carry.length ? concat([this.carry, samples]) : samples;
    let i = 0;
    for (; i + FRAME <= buf.length; i += FRAME) {
      let sum = 0;
      for (let j = i; j < i + FRAME; j++) sum += buf[j] * buf[j];
      const rms = Math.sqrt(sum / FRAME);
      this.frameLevels.push(rms);
      // Background-noise estimate: drops quickly in quiet moments, creeps up
      // very slowly otherwise, so sustained speech never counts as "noise".
      this.floor += (rms - this.floor) * (rms < this.floor ? 0.1 : 0.0005);
    }
    this.carry = buf.slice(i);

    if (this.length < MIN_CHUNK) return;
    const quiet = Math.max(this.floor * 2, 0.004);
    const recent = this.frameLevels.slice(-PAUSE_FRAMES);
    if (recent.length === PAUSE_FRAMES && recent.every((v) => v < quiet)) {
      // Cut in the middle of the pause.
      this.cut(this.length - (PAUSE_FRAMES / 2) * FRAME);
    } else if (this.length >= MAX_CHUNK) {
      // No pause: cut at the quietest point of the last 2 seconds.
      const window = this.frameLevels.slice(-100);
      const quietest = window.indexOf(Math.min(...window));
      this.cut(this.length - (window.length - quietest) * FRAME);
    }
  }

  // Whether the current chunk has anything louder than background noise, so
  // stretches of silence (thinking pauses) are never sent to the model.
  hasSpeech() {
    const loud = Math.max(this.floor * 4, 0.01);
    return this.frameLevels.some((v) => v > loud);
  }

  cut(at) {
    const all = concat(this.parts);
    const speech = this.hasSpeech();
    this.parts = [all.slice(at)];
    this.length = all.length - at;
    this.frameLevels = [];
    if (speech) this.onChunk(all.slice(0, at));
  }

  // Returns whatever hasn't been sent yet, or null if it's only silence.
  flush() {
    const rest = concat(this.parts);
    const speech = this.hasSpeech();
    this.parts = [];
    this.length = 0;
    this.frameLevels = [];
    return speech ? rest : null;
  }
}

export function concat(arrays) {
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// Decodes a recorded blob (webm/opus etc.) to 16 kHz mono samples.
export async function decodeToPcm(blob) {
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
