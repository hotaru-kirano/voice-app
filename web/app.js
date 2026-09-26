// Voice Drafts: a focused surface for thinking out loud.
// Speak -> the transcript fills the surface -> read it -> speak again, and the
// new take replaces it. Earlier versions are kept so a bad take is never a loss.
// Transcription: a Whisper-compatible /audio/transcriptions endpoint (Groq,
// OpenAI, …), xAI Grok realtime streaming, or Moonshine on the device.

import * as Local from './local-stt.js';
import * as Xai from './xai-stt.js';

const $ = (sel) => document.querySelector(sel);

// ---------- Settings ----------

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: '',
  engine: 'auto', // auto: cloud, on-device when offline | local | cloud
  provider: 'whisper', // cloud service: whisper (Groq, OpenAI, …) | xai
  liveText: true, // show words while speaking (on-device and xAI)
  xaiKey: '',
};

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// A Groq key (gsk_…) with the OpenAI defaults means Groq's endpoint and model.
const GROQ = { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' };

function withProviderDefaults(s) {
  if (!s.apiKey.startsWith('gsk_') || s.baseUrl !== DEFAULTS.baseUrl) return s;
  return { ...s, baseUrl: GROQ.baseUrl, model: s.model === DEFAULTS.model ? GROQ.model : s.model };
}

let settings = withProviderDefaults({ ...DEFAULTS, ...loadJSON('settings', {}) });

// ---------- Versions ----------
// Every take is appended; the surface shows one of them (the newest by default).

const MAX_VERSIONS = 200;
let versions = loadJSON('versions', []);
let current = versions.length - 1;

function saveVersions() {
  if (versions.length > MAX_VERSIONS) {
    current -= versions.length - MAX_VERSIONS;
    versions = versions.slice(-MAX_VERSIONS);
  }
  localStorage.setItem('versions', JSON.stringify(versions));
}

function currentText() {
  return versions[current]?.text ?? '';
}

function addVersion(text) {
  versions.push({ text, at: Date.now() });
  current = versions.length - 1;
  saveVersions();
  render({ fresh: true });
}

// ---------- Rendering ----------

const textEl = $('#text');
const micBtn = $('#mic-btn');
const statusEl = $('#status');

function render({ fresh = false } = {}) {
  const text = currentText();
  textEl.textContent = text;
  $('#placeholder').hidden = Boolean(text);
  $('#copy-btn').disabled = !text;

  if (fresh) {
    textEl.classList.remove('fresh');
    void textEl.offsetWidth; // restart the animation
    textEl.classList.add('fresh');
    $('#surface').scrollTop = 0;
  }

  $('#history').hidden = versions.length < 2;
  $('#version').textContent = `${current + 1} / ${versions.length}`;
  $('#prev-btn').disabled = current <= 0;
  $('#next-btn').disabled = current >= versions.length - 1;
  $('#new-btn').disabled = !text;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

// ---------- Recording ----------

function pickMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

function extensionFor(mime) {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

const MIN_TAKE_MS = 700;
let rec = null;
let busy = false;
let failedTake = null;

function cloudConfigured() {
  if (settings.provider === 'xai') return Boolean(settings.xaiKey);
  return Boolean(settings.apiKey) || settings.baseUrl !== DEFAULTS.baseUrl;
}

function xaiOptions() {
  return { key: settings.xaiKey, language: settings.language, keyterms: Xai.keytermsFrom(currentText()) };
}

// Picks cloud or on-device for a take, or explains why neither works.
function chooseMode() {
  const local = Local.isDownloaded();
  if (settings.engine === 'local') return local ? 'local' : 'need-model';
  if (settings.engine === 'cloud') return cloudConfigured() ? 'cloud' : 'need-key';
  if (local && (!navigator.onLine || !cloudConfigured())) return 'local';
  return cloudConfigured() ? 'cloud' : 'need-key';
}

async function startRecording() {
  const mode = chooseMode();
  if (mode === 'need-key') {
    toast('Add your API key, or download the offline model');
    return openSettings();
  }
  if (mode === 'need-model') {
    toast('Download the offline model first');
    return openSettings();
  }

  let stream;
  try {
    // The browser's noise suppression helps cloud models but garbles audio for
    // the on-device model, which was trained on unprocessed speech.
    const clean = mode !== 'local';
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: clean, noiseSuppression: clean, autoGainControl: true },
    });
  } catch (err) {
    return setStatus(`Microphone unavailable: ${err.message}`, true);
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();

  // 16 kHz audio graph: level meter, plus raw samples for on-device mode.
  const ctx = new AudioContext({ sampleRate: Local.SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  // Streaming (on-device, or xAI): feed audio as it's recorded, and replace
  // the draft live with what's heard. The previous draft stays until the first
  // words arrive.
  let live = null;
  let xai = null;
  // With live text off, the draft stays put until you stop. On-device still
  // streams in the background (it makes the result ready sooner); xAI uses
  // its batch API instead.
  const onText = (text) => settings.liveText && text && showLive(text);
  if (mode === 'local') {
    live = { ready: quiet(Local.startTake({ context: currentText(), onText })) };
  } else if (settings.provider === 'xai' && settings.liveText) {
    xai = new Xai.XaiStream({ ...xaiOptions(), onText });
  }
  if (live || xai) {
    try {
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      const tap = new AudioWorkletNode(ctx, 'pcm-tap');
      tap.port.onmessage = ({ data }) => (live ? Local.addAudio(data) : xai.addAudio(data));
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(tap).connect(mute).connect(ctx.destination);
    } catch {
      // No live audio: transcribe the whole recording at the end instead.
      if (live) Local.finishTake().catch(() => {});
      xai?.abort();
      live = xai = null;
    }
  }

  const started = performance.now();
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    micBtn.style.setProperty('--level', Math.min(Math.sqrt(sum / samples.length) * 8, 1).toFixed(3));
    setStatus(`Recording ${formatDuration(performance.now() - started)}${mode === 'local' ? ' · on-device' : xai ? ' · xAI live' : ''}`);
  }, 60);

  rec = { recorder, stream, ctx, chunks, started, timer, mode, live, xai };
  micBtn.setAttribute('aria-pressed', 'true');
  renderEngine();
  micBtn.setAttribute('aria-label', 'Finish speaking');
  setStatus('Recording 0:00');
  keepAwake(true);
}

async function stopRecording() {
  const { recorder, stream, ctx, chunks, started, timer, mode, live, xai } = rec;
  rec = null;
  clearInterval(timer);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();
  keepAwake(false);
  micBtn.setAttribute('aria-pressed', 'false');
  renderEngine();
  micBtn.setAttribute('aria-label', 'Speak');
  micBtn.style.setProperty('--level', 0);

  if (performance.now() - started < MIN_TAKE_MS || !chunks.length) {
    if (live) Local.finishTake().catch(() => {});
    xai?.abort();
    render(); // put the draft back if live text had replaced it
    return setStatus('Too short. Tap and speak, then tap again when done.');
  }
  const blob = new Blob(chunks, { type: recorder.mimeType });
  await transcribeTake({ blob, mode, live, xai });
}

// Errors are handled when the promise is awaited later; this just stops the
// browser reporting them as unhandled in the meantime.
function quiet(promise) {
  promise.catch(() => {});
  return promise;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Transcription ----------

async function transcribe(blob) {
  const form = new FormData();
  form.append('file', blob, `speech.${extensionFor(blob.type)}`);
  form.append('model', settings.model);
  form.append('response_format', 'json');
  if (settings.language) form.append('language', settings.language);
  // The draft you're revising helps with names, terms and spelling.
  const context = currentText().slice(-600);
  if (context) form.append('prompt', context);

  const headers = settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try { msg = JSON.parse(body).error?.message || body; } catch {}
    throw new Error(`${res.status} ${msg}`.slice(0, 160));
  }
  const data = await res.json();
  return (data.text || '').trim();
}

async function transcribeTake(take) {
  setBusy(true);
  setStatus('Transcribing…');
  const started = performance.now();
  try {
    const { text, via } = await transcribeWith(take);
    failedTake = null;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    textEl.classList.remove('live');
    if (text) {
      addVersion(text);
      setStatus(`${via} · ${secs} s`);
    } else {
      render();
      setStatus('Didn’t catch anything. Your draft is unchanged.');
    }
  } catch (err) {
    textEl.classList.remove('live');
    render();
    failedTake = take.blob;
    setStatus(`Transcription failed: ${err.message}`, true);
  } finally {
    $('#retry-btn').hidden = !failedTake;
    setBusy(false);
  }
}

async function transcribeWith({ blob, mode, live, xai }) {
  if (mode === 'local') {
    if (live) {
      await live.ready;
      return { text: await Local.finishTake(), via: 'On-device' };
    }
    return { text: await Local.transcribeBlob(blob, currentText()), via: 'On-device' };
  }
  if (xai) {
    try {
      return { text: await xai.finish(), via: 'xAI' };
    } catch (err) {
      console.warn('xAI live transcription failed, sending the recording instead', err);
    }
  }
  try {
    return { text: await transcribeCloud(blob), via: cloudLabel() };
  } catch (err) {
    // fetch() throws TypeError when there's no connection at all.
    if (!(err instanceof TypeError) || !Local.isDownloaded()) throw err;
    return { text: await Local.transcribeBlob(blob, currentText()), via: 'On-device (no connection)' };
  }
}

// Shows the take's transcript so far in place of the draft.
function showLive(text) {
  textEl.textContent = text;
  textEl.classList.add('live');
  $('#placeholder').hidden = true;
}

function transcribeCloud(blob) {
  return settings.provider === 'xai' ? Xai.transcribeFile(blob, xaiOptions()) : transcribe(blob);
}

function cloudLabel() {
  if (settings.provider === 'xai') return 'xAI';
  try {
    const host = new URL(settings.baseUrl).hostname;
    if (host.includes('groq')) return 'Groq';
    if (host.includes('openai')) return 'OpenAI';
    return host;
  } catch {
    return 'Cloud';
  }
}

// ---------- Cloud / Offline switch ----------

const engineBtn = $('#engine-btn');

function renderEngine() {
  const offline = settings.engine === 'local';
  engineBtn.textContent = offline ? 'Offline' : 'Cloud';
  engineBtn.setAttribute('aria-pressed', String(offline));
  engineBtn.setAttribute('aria-label', offline ? 'Using on-device transcription. Switch to cloud' : 'Using cloud transcription. Switch to on-device');
  engineBtn.disabled = Boolean(rec) || busy;
}

function saveSettingsQuietly() {
  localStorage.setItem('settings', JSON.stringify(settings));
}

engineBtn.addEventListener('click', () => {
  if (rec || busy) return;
  if (settings.engine === 'local') {
    settings = { ...settings, engine: settings.cloudEngine || 'auto' };
    toast('Cloud transcription');
  } else {
    if (!Local.isDownloaded()) {
      toast('Download the offline model first');
      return openSettings();
    }
    settings = { ...settings, cloudEngine: settings.engine, engine: 'local' };
    toast('On-device transcription');
    Local.load().catch(() => {});
  }
  saveSettingsQuietly();
  renderEngine();
});

function setBusy(on) {
  busy = on;
  micBtn.classList.toggle('busy', on);
  micBtn.disabled = on;
  $('#surface').classList.toggle('busy', on);
  renderEngine();
}

// ---------- Wake lock ----------

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on) await wakeLock?.release();
  } catch {}
  if (!on) wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec) keepAwake(true);
});

