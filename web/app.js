// Voice Drafts: a focused surface for thinking out loud.
// Speak -> the transcript fills the surface -> read it -> speak again, and the
// new take overwrites it. Save keeps it as a note when you're happy with it.
// Transcription: a Whisper-compatible /audio/transcriptions endpoint (Groq,
// OpenAI, …), xAI Grok realtime streaming, or Moonshine on the device.

import * as Local from './local-stt.js';
import * as Xai from './xai-stt.js';
import * as Tts from './xai-tts.js';
import * as LocalTts from './local-tts.js';
import * as Clips from './clips.js';

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
  ttsVoice: 'eve', // xAI voice for Read aloud
  ttsSpeed: 1,
  ttsEngine: 'auto', // read aloud with: auto (xAI online, on-device offline) | local | xai
  localVoice: 'F1', // Supertonic voice for on-device read aloud
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

// ---------- The draft ----------
// One working text. Each take overwrites it. It's kept across app restarts
// (so it isn't lost if the phone closes the app), but it's not a saved note.

let draft = localStorage.getItem('draft') ?? '';
// Earlier builds kept every version; carry over the one on screen, drop the rest.
if (localStorage.getItem('versions') !== null) {
  const old = loadJSON('versions', []);
  draft = [...old].reverse().find((v) => v.text)?.text ?? '';
  localStorage.removeItem('versions');
  localStorage.setItem('draft', draft);
}

function currentText() {
  return draft;
}

function setDraft(text, { fresh = true } = {}) {
  draft = text;
  localStorage.setItem('draft', draft);
  render({ fresh });
}

// ---------- Rendering ----------

const textEl = $('#text');
const micBtn = $('#mic-btn');
const statusEl = $('#status');

