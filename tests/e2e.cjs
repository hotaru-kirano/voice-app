// End-to-end test: records from Chromium's fake microphone, mocks the
// transcription API, and checks the speak -> read -> speak-again loop.
//
// Run: node tests/e2e.cjs   (needs `playwright` installed)

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const WEB = path.join(__dirname, '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!file.startsWith(WEB) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

// A voiced tone, looped by Chromium as the fake mic. `pattern` is a list of
// [seconds, on] segments; silence between segments makes pauses.
function makeWav(name, pattern = [[3, 1]]) {
  const rate = 16000;
  const total = Math.round(pattern.reduce((sum, [d]) => sum + d, 0) * rate);
  const data = Buffer.alloc(total * 2);
  let n = 0;
  for (const [dur, on] of pattern) {
    for (let k = 0; k < dur * rate; k++, n++) {
      const t = n / rate;
      const s = on ? 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 200 * t) : 0;
      data.writeInt16LE(Math.round(s * 32767), n * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), `voice-drafts-${name}.wav`);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

// A stand-in for the Moonshine WASM package, so the test doesn't download the
// real model. The fake stream "hears" one word per second of loud audio and
// reports its transcript as it grows. Calls are reported to https://stub.test
// so the test can check them.
const STUB_MOONSHINE = `
  export const ModelArch = { SmallStreaming: 4 };
  const report = (what) => fetch('https://stub.test/' + what);
  const loudSeconds = (pcm) => pcm.filter((v) => Math.abs(v) > 0.05).length / 16000 / 0.6;
  export const Transcriber = {
    async load(opts) {
      await report('load?arch=' + opts.modelArch);
      opts.onProgress?.(50, 100);
      opts.onProgress?.(100, 100);
      return {
        setContext(context) { report('context?text=' + encodeURIComponent(context)); },
        transcribe(pcm) {
          const n = Math.round(loudSeconds(pcm));
          return { lines: n ? [{ text: Array.from({ length: n }, (_, i) => 'word' + (i + 1)).join(' ') }] : [] };
        },
        createStream() {
          let heard = 0;
          let listener = null;
          const emit = () => {
            const n = Math.round(heard);
            if (n) listener?.onLineTextChanged?.({ line: { id: '1', text: Array.from({ length: n }, (_, i) => 'word' + (i + 1)).join(' ') } });
          };
          return {
            addListener(l) { listener = l; },
            start() {},
            addAudio(pcm) { heard += loudSeconds(pcm); },
            transcribe() { emit(); },
            stop() { emit(); },
            close() {},
          };
        },
      };
    },
  };
`;

async function testOnDevice(url) {
  const wav = makeWav('speech', [[6, 1], [1, 0]]);
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  const context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block' });
  const calls = [];
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: STUB_MOONSHINE }));
  await context.route('https://stub.test/**', (route) => {
    calls.push(decodeURIComponent(route.request().url()));
    route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  let cloudDown = false;
  await context.route('https://api.example.test/**', (route) => {
    if (cloudDown) return route.abort('internetdisconnected');
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ text: 'from the cloud' }) });
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('settings')) {
      localStorage.setItem('settings', JSON.stringify({ apiKey: 'test-key', baseUrl: 'https://api.example.test/v1', engine: 'local' }));
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  async function take(ms, during) {
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn[aria-pressed="true"]');
    await page.waitForTimeout(ms);
    await during?.();
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn:not(.busy)[aria-pressed="false"]');
  }

  // 1. Always on-device, but the model was never downloaded: send to Settings.
  await page.click('#mic-btn');
  await page.waitForSelector('#settings[open]');
  assert.match(await page.textContent('#model-status'), /Not downloaded/);

  // 2. Download from Settings.
  await page.click('#model-btn');
  await page.waitForFunction(() => /^Downloaded/.test(document.querySelector('#model-status').textContent));
  assert.ok(calls.some((c) => c.endsWith('/load?arch=4')));
  await page.click('#settings button[value="cancel"]');

  // 3. The draft is replaced live while speaking, then kept when done.
  await page.evaluate(() => {
    localStorage.setItem('draft', 'Old draft about Kyoto');
  });
  await page.reload();
  await take(4000, async () => {
    assert.match(await page.getAttribute('#text', 'class'), /\blive\b/);
    assert.match(await page.textContent('#text'), /^word1( word\d+)*$/);
  });
  assert.match(await page.textContent('#text'), /^word1( word\d+)+$/);
  assert.doesNotMatch(await page.getAttribute('#text', 'class'), /\blive\b/);
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('draft')), await page.textContent('#text'));
  assert.match(await page.textContent('#status'), /^On-device · \d+\.\d s$/);
  // The draft being revised was given to the engine as context.
  assert.ok(calls.includes('https://stub.test/context?text=Old draft about Kyoto'));

  // 3b. With live text off, the draft stays put until the take is done.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('settings'));
    localStorage.setItem('settings', JSON.stringify({ ...s, liveText: false }));
  });
  await page.reload();
  const before = await page.textContent('#text');
  await take(3000, async () => {
    assert.strictEqual(await page.textContent('#text'), before);
    assert.doesNotMatch(await page.getAttribute('#text', 'class'), /\blive\b/);
  });
  assert.match(await page.textContent('#text'), /^word1( word\d+)+$/);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('settings'));
    localStorage.setItem('settings', JSON.stringify({ ...s, liveText: true }));
  });

  // 4. Auto mode uses the cloud while online...
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('settings'));
    localStorage.setItem('settings', JSON.stringify({ ...s, engine: 'auto' }));
  });
  await page.reload();
  await take(1500);
  assert.strictEqual(await page.textContent('#text'), 'from the cloud');
  assert.match(await page.textContent('#status'), /^api\.example\.test · /);

  // 5. ...falls back to on-device when the request can't get through...
  cloudDown = true;
  await take(3000);
  assert.match(await page.textContent('#text'), /^word1/);
  assert.match(await page.textContent('#status'), /^On-device \(no connection\) · /);

  // 6. The switch on the main screen flips to on-device and back.
  cloudDown = false;
  assert.strictEqual(await page.textContent('#engine-btn'), 'Cloud');
  await page.click('#engine-btn');
  assert.strictEqual(await page.textContent('#engine-btn'), 'Offline');
  assert.strictEqual(await page.getAttribute('#engine-btn', 'aria-pressed'), 'true');
  await take(3000, async () => assert.ok(await page.isDisabled('#engine-btn')));
  assert.match(await page.textContent('#status'), /^On-device · /);
  await page.reload(); // the choice is remembered
  assert.strictEqual(await page.textContent('#engine-btn'), 'Offline');
  await page.click('#engine-btn');
  assert.strictEqual(await page.textContent('#engine-btn'), 'Cloud');
  await take(1500);
  assert.strictEqual(await page.textContent('#text'), 'from the cloud');

  // 7. ...and streams on-device when the phone is offline.
  cloudDown = false;
  await page.evaluate(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false }));
  await take(3000, async () => assert.match(await page.getAttribute('#text', 'class'), /\blive\b/));
  assert.match(await page.textContent('#status'), /^On-device · /);

  assert.deepStrictEqual(errors, []);
  await browser.close();
}

