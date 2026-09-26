// Reads the draft aloud with xAI Grok text-to-speech.

const API = 'https://api.x.ai/v1';

export const DEFAULT_VOICE = 'eve';

// The voices xAI offers, as [{ voice_id, name, gender }]. Cached, because the
// list rarely changes and Settings should open instantly.
export async function listVoices(key) {
  const res = await fetch(`${API}/tts/voices`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  const { voices } = await res.json();
  localStorage.setItem('xaiVoices', JSON.stringify(voices));
  return voices;
}

export function cachedVoices() {
  try {
    return JSON.parse(localStorage.getItem('xaiVoices')) || [];
  } catch {
    return [];
  }
}

// Starts the request. The response body streams: the first audio arrives in
// about half a second even when the whole clip takes several seconds.
async function request(text, { key, voice, speed, language }, signal) {
  const res = await fetch(`${API}/tts`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice_id: voice || DEFAULT_VOICE,
      language: language || 'auto',
      speed: speed || 1,
      text_normalization: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body}`.slice(0, 160));
  }
  return res;
}

const canStream = () =>
  typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');

// Plays one thing at a time. Audio starts playing as soon as the first bytes
// arrive (MediaSource) instead of after the whole clip has downloaded. The
// last clip is kept, so listening to the same draft again with the same voice
// doesn't make another request.
export class Player {
  constructor(onState) {
    this.onState = onState; // 'idle' | 'loading' | 'playing'
    this.audio = new Audio();
    this.audio.onended = () => this.setState('idle');
    this.audio.onerror = () => this.state !== 'loading' && this.setState('idle');
    this.cacheKey = null;
    this.url = null;
    this.state = 'idle';
    this.request = 0;
    this.abort = null;
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  setSource(url) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = url;
    this.audio.src = url;
  }

  async play(text, opts) {
    const id = ++this.request;
    this.abort?.abort();
    this.audio.pause();
    const key = JSON.stringify([text, opts.voice, opts.speed, opts.language]);
    if (key === this.cacheKey) {
      this.audio.currentTime = 0;
      await this.audio.play();
      return this.setState('playing');
    }

    this.cacheKey = null;
    this.setState('loading');
    const controller = new AbortController();
    this.abort = controller;
    const current = () => id === this.request;
    try {
      const res = await request(text, opts, controller.signal);
      if (!current()) return;
      const type = res.headers.get('content-type') || 'audio/mpeg';
      const blob = canStream() && type.includes('mpeg') && res.body
        ? await this.stream(res, current)
        : await res.blob();
      if (!blob || !current()) return;
      // Keep the finished clip for replays. Swapping the source mid-playback
      // would restart it, so only do that once it has finished or been stopped.
      const finished = new Blob([blob], { type });
      if (this.startedFor === id && this.state === 'playing' && !this.audio.ended) {
        this.audio.addEventListener('ended', () => current() && this.cache(key, finished), { once: true });
        this.pendingCache = () => this.cache(key, finished);
      } else {
        this.cache(key, finished);
        if (this.startedFor !== id) await this.begin(id);
      }
    } catch (err) {
      if (!current() || err.name === 'AbortError') return;
      this.setState('idle');
      throw err;
    }
  }

  async begin(id) {
    this.startedFor = id;
    await this.audio.play();
    this.setState('playing');
  }

  cache(key, blob) {
    this.pendingCache = null;
    this.setSource(URL.createObjectURL(blob));
    this.cacheKey = key;
  }

  // Feeds the response into a MediaSource and starts playing as soon as
  // there's a little audio buffered. Resolves with the whole clip.
  async stream(res, current, id = this.request) {
    const media = new MediaSource();
    this.setSource(URL.createObjectURL(media));
    await new Promise((r) => media.addEventListener('sourceopen', r, { once: true }));
    const buffer = media.addSourceBuffer('audio/mpeg');
    const appended = () => new Promise((r) => buffer.addEventListener('updateend', r, { once: true }));
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (!current()) {
        reader.cancel().catch(() => {});
        return null;
      }
      if (done) break;
      chunks.push(value);
      buffer.appendBuffer(value);
      await appended();
      if (this.startedFor !== id && buffer.buffered.length && buffer.buffered.end(0) > 0.25) {
        await this.begin(id);
      }
    }
    if (media.readyState === 'open') media.endOfStream();
    if (this.startedFor !== id) await this.begin(id);
    return new Blob(chunks, { type: 'audio/mpeg' });
  }

  stop() {
    this.request++;
    this.abort?.abort();
    this.audio.pause();
    this.pendingCache?.();
    if (this.state !== 'idle') this.setState('idle');
  }
}
