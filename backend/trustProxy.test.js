const test = require('node:test');
const assert = require('node:assert/strict');

// Config is read at module load, so set it before requiring the app. One
// reverse proxy sits in front, and each client gets one check per window.
process.env.TRUST_PROXY = '1';
process.env.RATE_LIMIT_MAX = '1000';
process.env.SCRAPE_RATE_LIMIT_MAX = '1';
process.env.GROQ_API_KEY = 'test-key';

const { app } = require('./index');

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

// The proxy appends the address it saw, so the last entry is the real client
// and anything before it came from the client itself.
const check = (forwardedFor) => fetch(`${base}/watches/999999/check`, {
  method: 'POST',
  headers: { 'X-Forwarded-For': forwardedFor }
});

test('behind one proxy, each client gets its own budget', async () => {
  assert.equal((await check('203.0.113.1')).status, 404);
  assert.equal((await check('203.0.113.1')).status, 429);
  // A different client behind the same proxy is not affected.
  assert.equal((await check('203.0.113.2')).status, 404);
});

test('a spoofed X-Forwarded-For entry does not buy a fresh budget', async () => {
  assert.equal((await check('203.0.113.3')).status, 404);
  for (const spoofed of ['198.51.100.7', '198.51.100.8, 198.51.100.9']) {
    assert.equal((await check(`${spoofed}, 203.0.113.3`)).status, 429, spoofed);
  }
});