// ---------- Wiring ----------

function toggleMic() {
  if (busy) return;
  if (rec) stopRecording();
  else startRecording();
}

micBtn.addEventListener('click', toggleMic);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    toggleMic();
  }
});

$('#retry-btn').addEventListener('click', () => {
  if (!failedTake || busy) return;
  const mode = chooseMode();
  transcribeTake({ blob: failedTake, mode: mode === 'local' ? 'local' : 'cloud' });
});

$('#copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentText());
    toast('Copied');
  } catch {
    toast('Copy failed');
  }
});

$('#new-btn').addEventListener('click', () => {
  if (!currentText()) return;
  addVersion('');
  toast('New draft. Earlier versions are still in history');
});

$('#prev-btn').addEventListener('click', () => {
  if (current > 0) current--;
  render();
});
$('#next-btn').addEventListener('click', () => {
  if (current < versions.length - 1) current++;
  render();
});

// Settings dialog
const settingsDialog = $('#settings');
const form = $('#settings-form');

function openSettings() {
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  updateModelStatus();
  showProviderFields();
  settingsDialog.showModal();
}

function showProviderFields() {
  for (const el of form.querySelectorAll('.provider-fields')) el.hidden = el.dataset.provider !== form.provider.value;
}
form.provider.addEventListener('change', showProviderFields);

