const test = require('node:test');
const assert = require('node:assert/strict');
const { ROBOTS_CACHE_MS, parseRobots, isAllowed, checkRobots } = require('./robots');
const { classifyError, failureMessage } = require('./failures');

const allowed = (text, path) => isAllowed(parseRobots(text), path);

test('only the rules for every agent apply', () => {
  const text = [
    'User-agent: Googlebot',
    'Disallow: /private',
    '',
    'User-agent: *',
    'Disallow: /checkout',
    'Sitemap: https://example.test/sitemap.xml'
  ].join('\n');
  assert.equal(allowed(text, '/private/page'), true);
  assert.equal(allowed(text, '/checkout/step1'), false);
  assert.equal(allowed(text, '/terms'), true);
});

test('agent names are case-insensitive, and a group can name several agents', () => {
  const text = 'USER-AGENT: SomeBot\nuser-agent: *\nDISALLOW: /terms';
  assert.equal(allowed(text, '/terms'), false);
});

test('groups for every agent are merged', () => {
  const text = 'User-agent: *\nDisallow: /a\n\nUser-agent: Bot\nDisallow: /\n\nUser-agent: *\nDisallow: /b';
  assert.equal(allowed(text, '/a'), false);
  assert.equal(allowed(text, '/b'), false);
  assert.equal(allowed(text, '/c'), true);
});

test('the longest match wins, and Allow wins a tie', () => {
  const text = 'User-agent: *\nDisallow: /legal\nAllow: /legal/terms\nDisallow: /tie\nAllow: /tie';
  assert.equal(allowed(text, '/legal/privacy'), false);
  assert.equal(allowed(text, '/legal/terms'), true);
  assert.equal(allowed(text, '/tie'), true);
});

test('* matches any characters and $ anchors the end', () => {
  const text = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=';
  assert.equal(allowed(text, '/files/terms.pdf'), false);
  assert.equal(allowed(text, '/files/terms.pdf.html'), true);
  assert.equal(allowed(text, '/search?q=price'), false);
  // Regex characters in a pattern are literal.
  assert.equal(allowed('User-agent: *\nDisallow: /a.b', '/axb'), true);
});

test('comments, empty Disallow and other lines are ignored', () => {
  const text = '# no rules\nUser-agent: * # everyone\nDisallow:\nCrawl-delay: 10\nnonsense';
  assert.equal(allowed(text, '/anything'), true);
  assert.equal(allowed('', '/anything'), true);
});

test('robots.txt itself is always allowed', () => {
  assert.equal(allowed('User-agent: *\nDisallow: /', '/robots.txt'), true);
});

const reasonOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return classifyError(err);
  }
};

test('checkRobots refuses a disallowed page and allows the rest', async () => {
  const cache = new Map();
  const fetchRobots = async () => ({ status: 200, text: 'User-agent: *\nDisallow: /account' });
  assert.equal(await reasonOf(checkRobots('https://site.test/account/billing', { fetchRobots, cache })), 'robots_disallowed');
  assert.equal(await reasonOf(checkRobots('https://site.test/terms', { fetchRobots, cache })), null);
  assert.match(failureMessage('robots_disallowed'), /robots\.txt/);
});

test('the query string counts toward the match', async () => {
  const fetchRobots = async () => ({ status: 200, text: 'User-agent: *\nDisallow: /*?print' });
  assert.equal(await reasonOf(checkRobots('https://q.test/terms?print=1', { fetchRobots, cache: new Map() })), 'robots_disallowed');
});

test('a missing robots.txt allows everything, and a failing one refuses', async () => {
  for (const status of [404, 403, 410]) {
    const fetchRobots = async () => ({ status, text: 'User-agent: *\nDisallow: /' });
    assert.equal(await reasonOf(checkRobots('https://missing.test/terms', { fetchRobots, cache: new Map() })), null, `HTTP ${status}`);
  }
  for (const fetchRobots of [
    async () => ({ status: 503, text: '' }),
    async () => null,
    async () => { throw new Error('net::ERR_CONNECTION_RESET'); }
  ]) {
    assert.equal(await reasonOf(checkRobots('https://down.test/terms', { fetchRobots, cache: new Map() })), 'robots_unavailable');
  }
  assert.match(failureMessage('robots_unavailable'), /robots\.txt/);
});

test('robots.txt is cached per origin for a day; failures are asked again', async () => {
  const cache = new Map();
  let calls = 0;
  const fetchRobots = async () => {
    calls++;
    return { status: 200, text: 'User-agent: *\nDisallow: /private' };
  };
  const now = 1_000_000;
  await checkRobots('https://cache.test/a', { fetchRobots, cache, now });
  await checkRobots('https://cache.test/b', { fetchRobots, cache, now: now + ROBOTS_CACHE_MS - 1 });
  assert.equal(calls, 1);
  // Another origin, even on the same host, has its own robots.txt.
  await checkRobots('http://cache.test/a', { fetchRobots, cache, now });
  assert.equal(calls, 2);
  await checkRobots('https://cache.test/a', { fetchRobots, cache, now: now + ROBOTS_CACHE_MS });
  assert.equal(calls, 3);

  let failing = 0;
  const down = async () => {
    failing++;
    return { status: 500, text: '' };
  };
  await reasonOf(checkRobots('https://flaky.test/a', { fetchRobots: down, cache, now }));
  await reasonOf(checkRobots('https://flaky.test/a', { fetchRobots: down, cache, now }));
  assert.equal(failing, 2);
});
