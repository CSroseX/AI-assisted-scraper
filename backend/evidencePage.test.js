const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB (and so its own evidence folder).
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-evpage-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.GROQ_API_KEY = 'test-key';
process.env.RATE_LIMIT_MAX = '10000';
process.env.EXPLAIN_ENABLED = 'false';

const TOKEN = 'evidence-token-abcdef0123456789';
process.env.LINK_TOKEN = TOKEN;

const scraper = require('./scraper');
const { app } = require('./index');
const { getDb, closeDb } = require('./db');
const { evidenceFile } = require('./evidence');

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
const open = (route, token = TOKEN) => fetch(`${base}${route}?token=${encodeURIComponent(token)}`);

// A screenshot file as the real scraper would leave it.
function transientScreenshot(t, body) {
  const name = `${crypto.randomUUID()}.png`;
  fs.mkdirSync(scraper.SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(scraper.SCREENSHOT_DIR, name), body);
  t.after(() => fs.rmSync(path.join(scraper.SCREENSHOT_DIR, name), { force: true }));
  return `screenshots/${name}`;
}

// Creates a watch, takes its baseline, then changes the page once.
async function changeOn(t, url, { before, after, beforeShot = null, afterShot = null }) {
  t.mock.method(scraper, 'validateScrapeUrl', async (u) => ({ ok: true, parsedUrl: u }));
  const watch = await (await post('/watches', { url, frequency: 'daily' })).json();
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: before, screenshotPath: beforeShot }));
  await post(`/watches/${watch.id}/check`);
  t.mock.method(scraper, 'captureSnapshot', async () => ({ content: after, screenshotPath: afterShot }));
  const { change } = await (await post(`/watches/${watch.id}/check`)).json();
  return change.id;
}

test('the evidence page needs the link token', async (t) => {
  const id = await changeOn(t, 'https://locked.test', { before: 'A.', after: 'B.' });
  assert.equal((await fetch(`${base}/evidence/changes/${id}`)).status, 403);
  assert.equal((await open(`/evidence/changes/${id}`, 'nope')).status, 403);

  delete process.env.LINK_TOKEN;
  t.after(() => { process.env.LINK_TOKEN = TOKEN; });
  assert.equal((await open(`/evidence/changes/${id}`)).status, 503);
});

test('unknown or malformed change ids are 404 and 400', async () => {
  assert.equal((await open('/evidence/changes/999999')).status, 404);
  assert.equal((await open('/evidence/changes/abc')).status, 400);
});

test('the page shows the summary, the exact changed paragraphs and both versions', async (t) => {
  const id = await changeOn(t, 'https://shop.test/pricing', {
    before: 'Plans.\n\nPrice: $10/month.',
    after: 'Plans.\n\nPrice: $12/month.',
    beforeShot: transientScreenshot(t, 'before-png'),
    afterShot: transientScreenshot(t, 'after-png')
  });
  getDb().prepare("UPDATE changes SET category = 'price', summary = 'The monthly price rose from $10 to $12.' WHERE id = ?").run(id);

  const res = await open(`/evidence/changes/${id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();

  assert.match(html, /<title>Price change on shop\.test<\/title>/);
  assert.match(html, /The monthly price rose from \$10 to \$12\./);
  assert.match(html, /class="para removed"><span class="tag">Removed<\/span>Price: \$10\/month\./);
  assert.match(html, /class="para added"><span class="tag">Added<\/span>Price: \$12\/month\./);
  // Full text of both versions, for anyone who wants all of it.
  assert.match(html, /<pre>Plans\.\n\nPrice: \$10\/month\.<\/pre>/);
  assert.match(html, /<pre>Plans\.\n\nPrice: \$12\/month\.<\/pre>/);

  // Both screenshots load through the guarded file route.
  const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.equal(srcs.length, 2);
  const bodies = [];
  for (const src of srcs) {
    const url = new URL(src, `${base}/evidence/changes/${id}`);
    const img = await fetch(url);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /image\/png/);
    bodies.push(await img.text());
  }
  assert.deepEqual(bodies, ['before-png', 'after-png']);
});

test('the page is locked down: no scripts, no referrer, scraped markup shown as text', async (t) => {
  const id = await changeOn(t, 'https://hostile.test', {
    before: 'Terms.',
    after: 'Terms.\n\n<script>alert(1)</script><img src=x onerror=alert(2)>'
  });
  const res = await open(`/evidence/changes/${id}`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/, 'no script source is allowed at all');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const html = await res.text();
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test('missing screenshots and missing summaries are stated plainly', async (t) => {
  const id = await changeOn(t, 'https://plain.test', { before: 'One.', after: 'Two.' });
  const html = await (await open(`/evidence/changes/${id}`)).text();
  assert.equal((html.match(/No screenshot was captured for this version\./g) || []).length, 2);
  assert.match(html, /No verified summary is available yet/);
  assert.match(html, /<title>Change detected on plain\.test<\/title>/);
});

test('the file route serves only stored evidence', async (t) => {
  const shot = transientScreenshot(t, 'png');
  await changeOn(t, 'https://files.test', { before: 'x.', after: 'y.', afterShot: shot });
  const name = path.basename(shot);
  assert.ok(fs.existsSync(evidenceFile(`evidence/${name}`)));

  assert.equal((await fetch(`${base}/evidence/files/${name}`)).status, 403, 'token required');
  assert.equal((await open(`/evidence/files/${name}`)).status, 200);
  assert.equal((await open(`/evidence/files/${crypto.randomUUID()}.png`)).status, 404);
  for (const bad of ['..%2Ftest.db', '..%2F..%2Fpackage.json', 'test.db', `${name}.txt`]) {
    assert.equal((await open(`/evidence/files/${bad}`)).status, 404, bad);
  }
});
