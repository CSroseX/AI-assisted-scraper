const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.GROQ_API_KEY = 'test-key';
// This file sends well over the default 60 requests a minute; rate limiting is
// not what it tests.
process.env.RATE_LIMIT_MAX = '10000';
process.env.SCRAPE_RATE_LIMIT_MAX = '10000';

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
  assert.equal((await post(`/watches/${created.id}/check`)).status, 500);
  assert.equal((await post(`/watches/${created.id}/check`)).status, 500, 'not 409: the failed check must not stay locked');
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

test('POST /watches/:id/check is 502 when the page is at fault, 500 when the error is ours', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://c.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'captureSnapshot', async () => { throw new Error('page.goto: Timeout 20000ms exceeded.'); });
  const timedOut = await post(`/watches/${created.id}/check`);
  assert.equal(timedOut.status, 502);
  assert.deepEqual(await timedOut.json(), { error: 'The page took too long to load.', reason: 'timeout' });

  t.mock.method(scraper, 'captureSnapshot', async () => { throw new Error('boom'); });
  const unexpected = await post(`/watches/${created.id}/check`);
  assert.equal(unexpected.status, 500);
  assert.equal((await unexpected.json()).reason, 'unknown');
});

test('a manual check records when it ran and clears or keeps the error, leaving the schedule alone', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://checked.test', frequency: 'daily' })).json();
  const before = Date.now();

  t.mock.method(scraper, 'captureSnapshot', async () => { throw new Error('page.goto: net::ERR_CONNECTION_CLOSED'); });
  assert.equal((await post(`/watches/${created.id}/check`)).status, 502);
  const failed = await (await fetch(`${base}/watches/${created.id}`)).json();
  assert.ok(failed.lastCheckedAt >= before);
  assert.equal(failed.lastError, 'page.goto: net::ERR_CONNECTION_CLOSED');
  assert.equal(failed.lastErrorReason, 'unreachable');
  assert.equal(failed.failureCount, 0);
  assert.equal(failed.status, 'active');
  assert.equal(failed.nextCheckAt, created.nextCheckAt);

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Terms v1', screenshotPath: null }));
  assert.equal((await post(`/watches/${created.id}/check`)).status, 200);
  const ok = await (await fetch(`${base}/watches/${created.id}`)).json();
  assert.ok(ok.lastCheckedAt >= failed.lastCheckedAt);
  assert.equal(ok.lastError, null);
  assert.equal(ok.nextCheckAt, created.nextCheckAt);
});

test('a bot check page never becomes a snapshot or a change, and the watch says why', async (t) => {
  const { PageUnreadableError } = require('./failures');
  explainerOff(t);
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://walled.test/pricing', frequency: 'daily' })).json();
  const challenge = async () => { throw new PageUnreadableError('bot_protection', 'Bot check page (matched "rayid:")'); };
  const snapshotCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM snapshots WHERE watch_id = ?').get(created.id).n;
  const changeCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM changes WHERE watch_id = ?').get(created.id).n;

  t.mock.method(scraper, 'captureSnapshot', challenge);
  const res = await post(`/watches/${created.id}/check`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: 'The site showed a bot check (a challenge or captcha page) instead of the page.',
    reason: 'bot_protection'
  });
  assert.equal(snapshotCount(), 0);

  const watch = await (await get(`/watches/${created.id}`)).json();
  assert.equal(watch.lastErrorReason, 'bot_protection');
  assert.equal(watch.lastErrorMessage, 'The site showed a bot check (a challenge or captcha page) instead of the page.');
  assert.match(watch.lastError, /rayid/);

  // The real page arrives, then the wall returns: still no false change.
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Pro: $10/month.', screenshotPath: null }));
  assert.equal((await post(`/watches/${created.id}/check`)).status, 200);
  t.mock.method(scraper, 'captureSnapshot', challenge);
  assert.equal((await post(`/watches/${created.id}/check`)).status, 502);
  assert.equal(snapshotCount(), 1);
  assert.equal(changeCount(), 0);

  // A good check clears the reason, as resuming does.
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Pro: $10/month.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);
  const cleared = await (await get(`/watches/${created.id}`)).json();
  assert.equal(cleared.lastErrorReason, null);
  assert.equal(cleared.lastErrorMessage, null);
});

