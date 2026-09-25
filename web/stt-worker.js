// On-device speech-to-text with Moonshine v2 (Small), run by Transformers.js.
// Uses the GPU through WebGPU when available, otherwise multi-threaded WASM.
// Everything it downloads is cached by the browser, so it works offline after
// the first load.

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

const MODEL = 'Workmind/moonshine-streaming-small-ONNX';
// GPU: 4-bit weights (~180 MB), transcripts match full precision.
// CPU: full-precision encoder + 8-bit decoder (~300 MB); an 8-bit encoder is
// faster but noticeably less accurate.
const DTYPES = {
  webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
};

env.allowLocalModels = false;

let asr = null;
let device = null;
let loading = null;
let loadedFor = null; // the preference the current model was loaded for

async function gpuAvailable() {
  try {
    return Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function loadAs(dev) {
  const files = new Map();
  const model = await pipeline('automatic-speech-recognition', MODEL, {
    device: dev,
    dtype: DTYPES[dev],
    progress_callback: (p) => {
      if (p.status !== 'progress' && p.status !== 'done') return;
      files.set(p.file, { loaded: p.loaded ?? p.total ?? 0, total: p.total ?? 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      postMessage({ type: 'progress', loaded, total });
    },
  });
  // Warm up so the first real take isn't slowed by one-time setup.
  await model(new Float32Array(16000));
  asr = model;
  device = dev;
}

function load(preference) {
  if (preference !== loadedFor) {
    loading = null;
    loadedFor = preference;
  }
  return (loading ??= (async () => {
    if (preference !== 'cpu' && (await gpuAvailable())) {
      try {
        return await loadAs('webgpu');
      } catch (err) {
        console.warn('WebGPU failed, using CPU', err);
      }
    }
    await loadAs('wasm');
  })().catch((err) => {
    loading = null;
    throw err;
  }));
}

// Cuts silence from both ends, keeping a short margin. The model can return
// nothing at all when a clip starts with a long pause.
function trimSilence(audio) {
  const FRAME = 320; // 20 ms
  const levels = [];
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    let sum = 0;
    for (let j = i; j < i + FRAME; j++) sum += audio[j] * audio[j];
    levels.push(Math.sqrt(sum / FRAME));
  }
  if (!levels.length) return audio;
  const sorted = [...levels].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[sorted.length - 1];
  const threshold = Math.max(noise * 3, peak * 0.05, 1e-3);
  const first = levels.findIndex((v) => v > threshold);
  if (first < 0) return audio;
  let last = levels.length - 1;
  while (levels[last] <= threshold) last--;
  const start = Math.max(0, (first - 10) * FRAME); // keep 200 ms before
  const end = Math.min(audio.length, (last + 16) * FRAME); // and 300 ms after
  return audio.subarray(start, end);
}

async function transcribe(input) {
  const audio = trimSilence(input);
  // The v2 audio frontend works in 5 ms frames (80 samples at 16 kHz), so pad
  // to whole frames. Dither the padding and any digital silence slightly.
  const padded = new Float32Array(Math.ceil(audio.length / 80) * 80);
  padded.set(audio);
  for (let i = 0; i < padded.length; i++) padded[i] += (Math.random() - 0.5) * 2e-4;
  try {
    return (await asr(padded)).text.trim();
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // Some mobile GPUs fail at run time; fall back to the CPU for good.
    console.warn('WebGPU inference failed, switching to CPU', err);
    loading = null;
    asr = null;
    loading = loadAs('wasm');
    await loading;
    return (await asr(padded)).text.trim();
  }
}

// Requests are handled one at a time, in order.
let queue = Promise.resolve();

onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      if (data.type === 'load') {
        await load(data.device);
        postMessage({ type: 'ready', id: data.id, device });
      } else if (data.type === 'transcribe') {
        await load(data.device);
        const started = performance.now();
        const text = await transcribe(data.audio);
        postMessage({ type: 'result', id: data.id, text, ms: performance.now() - started, device });
      }
    } catch (err) {
      postMessage({ type: 'error', id: data.id, message: err?.message || String(err) });
    }
  });
};