// Draft text is hidden by default so you can focus on speaking; the eye
// button shows it. Remembered on this device.
let showText = localStorage.getItem('showText') === '1';

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function render({ fresh = false } = {}) {
  const text = currentText();
  textEl.textContent = text;
  textEl.hidden = !showText;
  $('#placeholder').hidden = Boolean(text);
  const note = $('#hidden-note');
  note.hidden = showText || !text;
  if (text) {
    const n = wordCount(text);
    note.textContent = `Draft hidden · ${n} word${n === 1 ? '' : 's'}`;
  }
  const eye = $('#eye-btn');
  eye.setAttribute('aria-pressed', String(showText));
  eye.setAttribute('aria-label', showText ? 'Hide draft text' : 'Show draft text');
  $('#copy-btn').disabled = !text;

  if (fresh) {
    textEl.classList.remove('fresh');
    void textEl.offsetWidth; // restart the animation
    textEl.classList.add('fresh');
    $('#surface').scrollTop = 0;
  }

  $('#clear-btn').disabled = !text;
  $('#save-btn').disabled = !text;
  $('#save-btn').classList.toggle('done', Boolean(text) && isSaved(text));
  $('#save-btn').textContent = text && isSaved(text) ? 'Saved' : 'Save';
  // Whatever was being read aloud belongs to the text that was on screen.
  if (player?.text !== undefined && player.text !== text) player.stop();
  renderListen();
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  // Show it above any open dialog, which would otherwise cover it.
  const dialog = [...document.querySelectorAll('dialog[open]')].pop();
  (dialog ?? document.body).append(el);
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

// ---------- Read aloud ----------
// xAI Grok voices in the cloud, or Supertonic 3 on the device.

const listenBtn = $('#listen-btn');
const LISTEN_LABELS = { idle: 'Listen', loading: 'Loading…', playing: 'Stop' };

const idleWaiters = [];
function onTtsState(state) {
  listenBtn.dataset.state = state;
  listenBtn.textContent = LISTEN_LABELS[state];
  listenBtn.setAttribute('aria-label', state === 'idle' ? 'Listen to the draft' : 'Stop listening');
  if (state === 'idle') idleWaiters.splice(0).forEach((fn) => fn());
}
const xaiPlayer = new Tts.Player(onTtsState);
const localPlayer = new LocalTts.LocalPlayer(onTtsState);
const clipPlayer = new Clips.ClipPlayer(onTtsState);

// Clips being generated in the background (Play all prepares the next note).
const pendingClips = new Map();

// Generates a clip without playing it and saves it.
function prepareClip(text, engine = ttsEngine()) {
  if (!engine) return null;
  const opts = engine === 'local' ? localTtsOptions(text) : xaiTtsOptions();
  const key = Clips.keyFor(engine, text, opts);
  if (!pendingClips.has(key)) {
    const job = (async () => {
      if (await Clips.get(key)) return;
      const blob = engine === 'local' ? await LocalTts.render(text, opts) : await Tts.synthesize(text, opts);
      if (blob) await Clips.put(key, blob);
    })()
      .catch(() => {})
      .finally(() => pendingClips.delete(key));
    pendingClips.set(key, job);
  }
  return pendingClips.get(key);
}

// Which voice engine to use, or null if none is set up.
function ttsEngine(pref = settings.ttsEngine, xaiKey = settings.xaiKey) {
  const local = LocalTts.isDownloaded();
  if (pref === 'local') return local ? 'local' : null;
  if (pref === 'xai') return xaiKey ? 'xai' : null;
  if (xaiKey && navigator.onLine) return 'xai';
  return local ? 'local' : xaiKey ? 'xai' : null;
}

function xaiTtsOptions(o = {}) {
  return { key: settings.xaiKey, voice: settings.ttsVoice, speed: settings.ttsSpeed, language: settings.language, ...o };
}

function localTtsOptions(text, o = {}) {
  const speed = (o.speed ?? settings.ttsSpeed) * 1.05; // Supertonic's natural pace is 1.05
  return { voice: settings.localVoice, lang: LocalTts.languageFor(text, settings.language), ...o, speed };
}

// One player for both engines. `text` records what's being read (undefined
// for a voice preview), so it can be stopped when the draft changes.
const player = {
  text: undefined,
  active: null,
  get state() {
    return this.active?.state ?? 'idle';
  },
  // Resolves once the audio is fully generated (it may still be playing).
  async play(text, { engine = ttsEngine(), xai, local } = {}) {
    this.stop();
    if (!engine) throw new Error('add an xAI key, or download the on-device voice in Settings');
    const token = (this.token = {});
    const run = async (e) => {
      const opts = e === 'local' ? localTtsOptions(text, local) : xaiTtsOptions(xai);
      const key = Clips.keyFor(e, text, opts);
      // A clip that's being prepared right now: wait for it rather than
      // generating it twice.
      if (pendingClips.has(key)) {
        onTtsState('loading');
        await pendingClips.get(key);
        if (token !== this.token) return;
      }
      const saved = await Clips.get(key);
      if (token !== this.token) return;
      if (saved) {
        this.active = clipPlayer;
        return clipPlayer.play(saved);
      }
      const onClip = (blob) => Clips.put(key, blob);
      this.active = e === 'local' ? localPlayer : xaiPlayer;
      return this.active.play(text, { ...opts, onClip });
    };
    try {
      await run(engine);
    } catch (err) {
      // No connection: fall back to the on-device voice if it's there.
      if (engine === 'xai' && err instanceof TypeError && LocalTts.isDownloaded()) return run('local');
      throw err;
    }
  },
  stop() {
    this.token = null;
    xaiPlayer.stop();
    localPlayer.stop();
    clipPlayer.stop();
  },
  // Resolves when playback ends or is stopped.
  untilIdle() {
    return this.state === 'idle' ? Promise.resolve() : new Promise((r) => idleWaiters.push(r));
  },
};

function renderListen() {
  listenBtn.hidden = !ttsEngine() || !currentText() || Boolean(rec);
}

listenBtn.addEventListener('click', () => {
  if (playlist) return stopPlayAll();
  if (player.state !== 'idle') return player.stop();
  const text = currentText();
  player.text = text;
  player.play(text).catch((err) => toast(`Couldn’t read aloud: ${err.message}`));
});

async function startRecording() {
  stopPlayAll();
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
  renderListen();
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
  renderListen();
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
      setDraft(text);
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
  if (!showText) {
    const n = wordCount(text);
    $('#hidden-note').hidden = false;
    $('#hidden-note').textContent = `Listening · ${n} word${n === 1 ? '' : 's'}`;
  }
}

$('#eye-btn').addEventListener('click', () => {
  showText = !showText;
  try {
    localStorage.setItem('showText', showText ? '1' : '0');
  } catch {}
  if (textEl.classList.contains('live')) {
    // Mid-take: keep showing what's been heard so far, just toggle visibility.
    textEl.hidden = !showText;
    $('#hidden-note').hidden = showText;
    $('#eye-btn').setAttribute('aria-pressed', String(showText));
    return;
  }
  render();
});

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

// Copies text to the clipboard. Tries the Clipboard API, then the older
// execCommand way, and if the browser refuses both, shows the text selected so
// it can be copied by hand.
async function copyText(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    return toast(done);
  } catch {}
  const host = [...document.querySelectorAll('dialog[open]')].pop() ?? document.body;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  host.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  area.remove();
  if (ok) return toast(done);
  const dialog = $('#copy-dialog');
  $('#copy-text').value = text;
  dialog.showModal();
  $('#copy-text').focus();
  $('#copy-text').select();
}