// ---------- Offline model ----------

function updateModelStatus() {
  const ready = Local.isDownloaded();
  $('#model-status').textContent = ready
    ? 'Downloaded. Works offline.'
    : 'Not downloaded yet. Use Wi‑Fi for the download.';
  $('#model-btn').textContent = ready ? 'Test' : 'Download';
}

let removeProgress = null;
$('#model-btn').addEventListener('click', async () => {
  const btn = $('#model-btn');
  const bar = $('#model-progress');
  btn.disabled = true;
  bar.hidden = false;
  bar.removeAttribute('value');
  $('#model-status').textContent = 'Preparing…';
  removeProgress?.();
  removeProgress = Local.onProgress(({ loaded, total }) => {
    if (!total) return;
    bar.max = total;
    bar.value = loaded;
    $('#model-status').textContent = `Downloading… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`;
  });
  // Ask the browser not to evict the model when storage runs low.
  navigator.storage?.persist?.().catch(() => {});
  try {
    const t = performance.now();
    await Local.load();
    updateModelStatus();
    $('#model-status').textContent += ` Ready in ${((performance.now() - t) / 1000).toFixed(1)} s.`;
  } catch (err) {
    $('#model-status').textContent = `Download failed: ${err.message}`;
  } finally {
    removeProgress?.();
    removeProgress = null;
    bar.hidden = true;
    btn.disabled = false;
  }
});

