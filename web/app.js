// Voice Notes: hands-free dictation using an OpenAI-compatible
// /audio/transcriptions endpoint. No framework, no build step.

const $ = (sel) => document.querySelector(sel);

// ---------- Settings ----------

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: '',
  sensitivity: 5,
  silenceMs: 1200,
  speak: true,
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

let settings = loadSettings();

function saveSettings(next) {
  settings = { ...settings, ...next };
  localStorage.setItem('settings', JSON.stringify(settings));
}

// ---------- Storage (IndexedDB) ----------

const db = (() => {
  let opening;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('voice-notes', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('notes', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  async function run(mode, fn) {
    const conn = await open();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction('notes', mode);
      const req = fn(tx.objectStore('notes'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    all: () => run('readonly', (s) => s.getAll()),
    put: (note) => run('readwrite', (s) => s.put(note)),
    delete: (id) => run('readwrite', (s) => s.delete(id)),
  };
})();

// ---------- Draft ----------
// The draft is a list of transcribed segments so "scratch that" can remove
// the last one. Typing in the textarea collapses it into a single segment.

let segments = JSON.parse(localStorage.getItem('draft') || '[]');

const draftEl = $('#draft');

function setSegments(next) {
  segments = next.filter((s) => s.trim());
  localStorage.setItem('draft', JSON.stringify(segments));
  draftEl.value = segments.join(' ');
  updateDraftButtons();
}

function draftText() {
  return segments.join(' ').trim();
}

function updateDraftButtons() {
  const empty = !draftText();
  $('#save-btn').disabled = empty;
  $('#discard-btn').disabled = empty;
  $('#undo-btn').disabled = empty;
}

draftEl.addEventListener('input', () => {
  segments = draftEl.value.trim() ? [draftEl.value] : [];
  localStorage.setItem('draft', JSON.stringify(segments));
  updateDraftButtons();
});

async function saveDraft() {
  const text = draftText();
  if (!text) return false;
  const now = Date.now();
  await db.put({ id: crypto.randomUUID(), text, created: now, updated: now });
  setSegments([]);
  await renderNotes();
  return true;
}

// ---------- Notes list ----------

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let notesCache = [];

async function renderNotes() {
  notesCache = (await db.all()).sort((a, b) => b.created - a.created);
  const list = $('#notes');
  list.replaceChildren(
    ...notesCache.map((note) => {
      const li = document.createElement('li');
      li.dataset.id = note.id;
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = note.text;
      const time = document.createElement('time');
      time.dateTime = new Date(note.created).toISOString();
      time.textContent = dateFmt.format(note.created);
      li.append(text, time);
      return li;
    }),
  );
  $('#empty').hidden = notesCache.length > 0;
  $('#note-count').textContent = notesCache.length ? `(${notesCache.length})` : '';
}

let openNote = null;
const noteDialog = $('#note-dialog');

$('#notes').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  openNote = notesCache.find((n) => n.id === li.dataset.id);
  if (!openNote) return;
  $('#note-date').textContent = dateFmt.format(openNote.created);
  $('#note-text').value = openNote.text;
  $('#share-btn').hidden = !navigator.share;
  noteDialog.showModal();
});

noteDialog.addEventListener('close', async () => {
  const note = openNote;
  if (!note) return;
  const text = $('#note-text').value.trim();
  const action = noteDialog.returnValue;
  noteDialog.returnValue = '';

  if (action === 'copy') {
    await navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'));
  } else if (action === 'share') {
    navigator.share({ text }).catch(() => {});
  }

  if (action === 'delete') {
    if (!confirm('Delete this note?')) return noteDialog.showModal();
    await db.delete(note.id);
  } else if (text && text !== note.text) {
    await db.put({ ...note, text, updated: Date.now() });
  } else if (!text) {
    await db.delete(note.id);
  }
  openNote = null;
  renderNotes();
});

// ---------- UI helpers ----------

const statusEl = $('#status');
const micBtn = $('#mic-btn');

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
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

function speak(text) {
  if (!settings.speak || !('speechSynthesis' in window)) return;
  // Mute the mic while talking so the app doesn't transcribe itself.
  listener.mute(true);
  const u = new SpeechSynthesisUtterance(text);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    listener.mute(false);
  };
  u.onend = finish;
  u.onerror = finish;
  // Some Android builds never fire onend, so don't rely on it.
  setTimeout(finish, 1500 + text.length * 90);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------- Listener: mic + voice activity detection ----------
// Records continuously and cuts the recording into a segment whenever speech
// is followed by a pause. Each segment is a complete audio file.

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

const TICK_MS = 50;
const MIN_ONSET_MS = 150; // loud this long before it counts as speech
const MIN_SPEECH_MS = 300; // segments with less speech than this are dropped
const MAX_SEGMENT_MS = 60_000;
const IDLE_RESET_MS = 10_000; // throw away recorded silence this often

class Listener {
  constructor({ onSegment, onLevel, onSpeaking }) {
    Object.assign(this, { onSegment, onLevel, onSpeaking });
    this.active = false;
    this.muted = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.mimeType = pickMimeType();
    this.floor = 0.002;
    this.active = true;
    this.startRecorder();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    // Keep whatever was being said when the mic was turned off.
    this.cut(this.speaking && this.speechMs >= MIN_SPEECH_MS);
    this.stream.getTracks().forEach((t) => t.stop());
    this.ctx.close();
    this.onLevel(0);
    this.onSpeaking(false);
  }

  mute(on) {
    this.muted = on;
    // Discard audio recorded while muted (it contains our own voice).
    if (!on && this.active) this.cut(false);
  }

  startRecorder() {
    const rec = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      if (rec.keep && chunks.length) {
        this.onSegment(new Blob(chunks, { type: rec.mimeType || this.mimeType }), rec.speechMs);
      }
    };
    rec.start();
    this.rec = rec;
    this.segStart = performance.now();
    this.speechMs = 0;
    this.silenceMs = 0;
    if (this.speaking) this.onSpeaking(false);
    this.speaking = false;
  }

  cut(keep) {
    const rec = this.rec;
    rec.keep = keep;
    rec.speechMs = this.speechMs;
    if (rec.state !== 'inactive') rec.stop();
    if (this.active) this.startRecorder();
  }

  tick() {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    const rms = Math.sqrt(sum / this.samples.length);

    // Threshold follows the background noise level; sensitivity sets the floor.
    const minLevel = 0.004 * 2 ** ((5 - settings.sensitivity) / 2);
    const threshold = Math.max(this.floor * 3, minLevel);
    const loud = rms > threshold;
    this.floor += (rms - this.floor) * (loud ? 0.002 : 0.05);
    this.onLevel(Math.min(rms / threshold / 3, 1));

    if (this.muted) return;

    if (loud) {
      this.speechMs += TICK_MS;
      this.silenceMs = 0;
      if (!this.speaking && this.speechMs >= MIN_ONSET_MS) {
        this.speaking = true;
        this.onSpeaking(true);
      }
    } else if (this.speaking) {
      this.silenceMs += TICK_MS;
    } else {
      this.speechMs = 0;
    }

    const age = performance.now() - this.segStart;
    if (this.speaking && this.silenceMs >= settings.silenceMs) {
      this.cut(this.speechMs >= MIN_SPEECH_MS);
    } else if (this.speaking && age >= MAX_SEGMENT_MS) {
      this.cut(true);
    } else if (!this.speaking && !loud && age >= IDLE_RESET_MS) {
      this.cut(false);
    }
  }
}

// ---------- Transcription ----------

async function transcribe(blob) {
  const form = new FormData();
  form.append('file', blob, `speech.${extensionFor(blob.type)}`);
  form.append('model', settings.model);
  form.append('response_format', 'json');
  if (settings.language) form.append('language', settings.language);
  // The tail of the current note helps with continuity and spelling.
  const context = draftText().slice(-200);
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

// Whisper tends to invent these on near-silent audio.
const HALLUCINATIONS = new Set(['you', 'thank you', 'thanks for watching', 'thank you for watching', 'bye', 'thank you very much']);

let queue = Promise.resolve();
let pending = 0;
const failed = [];

function updatePending() {
  $('#pending').textContent = pending ? `Transcribing ${pending}…` : '';
  $('#retry-btn').hidden = failed.length === 0;
  $('#retry-btn').textContent = `Retry ${failed.length} failed`;
}

function enqueue(blob, speechMs) {
  pending++;
  updatePending();
  queue = queue
    .then(() => handleSegment(blob, speechMs))
    .catch((err) => {
      failed.push({ blob, speechMs });
      setStatus(`Transcription failed: ${err.message}`, true);
    })
    .finally(() => {
      pending--;
      updatePending();
    });
}

$('#retry-btn').addEventListener('click', () => {
  const items = failed.splice(0);
  items.forEach(({ blob, speechMs }) => enqueue(blob, speechMs));
});

async function handleSegment(blob, speechMs) {
  const text = await transcribe(blob);
  const norm = normalize(text);
  if (!norm) return;
  if (speechMs < 1500 && HALLUCINATIONS.has(norm)) return;
  await applyUtterance(text, norm);
  if (listener.active) setStatus('Listening…');
}

// ---------- Voice commands ----------

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const WHOLE_COMMANDS = [
  [/^(save|save (the )?note|save it|new note|next note|done|note done)$/, 'save'],
  [/^(scratch that|undo( that)?|delete (that|last)|remove (that|last))$/, 'undo'],
  [/^(discard|discard (the )?note|cancel (the )?note|clear (the )?note)$/, 'discard'],
  [/^(read (it )?back|read (the )?note)$/, 'read'],
  [/^(stop|stop listening|stop recording)$/, 'stop'],
];
const TRAILING_SAVE = /[\s,.;:!?-]*\b(save (the )?note|note done)[\s.!?]*$/i;
const LEADING_NEW = /^\s*new note\b[\s,.;:!?-]*/i;

async function applyUtterance(text, norm) {
  const command = WHOLE_COMMANDS.find(([re]) => re.test(norm))?.[1];
  if (command) return runCommand(command);

  if (LEADING_NEW.test(text)) {
    await runCommand('save');
    text = text.replace(LEADING_NEW, '');
  }
  if (TRAILING_SAVE.test(text)) {
    setSegments([...segments, text.replace(TRAILING_SAVE, '')]);
    return runCommand('save');
  }
  setSegments([...segments, text]);
}

async function runCommand(command) {
  switch (command) {
    case 'save':
      if (await saveDraft()) {
        toast('Note saved');
        speak('Saved');
      }
      break;
    case 'undo':
      if (segments.length) {
        setSegments(segments.slice(0, -1));
        toast('Removed last part');
        speak('Removed');
      }
      break;
    case 'discard':
      if (draftText()) {
        setSegments([]);
        toast('Note discarded');
        speak('Discarded');
      }
      break;
    case 'read':
      speak(draftText() || 'The note is empty');
      break;
    case 'stop':
      stopListening();
      break;
  }
}

// ---------- Wiring ----------

const listener = new Listener({
  onSegment: (blob, speechMs) => enqueue(blob, speechMs),
  onLevel: (level) => micBtn.style.setProperty('--level', level.toFixed(3)),
  onSpeaking: (on) => {
    micBtn.classList.toggle('speaking', on);
    if (listener.active) setStatus(on ? 'Hearing you…' : 'Listening…');
  },
});

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on) await wakeLock?.release();
  } catch {}
  if (!on) wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listener.active) keepAwake(true);
});

