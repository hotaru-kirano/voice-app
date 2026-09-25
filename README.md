# Voice Notes

A hands-free voice notes app, built as a Progressive Web App (PWA). You talk and
it writes down what you said. Say **"save note"** when you're done. Speech is
transcribed by any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI
Whisper, Groq, a self-hosted whisper server, …).

Plain HTML, CSS and JavaScript: no framework, no build step, no backend.

## Using it

1. Open the site in Chrome on Android, then choose **⋮ → Add to Home screen**
   (or **Install app**).
2. Tap the gear and enter your API key. Change the base URL and model if you're
   not using OpenAI (for example `https://api.groq.com/openai/v1` with
   `whisper-large-v3-turbo`).
3. Tap the mic once and start talking. Each time you pause, what you said is sent
   off to be transcribed and added to the current note.

Voice commands (said on their own, after a short pause):

| Say | Does |
|---|---|
| "save note" / "new note" / "done" | Save the current note and start a fresh one |
| "…, save note" at the end of a sentence | Add the sentence, then save |
| "new note, …" at the start | Save the previous note, then start a new one with the rest |
| "scratch that" / "undo" | Remove the last part you said |
| "discard note" | Clear the current note |
| "read back" | Read the current note aloud |
| "stop listening" | Turn the mic off |

Notes are stored on the device (IndexedDB). Tap a note to edit, copy, share or
delete it.

## How it works

- `MediaRecorder` records the mic continuously. A simple voice activity detector
  (it watches the volume level against the background noise) cuts the recording
  whenever you pause for about 1.2 seconds (you can change this in Settings).
- Each cut is a complete audio file. It is posted to `{baseUrl}/audio/transcriptions`,
  with the end of the current note as the `prompt` to help with context.
- Silence is never sent. Short clips that come back as typical Whisper
  "hallucinations" (for example "Thank you.") are ignored.
- The Screen Wake Lock API keeps the phone awake while listening.

**Limits:** the app has to stay open with the screen on while it listens. Your
API key is stored in the browser's localStorage, which is fine for a personal app
but not for one you share with other people.

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
