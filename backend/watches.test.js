const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.GROQ_API_KEY = 'test-key';

const scraper = require('./scraper');
const { app } = require('./index');
const { closeDb } = require('./db');

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

const post = (route, body) => fetch(base + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const patch = (route, body) => fetch(base + route, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const get = (route) => fetch(base + route);
const del = (route) => fetch(base + route, { method: 'DELETE' });

test('POST /watches validates url and frequency', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));

  assert.equal((await post('/watches', { frequency: 'daily' })).status, 400);
  assert.equal((await post('/watches', { url: 'https://example.com' })).status, 400);
  assert.equal((await post('/watches', { url: 'https://example.com', frequency: 'hourly' })).status, 400);
  assert.equal((await post('/watches', { url: 'https://example.com', frequency: 'daily', selector: 'x'.repeat(501) })).status, 400);
});

test('POST /watches rejects SSRF targets via validateScrapeUrl', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async () => ({ ok: false, reason: 'blocked' }));
  const res = await post('/watches', { url: 'http://127.0.0.1', frequency: 'daily' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'blocked' });
});

test('watches CRUD: create, list, get, pause, delete', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));

  const created = await (await post('/watches', { url: 'https://a.test/tos', frequency: 'weekly' })).json();
  assert.equal(created.url, 'https://a.test/tos');
  assert.equal(created.frequency, 'weekly');
  assert.equal(created.status, 'active');

  const list = await (await get('/watches')).json();
  assert.ok(list.some((w) => w.id === created.id));

  const fetched = await (await get(`/watches/${created.id}`)).json();
  assert.deepEqual(fetched, created);

  const paused = await (await patch(`/watches/${created.id}`, { status: 'paused' })).json();
  assert.equal(paused.status, 'paused');

  assert.equal((await patch(`/watches/${created.id}`, { status: 'bogus' })).status, 400);

  assert.equal((await del(`/watches/${created.id}`)).status, 204);
  assert.equal((await get(`/watches/${created.id}`)).status, 404);
});

test('GET/PATCH/DELETE on an unknown watch id returns 404', async () => {
  assert.equal((await get('/watches/999999')).status, 404);
  assert.equal((await patch('/watches/999999', { status: 'paused' })).status, 404);
  assert.equal((await del('/watches/999999')).status, 404);
});

test('invalid watch id in the path is a 400, not a crash', async () => {
  assert.equal((await get('/watches/not-a-number')).status, 400);
});

test('POST /watches/:id/check stores a snapshot only on first run, then diffs on change', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://b.test/pricing', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: null }));
  const first = await (await post(`/watches/${created.id}/check`)).json();
  assert.equal(first.changed, true);
  assert.equal(first.change, null); // nothing to diff against yet

  const snapshotsAfterFirst = await (await get(`/watches/${created.id}/snapshots`)).json();
  assert.equal(snapshotsAfterFirst.length, 1);

  // Re-running with identical content should not create a new snapshot.
  const repeat = await (await post(`/watches/${created.id}/check`)).json();
  assert.equal(repeat.changed, false);
  const snapshotsAfterRepeat = await (await get(`/watches/${created.id}/snapshots`)).json();
  assert.equal(snapshotsAfterRepeat.length, 1);

  // A real content change produces a new snapshot and a recorded diff.
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $15/month.', screenshotPath: null }));
  const changed = await (await post(`/watches/${created.id}/check`)).json();
  assert.equal(changed.changed, true);
  assert.ok(changed.change);
  assert.deepEqual(changed.change.changes, [
    { type: 'removed', text: 'Price: $10/month.' },
    { type: 'added', text: 'Price: $15/month.' }
  ]);

  const changes = await (await get(`/watches/${created.id}/changes`)).json();
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].diff, changed.change.changes);

  const snapshotsFinal = await (await get(`/watches/${created.id}/snapshots`)).json();
  assert.equal(snapshotsFinal.length, 2);
});

test('POST /watches/:id/check surfaces scrape failures as 502', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://c.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => { throw new Error('boom'); });
  const res = await post(`/watches/${created.id}/check`);
  assert.equal(res.status, 502);
});

test('POST /watches/:id/check is 503 when the scraper is at capacity', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://d.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'scraperBusy', () => true);
  const res = await post(`/watches/${created.id}/check`);
  assert.equal(res.status, 503);
});
