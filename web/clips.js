// Saved read-aloud clips, so listening to the same text again (or Play all
// over notes) doesn't generate the audio a second time. Kept in the Cache API,
// so clips survive the app being closed. The oldest are dropped past MAX.

const CACHE = 'tts-clips-v2';
const MAX = 80;
// v1 filed clips without their text, so they couldn't be deleted with a note.
caches.delete('tts-clips-v1').catch(() => {});

async function sha(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Clips are filed under their text, so every clip of a text (any engine,
// voice or speed) can be found and deleted together.
async function url(key) {
  const text = JSON.parse(key)[1];
  return `https://clips.invalid/${await sha(text)}/${await sha(key)}`;
}

// The same text, engine, voice, speed and language always gives the same key.
export function keyFor(engine, text, { voice, speed, lang, language } = {}) {
  return JSON.stringify([engine, text, voice, speed, lang ?? language ?? '']);
}

export async function get(key) {
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(await url(key));
    return res ? await res.blob() : null;
  } catch {
    return null;
  }
}

export async function put(key, blob) {
  try {
    const cache = await caches.open(CACHE);
    const u = await url(key);
    await cache.delete(u); // re-adding moves it to the end (newest)
    await cache.put(u, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX))) await cache.delete(old);
  } catch {}
}

// Deletes every clip of these texts.
export async function removeTexts(texts) {
  try {
    const cache = await caches.open(CACHE);
    const prefixes = await Promise.all(texts.map(async (t) => `https://clips.invalid/${await sha(t)}/`));
    for (const req of await cache.keys()) {
      if (prefixes.some((p) => req.url.startsWith(p))) await cache.delete(req);
    }
  } catch {}
}

// Plays a saved clip. Same interface as the other players.
export class ClipPlayer {
  constructor(onState) {
    this.onState = onState;
    this.state = 'idle';
    this.audio = new Audio();
    this.audio.onended = () => this.setState('idle');
    this.audio.onerror = () => this.setState('idle');
    this.url = null;
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  async play(blob) {
    this.stop();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.audio.src = this.url;
    await this.audio.play();
    this.setState('playing');
  }

  stop() {
    this.audio.pause();
    if (this.state !== 'idle') this.setState('idle');
  }
}
