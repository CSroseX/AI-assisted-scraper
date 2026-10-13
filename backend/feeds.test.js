const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-feeds-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.GROQ_API_KEY = 'test-key';
process.env.RATE_LIMIT_MAX = '10000';
process.env.EXPLAIN_ENABLED = 'false';

const TOKEN = 'test-feed-token-0123456789';
process.env.LINK_TOKEN = TOKEN;
process.env.PUBLIC_BASE_URL = 'https://watchdog.example';

const scraper = require('./scraper');
const { app } = require('./index');
const { getDb, closeDb } = require('./db');

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
const feed = (route, token = TOKEN) => fetch(`${base}${route}?token=${encodeURIComponent(token)}`);
const items = (xml) => xml.match(/<item>[\s\S]*?<\/item>/g) || [];

// Creates a watch, takes its baseline, then changes the page once.
async function watchWithChange(t, url, { before = 'Price: $10/month.', after = 'Price: $12/month.', alertChannels } = {}) {
  t.mock.method(scraper, 'validateScrapeUrl', async (u) => ({ ok: true, parsedUrl: u }));
  const watch = await (await post('/watches', { url, frequency: 'daily', alertChannels })).json();
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: before, screenshotPath: null }));
  await post(`/watches/${watch.id}/check`);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: after, screenshotPath: null }));
  await post(`/watches/${watch.id}/check`);
  return watch;
}

// --- access -----------------------------------------------------------------

test('feeds are off until LINK_TOKEN is set', async (t) => {
  delete process.env.LINK_TOKEN;
  t.after(() => { process.env.LINK_TOKEN = TOKEN; });
  const res = await feed('/feed.xml');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /LINK_TOKEN/);
});

test('a missing or wrong token is refused', async () => {
  assert.equal((await fetch(`${base}/feed.xml`)).status, 403);
  assert.equal((await feed('/feed.xml', 'wrong')).status, 403);
  assert.equal((await feed('/feed.xml', `${TOKEN}x`)).status, 403);
});

test('the token is checked before the watch lookup, so ids cannot be probed', async () => {
  assert.equal((await feed('/watches/999999/feed.xml', 'wrong')).status, 403);
  assert.equal((await feed('/watches/999999/feed.xml')).status, 404);
  assert.equal((await feed('/watches/abc/feed.xml')).status, 400);
});

// --- content ----------------------------------------------------------------

