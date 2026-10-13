const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-seed-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.GROQ_API_KEY = 'test-key';
process.env.RATE_LIMIT_MAX = '10000';

const scraper = require('../scraper');
const { app } = require('../index');
const { getDb, closeDb } = require('../db');
const { seedTrial, TRIAL_PAGES } = require('./seedTrial');

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

test.after(() => {
  server.close();
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  getDb().prepare('DELETE FROM watches').run();
});

// Normalizes like the real validateScrapeUrl, without any DNS lookup.
const acceptAll = async (url) => ({ ok: true, parsedUrl: new URL(url).toString() });

const pages = [
  { group: 'SaaS pricing', url: 'https://pricing.test/plans' },
  { group: 'SaaS terms', url: 'https://terms.test' },
  { group: 'Likely blocked', url: 'https://blocked.test/legal' }
];

test('TRIAL_PAGES holds 15–20 distinct https pages', () => {
  const urls = TRIAL_PAGES.map((p) => new URL(p.url).toString());
  assert.ok(urls.length >= 15 && urls.length <= 20);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.every((u) => u.startsWith('https://')));
});

test('creates each page as a daily watch with email and RSS alerts', async (t) => {
  const validate = t.mock.method(scraper, 'validateScrapeUrl', acceptAll);

  const results = await seedTrial({ baseUrl: base, pages });

  assert.deepEqual(results.map((r) => r.outcome), ['created', 'created', 'created']);
  assert.equal(validate.mock.callCount(), pages.length);
  const watches = await (await fetch(`${base}/watches`)).json();
  assert.equal(watches.length, pages.length);
  for (const w of watches) {
    assert.equal(w.frequency, 'daily');
    assert.deepEqual([...w.alertChannels].sort(), ['email', 'rss']);
  }
});

test('re-running skips pages that are already watched, matching the normalized URL', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', acceptAll);

  const first = await seedTrial({ baseUrl: base, pages });
  const second = await seedTrial({ baseUrl: base, pages });

  assert.deepEqual(second.map((r) => r.outcome), ['exists', 'exists', 'exists']);
  assert.deepEqual(second.map((r) => r.id), first.map((r) => r.id));
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, pages.length);
});

test('a page the API rejects is reported with its reason and the rest still get added', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) =>
    url.includes('blocked.test') ? { ok: false, reason: 'Blocked address' } : acceptAll(url)
  );

  const results = await seedTrial({ baseUrl: base, pages });

  assert.deepEqual(results.map((r) => r.outcome), ['created', 'created', 'rejected']);
  assert.equal(results[2].error, 'Blocked address');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM watches').get().n, 2);
});

test('fails loudly when the backend cannot list watches', async () => {
  const fetchImpl = async () => new Response('down', { status: 503 });
  await assert.rejects(seedTrial({ baseUrl: base, pages, fetchImpl }), /HTTP 503/);
});

test('a rate limit or server error is a failed request to retry, not a rejected page', async () => {
  const fetchImpl = async (_url, init) => (init && init.method === 'POST'
    ? new Response(JSON.stringify({ error: 'Too many requests, please slow down.' }), { status: 429 })
    : new Response('[]', { status: 200 }));
  const results = await seedTrial({ baseUrl: base, pages, fetchImpl });
  assert.deepEqual(results.map((r) => r.outcome), ['failed', 'failed', 'failed']);
  assert.match(results[0].error, /HTTP 429/);
});