$('#copy-btn').addEventListener('click', () => copyText(currentText()));

// Blanks the draft. Notes are kept.
$('#clear-btn').addEventListener('click', () => {
  const text = currentText();
  if (!text || rec || busy) return;
  if (!isSaved(text) && !confirm('Clear this draft? It isn’t saved as a note.')) return;
  player.stop();
  setDraft('', { fresh: false });
  setStatus('');
  toast('Cleared');
});

// ---------- Paste ----------
// Puts clipboard text on the surface, e.g. to listen to it and then say it in
// your own words, which overwrites it like any other take.

const pasteDialog = $('#paste-dialog');

function usePasted(raw) {
  const text = (raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return toast('Nothing to paste');
  const current = currentText();
  if (current && current !== text && !isSaved(current) && !confirm('Replace the current draft? It isn’t saved as a note.')) return;
  player.stop();
  setDraft(text);
  setStatus('Pasted. Tap Listen, then say it your way.');
}

$('#paste-btn').addEventListener('click', async () => {
  if (rec || busy) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) return usePasted(text);
  } catch {
    // No clipboard access (permission denied or unsupported): paste by hand.
  }
  $('#paste-text').value = '';
  pasteDialog.showModal();
  $('#paste-text').focus();
});

pasteDialog.addEventListener('close', () => {
  if (pasteDialog.returnValue === 'paste') usePasted($('#paste-text').value);
  pasteDialog.returnValue = '';
});

// ---------- Notes ----------
// Drafts you chose to keep with Save, newest first.

let saved = loadJSON('saved', []);

function isSaved(text) {
  return saved.some((d) => d.text === text);
}

function storeSaved() {
  localStorage.setItem('saved', JSON.stringify(saved));
  const count = $('#saved-count');
  count.hidden = !saved.length;
  count.textContent = saved.length > 99 ? '99+' : String(saved.length);
}

$('#save-btn').addEventListener('click', () => {
  const text = currentText();
  if (!text) return;
  if (isSaved(text)) return toast('Already in your notes');
  saved.unshift({ id: crypto.randomUUID?.() ?? String(Date.now()), text, at: Date.now() });
  storeSaved();
  render();
  toast('Saved to notes');
});

const savedDialog = $('#saved');
const savedDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// All notes as one text, in the order they were saved (oldest first), with a
// blank line between them.
function allNotesText() {
  return [...saved].reverse().map((d) => d.text.trim()).join('\n\n');
}

$('#copy-all-btn').addEventListener('click', () =>
  copyText(allNotesText(), `Copied ${saved.length} note${saved.length === 1 ? '' : 's'}`),
);

// Combines all notes (oldest first, blank line between) into a single note,
// e.g. once every section of a long piece is recorded.
$('#merge-notes-btn').addEventListener('click', () => {
  const n = saved.length;
  if (n < 2 || !confirm(`Merge all ${n} notes into one, oldest first? The separate notes will be replaced by the merged note.`)) return;
  if (playlist) stopPlayAll();
  saved = [{ id: crypto.randomUUID?.() ?? String(Date.now()), text: allNotesText(), at: Date.now() }];
  storeSaved();
  renderSaved();
  render();
  toast(`Merged ${n} notes into one`);
});

// Clears every note, e.g. after copying a finished long draft, to start the next.
$('#clear-notes-btn').addEventListener('click', () => {
  const n = saved.length;
  if (!n || !confirm(`Delete all ${n} note${n === 1 ? '' : 's'}? This can’t be undone, so use Copy all first if you need them.`)) return;
  if (playlist) stopPlayAll();
  saved = [];
  storeSaved();
  renderSaved();
  render();
  toast('All notes deleted');
});