// Load the model ahead of time whenever a take would use it.
function warmUpIfNeeded() {
  if (chooseMode() === 'local') Local.load().catch(() => {});
}
window.addEventListener('offline', warmUpIfNeeded);

// Show the Groq endpoint as soon as a Groq key is typed or pasted.
form.apiKey.addEventListener('input', () => {
  // An xAI key pasted here belongs in the xAI field.
  if (form.apiKey.value.trim().startsWith('xai-')) {
    form.xaiKey.value = form.apiKey.value.trim();
    form.apiKey.value = '';
    form.provider.value = 'xai';
    showProviderFields();
    return;
  }
  const s = withProviderDefaults({ apiKey: form.apiKey.value.trim(), baseUrl: form.baseUrl.value.trim(), model: form.model.value.trim() });
  form.baseUrl.value = s.baseUrl;
  form.model.value = s.model;
});

$('#settings-btn').addEventListener('click', openSettings);
settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  settings = withProviderDefaults({
    baseUrl: form.baseUrl.value.trim() || DEFAULTS.baseUrl,
    apiKey: form.apiKey.value.trim(),
    model: form.model.value.trim() || DEFAULTS.model,
    language: form.language.value.trim(),
    engine: form.engine.value,
    cloudEngine: settings.cloudEngine,
    provider: form.provider.value,
    xaiKey: form.xaiKey.value.trim(),
    liveText: form.liveText.checked,
  });
  localStorage.setItem('settings', JSON.stringify(settings));
  toast('Settings saved');
  renderEngine();
  warmUpIfNeeded();
});

// Init
render();
renderEngine();
warmUpIfNeeded();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // The service worker adds the headers that let the on-device model use all
  // CPU cores. They apply from the next page load, so reload once when it
  // first takes over (never in the middle of a take).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!crossOriginIsolated && !rec && !busy && !sessionStorage.getItem('isolationReload')) {
      sessionStorage.setItem('isolationReload', '1');
      location.reload();
    }
  });
}
