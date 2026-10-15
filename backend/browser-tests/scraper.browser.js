// End-to-end checks of the real scraper: real Chromium, the real guard proxy,
// local fixture pages. Needs `npm exec playwright install chromium`, so it is
// not part of `npm test`; run it with `npm run test:browser`.
//
// The guard proxy refuses loopback, so the fixture server can't be reached as
// itself. The test builds its own proxy with createGuardProxy, injecting a DNS
// lookup that gives `fixture.test` a public address and a dialler that sends
// that one address to the fixture server. Every other address the proxy
// approves is refused, so nothing leaves the machine, and blocked targets must
// still be refused by the proxy's own rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { createGuardProxy } = require('../ssrf');
const { createScraper } = require('../scraper');
const { classifyError } = require('../failures');

// A public-looking address for fixture.test. It is never actually dialled.
const FIXTURE_IP = '1.2.3.4';
const HOSTS = {
  'fixture.test': FIXTURE_IP,
  'internal.test': '10.0.0.5'
};

const hits = [];
const dialled = [];
let fixturePort;
let fixtureServer;
let scraper;

function fixture(req, res) {
  hits.push(req.url);
  const html = (body) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`);
  };
  switch (req.url) {
    case '/robots.txt':
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /private\n');
    case '/terms':
      return html(`<main><h1>Terms of service</h1>
        <p>These terms explain what the Example plan costs and how to cancel it.</p>
        <p>Price: $10/month.</p></main>
        <img src="http://127.0.0.1:${fixturePort}/secret-image" alt="">`);
    case '/redirect-loopback':
      res.writeHead(302, { Location: `http://127.0.0.1:${fixturePort}/secret` });
      return res.end();
    case '/redirect-metadata':
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
  }
}

test.before(async () => {
  fixtureServer = http.createServer(fixture);
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  fixturePort = fixtureServer.address().port;

  const guardProxy = createGuardProxy({
    lookup: async (hostname) => {
      const address = HOSTS[hostname];
      if (!address) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dial: (address, port) => {
      dialled.push(`${address}:${port}`);
      if (address === FIXTURE_IP) return net.connect({ host: '127.0.0.1', port: fixturePort });
      const refused = new net.Socket();
      setImmediate(() => refused.destroy(new Error(`test dialler refused ${address}`)));
      return refused;
    }
  });
  scraper = createScraper({ guardProxy });
});

test.after(async () => {
  await scraper.closeScraper();
  fixtureServer.close();
});

const reasonOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return classifyError(err);
  }
  assert.fail('expected the check to fail');
};

test('a public page is scraped through the guard proxy, with a screenshot', async () => {
  const { content, screenshotPath } = await scraper.captureSnapshot('http://fixture.test/terms');
  assert.match(content, /Terms of service/);
  assert.match(content, /Price: \$10\/month\./);

  assert.ok(screenshotPath, 'a screenshot was taken');
  const file = path.join(__dirname, '..', screenshotPath);
  assert.ok(fs.statSync(file).size > 0);
  fs.rmSync(file);

  assert.ok(hits.includes('/robots.txt'), 'robots.txt was read first');
  // The page's <img> pointed at loopback; the proxy refused it.
  assert.ok(!hits.includes('/secret-image'));
});

test('a loopback target is blocked', async () => {
  assert.equal(await reasonOf(scraper.captureSnapshot(`http://127.0.0.1:${fixturePort}/secret`)), 'blocked_address');
  assert.ok(!hits.includes('/secret'));
});

test('a redirect from a public page to loopback is blocked', async () => {
  assert.equal(await reasonOf(scraper.captureSnapshot('http://fixture.test/redirect-loopback')), 'blocked_address');
  assert.ok(hits.includes('/redirect-loopback'), 'the public page was fetched');
  assert.ok(!hits.includes('/secret'), 'its redirect target was not');
});

test('a redirect to the cloud metadata address is blocked', async () => {
  assert.equal(await reasonOf(scraper.captureSnapshot('http://fixture.test/redirect-metadata')), 'blocked_address');
  assert.ok(!dialled.some((d) => d.startsWith('169.254.169.254')));
});

test('a hostname that resolves to a private address is blocked', async () => {
  assert.equal(await reasonOf(scraper.captureSnapshot('http://internal.test/')), 'blocked_address');
  assert.ok(!dialled.some((d) => d.startsWith('10.0.0.5')));
});

test('a page robots.txt disallows is never fetched', async () => {
  assert.equal(await reasonOf(scraper.captureSnapshot('http://fixture.test/private')), 'robots_disallowed');
  assert.ok(!hits.includes('/private'));
});

test('only the fixture address was ever dialled', () => {
  assert.ok(dialled.length > 0);
  assert.deepEqual([...new Set(dialled.map((d) => d.split(':')[0]))], [FIXTURE_IP]);
});