test('a manual check records when it ran and clears or keeps the error, leaving the schedule alone', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://checked.test', frequency: 'daily' })).json();
  const before = Date.now();

  t.mock.method(scraper, 'captureSnapshot', async () => { throw new Error('page.goto: net::ERR_CONNECTION_CLOSED'); });
  assert.equal((await post(`/watches/${created.id}/check`)).status, 502);
  const failed = await (await fetch(`${base}/watches/${created.id}`)).json();
  assert.ok(failed.lastCheckedAt >= before);
  assert.equal(failed.lastError, 'page.goto: net::ERR_CONNECTION_CLOSED');
  assert.equal(failed.failureCount, 0);
  assert.equal(failed.status, 'active');
  assert.equal(failed.nextCheckAt, created.nextCheckAt);

  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Terms v1', screenshotPath: null }));
  assert.equal((await post(`/watches/${created.id}/check`)).status, 200);
  const ok = await (await fetch(`${base}/watches/${created.id}`)).json();
  assert.ok(ok.lastCheckedAt >= failed.lastCheckedAt);
  assert.equal(ok.lastError, null);
  assert.equal(ok.nextCheckAt, created.nextCheckAt);
});

test('POST /watches/:id/check is 503 when the scraper is at capacity', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://d.test', frequency: 'daily' })).json();

  t.mock.method(scraper, 'scraperBusy', () => true);
  const res = await post(`/watches/${created.id}/check`);
  assert.equal(res.status, 503);
});

// --- alert channels, alerts and feedback --------------------------------------

function explainerOff(t) {
  process.env.EXPLAIN_ENABLED = 'false';
  t.after(() => { delete process.env.EXPLAIN_ENABLED; });
}

// Creates a watch, takes its baseline, then changes the page once.
async function watchWithOneChange(t, url, body = {}) {
  explainerOff(t);
  t.mock.method(scraper, 'validateScrapeUrl', async (u) => ({ ok: true, parsedUrl: u }));
  const created = await (await post('/watches', { url, frequency: 'daily', ...body })).json();
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $12/month.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);
  const [change] = await (await get(`/watches/${created.id}/changes`)).json();
  return { watch: created, change };
}

test('a watch respects robots.txt unless it records an exception', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://robots-ex.test/terms', frequency: 'daily' })).json();
  assert.equal(created.ignoreRobots, false);

  const options = [];
  t.mock.method(scraper, 'captureSnapshot', async (_url, opts) => {
    options.push(opts);
    return { content: 'Terms: version 1.', screenshotPath: null };
  });
  await post(`/watches/${created.id}/check`);
  assert.equal(options[0].respectRobots, true);

  const updated = await (await patch(`/watches/${created.id}`, { ignoreRobots: true })).json();
  assert.equal(updated.ignoreRobots, true);
  await post(`/watches/${created.id}/check`);
  assert.equal(options[1].respectRobots, false);

  const withException = await (await post('/watches', { url: 'https://robots-ex2.test', frequency: 'daily', ignoreRobots: true })).json();
  assert.equal(withException.ignoreRobots, true);

  assert.equal((await post('/watches', { url: 'https://robots-ex3.test', frequency: 'daily', ignoreRobots: 'yes' })).status, 400);
  assert.equal((await patch(`/watches/${created.id}`, { ignoreRobots: 1 })).status, 400);
});

