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
  sw.js         offline cache for the app itself
  manifest.webmanifest
  icons/
tests/e2e.cjs   Playwright test with a fake microphone and a mocked API
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

`.github/workflows/pages.yml` runs the test on every push and deploys `web/` to
GitHub Pages from the default branch. Turn it on once in **Settings → Pages →
Source: GitHub Actions**. Pages on a private repo needs a paid GitHub plan.
Otherwise, drag the `web/` folder onto Netlify Drop or Cloudflare Pages.
