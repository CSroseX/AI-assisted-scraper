// Links that leave the app: RSS feeds and evidence pages, opened by feed
// readers and email clients rather than by our frontend. They are guarded by
// one shared secret, LINK_TOKEN, carried as ?token=, and are off until it is set.
// In deployment these are the only URLs that must be publicly reachable.

const crypto = require('crypto');

function publicBaseUrl() {
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
  return base.replace(/\/+$/, '');
}

// Absolute URL for a public path, with the token attached.
function publicUrl(pathname) {
  return `${publicBaseUrl()}${pathname}?token=${encodeURIComponent(process.env.LINK_TOKEN || '')}`;
}

function tokensMatch(given, expected) {
  // Hashing first gives equal lengths, which timingSafeEqual requires.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireLinkToken(req, res, next) {
  const expected = process.env.LINK_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: 'Feeds and evidence pages are off. Set LINK_TOKEN in backend/.env to turn them on.'
    });
  }
  const given = typeof req.query.token === 'string' ? req.query.token : '';
  if (!given || !tokensMatch(given, expected)) {
    return res.status(403).json({ error: 'Invalid link token' });
  }
  next();
}

const ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };

// Escapes text for XML or HTML. Page text is scraped and untrusted; characters
// XML 1.0 forbids are dropped, since one would make a whole feed unreadable.
function escapeMarkup(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[<>&"']/g, (c) => ESCAPES[c]);
}

module.exports = { publicBaseUrl, publicUrl, requireLinkToken, escapeMarkup };
