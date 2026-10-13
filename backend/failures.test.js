const test = require('node:test');
const assert = require('node:assert/strict');
const { FAILURE_MESSAGES, PageUnreadableError, classifyPage, classifyError, failureMessage, failureResponse } = require('./failures');

// A real terms page is long; most fixtures below are not.
const TERMS = 'These Terms of Service govern your use of the service. '.repeat(80);

// One fixture per reason. The Canva, Amazon and YouTube ones are what the
// real-page trial (docs/TRIAL.md) captured on its first day.
const PAGE_FIXTURES = [
  {
    name: 'Cloudflare interstitial',
    page: { status: 403, title: 'Just a moment...', text: 'Checking if the site connection is secure' },
    reason: 'bot_protection'
  },
  {
    name: 'Canva block page (trial)',
    page: {
      status: 403,
      title: 'Canva',
      text: 'We’ll have you designing again soon\nIf you can’t get past this page, visit the Help Centre to see why this is happening.\nRayID: a49fefddeeca7f62'
    },
    reason: 'bot_protection'
  },
  {
    name: 'Akamai access denied',
    page: { status: 403, title: 'Access Denied', text: "You don't have permission to access this server. Reference #18.5c" },
    reason: 'bot_protection'
  },
  {
    name: 'a challenge widget on a 200 page',
    page: { status: 200, title: 'Pricing', text: 'One moment, please.', hasChallengeElement: true },
    reason: 'bot_protection'
  },
  {
    name: 'HTTP 401',
    page: { status: 401, title: 'Unauthorized', text: 'Unauthorized' },
    reason: 'login_required'
  },
  {
    name: 'a login form as the main content',
    page: { status: 200, title: 'Sign in', text: 'Sign in to continue\nEmail\nPassword\nForgot password?', hasPasswordField: true },
    reason: 'login_required'
  },
  {
    name: 'a login form on a 403 page',
    page: { status: 403, title: 'Sign in', text: 'Please sign in\nPassword', hasPasswordField: true },
    reason: 'login_required'
  },
  {
    name: 'a bare 403, as Amazon answers bots with its "page not found" page (trial)',
    page: { status: 403, title: 'Page Not Found', text: '' },
    reason: 'access_denied'
  },
  {
    name: 'HTTP 404',
    page: { status: 404, title: 'Page Not Found', text: 'Sorry, we could not find that page.' },
    reason: 'not_found'
  },
  {
    name: 'HTTP 503 without challenge markers',
    page: { status: 503, title: 'Service Unavailable', text: 'The service is temporarily unavailable. Please try later.' },
    reason: 'http_error'
  },
  {
    name: 'an empty page, as YouTube and Disney+ rendered (trial)',
    page: { status: 200, title: 'YouTube Premium', text: '   \n ' },
    reason: 'no_text'
  },
  {
    name: 'a near-empty page without a selector',
    page: { status: 200, title: 'Plans', text: 'Loading…' },
    reason: 'no_text'
  }
];

for (const { name, page, reason } of PAGE_FIXTURES) {
  test(`classifyPage: ${name} is ${reason}`, () => {
    const failure = classifyPage(page);
    assert.equal(failure && failure.reason, reason);
    assert.ok(failure.detail);
  });
}

test('classifyPage accepts real pages', () => {
  assert.equal(classifyPage({ status: 200, title: 'Terms', text: TERMS }), null);
  // A long terms page may mention a captcha or a login in passing.
  assert.equal(classifyPage({ status: 200, title: 'Terms', text: `${TERMS} We may use a CAPTCHA. Access denied to abusers.`, hasPasswordField: true }), null);
  // A selector picks a small part on purpose, so short text is fine there,
  // even when it mentions a captcha or access being denied.
  assert.equal(classifyPage({ status: 200, title: 'Pricing', text: '$12/month', selectorMatched: true }), null);
  assert.equal(classifyPage({ status: 200, title: 'FAQ', text: 'Access denied errors are refunded. Our captcha is free.', selectorMatched: true }), null);
  // A long page is real content whatever its status says.
  assert.equal(classifyPage({ status: 404, title: 'Terms', text: TERMS }), null);
  assert.equal(classifyPage({ status: 503, title: 'Terms', text: TERMS }), null);
  // No response object (e.g. a same-document navigation) is not a failure by itself.
  assert.equal(classifyPage({ status: null, title: 'Terms', text: TERMS }), null);
});

test('classifyPage still reports an empty selected element', () => {
  assert.equal(classifyPage({ status: 200, title: 'Pricing', text: '', selectorMatched: true }).reason, 'no_text');
});

test('classifyPage treats a selector that matched nothing like no selector', () => {
  // The scraper falls back to <main> or the body, so the short-page rules apply.
  assert.equal(classifyPage({ status: 200, title: 'Plans', text: 'Loading…', selectorMatched: false }).reason, 'no_text');
});

test('failureResponse is 502 when the page is at fault and 500 when we are', () => {
  assert.deepEqual(failureResponse(new PageUnreadableError('bot_protection', 'x')), {
    status: 502,
    body: { error: FAILURE_MESSAGES.bot_protection, reason: 'bot_protection' }
  });
  assert.equal(failureResponse(new Error('SQLITE_IOERR: disk I/O error')).status, 500);
  const missing = failureResponse(new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium"));
  assert.equal(missing.status, 500);
  assert.match(missing.body.fix, /playwright install chromium/);
});

test('classifyError maps browser and guard proxy errors', () => {
  const cases = [
    [new PageUnreadableError('bot_protection', 'Bot check page'), 'bot_protection'],
    [Object.assign(new Error('page.goto: Timeout 20000ms exceeded.'), { name: 'TimeoutError' }), 'timeout'],
    [new Error('page.goto: net::ERR_TIMED_OUT at https://a.test'), 'timeout'],
    [new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://internal.test'), 'blocked_address'],
    [new Error('page.goto: net::ERR_EMPTY_RESPONSE at http://10.0.0.1'), 'blocked_address'],
    // T-Mobile in the trial: the site itself dropped the connection.
    [new Error('page.goto: net::ERR_CONNECTION_CLOSED at https://www.t-mobile.com/cell-phone-plans'), 'unreachable'],
    [new Error('page.goto: net::ERR_CONNECTION_RESET'), 'unreachable'],
    [new Error('page.goto: net::ERR_CERT_DATE_INVALID'), 'unreachable'],
    [new Error('something odd'), 'unknown'],
    ['a thrown string', 'unknown']
  ];
  for (const [err, reason] of cases) assert.equal(classifyError(err), reason, String(err.message || err));
});

test('every reason has a plain message, and unknown codes fall back', () => {
  for (const reason of ['login_required', 'access_denied', 'bot_protection', 'timeout', 'blocked_address', 'no_text', 'not_found', 'http_error', 'unreachable', 'unknown']) {
    assert.equal(failureMessage(reason), FAILURE_MESSAGES[reason]);
  }
  assert.equal(failureMessage('not_a_reason'), FAILURE_MESSAGES.unknown);
  assert.equal(failureMessage(null), null);
});
