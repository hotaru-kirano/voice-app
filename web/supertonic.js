// On-device text-to-speech with Supertonic 3 (ONNX), run by ONNX Runtime
// Web. Ported from the official web example (github.com/supertone-inc/supertonic,
// MIT), using flat typed arrays instead of nested JS arrays for speed.
// Model files are cached with the Cache API, so it works offline after the
// first download.

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';

// The official full-precision models (~400 MB). The community int8 export is
// 4x smaller but ~6x slower in ONNX Runtime Web and produced unusable audio.
export const MODEL_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main/';
export const CACHE = 'supertonic-3';
const MODELS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
export const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];
export const LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi'];
// Denoising steps. The official default is 8; 5 transcribed identically in
// testing and is ~40% faster (faster than real time on a laptop CPU).
const DEFAULT_STEPS = 5;
const GAP_SECONDS = 0.3; // silence between sentences

// Downloads a file once, then serves it from the cache.
async function cachedFetch(path, onBytes) {
  const url = MODEL_BASE + path;
  const cache = await caches.open(CACHE);
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} downloading ${path}`);
    await cache.put(url, res.clone());
  }
  const buf = await res.arrayBuffer();
  onBytes?.(buf.byteLength);
  return buf;
}

export async function isDownloaded() {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  return MODELS.every((m) => keys.some((k) => k.url.endsWith(`onnx/${m}.onnx`)));
}

// ---------- Text ----------

const REPLACE = {
  '–': '-', '‑': '-', '—': '-', '_': ' ', '“': '"', '”': '"', '‘': "'", '’': "'",
  '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
  '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ',
};

function preprocess(text, lang) {
  text = text.normalize('NFKD');
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  for (const [k, v] of Object.entries(REPLACE)) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, '');
  text = text.replace(/ ([,.!?;:'])/g, '$1');
  text = text.replace(/"{2,}/g, '"').replace(/'{2,}/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

// Splits into sentence-sized chunks so audio can start after the first one.
export function chunkText(text, lang) {
  const maxLen = lang === 'ko' || lang === 'ja' ? 120 : 300;
  const chunks = [];
  for (const para of text.trim().split(/\n\s*\n+/)) {
    const sentences = para
      .trim()
      .split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|St\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+|(?<=[。！？])\s*/);
    const sep = lang === 'ja' ? '' : ' ';
    let current = '';
    for (const s of sentences) {
      if (!s.trim()) continue;
      // The very first chunk is a single sentence, so the voice starts sooner.
      if (current && (chunks.length === 0 || current.length + s.length + 1 > maxLen)) {
        chunks.push(current);
        current = s;
      } else {
        current = current ? `${current}${sep}${s}` : s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  // A long first sentence is split at a comma, so the voice starts sooner.
  if (chunks.length && chunks[0].length > 80) {
    const cut = chunks[0].slice(30).search(/[,;:、，]\s/);
    if (cut >= 0 && cut + 32 < chunks[0].length - 20) {
      const at = cut + 31;
      chunks.splice(0, 1, chunks[0].slice(0, at).trim(), chunks[0].slice(at).trim());
    }
  }
  return chunks;
}

// ---------- Model ----------

export class Supertonic {
  static async load({ device = 'auto', onProgress } = {}) {
    const cfg = JSON.parse(new TextDecoder().decode(await cachedFetch('onnx/tts.json')));
    const indexer = JSON.parse(new TextDecoder().decode(await cachedFetch('onnx/unicode_indexer.json')));
    let loaded = 0;
    const bytes = (n) => onProgress?.((loaded += n));
    const buffers = await Promise.all(MODELS.map((m) => cachedFetch(`onnx/${m}.onnx`, bytes)));
    const tryCreate = async (providers) =>
      Promise.all(buffers.map((b) => ort.InferenceSession.create(b, { executionProviders: providers, graphOptimizationLevel: 'all' })));
    let sessions;
    let used = 'wasm';
    if (device !== 'cpu' && typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        sessions = await tryCreate(['webgpu']);
        used = 'webgpu';
      } catch {}
    }
    sessions ??= await tryCreate(['wasm']);
    return new Supertonic(cfg, indexer, sessions, used);
  }

  constructor(cfg, indexer, [dp, textEnc, vectorEst, vocoder], device) {
    Object.assign(this, { cfg, indexer, dp, textEnc, vectorEst, vocoder, device });
    this.sampleRate = cfg.ae.sample_rate;
    this.styles = new Map();
  }

  async style(voice) {
    if (!this.styles.has(voice)) {
      const json = JSON.parse(new TextDecoder().decode(await cachedFetch(`voice_styles/${voice}.json`)));
      const tensor = (s) => new ort.Tensor('float32', Float32Array.from(s.data.flat(Infinity)), s.dims);
      this.styles.set(voice, { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) });
    }
    return this.styles.get(voice);
  }

  // One chunk of text -> Float32Array of samples.
  async synthesize(text, { voice = 'F1', lang = 'en', speed = 1.05, steps = DEFAULT_STEPS, timings } = {}) {
    const t0 = performance.now();
    const style = await this.style(voice);
    const processed = preprocess(text, lang);
    const ids = new BigInt64Array(processed.length);
    let n = 0;
    for (const ch of processed) {
      const cp = ch.codePointAt(0);
      ids[n++] = BigInt(cp < this.indexer.length ? this.indexer[cp] : -1);
    }
    const L = n;
    const textIds = new ort.Tensor('int64', ids.subarray(0, L), [1, L]);
    const textMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);

    const { duration } = await this.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const seconds = duration.data[0] / speed;
    const { text_emb: textEmb } = await this.textEnc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });

    const chunk = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
    const wavLen = Math.floor(seconds * this.sampleRate);
    const T = Math.max(1, Math.ceil(wavLen / chunk));
    const D = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;
    let xt = new Float32Array(D * T);
    for (let i = 0; i < xt.length; i++) {
      const u1 = Math.max(1e-4, Math.random());
      xt[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
    }
    const latentMask = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, 1, T]);
    const total = new ort.Tensor('float32', new Float32Array([steps]), [1]);
    const t1 = performance.now();
    for (let step = 0; step < steps; step++) {
      const out = await this.vectorEst.run({
        noisy_latent: new ort.Tensor('float32', xt, [1, D, T]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
        total_step: total,
      });
      xt = new Float32Array(out.denoised_latent.data);
    }
    const t2 = performance.now();
    const { wav_tts: wav } = await this.vocoder.run({ latent: new ort.Tensor('float32', xt, [1, D, T]) });
    if (timings) {
      timings.text = (timings.text || 0) + t1 - t0;
      timings.denoise = (timings.denoise || 0) + t2 - t1;
      timings.vocoder = (timings.vocoder || 0) + performance.now() - t2;
    }
    return wav.data.slice(0, Math.min(wav.data.length, wavLen));
  }

  // Whole text, chunk by chunk. `onChunk(samples)` is called as each chunk is
  // ready, so playback can start after the first sentence.
  async speak(text, opts, onChunk) {
    const chunks = chunkText(text, opts.lang || 'en');
    const gap = new Float32Array(Math.floor(GAP_SECONDS * this.sampleRate));
    for (let i = 0; i < chunks.length; i++) {
      const samples = await this.synthesize(chunks[i], opts);
      if (opts.signal?.aborted) return;
      await onChunk(i ? concat(gap, samples) : samples, i, chunks.length);
    }
  }
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// 16-bit mono WAV, for caching a finished clip.
export function toWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
