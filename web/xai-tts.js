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

async function synthesize(text, { key, voice, speed, language }) {
  const res = await fetch(`${API}/tts`, {
    method: 'POST',
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
  return res.blob();
}

// Plays one thing at a time. The last clip is kept, so listening to the same
// draft again with the same voice doesn't make another request.
export class Player {
  constructor(onState) {
    this.onState = onState; // 'idle' | 'loading' | 'playing'
    this.audio = new Audio();
    this.audio.onended = () => this.setState('idle');
    this.audio.onerror = () => this.setState('idle');
    this.cacheKey = null;
    this.url = null;
    this.state = 'idle';
    this.request = 0;
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  async play(text, opts) {
    const id = ++this.request;
    this.audio.pause();
    const key = JSON.stringify([text, opts.voice, opts.speed, opts.language]);
    if (key !== this.cacheKey) {
      this.setState('loading');
      const blob = await synthesize(text, opts).catch((err) => {
        if (id === this.request) this.setState('idle');
        throw err;
      });
      if (id !== this.request) return; // stopped while loading
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(blob);
      this.cacheKey = key;
      this.audio.src = this.url;
    }
    this.audio.currentTime = 0;
    await this.audio.play();
    this.setState('playing');
  }

  stop() {
    this.request++;
    this.audio.pause();
    if (this.state !== 'idle') this.setState('idle');
  }
}
