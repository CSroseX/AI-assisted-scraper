// robots.txt, read the way RFC 9309 says.
//
// A site's robots.txt says which paths automated visitors may read. A check
// reads it before the page and refuses a disallowed page with a plain reason,
// unless the watch records a deliberate exception. The scraper doesn't send a
// bot name of its own, so only the rules for every agent (`User-agent: *`)
// apply to it.

const { PageUnreadableError } = require('./failures');

// How long a robots.txt that was read is trusted; the RFC asks for at most a day.
const ROBOTS_CACHE_MS = 24 * 60 * 60 * 1000;
// The RFC asks parsers to read at least 500 KiB and allows them to stop there.
const MAX_ROBOTS_CHARS = 500 * 1024;

const ALLOW_ALL = { rules: [] };
const DISALLOW_ALL = { rules: [{ allow: false, pattern: '/' }] };

// Returns { rules } for the `*` agent: each rule is { allow, pattern }. Groups
// that name `*` are merged, as the RFC asks.
function parseRobots(text) {
  const rules = [];
  let agents = [];
  let inRules = false;
  for (const rawLine of String(text || '').slice(0, MAX_ROBOTS_CHARS).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      // A user-agent line after rules starts a new group.
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      // An empty Disallow allows everything, which is the same as no rule.
      if (value && agents.includes('*')) rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  return { rules };
}

// `*` matches any run of characters and a trailing `$` anchors the end.
function patternMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

// The longest matching pattern wins, and on a tie Allow wins.
function isAllowed(robots, path) {
  if (path === '/robots.txt') return true;
  let best = null;
  for (const rule of robots.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return !best || best.allow;
}

// What a robots.txt answer means: a file read is parsed, a 4xx means there are
// no rules, and a 5xx means stay away (RFC 9309 2.3.1).
function robotsFromResponse(response) {
  const status = response && response.status;
  if (status >= 200 && status < 300) return { robots: parseRobots(response.text), cache: true };
  if (status >= 400 && status < 500) return { robots: ALLOW_ALL, cache: true };
  return { robots: DISALLOW_ALL, cache: false, unavailable: `robots.txt answered HTTP ${status || 'nothing'}` };
}

const robotsCache = new Map();

// Throws PageUnreadableError when robots.txt asks visitors not to read `url`.
// `fetchRobots(robotsUrl)` resolves { status, text } and goes through the
// guarded browser, like the page itself. Only answers that were read are
// cached, so a robots.txt that failed is asked for again next time.
async function checkRobots(url, { fetchRobots, now = Date.now(), cache = robotsCache }) {
  const target = new URL(url);
  const robotsUrl = `${target.origin}/robots.txt`;
  let entry = cache.get(target.origin);
  if (!entry || entry.expiresAt <= now) {
    // A fetch that fails outright (a blocked address, a timeout, a refused
    // connection) is thrown as it is: the page would fail the same way, and
    // its own reason says more than "robots.txt couldn't be read".
    const verdict = robotsFromResponse(await fetchRobots(robotsUrl));
    entry = { robots: verdict.robots, unavailable: verdict.unavailable, expiresAt: now + ROBOTS_CACHE_MS };
    if (verdict.cache) cache.set(target.origin, entry);
    else cache.delete(target.origin);
  }

  if (entry.unavailable) throw new PageUnreadableError('robots_unavailable', entry.unavailable);
  if (!isAllowed(entry.robots, target.pathname + target.search)) {
    throw new PageUnreadableError('robots_disallowed', `robots.txt disallows ${target.pathname}${target.search}`);
  }
}

module.exports = { ROBOTS_CACHE_MS, parseRobots, isAllowed, checkRobots };
