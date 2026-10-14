const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Config is read at module load, so set it before requiring the app.
process.env.JSON_BODY_LIMIT = '5kb';
process.env.RATE_LIMIT_MAX = '1000';
process.env.SCRAPE_RATE_LIMIT_MAX = '2';
process.env.GROQ_API_KEY = 'test-key';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

const { app, cleanupScreenshots } = require('./index');

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
  const res = await post('/watches', { url: `https://a.test/${'x'.repeat(10000)}`, frequency: 'daily' });
  assert.equal(res.status, 413);
});

test('malformed JSON returns 400 without a stack trace', async () => {
  const res = await post('/watches', null, '{bad json');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid JSON body' });
});

test('a check launches a browser, so it has a tighter rate limit than the rest of the API', async () => {
  // SCRAPE_RATE_LIMIT_MAX is 2 here; the watch doesn't exist, so the first two are 404s.
  assert.equal((await post('/watches/999999/check')).status, 404);
  assert.equal((await post('/watches/999999/check')).status, 404);
  assert.equal((await post('/watches/999999/check')).status, 429);
  // Other routes still answer.
  assert.equal((await fetch(`${base}/watches`)).status, 200);
});

test('the chat demo endpoints are gone', async () => {
  for (const route of ['/scrape', '/ask', '/spin', '/chat', '/review', '/summarize']) {
    assert.equal((await post(route, { url: 'https://a.test', content: 'x', text: 'x', message: 'x' })).status, 404, route);
  }
});

const preflight = (origin, method) => fetch(`${base}/watches/1`, {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': method }
});

test('CORS preflight allows PATCH, PUT and DELETE from an allowed origin', async () => {
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const res = await preflight('http://localhost:3000', method);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.ok(res.headers.get('access-control-allow-methods').split(',').includes(method));
  }
});

test('CORS preflight refuses a disallowed origin', async () => {
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const res = await preflight('https://evil.example', method);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
});

test('/health is reachable', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test('API responses carry security headers and no Express banner', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none';frame-ancestors 'none'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
});

test('transient screenshots are not served: only evidence has routes', async (t) => {
  const dir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'served-test.png');
  fs.writeFileSync(file, 'png');
  t.after(() => fs.rmSync(file, { force: true }));
  assert.equal((await fetch(`${base}/screenshots/served-test.png`)).status, 404);
});

test('cleanupScreenshots removes only stale png files', () => {
  const dir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'stale-test.png');
  const fresh = path.join(dir, 'fresh-test.png');
  fs.writeFileSync(stale, 'x');
  fs.writeFileSync(fresh, 'x');
  // Age the stale file rather than moving the clock forward: other test files
  // run in parallel and keep fresh screenshots in this same folder.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
  try {
    cleanupScreenshots(Date.now());
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    for (const f of [stale, fresh]) fs.rmSync(f, { force: true });
  }
});