test('a new watch alerts by RSS unless told otherwise', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const plain = await (await post('/watches', { url: 'https://default-ch.test', frequency: 'daily' })).json();
  assert.deepEqual(plain.alertChannels, ['rss']);

  const both = await (await post('/watches', { url: 'https://both-ch.test', frequency: 'daily', alertChannels: ['rss', 'email'] })).json();
  assert.deepEqual(both.alertChannels, ['email', 'rss']);

  const none = await (await post('/watches', { url: 'https://no-ch.test', frequency: 'daily', alertChannels: [] })).json();
  assert.deepEqual(none.alertChannels, []);
});

test('POST /watches rejects bad alert channels', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const bad = (alertChannels) => post('/watches', { url: 'https://bad-ch.test', frequency: 'daily', alertChannels });
  assert.equal((await bad(['sms'])).status, 400);
  assert.equal((await bad(['rss', 'rss'])).status, 400);
  assert.equal((await bad('rss')).status, 400);
});

test('PATCH /watches/:id changes alert channels without touching status', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://patch-ch.test', frequency: 'daily' })).json();
  await patch(`/watches/${created.id}`, { status: 'paused' });

  const updated = await (await patch(`/watches/${created.id}`, { alertChannels: ['email'] })).json();
  assert.deepEqual(updated.alertChannels, ['email']);
  assert.equal(updated.status, 'paused');

  // Both at once.
  const both = await (await patch(`/watches/${created.id}`, { status: 'active', alertChannels: [] })).json();
  assert.equal(both.status, 'active');
  assert.deepEqual(both.alertChannels, []);

  assert.equal((await patch(`/watches/${created.id}`, {})).status, 400);
  assert.equal((await patch(`/watches/${created.id}`, { alertChannels: ['fax'] })).status, 400);
  // A bad field rejects the whole request: the valid half is not applied.
  assert.equal((await patch(`/watches/${created.id}`, { status: 'paused', alertChannels: ['fax'] })).status, 400);
  assert.equal((await (await get(`/watches/${created.id}`)).json()).status, 'active');
});

test('a detected change queues an alert on each enabled channel', async (t) => {
  const { watch, change } = await watchWithOneChange(t, 'https://alerts.test', { alertChannels: ['email', 'rss'] });
  const alerts = await (await get(`/watches/${watch.id}/alerts`)).json();
  const byChannel = Object.fromEntries(alerts.map((a) => [a.channel, a]));
  assert.deepEqual(Object.keys(byChannel).sort(), ['email', 'rss']);
  assert.equal(byChannel.email.status, 'pending');
  assert.equal(byChannel.rss.status, 'sent');
  for (const alert of alerts) assert.equal(alert.changeId, change.id);
});

test('end to end: a page change detected by a check is emailed once', async (t) => {
  const { deliverPendingEmails } = require('./emailAlerts');
  const { watch, change } = await watchWithOneChange(t, 'https://e2e-mail.test/pricing', { alertChannels: ['email'] });

  const sent = [];
  const send = async (message) => { sent.push(message); return { messageId: '<e2e@test>' }; };
  const ready = { ok: true, mode: 'smtp', missing: [] };
  await deliverPendingEmails({ send, setup: ready });
  await deliverPendingEmails({ send, setup: ready });

  // Earlier tests in this file queue email alerts too; look only at ours.
  const ours = sent.filter((m) => m.subject.endsWith('e2e-mail.test'));
  assert.equal(ours.length, 1, 'sent exactly once across two passes');
  assert.equal(ours[0].subject, 'Change detected on e2e-mail.test');
  assert.match(ours[0].text, /Removed: Price: \$10\/month\./);
  assert.match(ours[0].text, new RegExp(`/evidence/changes/${change.id}\\?token=`));
  const [emailAlert] = await (await get(`/watches/${watch.id}/alerts`)).json();
  assert.equal(emailAlert.status, 'sent');
});

test('a baseline or an unchanged page queues no alerts', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://quiet.test', frequency: 'daily' })).json();
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Same.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);
  await post(`/watches/${created.id}/check`);
  assert.deepEqual(await (await get(`/watches/${created.id}/alerts`)).json(), []);
});

