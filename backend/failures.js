// Why a page couldn't be read, in plain words.
//
// Many terms and pricing pages sit behind logins or bot protection. A check
// that fails says which, instead of a raw browser error. And a page that
// loaded but isn't the real page (a bot check, a login wall, an error page,
// nothing at all) is a failure too: stored as a snapshot, it would turn into
// a false "change" when the real page came back.

const FAILURE_MESSAGES = {
  login_required: 'This page needs a login, so it can\'t be read.',
  access_denied: 'The site refused access (HTTP 403). It may need a login, or it may block automated visitors.',
  bot_protection: 'The site showed a bot check (a challenge or captcha page) instead of the page.',
  not_found: 'The site says this page doesn\'t exist (HTTP 404). Check the address; some sites also send this to automated visitors.',
  http_error: 'The site answered with an error instead of the page.',
  timeout: 'The page took too long to load.',
  // The guard proxy fails the same way for a refused address and for a public
  // host it couldn't connect to, so the message can't claim to know which.
  blocked_address: 'The site couldn\'t be reached, or its address was refused because it (or a page it redirects to) is private or internal.',
  unreachable: 'The site closed or refused the connection. Some sites do this to automated visitors.',
  no_text: 'The page loaded but had no readable text.',
  unknown: 'Something went wrong while reading the page.'
};

// A page that loaded but must not be stored. `message` keeps the technical
// detail for logs and last_error; `reason` picks the plain message.
class PageUnreadableError extends Error {
  constructor(reason, detail) {
    super(detail);
    this.name = 'PageUnreadableError';
    this.reason = reason;
  }
}

// Phrases bot checks show (Cloudflare, Akamai, Imperva, PerimeterX, and the
// generic ones). Only trusted on a short whole page: a long terms page, or a
// part of one picked by a selector, may mention "captcha" in passing.
const CHALLENGE_PHRASES = [
  'just a moment...',
  'checking your browser',
  'verify you are human',
  'verifying you are human',
  'are you a robot',
  'unusual traffic from your computer',
  'enable javascript and cookies to continue',
  'attention required! | cloudflare',
  'ray id:',
  'rayid:',
  'captcha',
  'pardon our interruption',
  'request unsuccessful. incapsula',
  'press & hold',
  'access denied'
];
// Error and challenge pages are short. A long page is real content, whatever
// its HTTP status says.
const SHORT_PAGE_CHARS = 3000;
// Without a selector, a real terms or pricing page has far more text than this.
const MIN_PAGE_CHARS = 50;

// Decides whether a loaded page is the real page. Returns { reason, detail }
// when it isn't, or null when it can be stored. `selectorMatched` means the
// text came from the watch's selector rather than the whole page.
function classifyPage({ status = null, title = '', text = '', hasPasswordField = false, hasChallengeElement = false, selectorMatched = false }) {
  const body = String(text || '').trim();
  const short = body.length < SHORT_PAGE_CHARS;
  const withStatus = status ? `, HTTP ${status}` : '';

  if (short && !selectorMatched) {
    const haystack = `${title}\n${body}`.toLowerCase();
    const phrase = CHALLENGE_PHRASES.find((p) => haystack.includes(p));
    if (phrase) return { reason: 'bot_protection', detail: `Bot check page (matched "${phrase}")${withStatus}` };
    if (hasChallengeElement) return { reason: 'bot_protection', detail: `Bot check page (challenge element)${withStatus}` };
  }
  if (short && hasPasswordField) return { reason: 'login_required', detail: `A login form is the main content${withStatus}` };
  if (short && status >= 400) {
    if (status === 401 || status === 407) return { reason: 'login_required', detail: `HTTP ${status}` };
    // A bare 403 doesn't say why: Amazon, for one, sends it with a "page not
    // found" page to visitors it takes for bots.
    if (status === 403) return { reason: 'access_denied', detail: 'HTTP 403' };
    if (status === 404 || status === 410) return { reason: 'not_found', detail: `HTTP ${status}` };
    return { reason: 'http_error', detail: `HTTP ${status}` };
  }
  if (!body) return { reason: 'no_text', detail: 'No text on the page' };
  if (!selectorMatched && body.length < MIN_PAGE_CHARS) return { reason: 'no_text', detail: `Only ${body.length} characters of text` };
  return null;
}

// Maps any error from a check to a reason.
function classifyError(err) {
  if (err && err.reason && FAILURE_MESSAGES[err.reason]) return err.reason;
  const message = String((err && err.message) || err || '');
  if ((err && err.name === 'TimeoutError') || /Timeout \d+ms exceeded|ERR_TIMED_OUT/.test(message)) return 'timeout';
  // The guard proxy answers a refused or unreachable host with a 403 to the
  // tunnel request (HTTPS), or by dropping the socket (plain HTTP).
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE/.test(message)) return 'blocked_address';
  if (/ERR_CONNECTION_(CLOSED|RESET|REFUSED)|ERR_ADDRESS_UNREACHABLE|ERR_HTTP2_PROTOCOL_ERROR|ERR_SSL_|ERR_CERT_/.test(message)) return 'unreachable';
  return 'unknown';
}

const failureMessage = (reason) => (reason ? FAILURE_MESSAGES[reason] || FAILURE_MESSAGES.unknown : null);

// The HTTP answer for a failed manual check: 502 when the page is at fault,
// 500 when we are (no browser installed, or an unexpected error).
function failureResponse(err) {
  if (String((err && err.message) || '').includes('Executable doesn\'t exist')) {
    return {
      status: 500,
      body: {
        error: 'Playwright browser binaries are not installed.',
        fix: 'Run `npx playwright install chromium` inside the backend folder.',
        reason: 'unknown'
      }
    };
  }
  const reason = classifyError(err);
  return { status: reason === 'unknown' ? 500 : 502, body: { error: FAILURE_MESSAGES[reason], reason } };
}

module.exports = { FAILURE_MESSAGES, PageUnreadableError, classifyPage, classifyError, failureMessage, failureResponse };
