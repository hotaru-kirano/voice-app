// End-to-end test: feeds synthetic "speech" into Chromium's fake microphone,
// mocks the transcription API, and checks that voice commands create notes.
//
// Run: NODE_PATH=$(npm root -g) node tests/e2e.cjs   (needs `playwright` installed)

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

// 16 kHz mono WAV: silence, a burst of "speech", silence, a second burst, silence.
function makeWav() {
  const rate = 16000;
  const pattern = [[1.5, 0], [1.6, 1], [2.2, 0], [1.0, 1], [3.0, 0]];
  const total = pattern.reduce((s, [d]) => s + d, 0);
  const data = Buffer.alloc(Math.round(total * rate) * 2);
  let i = 0;
  for (const [dur, on] of pattern) {
    for (let n = 0; n < dur * rate; n++, i++) {
      const t = n / rate;
      // Voiced harmonics with a syllable-rate envelope, so noise suppression keeps it.
      const env = on ? 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t) : 0;
      const s = env * 0.35 * (Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 360 * t) + 0.3 * Math.sin(2 * Math.PI * 720 * t)) / 1.9;
      data.writeInt16LE(Math.round(s * 32767), i * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), 'voice-notes-test.wav');
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

(async () => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${makeWav()}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addInitScript(() => {
    if (!localStorage.getItem('settings')) {
      localStorage.setItem('settings', JSON.stringify({ apiKey: 'test-key', baseUrl: 'https://api.example.test/v1', model: 'whisper-1', speak: false, silenceMs: 1000 }));
    }
  });

  const replies = ['Buy milk and eggs.', 'Save note.'];
  const requests = [];
  await context.route('https://api.example.test/**', async (route) => {
    const req = route.request();
    requests.push({ url: req.url(), auth: req.headers()['authorization'], body: req.postDataBuffer()?.toString('latin1') || '' });
    const text = replies[(requests.length - 1) % replies.length];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ text }) });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  await page.click('#mic-btn');
  await page.waitForSelector('#mic-btn[aria-pressed="true"]');

  // The first burst becomes draft text; the second ("Save note.") saves it.
  await page.waitForSelector('#notes li', { timeout: 20000 });
  const noteText = await page.textContent('#notes li .text');
  assert.strictEqual(noteText, 'Buy milk and eggs.');
  assert.strictEqual(await page.inputValue('#draft'), '');

  const first = requests[0];
  assert.strictEqual(first.url, 'https://api.example.test/v1/audio/transcriptions');
  assert.strictEqual(first.auth, 'Bearer test-key');
  assert.match(first.body, /name="model"\r\n\r\nwhisper-1/);
  assert.match(first.body, /filename="speech\.(webm|ogg|m4a)"/);

  await page.click('#mic-btn');
  await page.waitForSelector('#mic-btn[aria-pressed="false"]');

  // Notes survive a reload (IndexedDB).
  await page.reload();
  await page.waitForSelector('#notes li');
  assert.strictEqual(await page.locator('#notes li').count(), 1);

  // Edit a note through the dialog.
  await page.click('#notes li');
  await page.fill('#note-text', 'Buy milk, eggs and bread.');
  await page.click('#note-dialog button[value="save"]');
  await page.waitForFunction(() => document.querySelector('#notes li .text')?.textContent === 'Buy milk, eggs and bread.');

  assert.deepStrictEqual(errors, []);
  console.log(`PASS (${requests.length} transcription requests)`);
  await browser.close();
  server.close();
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
