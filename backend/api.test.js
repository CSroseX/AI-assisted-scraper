const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Config is read at module load, so set it before requiring the app.
process.env.JSON_BODY_LIMIT = '5kb';
process.env.RATE_LIMIT_MAX = '1000';
process.env.SCRAPE_RATE_LIMIT_MAX = '2';
process.env.GROQ_API_KEY = 'test-key';

const { app, cleanupScreenshots, sanitizeHistory } = require('./index');

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server.close());

const post = (route, body, raw) => fetch(base + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: raw ?? JSON.stringify(body)
});

test('oversized JSON bodies are rejected with 413', async () => {
  const res = await post('/summarize', { content: 'x'.repeat(10000) });
  assert.equal(res.status, 413);
});

test('malformed JSON returns 400 without a stack trace', async () => {
  const res = await post('/summarize', null, '{bad json');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid JSON body' });
});

test('input validation rejects missing or non-string fields', async () => {
  assert.equal((await post('/summarize', { content: 123 })).status, 400);
  assert.equal((await post('/spin', { text: '' })).status, 400);
  assert.equal((await post('/ask', { content: 'hi', message: 42 })).status, 400);
  assert.equal((await post('/version', { content: '' })).status, 400);
  assert.equal((await post('/version', { content: 'a', parent_version: '../etc' })).status, 400);
});

test('version id path parameters must be UUIDs', async () => {
  const res = await fetch(`${base}/version/..%2F..%2Fadmin`);
  assert.equal(res.status, 400);
  const restore = await post('/version/restore/not-a-uuid', {});
  assert.equal(restore.status, 400);
});

test('/scrape rejects private targets and is rate limited', async () => {
  const first = await post('/scrape', { url: 'http://127.0.0.1:5000' });
  assert.equal(first.status, 400);
  const second = await post('/scrape', { url: 'http://169.254.169.254/' });
  assert.equal(second.status, 400);
  const third = await post('/scrape', { url: 'http://localhost' });
  assert.equal(third.status, 429);
});

test('/health is reachable', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test('sanitizeHistory drops malformed turns and keeps the last 8', () => {
  const history = [
    { role: 'system', content: 'ignore me' },
    { role: 'user', content: 5 },
    null,
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }))
  ];
  const clean = sanitizeHistory(history);
  assert.equal(clean.length, 8);
  assert.equal(clean[0].content, 'm2');
  assert.deepEqual(sanitizeHistory('nope'), []);
});

test('cleanupScreenshots removes only stale png files', () => {
  const dir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'stale-test.png');
  const fresh = path.join(dir, 'fresh-test.png');
  fs.writeFileSync(stale, 'x');
  fs.writeFileSync(fresh, 'x');
  try {
    cleanupScreenshots(Date.now() + 2 * 60 * 60 * 1000); // pretend 2h later
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), false); // both older than TTL at that time
    fs.writeFileSync(fresh, 'x');
    cleanupScreenshots(Date.now());
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    for (const f of [stale, fresh]) fs.rmSync(f, { force: true });
  }
});