test('if alerts cannot be queued, the snapshot and change roll back and the next check retries', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://atomic.test', frequency: 'daily' })).json();
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Fee: $1.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  // Make every alert insert fail, as a disk or constraint error would.
  getDb().exec("CREATE TRIGGER fail_alerts BEFORE INSERT ON alerts BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  t.after(() => getDb().exec('DROP TRIGGER IF EXISTS fail_alerts'));

  explainerOff(t);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Fee: $2.', screenshotPath: null }));
  assert.equal((await post(`/watches/${created.id}/check`)).status, 500, 'a failed write is our fault, not the page');
  assert.equal((await (await get(`/watches/${created.id}/snapshots`)).json()).length, 1, 'no half-written snapshot');
  assert.equal((await (await get(`/watches/${created.id}/changes`)).json()).length, 0);

  // Once the fault clears, the same content is still seen as new and recorded fully.
  getDb().exec('DROP TRIGGER fail_alerts');
  assert.equal((await post(`/watches/${created.id}/check`)).status, 200);
  assert.equal((await (await get(`/watches/${created.id}/changes`)).json()).length, 1);
  assert.equal((await (await get(`/watches/${created.id}/alerts`)).json()).length, 1);
});

// A screenshot file as the real scraper would leave it.
function transientScreenshot(t) {
  const name = `${require('crypto').randomUUID()}.png`;
  fs.mkdirSync(scraper.SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(scraper.SCREENSHOT_DIR, name), 'png-bytes');
  t.after(() => fs.rmSync(path.join(scraper.SCREENSHOT_DIR, name), { force: true }));
  return `screenshots/${name}`;
}

test('a stored snapshot keeps its screenshot as evidence, beyond the transient cleanup', async (t) => {
  const { evidenceFile } = require('./evidence');
  explainerOff(t);
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://evidence.test', frequency: 'daily' })).json();

  const shot = transientScreenshot(t);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: shot }));
  await post(`/watches/${created.id}/check`);

  const [snapshot] = await (await get(`/watches/${created.id}/snapshots`)).json();
  assert.match(snapshot.screenshotPath, /^evidence\/[0-9a-f-]+\.png$/);
  // The transient copy expiring must not take the evidence with it.
  fs.rmSync(path.join(scraper.SCREENSHOT_DIR, path.basename(shot)));
  assert.equal(fs.readFileSync(evidenceFile(snapshot.screenshotPath), 'utf8'), 'png-bytes');

  // A repeat check of unchanged content stores nothing, so keeps nothing.
  const repeatShot = transientScreenshot(t);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: repeatShot }));
  await post(`/watches/${created.id}/check`);
  assert.equal(fs.existsSync(evidenceFile(`evidence/${path.basename(repeatShot)}`)), false);
});

