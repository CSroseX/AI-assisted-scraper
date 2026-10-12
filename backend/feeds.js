// RSS 2.0 feeds of alerts: one per watch, and one global feed across all.
//
// RSS has no delivery step. An RSS alert is published the moment it is stored
// (queueAlerts marks it 'sent'), and a feed is just the latest of those rows
// rendered as XML whenever a reader polls. The change's summary is read at
// render time, so an explanation that lands after the alert still shows up.
//
// Feed readers such as Feedly fetch from their own servers, so in deployment
// the feed is the one URL that must be publicly reachable. It is therefore
// guarded by FEED_TOKEN, passed as ?token=, and is off until one is set.

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');

const router = express.Router();

const MAX_ITEMS = 50;
const MAX_EVIDENCE_PARAGRAPHS = 6;

const CATEGORY_TITLES = {
  price: 'Price change',
  fees: 'Fee change',
  cancellation: 'Cancellation terms changed',
  data_use: 'Data use terms changed',
  cosmetic: 'Wording change',
  layout_change: 'Page redesigned'
};

const ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };

// Page text is scraped and untrusted. Characters XML 1.0 forbids are dropped,
// since a single one would make the whole feed unreadable.
function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[<>&"']/g, (c) => ESCAPES[c]);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function tokensMatch(given, expected) {
  // Hashing first gives equal lengths, which timingSafeEqual requires.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireFeedToken(req, res, next) {
  const expected = process.env.FEED_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'RSS feeds are off. Set FEED_TOKEN in backend/.env to turn them on.' });
  }
  const given = typeof req.query.token === 'string' ? req.query.token : '';
  if (!given || !tokensMatch(given, expected)) {
    return res.status(403).json({ error: 'Invalid feed token' });
  }
  next();
}

function loadItems(watchId = null) {
  return getDb()
    .prepare(
      `SELECT a.id AS alert_id, a.created_at AS alerted_at, w.url,
              c.category, c.summary, c.diff_json
       FROM alerts a
       JOIN changes c ON c.id = a.change_id
       JOIN watches w ON w.id = a.watch_id
       WHERE a.channel = 'rss' AND a.status = 'sent' AND (? IS NULL OR a.watch_id = ?)
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`
    )
    .all(watchId, watchId, MAX_ITEMS);
}

// The item body is HTML, which the XML then escapes as text. Every
// page-derived string is HTML-escaped first, so a scraped "<script>" arrives
// in the reader as visible text, never as markup.
function itemDescription(row) {
  const diff = JSON.parse(row.diff_json);
  const parts = [
    `<p>${escapeXml(row.summary || 'This page changed. No verified summary is available yet; the changed text is below.')}</p>`
  ];
  for (const para of diff.slice(0, MAX_EVIDENCE_PARAGRAPHS)) {
    const label = para.type === 'removed' ? 'Removed' : 'Added';
    parts.push(`<p><strong>${label}:</strong> ${escapeXml(para.text)}</p>`);
  }
  if (diff.length > MAX_EVIDENCE_PARAGRAPHS) {
    parts.push(`<p>…and ${diff.length - MAX_EVIDENCE_PARAGRAPHS} more changed paragraphs.</p>`);
  }
  parts.push(`<p><a href="${escapeXml(row.url)}">Open the page</a></p>`);
  return parts.join('');
}

function renderItem(row) {
  const title = `${CATEGORY_TITLES[row.category] || 'Change detected'} on ${hostOf(row.url)}`;
  return [
    '<item>',
    `<title>${escapeXml(title)}</title>`,
    `<link>${escapeXml(row.url)}</link>`,
    `<guid isPermaLink="false">watchdog-alert-${row.alert_id}</guid>`,
    `<pubDate>${new Date(row.alerted_at).toUTCString()}</pubDate>`,
    `<description>${escapeXml(itemDescription(row))}</description>`,
    '</item>'
  ].join('');
}

function renderFeed({ title, link, description, rows }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${escapeXml(title)}</title>`,
    `<link>${escapeXml(link)}</link>`,
    `<description>${escapeXml(description)}</description>`,
    ...rows.map(renderItem),
    '</channel></rss>'
  ].join('\n');
}

function sendFeed(res, feed) {
  res.type('application/rss+xml; charset=utf-8').send(renderFeed(feed));
}

// Every watched page in one feed.
router.get('/feed.xml', requireFeedToken, (req, res) => {
  sendFeed(res, {
    title: 'Watchdog: all watched pages',
    link: `${req.protocol}://${req.get('host')}/feed.xml`,
    description: 'Meaningful changes detected on every page you watch.',
    rows: loadItems()
  });
});

// One watched page. The token is checked before the watch lookup, so a caller
// without it cannot probe which watch ids exist.
router.get('/watches/:id/feed.xml', requireFeedToken, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid watch id' });
  const watch = getDb().prepare('SELECT id, url FROM watches WHERE id = ?').get(id);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });

  sendFeed(res, {
    title: `Watchdog: ${hostOf(watch.url)}`,
    link: watch.url,
    description: `Meaningful changes detected on ${watch.url}`,
    rows: loadItems(watch.id)
  });
});

module.exports = router;
module.exports.escapeXml = escapeXml;