async function startListening() {
  if (!settings.apiKey && settings.baseUrl === DEFAULTS.baseUrl) {
    toast('Add your API key first');
    return openSettings();
  }
  try {
    await listener.start();
  } catch (err) {
    setStatus(`Microphone unavailable: ${err.message}`, true);
    return;
  }
  micBtn.setAttribute('aria-pressed', 'true');
  micBtn.setAttribute('aria-label', 'Stop listening');
  setStatus('Listening…');
  keepAwake(true);
}

function stopListening() {
  listener.stop();
  micBtn.setAttribute('aria-pressed', 'false');
  micBtn.setAttribute('aria-label', 'Start listening');
  setStatus('Tap to start listening');
  keepAwake(false);
}

micBtn.addEventListener('click', () => (listener.active ? stopListening() : startListening()));
$('#save-btn').addEventListener('click', () => runCommand('save'));
$('#undo-btn').addEventListener('click', () => runCommand('undo'));
$('#discard-btn').addEventListener('click', () => {
  if (confirm('Discard the current note?')) setSegments([]);
});

// Settings dialog
const settingsDialog = $('#settings');
const form = $('#settings-form');

function updateSilenceLabel() {
  $('#silence-out').textContent = `(${(form.silenceMs.value / 1000).toFixed(1)}s)`;
}
form.silenceMs.addEventListener('input', updateSilenceLabel);

function openSettings() {
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  updateSilenceLabel();
  settingsDialog.showModal();
}

$('#settings-btn').addEventListener('click', openSettings);
settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  saveSettings({
    baseUrl: form.baseUrl.value.trim() || DEFAULTS.baseUrl,
    apiKey: form.apiKey.value.trim(),
    model: form.model.value.trim() || DEFAULTS.model,
    language: form.language.value.trim(),
    sensitivity: Number(form.sensitivity.value),
    silenceMs: Number(form.silenceMs.value),
    speak: form.speak.checked,
  });
  toast('Settings saved');
});

// Init
setSegments(segments);
renderNotes();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
