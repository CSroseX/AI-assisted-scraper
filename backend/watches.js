const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const scraper = require('./scraper');
const { computeDiff } = require('./diff');

const router = express.Router();

const MAX_URL_LENGTH = 2048;
const MAX_SELECTOR_LENGTH = 500;
const FREQUENCIES = ['daily', 'weekly'];
const STATUSES = ['active', 'paused', 'broken'];

function isNonEmptyString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function serializeWatch(row) {
  return {
    id: row.id,
    url: row.url,
    selector: row.selector,
    frequency: row.frequency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getWatchOr404(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid watch id' });
    return null;
  }
  const watch = getDb().prepare('SELECT * FROM watches WHERE id = ?').get(id);
  if (!watch) {
    res.status(404).json({ error: 'Watch not found' });
    return null;
  }
  return watch;
}

// Create a watch.
router.post('/', async (req, res) => {
  const { url, selector = null, frequency } = req.body || {};

  if (!isNonEmptyString(url, MAX_URL_LENGTH)) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (selector != null && (typeof selector !== 'string' || selector.length > MAX_SELECTOR_LENGTH)) {
    return res.status(400).json({ error: `selector must be a string of at most ${MAX_SELECTOR_LENGTH} characters` });
  }
  if (!FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ error: `frequency must be one of: ${FREQUENCIES.join(', ')}` });
  }

  const urlCheck = await scraper.validateScrapeUrl(url);
  if (!urlCheck.ok) {
    return res.status(400).json({ error: urlCheck.reason });
  }

  const now = Date.now();
  const result = getDb()
    .prepare('INSERT INTO watches (url, selector, frequency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(urlCheck.parsedUrl, selector, frequency, 'active', now, now);

  const watch = getDb().prepare('SELECT * FROM watches WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(serializeWatch(watch));
});

// List watches.
router.get('/', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM watches ORDER BY created_at DESC').all();
  res.json(rows.map(serializeWatch));
});

// Get one watch.
router.get('/:id', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  res.json(serializeWatch(watch));
});

// Pause or resume a watch.
router.patch('/:id', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;

  const { status } = req.body || {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  getDb().prepare('UPDATE watches SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), watch.id);
  const updated = getDb().prepare('SELECT * FROM watches WHERE id = ?').get(watch.id);
  res.json(serializeWatch(updated));
});

// Delete a watch (and its snapshots/changes via ON DELETE CASCADE).
router.delete('/:id', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
  res.status(204).end();
});

// List a watch's snapshots (newest first).
router.get('/:id/snapshots', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const rows = getDb()
    .prepare('SELECT id, content_hash, screenshot_path, created_at FROM snapshots WHERE watch_id = ? ORDER BY created_at DESC')
    .all(watch.id);
  res.json(rows.map((r) => ({
    id: r.id,
    contentHash: r.content_hash,
    screenshotPath: r.screenshot_path,
    createdAt: r.created_at
  })));
});

// List a watch's detected changes (newest first).
router.get('/:id/changes', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const rows = getDb()
    .prepare('SELECT id, from_snapshot_id, to_snapshot_id, diff_json, created_at FROM changes WHERE watch_id = ? ORDER BY created_at DESC')
    .all(watch.id);
  res.json(rows.map((r) => ({
    id: r.id,
    fromSnapshotId: r.from_snapshot_id,
    toSnapshotId: r.to_snapshot_id,
    diff: JSON.parse(r.diff_json),
    createdAt: r.created_at
  })));
});

// Runs the snapshot pipeline for one watch: fetch -> hash -> store only on
// change -> diff against the previous snapshot. This is what the scheduler
// (not yet built) will call on each watch's cadence; exposed here so a check
// can also be triggered manually.
async function runCheck(watchId) {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId);
  if (!watch) throw new Error('Watch not found');

  const latest = db
    .prepare('SELECT * FROM snapshots WHERE watch_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(watchId);

  const captured = await scraper.captureSnapshot(watch.url, { includeScreenshot: true, selector: watch.selector });
  const contentHash = hashContent(captured.content);

  if (latest && latest.content_hash === contentHash) {
    return { changed: false, snapshot: null, change: null };
  }

  const now = Date.now();
  const insertResult = db
    .prepare('INSERT INTO snapshots (watch_id, content, content_hash, screenshot_path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(watchId, captured.content, contentHash, captured.screenshotPath, now);
  const snapshotId = insertResult.lastInsertRowid;

  let change = null;
  if (latest) {
    const diffResult = computeDiff(latest.content, captured.content);
    if (diffResult.hasMeaningfulChange) {
      const changeResult = db
        .prepare('INSERT INTO changes (watch_id, from_snapshot_id, to_snapshot_id, diff_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(watchId, latest.id, snapshotId, JSON.stringify(diffResult.changes), now);
      change = { id: changeResult.lastInsertRowid, changes: diffResult.changes };
    }
  }

  return { changed: true, snapshot: { id: snapshotId, contentHash }, change };
}

// Manually trigger a check for one watch outside its schedule.
router.post('/:id/check', async (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;

  if (scraper.scraperBusy()) {
    res.set('Retry-After', '5');
    return res.status(503).json({ error: 'Scraper is busy, please retry shortly.' });
  }

  try {
    const result = await runCheck(watch.id);
    res.json(result);
  } catch (err) {
    console.error('[watches/check] error:', err.message);
    res.status(502).json({ error: 'Could not check the watched page.' });
  }
});

module.exports = router;
module.exports.runCheck = runCheck;
module.exports.hashContent = hashContent;