test('a feed with no alerts is still a valid empty RSS document', async (t) => {
  t.mock.method(scraper, 'validateScrapeUrl', async (u) => ({ ok: true, parsedUrl: u }));
  const watch = await (await post('/watches', { url: 'https://empty.test', frequency: 'daily' })).json();
  const res = await feed(`/watches/${watch.id}/feed.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/rss\+xml/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  const xml = await res.text();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<rss version="2\.0"><channel>/);
  assert.equal(items(xml).length, 0);
});

test('an item carries the title, the page link, the changed text and a stable id', async (t) => {
  const watch = await watchWithChange(t, 'https://shop.test/pricing');
  // As the explainer would have written it.
  getDb()
    .prepare("UPDATE changes SET category = 'price', summary = 'The monthly price rose from $10 to $12.' WHERE watch_id = ?")
    .run(watch.id);

  const xml = await (await feed(`/watches/${watch.id}/feed.xml`)).text();
  const [item] = items(xml);
  assert.ok(item, 'one item for one change');
  assert.match(item, /<title>Price change on shop\.test<\/title>/);
  // The title opens the evidence page, so the claim can be checked in one click.
  const evidence = `https://watchdog.example/evidence/changes/\\d+\\?token=${TOKEN}`;
  assert.match(item, new RegExp(`<link>${evidence}</link>`));
  assert.match(item, new RegExp(`href=&quot;${evidence}&quot;&gt;See before and after`));
  assert.match(item, /href=&quot;https:\/\/shop\.test\/pricing&quot;&gt;Open the page/);
  assert.match(item, /<guid isPermaLink="false">watchdog-alert-\d+<\/guid>/);
  assert.match(item, /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
  assert.match(item, /The monthly price rose from \$10 to \$12\./);
  assert.match(item, /Removed:.*Price: \$10\/month\./);
  assert.match(item, /Added:.*Price: \$12\/month\./);

  // Polling again gives the same id, so a reader does not show it twice.
  const again = items(await (await feed(`/watches/${watch.id}/feed.xml`)).text())[0];
  assert.equal(again.match(/watchdog-alert-\d+/)[0], item.match(/watchdog-alert-\d+/)[0]);
});

test('an unexplained change still appears, with an honest fallback', async (t) => {
  const watch = await watchWithChange(t, 'https://unexplained.test');
  const [item] = items(await (await feed(`/watches/${watch.id}/feed.xml`)).text());
  assert.match(item, /<title>Change detected on unexplained\.test<\/title>/);
  assert.match(item, /No verified summary is available yet/);
});

test('scraped markup is shown as text, never as HTML', async (t) => {
  const watch = await watchWithChange(t, 'https://hostile.test', {
    before: 'Terms.',
    after: 'Terms. <script>alert(1)</script> & <img src=x onerror=alert(2)>\u0007'
  });
  const xml = await (await feed(`/watches/${watch.id}/feed.xml`)).text();
  assert.doesNotMatch(xml, /<script/i);
  assert.doesNotMatch(xml, /<img/i);
  assert.doesNotMatch(xml, /\u0007/, 'characters XML forbids are dropped');
  // Escaped once as HTML, then again as XML text.
  assert.match(xml, /&amp;lt;script&amp;gt;alert\(1\)&amp;lt;\/script&amp;gt;/);
});

test('long diffs are capped so one redesign does not flood the reader', async (t) => {
  const paragraphs = Array.from({ length: 10 }, (_, i) => `New clause ${i + 1}.`).join('\n\n');
  const watch = await watchWithChange(t, 'https://long.test', { before: 'Intro.', after: `Intro.\n\n${paragraphs}` });
  const [item] = items(await (await feed(`/watches/${watch.id}/feed.xml`)).text());
  assert.equal((item.match(/Added:/g) || []).length, 6);
  assert.match(item, /and 4 more changed paragraphs/);
});

// --- which alerts appear ----------------------------------------------------

test('only RSS alerts that were published appear: not email-only, not suppressed', async (t) => {
  const emailOnly = await watchWithChange(t, 'https://email-only.test', { alertChannels: ['email'] });
  assert.equal(items(await (await feed(`/watches/${emailOnly.id}/feed.xml`)).text()).length, 0);

  const flapping = await watchWithChange(t, 'https://flap.test');
  // Flip back and forth: the third change repeats the first, inside the window.
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $10/month.', screenshotPath: null }));
  await post(`/watches/${flapping.id}/check`);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: 'Price: $12/month.', screenshotPath: null }));
  await post(`/watches/${flapping.id}/check`);

  const statuses = getDb().prepare('SELECT status FROM alerts WHERE watch_id = ? ORDER BY id').all(flapping.id).map((r) => r.status);
  assert.deepEqual(statuses, ['sent', 'sent', 'suppressed']);
  assert.equal(items(await (await feed(`/watches/${flapping.id}/feed.xml`)).text()).length, 2);
});

test('the global feed covers every watch, newest first; a watch feed covers only its own', async (t) => {
  const first = await watchWithChange(t, 'https://first.test');
  const second = await watchWithChange(t, 'https://second.test');

  const globalXml = await (await feed('/feed.xml')).text();
  const firstAt = globalXml.indexOf('on first.test</title>');
  const secondAt = globalXml.indexOf('on second.test</title>');
  assert.ok(firstAt > -1 && secondAt > -1, 'both watches appear');
  assert.ok(secondAt < firstAt, 'newest first');

  const own = await (await feed(`/watches/${first.id}/feed.xml`)).text();
  assert.match(own, /first\.test/);
  assert.doesNotMatch(own, /second\.test/);
  assert.ok(second.id);
});
