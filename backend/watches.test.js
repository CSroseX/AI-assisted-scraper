const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.GROQ_API_KEY = 'test-key';

const axios = require('axios');
const scraper = require('./scraper');
const { app } = require('./index');
const { getDb, closeDb } = require('./db');
const { hashChanges } = require('./diff');

// The fingerprint isn't part of the API response, so read it from the DB.
const storedDiffHashes = (watchId) =>
  getDb().prepare('SELECT diff_hash FROM changes WHERE watch_id = ?').all(watchId).map((r) => r.diff_hash);

// Stands in for Groq so no test reaches the network. `reply` is the raw model
// text, or an Error to simulate the provider being down.
function mockModel(t, reply) {
  const calls = [];
  t.mock.method(axios, 'post', async (_url, body) => {
    calls.push(body);
    if (reply instanceof Error) throw reply;
    return { data: { choices: [{ message: { content: reply } }] } };
  });
  return calls;
}

const explanation = (obj) => JSON.stringify(obj);

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
  mockModel(t, explanation({
    category: 'price',
    summary: 'The monthly price rose from $10 to $15.',
    quote_ids: [1, 2]
  }));
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

test('a detected change is stored with its explanation and quoted evidence', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://explain.test/terms', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Cancellation fee: none.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  const calls = mockModel(t, explanation({
    category: 'cancellation',
    summary: 'Cancelling now costs $25, where it used to be free.',
    quote_ids: [1, 2]
  }));
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Cancellation fee: $25.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  assert.equal(calls.length, 1, 'the model is called once for one change');

  const [change] = await (await get(`/watches/${created.id}/changes`)).json();
  assert.equal(change.category, 'cancellation');
  assert.equal(change.summary, 'Cancelling now costs $25, where it used to be free.');
  // Quotes come from the diff, not from the model's reply.
  assert.deepEqual(change.quotes, ['Cancellation fee: none.', 'Cancellation fee: $25.']);
  assert.ok(change.explainedAt);
  assert.equal(change.explainError, null);
});

test('an unverifiable explanation is dropped but the change survives', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://unverified.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  // The model asserts a figure that is nowhere in the diff.
  mockModel(t, explanation({
    category: 'price',
    summary: 'The price jumped to "$99/month" overnight.',
    quote_ids: [1, 2]
  }));
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $12/month.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  const [change] = await (await get(`/watches/${created.id}/changes`)).json();
  // The fabricated claim is discarded...
  assert.equal(change.summary, null);
  assert.equal(change.category, null);
  // ...but the diff that proved the change is intact.
  assert.deepEqual(change.diff, [
    { type: 'removed', text: 'Price: $10/month.' },
    { type: 'added', text: 'Price: $12/month.' }
  ]);
});

test('a change is still recorded when the model is unreachable', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://outage.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Free trial: 30 days.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  mockModel(t, new Error('connect ECONNREFUSED'));
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Free trial: 7 days.', screenshotPath: null }));
  const res = await post(`/watches/${created.id}/check`);

  // The check itself must still succeed: detection does not depend on the LLM.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.change, 'the change is reported despite the model failing');

  const [change] = await (await get(`/watches/${created.id}/changes`)).json();
  assert.equal(change.summary, null);
  assert.match(change.explainError, /ECONNREFUSED/);
  assert.deepEqual(change.diff, [
    { type: 'removed', text: 'Free trial: 30 days.' },
    { type: 'added', text: 'Free trial: 7 days.' }
  ]);
  // The fingerprint must not depend on the model, or alerts could not be deduplicated.
  assert.deepEqual(storedDiffHashes(created.id), [hashChanges(change.diff)]);
});

test('EXPLAIN_ENABLED=false detects changes without calling the model', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://disabled.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Plan: Basic.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  const calls = mockModel(t, explanation({ category: 'price', summary: 'x', quote_ids: [1] }));
  process.env.EXPLAIN_ENABLED = 'false';
  t.after(() => { delete process.env.EXPLAIN_ENABLED; });

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Plan: Pro.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  assert.equal(calls.length, 0, 'no LLM call when explanations are disabled');
  const [change] = await (await get(`/watches/${created.id}/changes`)).json();
  assert.equal(change.summary, null);
  assert.ok(change.diff.length, 'the change is still detected and stored');
  assert.deepEqual(storedDiffHashes(created.id), [hashChanges(change.diff)]);
});

test('two overlapping checks of one watch record the change once', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://race.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  // Hold the first check mid-scrape so the second one arrives while it runs.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let scrapeStarted;
  const started = new Promise((resolve) => { scrapeStarted = resolve; });
  t.mock.method(scraper, 'captureSnapshot', async () => {
    scrapeStarted();
    await gate;
    return { content: 'Price: $12/month.', screenshotPath: null };
  });
  mockModel(t, new Error('model off for this test'));

  const first = post(`/watches/${created.id}/check`);
  await started;
  const second = await post(`/watches/${created.id}/check`);
  assert.equal(second.status, 409);
  assert.equal(second.headers.get('retry-after'), '5');

  release();
  assert.equal((await first).status, 200);

  const changes = await (await get(`/watches/${created.id}/changes`)).json();
  assert.equal(changes.length, 1, 'the change is recorded exactly once');

  // The lock is released afterwards, so a later check runs normally.
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $12/month.', screenshotPath: null }));
  assert.equal((await post(`/watches/${created.id}/check`)).status, 200);
});

test('a check that fails releases its lock', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://lock-release.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => { throw new Error('boom'); });
  assert.equal((await post(`/watches/${created.id}/check`)).status, 502);
  assert.equal((await post(`/watches/${created.id}/check`)).status, 502, 'not 409: the failed check must not stay locked');
});

test('opening the database backfills fingerprints missing from older changes', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://backfill.test', frequency: 'daily' })).json();

  const diff = [{ type: 'added', text: 'New fee: $3.' }];
  const db = getDb();
  const now = Date.now();
  const snap = db
    .prepare('INSERT INTO snapshots (watch_id, content, content_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(created.id, 'New fee: $3.', 'h', now);
  // Simulates a row written before fingerprints were stored at insert time.
  db.prepare('INSERT INTO changes (watch_id, to_snapshot_id, diff_json, created_at) VALUES (?, ?, ?, ?)')
    .run(created.id, snap.lastInsertRowid, JSON.stringify(diff), now);
  assert.deepEqual(storedDiffHashes(created.id), [null]);

  closeDb();
  assert.deepEqual(storedDiffHashes(created.id), [hashChanges(diff)]);
});

test('an unchanged page never reaches the model', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://static.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Terms unchanged since 2019.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  // Mock the model only now, so any call below would be a real one.
  const calls = mockModel(t, explanation({ category: 'price', summary: 'x', quote_ids: [1] }));
  const repeat = await (await post(`/watches/${created.id}/check`)).json();

  assert.equal(repeat.changed, false);
  // This is the cost guarantee: a stable page costs nothing to watch.
  assert.equal(calls.length, 0);
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
