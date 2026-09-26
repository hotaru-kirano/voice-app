// Main-thread side of on-device read-aloud: asks tts-worker.js (Supertonic 3)
// for audio and plays each sentence as soon as it's ready, back to back.

export const VOICES = [
  ['F1', 'Female 1'], ['F2', 'Female 2'], ['F3', 'Female 3'], ['F4', 'Female 4'], ['F5', 'Female 5'],
  ['M1', 'Male 1'], ['M2', 'Male 2'], ['M3', 'Male 3'], ['M4', 'Male 4'], ['M5', 'Male 5'],
];
const LANGS = new Set(['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi']);
export const APPROX_MB = 400;

// Picks the language: Japanese/Korean script wins, then the app's Language
// setting if Supertonic supports it, then English.
export function languageFor(text, preferred) {
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[가-힯]/.test(text)) return 'ko';
  const lang = (preferred || '').toLowerCase().slice(0, 2);
  return LANGS.has(lang) ? lang : 'en';
}

export function isDownloaded() {
  return localStorage.getItem('localTts') === '1';
}

// ---------- Worker ----------

let worker = null;
let nextId = 0;
const handlers = new Map(); // id -> { onChunk, resolve, reject }
const progress = new Set();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('tts-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') return progress.forEach((fn) => fn(data.loaded));
    const h = handlers.get(data.id);
    if (!h) return;
    if (data.type === 'chunk') return h.onChunk?.(data);
    handlers.delete(data.id);
    if (data.type === 'error') h.reject(new Error(data.message));
    else h.resolve(data);
  };
  worker.onerror = (e) => {
    for (const h of handlers.values()) h.reject(new Error(e.message || 'On-device voice crashed'));
    handlers.clear();
    worker = null;
  };
  return worker;
}

function call(msg, onChunk) {
  const id = ++nextId;
  return {
    id,
    done: new Promise((resolve, reject) => {
      handlers.set(id, { onChunk, resolve, reject });
      getWorker().postMessage({ ...msg, id });
    }),
  };
}

export function onProgress(fn) {
  progress.add(fn);
  return () => progress.delete(fn);
}

// Downloads (first time) and loads the model. Resolves with 'webgpu' or 'wasm'.
export async function load(device = 'auto') {
  const { device: used } = await call({ type: 'load', device }).done;
  localStorage.setItem('localTts', '1');
  return used;
}

// ---------- Player ----------

export class LocalPlayer {
  constructor(onState) {
    this.onState = onState; // 'idle' | 'loading' | 'playing'
    this.state = 'idle';
    this.ctx = null;
    this.sources = [];
    this.cacheKey = null;
    this.cached = null; // Float32Array[] of the last clip
    this.job = null;
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  audio() {
    // Created on first use, which is always right after a tap.
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // Schedules a chunk to play right after whatever is already queued.
  enqueue(samples, sampleRate) {
    const ctx = this.audio();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.05, this.playhead || 0);
    src.start(start);
    this.playhead = start + buffer.duration;
    this.sources.push(src);
    return src;
  }

  finishWhen(src, token) {
    src.onended = () => {
      if (token === this.token && this.generated) this.setState('idle');
    };
  }

  async play(text, opts) {
    this.stop();
    const token = (this.token = {});
    this.playhead = 0;
    this.generated = false;
    this.audio();
    const key = JSON.stringify([text, opts.voice, opts.speed, opts.lang]);

    if (key === this.cacheKey && this.cached) {
      let last;
      for (const c of this.cached.chunks) last = this.enqueue(c, this.cached.sampleRate);
      this.generated = true;
      this.finishWhen(last, token);
      return this.setState('playing');
    }

    this.setState('loading');
    const chunks = [];
    let sampleRate = 44100;
    let last = null;
    this.job = call({ type: 'speak', text, device: opts.device, opts: { voice: opts.voice, lang: opts.lang, speed: opts.speed } }, (msg) => {
      if (token !== this.token) return;
      sampleRate = msg.sampleRate;
      chunks.push(msg.samples);
      last = this.enqueue(msg.samples, sampleRate);
      if (this.state !== 'playing') this.setState('playing');
    });
    try {
      await this.job.done;
    } catch (err) {
      if (token === this.token) this.setState('idle');
      throw err;
    }
    if (token !== this.token) return;
    this.cacheKey = key;
    this.cached = { chunks, sampleRate };
    this.generated = true;
    if (last) this.finishWhen(last, token);
    else this.setState('idle');
  }

  stop() {
    this.token = null;
    if (this.job) {
      worker?.postMessage({ type: 'cancel' });
      this.job = null;
    }
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources = [];
    if (this.state !== 'idle') this.setState('idle');
  }
}
