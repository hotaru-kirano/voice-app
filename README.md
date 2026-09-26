# Voice Drafts

A focused surface for organizing your thoughts out loud.

1. **Speak.** Tap the mic, say what's on your mind, tap again when you're done.
2. **Read.** The transcript fills the screen.
3. **Speak again.** Read it back and say a better version. The new take
   replaces the old one on the surface.

Repeat until the thought is clear. Earlier versions are kept, so a bad take is
never a loss. Step through them with the ‹ › arrows at the top, or tap **+** to
start a new draft on a blank surface.

Speech is transcribed by any OpenAI-compatible `/audio/transcriptions`
endpoint (OpenAI Whisper, Groq, a self-hosted whisper server, …). The app is
plain HTML, CSS and JavaScript: no framework, no build step, no backend. It's a
Progressive Web App, so it installs to your home screen.

## Setup

1. Open the site in Chrome on Android, then choose **⋮ → Add to Home screen**
   (or **Install app**).
2. Tap the gear and paste your API key. A Groq key (`gsk_…`) automatically
   fills in Groq's endpoint (`https://api.groq.com/openai/v1`) and the
   `whisper-large-v3-turbo` model. For another provider, set the base URL and
   model yourself.

## Offline (on-device) transcription

The app can also transcribe on your phone, with no internet connection, using
[Moonshine v2](https://arxiv.org/abs/2602.12241) Small (streaming, English only)
through Moonshine's official WebAssembly package,
[`@moonshine-ai/moonshine-wasm`](https://www.npmjs.com/package/@moonshine-ai/moonshine-wasm).

1. While online, open Settings → **Offline (on-device)** and tap **Download**
   (once; use Wi‑Fi).
2. Choose **Transcribe with**:
   - **Cloud, or on-device when offline** (default): uses the cloud API, and
     switches to on-device when the phone is offline or the request can't get
     through.
   - **Always on-device**: never sends audio anywhere.
   - **Always cloud**.
3. Or tap the **Cloud / Offline** switch at the top of the main screen to flip
   to on-device and back in one tap. Switching back returns to whichever cloud
   mode you had before.

How it works:
- **True streaming.** Audio is fed to the model as you speak, and the draft on
  screen is **replaced live** with what it hears (a blinking cursor marks live
  text). When you tap stop, the transcript is usually already final. If the take
  fails or is empty, the previous draft comes back.
- **Context.** The draft being revised is given to the engine, which picks
  names and unusual words out of it and listens for them, so spellings stay
  consistent between takes.
- **Timing.** After each take the status line shows what was used and how long
  it took from tapping stop, e.g. `On-device · 0.0 s` or `Groq · 0.9 s`.
- **Runs off the main thread** in a worker (`stt-worker.js`), on the CPU with
  multi-threaded WebAssembly. The library has no GPU path.

Notes:
- The browser's noise suppression is turned off for on-device takes. It
  garbled transcripts in testing.
- The service worker adds cross-origin isolation headers (GitHub Pages can't),
  which the engine needs to use more than one core. The first visit reloads
  itself once to turn them on.

## Behaviour details

- The draft stays on screen while you record, so you can read it while you
  speak the next version.
- The current draft is sent to the API as the Whisper `prompt`, which helps it
  keep names and terms spelled the same way between takes.
- A take only replaces the draft when transcription succeeds and returns text.
  If it fails, the draft is untouched and **Retry** resends the same recording.
  Taps shorter than 0.7 s are ignored.
- The screen stays awake while recording (Screen Wake Lock API).
- Everything is stored in the browser's localStorage: the versions (the last
  200) and your API key. That's fine for a personal app, but don't use it this
  way in an app you share.
- On a computer, the space bar starts and stops recording.

## Files

```
web/            the app (this is what gets deployed)
  index.html
  style.css
  app.js
  local-stt.js  on-device transcription: main-thread wrapper
  stt-worker.js runs Moonshine v2 streaming (official WASM package) in a worker
  pcm-worklet.js  passes raw mic samples to the worker
  sw.js         offline cache + cross-origin isolation headers
  manifest.webmanifest
  icons/
tests/e2e.cjs   Playwright test with a fake microphone, a mocked API and a
                stand-in for the on-device model
```

## Running locally

```sh
npx http-server web        # then open http://localhost:8080
```

The mic needs `localhost` or HTTPS.

Test:

```sh
npm install --no-save playwright && npx playwright install chromium
node tests/e2e.cjs
```

## Deploying

**Private repo (free): Netlify.** Sign in at app.netlify.com with GitHub, then
choose **Add new site → Import an existing project → GitHub** and pick this repo.
`netlify.toml` already sets the publish folder to `web/`, so there's nothing to
configure. Netlify redeploys on every push.

**Public repo: GitHub Pages.** `.github/workflows/pages.yml` runs the test on
every push, and for a public repo it also deploys `web/` to GitHub Pages from
the default branch. Turn it on once in **Settings → Pages → Source: GitHub
Actions**.
