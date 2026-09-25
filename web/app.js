// Voice Drafts: a focused surface for thinking out loud.
// Speak -> the transcript fills the surface -> read it -> speak again, and the
// new take replaces it. Earlier versions are kept so a bad take is never a loss.
// Transcription uses an OpenAI-compatible /audio/transcriptions endpoint.

const $ = (sel) => document.querySelector(sel);

// ---------- Settings ----------

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: '',
};

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

let settings = { ...DEFAULTS, ...loadJSON('settings', {}) };

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
let rec = null; // { recorder, stream, ctx, chunks, started, timer }
let busy = false;
let failedTake = null;

async function startRecording() {
  if (!settings.apiKey && settings.baseUrl === DEFAULTS.baseUrl) {
    toast('Add your API key first');
    return openSettings();
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    return setStatus(`Microphone unavailable: ${err.message}`, true);
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();

  // Level meter for the ring around the button.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const started = performance.now();
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    micBtn.style.setProperty('--level', Math.min(Math.sqrt(sum / samples.length) * 8, 1).toFixed(3));
    setStatus(`Recording ${formatDuration(performance.now() - started)}`);
  }, 60);

  rec = { recorder, stream, ctx, chunks, started, timer };
  micBtn.setAttribute('aria-pressed', 'true');
  micBtn.setAttribute('aria-label', 'Finish speaking');
  setStatus('Recording 0:00');
  keepAwake(true);
}

async function stopRecording() {
  const { recorder, stream, ctx, chunks, started, timer } = rec;
  rec = null;
  clearInterval(timer);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();
  keepAwake(false);
  micBtn.setAttribute('aria-pressed', 'false');
  micBtn.setAttribute('aria-label', 'Speak');
  micBtn.style.setProperty('--level', 0);

  if (performance.now() - started < MIN_TAKE_MS || !chunks.length) {
    return setStatus('Too short. Tap and speak, then tap again when done.');
  }
  await transcribeTake(new Blob(chunks, { type: recorder.mimeType }));
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

async function transcribeTake(blob) {
  setBusy(true);
  setStatus('Transcribing…');
  try {
    const text = await transcribe(blob);
    failedTake = null;
    if (text) {
      addVersion(text);
      setStatus('');
    } else {
      setStatus('Didn’t catch anything. Your draft is unchanged.');
    }
  } catch (err) {
    failedTake = blob;
    setStatus(`Transcription failed: ${err.message}`, true);
  } finally {
    $('#retry-btn').hidden = !failedTake;
    setBusy(false);
  }
}

function setBusy(on) {
  busy = on;
  micBtn.classList.toggle('busy', on);
  micBtn.disabled = on;
  $('#surface').classList.toggle('busy', on);
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

$('#retry-btn').addEventListener('click', () => failedTake && !busy && transcribeTake(failedTake));

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
    if (form.elements[key]) form.elements[key].value = value;
  }
  settingsDialog.showModal();
}

// Pasting a Groq key fills in Groq's endpoint and Whisper model.
const GROQ = { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' };
form.apiKey.addEventListener('input', () => {
  if (form.apiKey.value.trim().startsWith('gsk_') && form.baseUrl.value.trim() === DEFAULTS.baseUrl) {
    form.baseUrl.value = GROQ.baseUrl;
    if (form.model.value.trim() === DEFAULTS.model) form.model.value = GROQ.model;
  }
});

$('#settings-btn').addEventListener('click', openSettings);
settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  settings = {
    baseUrl: form.baseUrl.value.trim() || DEFAULTS.baseUrl,
    apiKey: form.apiKey.value.trim(),
    model: form.model.value.trim() || DEFAULTS.model,
    language: form.language.value.trim(),
  };
  localStorage.setItem('settings', JSON.stringify(settings));
  toast('Settings saved');
});

// Init
render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
