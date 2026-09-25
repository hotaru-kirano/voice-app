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

// A few seconds of a voiced tone, looped by Chromium as the fake mic.
function makeWav() {
  const rate = 16000;
  const data = Buffer.alloc(rate * 3 * 2);
  for (let n = 0; n < rate * 3; n++) {
    const t = n / rate;
    const s = 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 200 * t);
    data.writeInt16LE(Math.round(s * 32767), n * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), 'voice-drafts-test.wav');
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

(async () => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${makeWav()}`],
  });
  const context = await browser.newContext({ permissions: ['microphone', 'clipboard-read', 'clipboard-write'] });
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

  // 2. Speaking again replaces it, and the previous draft is sent as context.
  replies.push({ text: 'Trip to Kyoto in May. Budget first, then book flights.' });
  await take();
  assert.strictEqual(await text(), 'Trip to Kyoto in May. Budget first, then book flights.');
  assert.match(requests[1].body, /name="prompt"\r\n\r\nI want to plan a trip, maybe Kyoto/);
  assert.strictEqual(await page.textContent('#version'), '2 / 2');

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

  // 5. History: step back, then forward.
  assert.strictEqual(await page.textContent('#version'), '3 / 3');
  await page.click('#prev-btn');
  assert.strictEqual(await text(), 'Trip to Kyoto in May. Budget first, then book flights.');
  await page.click('#next-btn');

  // 6. Copy.
  await page.click('#copy-btn');
  assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'Kyoto, May. One: set a budget. Two: book flights.');

  // 7. Survives a reload.
  await page.reload();
  assert.strictEqual(await text(), 'Kyoto, May. One: set a budget. Two: book flights.');

  // 8. New draft clears the surface; history is kept.
  await page.click('#new-btn');
  assert.strictEqual(await text(), '');
  assert.ok(await page.isVisible('#placeholder'));
  await page.click('#prev-btn');
  assert.strictEqual(await text(), 'Kyoto, May. One: set a budget. Two: book flights.');

  // 9. Pasting a Groq key fills in Groq's endpoint and model.
  await page.evaluate(() => localStorage.setItem('settings', '{}'));
  await page.reload();
  await page.click('#settings-btn');
  assert.strictEqual(await page.inputValue('input[name=baseUrl]'), 'https://api.openai.com/v1');
  await page.fill('input[name=apiKey]', 'gsk_example');
  assert.strictEqual(await page.inputValue('input[name=baseUrl]'), 'https://api.groq.com/openai/v1');
  assert.strictEqual(await page.inputValue('input[name=model]'), 'whisper-large-v3-turbo');
  await page.click('#settings button[value="save"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('settings')).baseUrl === 'https://api.groq.com/openai/v1');

  // 10. A Groq key that arrives without an input event (e.g. keyboard autofill)
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
  console.log(`PASS (${requests.length} transcription requests)`);
  await browser.close();
  server.close();
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