function renderSaved() {
  $('#saved-empty').hidden = saved.length > 0;
  $('#copy-all-btn').hidden = saved.length === 0;
  queueMicrotask(renderPlayAll);
  $('#clear-notes-btn').hidden = saved.length === 0;
  $('#merge-notes-btn').hidden = saved.length < 2;
  $('#saved-list').replaceChildren(
    ...saved.map((d) => {
      const li = document.createElement('li');
      li.dataset.id = d.id;
      const p = document.createElement('p');
      p.className = 'saved-text';
      p.textContent = d.text;
      const time = document.createElement('time');
      time.dateTime = new Date(d.at).toISOString();
      time.textContent = savedDate.format(d.at);
      const actions = document.createElement('div');
      actions.className = 'saved-actions';
      const button = (label, action, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn ${cls}`.trim();
        b.textContent = label;
        b.dataset.action = action;
        return b;
      };
      actions.append(button('Open', 'open'), button('Copy', 'copy'));
      if (ttsEngine()) actions.append(button('Listen', 'listen'));
      const del = button('', 'delete', 'danger icon');
      del.setAttribute('aria-label', 'Delete');
      del.title = 'Delete';
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>';
      actions.append(del);
      li.append(p, time, actions);
      return li;
    }),
  );
}

$('#saved-btn').addEventListener('click', () => {
  if (rec) return;
  renderSaved();
  savedDialog.showModal();
});

$('#saved-list').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const id = e.target.closest('li')?.dataset.id;
  const note = saved.find((d) => d.id === id);
  if (!action || !note) return;
  if (action === 'open') {
    // Puts the note on the surface so you can keep revising it by voice.
    const text = currentText();
    if (text && text !== note.text && !isSaved(text) && !confirm('Replace the current draft? It isn’t saved as a note.')) return;
    player.stop();
    setDraft(note.text);
    savedDialog.close();
  } else if (action === 'copy') {
    copyText(note.text);
  } else if (action === 'listen') {
    if (playlist) stopPlayAll();
    else if (player.state !== 'idle' && player.text === note.text) return player.stop();
    player.text = note.text;
    player.play(note.text).catch((err) => toast(`Couldn’t read aloud: ${err.message}`));
  } else if (action === 'delete') {
    if (!confirm('Delete this note?')) return;
    if (playlist) stopPlayAll();
    saved = saved.filter((d) => d !== note);
    storeSaved();
    renderSaved();
    render();
  }
});

savedDialog.addEventListener('close', () => {
  // Play all keeps going with Notes closed; a single note's Listen stops.
  if (!playlist && player.text !== currentText()) player.stop();
});

// ---------- Play all ----------
// Reads every note aloud, oldest first. Saved clips play instantly; others are
// generated (streaming, so they start fast). While one note plays, the next
// note's clip is prepared in the background so there's no wait in between.

let playlist = null; // { index, count } while playing

function renderPlayAll() {
  const btn = $('#play-all-btn');
  btn.hidden = saved.length === 0 || !ttsEngine();
  btn.textContent = playlist ? `Stop (${playlist.index + 1}/${playlist.count})` : 'Play all';
  btn.toggleAttribute('data-active', Boolean(playlist));
  const current = playlist ? [...saved].reverse()[playlist.index]?.id : null;
  for (const li of $('#saved-list').children) li.classList.toggle('playing', li.dataset.id === current);
}

function stopPlayAll() {
  playlist = null;
  player.stop();
  renderPlayAll();
}

async function playAll() {
  const notes = [...saved].reverse();
  const run = (playlist = { index: 0, count: notes.length });
  player.text = undefined; // not tied to the draft on screen
  try {
    for (let i = 0; i < notes.length && playlist === run; i++) {
      run.index = i;
      renderPlayAll();
      await player.play(notes[i].text);
      if (playlist !== run) break;
      // Generation of this note is done: prepare the next while this one plays.
      if (notes[i + 1]) prepareClip(notes[i + 1].text);
      await player.untilIdle();
    }
  } catch (err) {
    if (playlist === run) toast(`Couldn’t read aloud: ${err.message}`);
  } finally {
    if (playlist === run) {
      playlist = null;
      renderPlayAll();
    }
  }
}

$('#play-all-btn').addEventListener('click', () => {
  if (playlist) return stopPlayAll();
  if (rec || busy || !saved.length) return;
  playAll();
});


// Settings dialog
const settingsDialog = $('#settings');
const form = $('#settings-form');

function openSettings() {
  fillVoices(Tts.cachedVoices());
  if (!form.localVoice.options.length) {
    form.localVoice.replaceChildren(...LocalTts.VOICES.map(([id, name]) => new Option(name, id)));
  }
  updateLocalTtsStatus();
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  updateModelStatus();
  showProviderFields();
  updateSpeedLabel();
  refreshVoices();
  settingsDialog.showModal();
}

// ---------- Read aloud settings ----------

function fillVoices(voices) {
  const select = form.ttsVoice;
  const chosen = select.value || settings.ttsVoice;
  const list = voices.length ? voices : [{ voice_id: Tts.DEFAULT_VOICE, name: 'Eve', gender: 'female' }];
  select.replaceChildren(
    ...list.map((v) => new Option(v.gender ? `${v.name} (${v.gender})` : v.name, v.voice_id)),
  );
  if (![...select.options].some((o) => o.value === chosen)) select.add(new Option(chosen, chosen));
  select.value = chosen;
}

async function refreshVoices() {
  const key = form.xaiKey.value.trim();
  const status = $('#voice-status');
  if (!key) {
    status.textContent = 'No xAI key: only the on-device voice is available.';
    return;
  }
  status.textContent = '';
  try {
    fillVoices(await Tts.listVoices(key));
    status.textContent = `${form.ttsVoice.options.length} voices`;
  } catch (err) {
    status.textContent = `Couldn’t load voices: ${err.message}`;
  }
}

function updateSpeedLabel() {
  $('#speed-out').textContent = `(${Number(form.ttsSpeed.value).toFixed(2)}×)`;
}
form.ttsSpeed.addEventListener('input', updateSpeedLabel);
form.xaiKey.addEventListener('change', refreshVoices);

$('#preview-btn').addEventListener('click', () => {
  // Tapping Preview again stops the preview; anything else playing is replaced.
  if (player.state !== 'idle' && player.text === undefined) return player.stop();
  const key = form.xaiKey.value.trim();
  const engine = ttsEngine(form.ttsEngine.value, key);
  if (!engine) {
    $('#voice-status').textContent = form.ttsEngine.value === 'local' ? 'Download the on-device voice first.' : 'Add an xAI API key first.';
    return;
  }
  const select = engine === 'local' ? form.localVoice : form.ttsVoice;
  const name = select.selectedOptions[0]?.text.replace(/ \(.*\)$/, '') || 'this voice';
  const text = `Hi, I'm ${name}. This is how your drafts will sound.`;
  const speed = Number(form.ttsSpeed.value);
  player.text = undefined;
  player
    .play(text, { engine, xai: { key, voice: form.ttsVoice.value, speed }, local: { voice: form.localVoice.value, speed } })
    .catch((err) => ($('#voice-status').textContent = `Preview failed: ${err.message}`));
});

function showProviderFields() {
  for (const el of form.querySelectorAll('.provider-fields')) el.hidden = el.dataset.provider !== form.provider.value;
}
form.provider.addEventListener('change', showProviderFields);

// ---------- On-device voice (Supertonic) ----------

function updateLocalTtsStatus() {
  const ready = LocalTts.isDownloaded();
  $('#localtts-status').textContent = ready
    ? 'On-device voice downloaded. Works offline.'
    : `On-device voice not downloaded (about ${LocalTts.APPROX_MB} MB, use Wi‑Fi).`;
  $('#localtts-btn').textContent = ready ? 'Test' : 'Download';
}

$('#localtts-btn').addEventListener('click', async () => {
  const btn = $('#localtts-btn');
  const bar = $('#localtts-progress');
  btn.disabled = true;
  bar.hidden = false;
  bar.max = LocalTts.APPROX_MB;
  bar.removeAttribute('value');
  $('#localtts-status').textContent = 'Preparing…';
  const off = LocalTts.onProgress((loaded) => {
    const mb = Math.round(loaded / 1e6);
    bar.value = Math.min(mb, LocalTts.APPROX_MB);
    $('#localtts-status').textContent = `Downloading… ${mb} / ~${LocalTts.APPROX_MB} MB`;
  });
  navigator.storage?.persist?.().catch(() => {});
  try {
    const t = performance.now();
    const device = await LocalTts.load();
    updateLocalTtsStatus();
    $('#localtts-status').textContent += ` Using the ${device === 'webgpu' ? 'GPU' : 'CPU'}, ready in ${((performance.now() - t) / 1000).toFixed(1)} s.`;
    renderListen();
  } catch (err) {
    $('#localtts-status').textContent = `Download failed: ${err.message}`;
  } finally {
    off();
    bar.hidden = true;
    btn.disabled = false;
  }
});

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
    refreshVoices();
    return;
  }
  const s = withProviderDefaults({ apiKey: form.apiKey.value.trim(), baseUrl: form.baseUrl.value.trim(), model: form.model.value.trim() });
  form.baseUrl.value = s.baseUrl;
  form.model.value = s.model;
});

$('#settings-btn').addEventListener('click', openSettings);
settingsDialog.addEventListener('close', () => {
  if (player.text === undefined) player.stop(); // a voice preview
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
    ttsVoice: form.ttsVoice.value || Tts.DEFAULT_VOICE,
    ttsEngine: form.ttsEngine.value,
    localVoice: form.localVoice.value || 'F1',
    ttsSpeed: Number(form.ttsSpeed.value) || 1,
  });
  localStorage.setItem('settings', JSON.stringify(settings));
  toast('Settings saved');
  renderEngine();
  renderListen();
  warmUpIfNeeded();
});

// Init
storeSaved();
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
