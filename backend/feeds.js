// RSS 2.0 feeds of alerts: one per watch, and one global feed across all.
//
// RSS has no delivery step. An RSS alert is published the moment it is stored
// (queueAlerts marks it 'sent'), and a feed is just the latest of those rows
// rendered as XML whenever a reader polls. The change's summary is read at
// render time, so an explanation that lands after the alert still shows up.
//
// Feeds are guarded by LINK_TOKEN (see publicLinks.js).

const express = require('express');
const { getDb } = require('./db');
const { publicUrl, requireLinkToken, escapeMarkup } = require('./publicLinks');
const { NO_SUMMARY, hostOf, alertTitle, evidenceUrl } = require('./alertContent');

const router = express.Router();

const MAX_ITEMS = 50;
const MAX_EVIDENCE_PARAGRAPHS = 6;

function loadItems(watchId = null) {
  return getDb()
    .prepare(
      `SELECT a.id AS alert_id, a.created_at AS alerted_at, w.url,
              c.id AS change_id, c.category, c.summary, c.diff_json
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
  const parts = [`<p>${escapeMarkup(row.summary || NO_SUMMARY)}</p>`];
  for (const para of diff.slice(0, MAX_EVIDENCE_PARAGRAPHS)) {
    const label = para.type === 'removed' ? 'Removed' : 'Added';
    parts.push(`<p><strong>${label}:</strong> ${escapeMarkup(para.text)}</p>`);
  }
  if (diff.length > MAX_EVIDENCE_PARAGRAPHS) {
    parts.push(`<p>…and ${diff.length - MAX_EVIDENCE_PARAGRAPHS} more changed paragraphs.</p>`);
  }
  parts.push(
    `<p><a href="${escapeMarkup(evidenceUrl(row.change_id))}">See before and after</a>` +
    ` · <a href="${escapeMarkup(row.url)}">Open the page</a></p>`
  );
  return parts.join('');
}

function renderItem(row) {
  return [
    '<item>',
    `<title>${escapeMarkup(alertTitle(row.category, row.url))}</title>`,
    `<link>${escapeMarkup(evidenceUrl(row.change_id))}</link>`,
    `<guid isPermaLink="false">watchdog-alert-${row.alert_id}</guid>`,
    `<pubDate>${new Date(row.alerted_at).toUTCString()}</pubDate>`,
    `<description>${escapeMarkup(itemDescription(row))}</description>`,
    '</item>'
  ].join('');
}

function renderFeed({ title, link, description, rows }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${escapeMarkup(title)}</title>`,
    `<link>${escapeMarkup(link)}</link>`,
    `<description>${escapeMarkup(description)}</description>`,
    ...rows.map(renderItem),
    '</channel></rss>'
  ].join('\n');
}

function sendFeed(res, feed) {
  res.type('application/rss+xml; charset=utf-8').send(renderFeed(feed));
}

// Every watched page in one feed.
router.get('/feed.xml', requireLinkToken, (_req, res) => {
  sendFeed(res, {
    title: 'Watchdog: all watched pages',
    link: publicUrl('/feed.xml'),
    description: 'Meaningful changes detected on every page you watch.',
    rows: loadItems()
  });
});

// One watched page. The token is checked before the watch lookup, so a caller
// without it cannot probe which watch ids exist.
router.get('/watches/:id/feed.xml', requireLinkToken, (req, res) => {
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