// xAI realtime: a mock of wss://api.x.ai/v1/stt that "hears" one word per
// half second of audio (16 kHz PCM16 = 16000 bytes), locks a segment every 2 s,
// and finishes on audio.done, like the real service.
async function testXai(url) {
  const wav = makeWav('xai', [[6, 1]]);
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  const context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block' });
  const seen = { tokenAuth: [], wsUrls: [], batch: 0 };
  const cors = { 'access-control-allow-origin': '*' };
  await context.route('https://api.x.ai/v1/realtime/client_secrets', (route) => {
    seen.tokenAuth.push(route.request().headers()['authorization']);
    route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ value: 'xai-realtime-test-token', expires_at: 0 }) });
  });
  await context.route('https://api.x.ai/v1/stt', (route) => {
    seen.batch++;
    route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ text: 'from the batch api' }) });
  });
  const tts = [];
  await context.route('https://api.x.ai/v1/tts/voices', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ voices: [
      { voice_id: 'ara', name: 'Ara', gender: 'female' }, { voice_id: 'eve', name: 'Eve', gender: 'female' }, { voice_id: 'rex', name: 'Rex', gender: 'male' },
    ] }) }));
  await context.route('https://api.x.ai/v1/tts', (route) => {
    tts.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'audio/wav', headers: cors, body: fs.readFileSync(makeWav('tts', [[0.6, 1]])) });
  });
  let dropConnections = false;
  await context.routeWebSocket(/wss:\/\/api\.x\.ai\/v1\/stt/, (ws) => {
    seen.wsUrls.push(ws.url());
    if (dropConnections) return ws.close({ code: 1011, reason: 'test drop' });
    let bytes = 0;
    let segStart = 0;
    let segWords = 0;
    // Finished phrases are re-reported with a slightly shifted start time, as
    // real services can; the app must replace the phrase, not show it twice.
    const partial = (isFinal) => ws.send(JSON.stringify({
      type: 'transcript.partial', text: Array.from({ length: segWords }, (_, i) => `s${segStart}w${i + 1}`).join(' '),
      is_final: isFinal, speech_final: isFinal, start: segStart + (isFinal ? 0.03 : 0), duration: segWords * 0.5,
    }));
    ws.send(JSON.stringify({ type: 'transcript.created' }));
    ws.onMessage((msg) => {
      if (typeof msg === 'string') {
        if (JSON.parse(msg).type === 'audio.done') {
          if (segWords) partial(true);
          ws.send(JSON.stringify({ type: 'transcript.done', text: '' }));
          ws.close();
        }
        return;
      }
      bytes += msg.length;
      while (bytes >= 16000) {
        bytes -= 16000;
        segWords++;
        partial(false);
        if (segWords === 4) {
          partial(true);
          segStart += 2;
          segWords = 0;
        }
      }
    });
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('settings')) localStorage.setItem('settings', '{}');
    if (localStorage.getItem('draft') === null) localStorage.setItem('draft', 'Trip to Kyoto with Hotaru.');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  // 1. Pasting an xAI key into the API key field switches the service to xAI.
  await page.click('#settings-btn');
  assert.ok(await page.isVisible('input[name=baseUrl]'));
  await page.fill('input[name=apiKey]', 'xai-test-key');
  assert.strictEqual(await page.inputValue('select[name=provider]'), 'xai');
  assert.strictEqual(await page.inputValue('input[name=xaiKey]'), 'xai-test-key');
  assert.ok(!(await page.isVisible('input[name=baseUrl]')));
  await page.click('#settings button[value="save"]');

  async function take(ms, during) {
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn[aria-pressed="true"]');
    await page.waitForTimeout(ms);
    await during?.();
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn:not(.busy)[aria-pressed="false"]');
  }

  // 2. Live: the draft is replaced while speaking; segments are stitched together.
  await take(3500, async () => {
    assert.match(await page.getAttribute('#text', 'class'), /\blive\b/);
    assert.match(await page.textContent('#text'), /^s0w1/);
  });
  const text = await page.textContent('#text');
  assert.match(text, /^s0w1 s0w2 s0w3 s0w4 s2w1( s2w\d)*$/);
  assert.match(await page.textContent('#status'), /^xAI · \d+\.\d s$/);
  assert.deepStrictEqual(seen.tokenAuth, ['Bearer xai-test-key']);
  const wsUrl = new URL(seen.wsUrls[0]);
  assert.strictEqual(wsUrl.searchParams.get('model'), 'grok-voice-transcribe-2.0');
  assert.strictEqual(wsUrl.searchParams.get('encoding'), 'pcm');
  assert.strictEqual(wsUrl.searchParams.get('language'), 'en');
  assert.deepStrictEqual(wsUrl.searchParams.getAll('keyterm'), ['Kyoto', 'Hotaru']);
  assert.strictEqual(seen.batch, 0);

  // 3. If the live connection fails, the recording is sent to the batch API.
  dropConnections = true;
  await take(2000);
  assert.strictEqual(await page.textContent('#text'), 'from the batch api');
  assert.match(await page.textContent('#status'), /^xAI · /);
  assert.strictEqual(seen.batch, 1);

  // 4. With live text off, the draft stays put and xAI's batch API is used.
  dropConnections = false;
  await page.click('#settings-btn');
  assert.ok(await page.isChecked('input[name=liveText]'));
  await page.uncheck('input[name=liveText]');
  await page.click('#settings button[value="save"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('settings')).liveText === false);
  const connections = seen.wsUrls.length;
  await page.evaluate(() => localStorage.setItem('draft', 'Keep me visible'));
  await page.reload();
  await take(2500, async () => {
    assert.strictEqual(await page.textContent('#text'), 'Keep me visible');
    assert.doesNotMatch(await page.getAttribute('#text', 'class'), /\blive\b/);
  });
  assert.strictEqual(await page.textContent('#text'), 'from the batch api');
  assert.strictEqual(seen.wsUrls.length, connections, 'no live connection when live text is off');
  assert.strictEqual(seen.batch, 2);

  // 5. Read aloud: Listen plays the draft with the chosen voice.
  const draft = await page.textContent('#text');
  assert.ok(await page.isVisible('#listen-btn'));
  await page.click('#listen-btn');
  await page.waitForFunction(() => document.querySelector('#listen-btn').textContent === 'Stop');
  assert.deepStrictEqual(tts.at(-1), { text: draft, voice_id: 'eve', language: 'auto', speed: 1, text_normalization: true });
  await page.waitForFunction(() => document.querySelector('#listen-btn').textContent === 'Listen', null, { timeout: 5000 });
  // Listening again to the same text reuses the audio.
  await page.click('#listen-btn');
  await page.waitForFunction(() => document.querySelector('#listen-btn').textContent === 'Stop');
  await page.waitForFunction(() => document.querySelector('#listen-btn').textContent === 'Listen', null, { timeout: 5000 });
  assert.strictEqual(tts.length, 1);

  // 6. Settings: the voice list comes from xAI; preview, pick a voice and speed.
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.querySelector('select[name=ttsVoice]').options.length === 3);
  assert.strictEqual(await page.inputValue('select[name=ttsVoice]'), 'eve');
  await page.selectOption('select[name=ttsVoice]', 'rex');
  await page.fill('input[name=ttsSpeed]', '1.2');
  await page.click('#preview-btn');
  await page.waitForFunction(() => document.querySelector('#listen-btn').textContent === 'Stop');
  assert.strictEqual(tts.at(-1).voice_id, 'rex');
  assert.match(tts.at(-1).text, /^Hi, I'm Rex\./);
  await page.click('#settings button[value="save"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('settings')).ttsVoice === 'rex');
  await page.click('#listen-btn');
  await page.waitForFunction(() => document.querySelector('#listen-btn').textContent === 'Stop');
  assert.strictEqual(tts.at(-1).voice_id, 'rex');
  assert.strictEqual(tts.at(-1).speed, 1.2);

  // 7. Starting a take stops playback and hides the button while recording.
  await page.click('#mic-btn');
  await page.waitForSelector('#mic-btn[aria-pressed="true"]');
  assert.ok(await page.isHidden('#listen-btn'));
  assert.strictEqual(await page.textContent('#listen-btn'), 'Listen');
  await page.click('#mic-btn');
  await page.waitForSelector('#mic-btn:not(.busy)[aria-pressed="false"]');

  assert.deepStrictEqual(errors, []);
  await browser.close();
}

(async () => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${makeWav('tone')}`],
  });
  const context = await browser.newContext({ permissions: ['microphone', 'clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  await context.addInitScript(() => {
    if (!localStorage.getItem('settings')) {
      localStorage.setItem('settings', JSON.stringify({ apiKey: 'test-key', baseUrl: 'https://api.example.test/v1', model: 'whisper-1' }));
    }
  });

  // Each API call takes the next scripted reply.
  const replies = [];
  const requests = [];
  await context.route('https://api.example.test/**', async (route) => {
    const req = route.request();
    requests.push({ url: req.url(), auth: req.headers()['authorization'], body: req.postDataBuffer()?.toString('latin1') || '' });
    const reply = replies.shift() ?? { text: '' };
    const headers = { 'access-control-allow-origin': '*' };
    if (reply.status) return route.fulfill({ status: reply.status, contentType: 'application/json', headers, body: JSON.stringify({ error: { message: 'Server exploded' } }) });
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ text: reply.text }) });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  const text = () => page.textContent('#text');
  async function take(ms = 1200) {
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn[aria-pressed="true"]');
    await page.waitForTimeout(ms);
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn:not(.busy)[aria-pressed="false"]');
  }

  assert.ok(await page.isVisible('#placeholder'));

  // Old builds kept every version: the one on screen carries over, the rest go.
  await page.evaluate(() => localStorage.setItem('versions', JSON.stringify([{ text: 'older', at: 1 }, { text: 'newest', at: 2 }, { text: '', at: 3 }])));
  await page.reload();
  assert.strictEqual(await page.textContent('#text'), 'newest');
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('versions')), null);
  await page.evaluate(() => localStorage.setItem('draft', ''));
  await page.reload();

  // The Cloud/Offline switch needs the offline model first.
  assert.strictEqual(await page.textContent('#engine-btn'), 'Cloud');
  await page.click('#engine-btn');
  await page.waitForSelector('#settings[open]');
  await page.click('#settings button[value="cancel"]');
  assert.strictEqual(await page.textContent('#engine-btn'), 'Cloud');

  // 1. First take fills the surface.
  replies.push({ text: 'I want to plan a trip, maybe Kyoto, not sure when.' });
  await take();
  assert.strictEqual(await text(), 'I want to plan a trip, maybe Kyoto, not sure when.');
  assert.ok(!(await page.isVisible('#placeholder')));
  assert.strictEqual(requests[0].url, 'https://api.example.test/v1/audio/transcriptions');
  assert.strictEqual(requests[0].auth, 'Bearer test-key');
  assert.match(requests[0].body, /name="model"\r\n\r\nwhisper-1/);
  assert.match(requests[0].body, /filename="speech\.(webm|ogg|m4a)"/);
  assert.doesNotMatch(requests[0].body, /name="prompt"/);

  // 2. Speaking again overwrites it, and the previous draft is sent as context.
  replies.push({ text: 'Trip to Kyoto in May. Budget first, then book flights.' });
  await take();
  assert.strictEqual(await text(), 'Trip to Kyoto in May. Budget first, then book flights.');
  assert.match(requests[1].body, /name="prompt"\r\n\r\nI want to plan a trip, maybe Kyoto/);
  // Overwritten, not kept: there's no version history.
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('draft')), 'Trip to Kyoto in May. Budget first, then book flights.');
  assert.strictEqual(await page.locator('#prev-btn, #version').count(), 0);

  // 3. A failed transcription leaves the draft alone and can be retried.
  replies.push({ status: 500 });
  await take();
  assert.strictEqual(await text(), 'Trip to Kyoto in May. Budget first, then book flights.');
  assert.match(await page.textContent('#status'), /failed: 500 Server exploded/);
  assert.ok(await page.isVisible('#retry-btn'));
  replies.push({ text: 'Kyoto, May. One: set a budget. Two: book flights.' });
  await page.click('#retry-btn');
  await page.waitForFunction(() => document.querySelector('#text').textContent.startsWith('Kyoto, May.'));
  assert.ok(!(await page.isVisible('#retry-btn')));

  // 4. An empty transcription or a too-short tap changes nothing.
  replies.push({ text: '' });
  await take();
  assert.strictEqual(await text(), 'Kyoto, May. One: set a budget. Two: book flights.');
  const before = requests.length;
  await take(100);
  assert.strictEqual(requests.length, before);
  assert.match(await page.textContent('#status'), /Too short/);

  // 6. Copy.
  await page.click('#copy-btn');
  assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'Kyoto, May. One: set a budget. Two: book flights.');

  // 7. Survives a reload.
  await page.reload();
  assert.strictEqual(await text(), 'Kyoto, May. One: set a budget. Two: book flights.');

  // 8. Save keeps the draft as a note.
  assert.ok(await page.isHidden('#saved-count'));
  await page.click('#save-btn');
  assert.strictEqual(await page.textContent('#save-btn'), 'Saved');
  assert.strictEqual(await page.textContent('#saved-count'), '1');
  await page.click('#save-btn'); // saving the same text twice doesn't duplicate it
  assert.strictEqual(await page.textContent('#saved-count'), '1');

  // 9. Clear blanks the draft (notes stay). A saved draft clears without asking.
  await page.click('#clear-btn');
  assert.strictEqual(await text(), '');
  assert.ok(await page.isVisible('#placeholder'));
  assert.ok(await page.isDisabled('#clear-btn'));
  assert.ok(await page.isDisabled('#save-btn'));
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('draft')), '');
  assert.strictEqual(await page.textContent('#saved-count'), '1');

  // An unsaved draft asks first; cancelling keeps it.
  await page.evaluate(() => localStorage.setItem('draft', 'Unsaved thought'));
  await page.reload();
  page.once('dialog', (d) => d.dismiss());
  await page.click('#clear-btn');
  assert.strictEqual(await text(), 'Unsaved thought');
  page.once('dialog', (d) => d.accept());
  await page.click('#clear-btn');
  assert.strictEqual(await text(), '');

  // 10. Notes survive a reload and can be opened, copied and deleted.
  await page.reload();
  assert.strictEqual(await page.textContent('#saved-count'), '1');
  await page.click('#saved-btn');
  await page.waitForSelector('#saved[open]');
  assert.strictEqual(await page.textContent('#saved-list li .saved-text'), 'Kyoto, May. One: set a budget. Two: book flights.');
  assert.strictEqual(await page.locator('#saved-list [data-action=listen]').count(), 0); // no xAI key
  await page.click('#saved-list [data-action=copy]');
  assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'Kyoto, May. One: set a budget. Two: book flights.');
  await page.click('#saved-list [data-action=open]');
  await page.waitForFunction(() => !document.querySelector('#saved').open);
  assert.strictEqual(await text(), 'Kyoto, May. One: set a budget. Two: book flights.');
  assert.strictEqual(await page.textContent('#save-btn'), 'Saved');
  await page.click('#saved-btn');
  page.once('dialog', (d) => d.accept());
  await page.click('#saved-list [data-action=delete]');
  await page.waitForFunction(() => !document.querySelector('#saved-list li'));
  assert.ok(await page.isVisible('#saved-empty'));
  await page.click('#saved button[value=close]');
  assert.ok(await page.isHidden('#saved-count'));
  assert.strictEqual(await page.textContent('#save-btn'), 'Save');

  // 10b. Paste puts clipboard text on the surface...
  await page.evaluate(() => navigator.clipboard.writeText('  An article paragraph to rephrase.\r\n'));
  page.once('dialog', (d) => d.accept()); // the draft on screen isn't saved
  await page.click('#paste-btn');
  await page.waitForFunction(() => document.querySelector('#text').textContent === 'An article paragraph to rephrase.');
  assert.match(await page.textContent('#status'), /^Pasted/);
  // ...and the next take overwrites it, with the pasted text sent as context.
  replies.push({ text: 'My own take on the paragraph.' });
  await take();
  assert.strictEqual(await text(), 'My own take on the paragraph.');
  assert.match(requests.at(-1).body, /name="prompt"\r\n\r\nAn article paragraph to rephrase\./);
  // Pasting over an unsaved draft asks first.
  await page.evaluate(() => navigator.clipboard.writeText('Second paste'));
  let asked = new Promise((r) => page.once('dialog', (d) => { d.dismiss(); r(); }));
  await page.click('#paste-btn');
  await asked;
  assert.strictEqual(await text(), 'My own take on the paragraph.');
  page.once('dialog', (d) => d.accept());
  await page.click('#paste-btn');
  await page.waitForFunction(() => document.querySelector('#text').textContent === 'Second paste');
  // Without clipboard access, a box opens to paste by hand.
  await page.evaluate(() => { navigator.clipboard.readText = () => Promise.reject(new Error('denied')); });
  await page.click('#paste-btn');
  await page.waitForSelector('#paste-dialog[open]');
  await page.fill('#paste-text', 'Typed by hand');
  page.once('dialog', (d) => d.accept()); // replaces the unsaved "Second paste"
  await page.click('#paste-dialog button[value=paste]');
  await page.waitForFunction(() => document.querySelector('#text').textContent === 'Typed by hand');
  await page.evaluate(() => localStorage.setItem('draft', ''));
  await page.reload();

  // 11. Pasting a Groq key fills in Groq's endpoint and model.
  await page.evaluate(() => localStorage.setItem('settings', '{}'));
  await page.reload();
  await page.click('#settings-btn');
  assert.strictEqual(await page.inputValue('input[name=baseUrl]'), 'https://api.openai.com/v1');
  await page.fill('input[name=apiKey]', 'gsk_example');
  assert.strictEqual(await page.inputValue('input[name=baseUrl]'), 'https://api.groq.com/openai/v1');
  assert.strictEqual(await page.inputValue('input[name=model]'), 'whisper-large-v3-turbo');
  await page.click('#settings button[value="save"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('settings')).baseUrl === 'https://api.groq.com/openai/v1');

  // 12. A Groq key that arrives without an input event (e.g. keyboard autofill)
  //     still gets Groq's endpoint on save, and existing settings are fixed on load.
  await page.evaluate(() => localStorage.setItem('settings', '{}'));
  await page.reload();
  await page.click('#settings-btn');
  await page.evaluate(() => (document.querySelector('input[name=apiKey]').value = 'gsk_autofilled'));
  await page.click('#settings button[value="save"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('settings')).baseUrl === 'https://api.groq.com/openai/v1');
  await page.evaluate(() => localStorage.setItem('settings', JSON.stringify({ apiKey: 'gsk_old', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' })));
  await page.reload();
  await page.click('#settings-btn');
  assert.strictEqual(await page.inputValue('input[name=baseUrl]'), 'https://api.groq.com/openai/v1');
  assert.strictEqual(await page.inputValue('input[name=model]'), 'whisper-large-v3-turbo');

  assert.deepStrictEqual(errors, []);
  await browser.close();
  await testOnDevice(url);
  await testXai(url);
  console.log(`PASS (${requests.length} cloud transcription requests)`);
  server.close();
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
