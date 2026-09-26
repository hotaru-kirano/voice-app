// xAI Grok speech-to-text: realtime streaming over WebSocket, plus the batch
// REST endpoint as a fallback. The API key stays on this device: it's only used
// to mint a short-lived token, and the WebSocket authenticates with that token.

const API = 'https://api.x.ai/v1';
const MODEL = 'grok-voice-transcribe-2.0';
const CHUNK = 1600; // 100 ms of 16 kHz audio per WebSocket frame

// Names and unusual words from the draft being revised, so the service listens
// for them (xAI "keyterms": at most 100, 50 characters each).
export function keytermsFrom(text) {
  const terms = new Set();
  for (const sentence of text.split(/[.!?\n]+/)) {
    const words = sentence.trim().split(/\s+/).slice(1); // skip sentence-initial capitals
    for (const raw of words) {
      const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (w.length > 1 && w.length <= 50 && w !== 'I' && (/^\p{Lu}/u.test(w) || /\d/.test(w))) terms.add(w);
    }
  }
  return [...terms].slice(0, 30);
}

function params({ language, keyterms }) {
  const p = new URLSearchParams({ model: MODEL, sample_rate: '16000', encoding: 'pcm', interim_results: 'true' });
  // Setting a language also turns on punctuation and number formatting.
  p.set('language', language || 'en');
  for (const t of keyterms || []) p.append('keyterm', t);
  return p;
}

async function mintToken(key) {
  const res = await fetch(`${API}/realtime/client_secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).value;
}

// One live take. Audio can be added right away; it's buffered until the
// connection is ready. `onText` gets the whole transcript so far.
export class XaiStream {
  constructor({ key, language, keyterms, onText }) {
    this.onText = onText;
    this.segments = new Map(); // segment start time -> text
    this.buffer = [];
    this.buffered = 0;
    this.ready = false;
    this.failed = null;
    this.opened = this.open(key, { language, keyterms });
    this.opened.catch(() => {});
  }

  async open(key, opts) {
    const token = await mintToken(key);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://api.x.ai/v1/stt?${params(opts)}`, [`xai-client-secret.${token}`]);
      this.ws = ws;
      ws.onmessage = ({ data }) => {
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          return;
        }
        if (ev.type === 'transcript.created') {
          this.ready = true;
          this.flush();
          resolve();
        } else if (ev.type === 'transcript.partial') {
          this.segments.set(ev.start ?? 0, ev.text || '');
          this.onText?.(this.text());
        } else if (ev.type === 'transcript.done') {
          this.done?.();
        } else if (ev.type === 'error') {
          this.fail(new Error(ev.message || 'xAI error'));
          reject(this.failed);
        }
      };
      ws.onclose = (e) => {
        if (!this.ready) reject(new Error(`xAI connection closed (${e.code})`));
        this.closed?.();
        if (!this.finishing) this.fail(new Error('xAI connection dropped'));
      };
    });
  }

  fail(err) {
    this.failed ??= err;
    this.done?.();
  }

  text() {
    return [...this.segments.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => t.trim())
      .filter(Boolean)
      .join(' ');
  }

  // Float32 samples at 16 kHz.
  addAudio(f32) {
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7fff;
    this.buffer.push(pcm);
    this.buffered += pcm.length;
    if (this.ready && this.buffered >= CHUNK) this.flush();
  }

  flush() {
    if (!this.buffered || this.ws?.readyState !== WebSocket.OPEN) return;
    const all = new Int16Array(this.buffered);
    let offset = 0;
    for (const b of this.buffer) {
      all.set(b, offset);
      offset += b.length;
    }
    for (let i = 0; i < all.length; i += CHUNK) this.ws.send(all.slice(i, i + CHUNK).buffer);
    this.buffer = [];
    this.buffered = 0;
  }

  // Sends the rest of the audio, waits for the final transcript, and returns it.
  async finish(timeoutMs = 8000) {
    await this.opened;
    if (this.failed) throw this.failed;
    this.finishing = true;
    this.flush();
    const finished = new Promise((resolve) => {
      this.done = resolve;
      this.closed = resolve;
      setTimeout(resolve, timeoutMs);
    });
    this.ws.send(JSON.stringify({ type: 'audio.done' }));
    await finished;
    this.ws.close();
    if (this.failed) throw this.failed;
    return this.text();
  }

  abort() {
    this.finishing = true;
    this.opened.then(() => this.ws?.close(), () => {});
  }
}

// Whole recording in one request (fallback when the live connection fails,
// and for retries).
export async function transcribeFile(blob, { key, language, keyterms }) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('language', language || 'en');
  form.append('format', 'true');
  for (const t of keyterms || []) form.append('keyterm', t);
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  form.append('file', blob, `speech.${ext}`); // the file must be the last field
  const res = await fetch(`${API}/stt`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try { msg = JSON.parse(body).error || JSON.parse(body).code || body; } catch {}
    throw new Error(`${res.status} ${msg}`.slice(0, 160));
  }
  return ((await res.json()).text || '').trim();
}