test('the UI can read a snapshot text and screenshot without LINK_TOKEN', async (t) => {
  explainerOff(t);
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://snapshot-files.test', frequency: 'daily' })).json();
  const shot = transientScreenshot(t);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: shot }));
  await post(`/watches/${created.id}/check`);
  const [listed] = await (await get(`/watches/${created.id}/snapshots`)).json();

  const snapshot = await (await get(`/watches/${created.id}/snapshots/${listed.id}`)).json();
  assert.equal(snapshot.content, 'Price: $10/month.');
  assert.equal(snapshot.screenshotPath, listed.screenshotPath);

  // No ?token=: the frontend never holds LINK_TOKEN.
  const res = await get(`/watches/${created.id}/snapshots/${listed.id}/screenshot`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(await res.text(), 'png-bytes');
  // An <img> on the frontend's origin must be allowed to load it...
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  // ...without losing the other helmet headers.
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('snapshot routes return 404 for other watches, missing files and path tricks', async (t) => {
  explainerOff(t);
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const mine = await (await post('/watches', { url: 'https://snapshot-404.test', frequency: 'daily' })).json();
  const other = await (await post('/watches', { url: 'https://snapshot-other.test', frequency: 'daily' })).json();
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'No screenshot here.', screenshotPath: null }));
  await post(`/watches/${mine.id}/check`);
  const [snapshot] = await (await get(`/watches/${mine.id}/snapshots`)).json();

  // Another watch's id can't reach this snapshot.
  assert.equal((await get(`/watches/${other.id}/snapshots/${snapshot.id}`)).status, 404);
  assert.equal((await get(`/watches/${other.id}/snapshots/${snapshot.id}/screenshot`)).status, 404);
  // The snapshot exists but has no screenshot.
  assert.equal((await get(`/watches/${mine.id}/snapshots/${snapshot.id}/screenshot`)).status, 404);
  for (const bad of ['..%2F..%2Fwatchdog.db', '..', '-1', '0', `${snapshot.id}.png`, '1e3']) {
    assert.equal((await get(`/watches/${mine.id}/snapshots/${bad}/screenshot`)).status, 404, bad);
  }

  // Even a tampered stored path never resolves outside evidence storage.
  for (const tampered of ['evidence/../../watchdog.db', '../watchdog.db', 'evidence/x.png/../../secret.png']) {
    getDb().prepare('UPDATE snapshots SET screenshot_path = ? WHERE id = ?').run(tampered, snapshot.id);
    assert.equal((await get(`/watches/${mine.id}/snapshots/${snapshot.id}/screenshot`)).status, 404, tampered);
  }
});

test('when the snapshot write fails, its kept screenshot is discarded too', async (t) => {
  const { evidenceFile } = require('./evidence');
  explainerOff(t);
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const created = await (await post('/watches', { url: 'https://evidence-rollback.test', frequency: 'daily' })).json();
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Fee: $1.', screenshotPath: null }));
  await post(`/watches/${created.id}/check`);

  getDb().exec("CREATE TRIGGER fail_alerts_ev BEFORE INSERT ON alerts BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  t.after(() => getDb().exec('DROP TRIGGER IF EXISTS fail_alerts_ev'));

  const shot = transientScreenshot(t);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Fee: $2.', screenshotPath: shot }));
  assert.equal((await post(`/watches/${created.id}/check`)).status, 500);
  assert.equal(fs.existsSync(evidenceFile(`evidence/${path.basename(shot)}`)), false, 'no orphaned evidence');
});

test('feedback: rate a change, change your mind, then clear it', async (t) => {
  const { watch, change } = await watchWithOneChange(t, 'https://feedback.test');
  const route = `/watches/${watch.id}/changes/${change.id}/feedback`;
  const put = (body) => fetch(base + route, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  assert.equal(change.feedback, null);

  assert.deepEqual(await (await put({ vote: 'noise' })).json(), { changeId: change.id, vote: 'noise' });
  await put({ vote: 'useful' });
  const [rated] = await (await get(`/watches/${watch.id}/changes`)).json();
  assert.equal(rated.feedback, 'useful', 'voting again replaces the earlier vote');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM feedback WHERE change_id = ?').get(change.id).n, 1);

  assert.equal((await del(route)).status, 204);
  const [cleared] = await (await get(`/watches/${watch.id}/changes`)).json();
  assert.equal(cleared.feedback, null);

  assert.equal((await put({ vote: 'meh' })).status, 400);
});

test('feedback is refused for a change that belongs to another watch', async (t) => {
  const { change } = await watchWithOneChange(t, 'https://owner.test');
  t.mock.method(scraper, 'validateScrapeUrl', async (url) => ({ ok: true, parsedUrl: url }));
  const other = await (await post('/watches', { url: 'https://other.test', frequency: 'daily' })).json();

  const res = await fetch(`${base}/watches/${other.id}/changes/${change.id}/feedback`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote: 'useful' })
  });
  assert.equal(res.status, 404);
  assert.equal((await fetch(`${base}/watches/${other.id}/changes/abc/feedback`, { method: 'DELETE' })).status, 400);
});
