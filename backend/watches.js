const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const scraper = require('./scraper');
const { computeDiff, hashChanges } = require('./diff');
const { explainChange } = require('./explainer');

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
    updatedAt: row.updated_at,
    nextCheckAt: row.next_check_at,
    lastCheckedAt: row.last_checked_at,
    failureCount: row.failure_count,
    lastError: row.last_error
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
  // Due immediately: the scheduler takes the baseline snapshot on its next tick.
  const result = getDb()
    .prepare('INSERT INTO watches (url, selector, frequency, status, created_at, updated_at, next_check_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(urlCheck.parsedUrl, selector, frequency, 'active', now, now, now);

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

  const now = Date.now();
  if (status === 'active') {
    // Resuming a paused or broken watch clears its backoff so it runs again
    // promptly rather than staying parked at a far-future due time.
    getDb()
      .prepare('UPDATE watches SET status = ?, failure_count = 0, last_error = NULL, next_check_at = ?, updated_at = ? WHERE id = ?')
      .run(status, now, now, watch.id);
  } else {
    getDb().prepare('UPDATE watches SET status = ?, updated_at = ? WHERE id = ?').run(status, now, watch.id);
  }
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
    .prepare(
      `SELECT id, from_snapshot_id, to_snapshot_id, diff_json, created_at,
              category, summary, quotes_json, explained_at, explain_error
       FROM changes WHERE watch_id = ? ORDER BY created_at DESC`
    )
    .all(watch.id);
  res.json(rows.map((r) => ({
    id: r.id,
    fromSnapshotId: r.from_snapshot_id,
    toSnapshotId: r.to_snapshot_id,
    diff: JSON.parse(r.diff_json),
    createdAt: r.created_at,
    // Explanation fields. `summary` is null when the change has not been
    // explained, or when the explanation failed verification.
    category: r.category,
    summary: r.summary,
    quotes: r.quotes_json ? JSON.parse(r.quotes_json) : [],
    explainedAt: r.explained_at,
    explainError: r.explain_error
  })));
});

// Asks the LLM to describe a change that is already stored, and records the
// answer on that change.
//
// Deliberately best-effort: the change is the fact, the explanation is only
// commentary on top of it. A model outage must never undo a detection the diff
// already proved, so every failure is caught and written to `explain_error`
// instead of propagating. The row always survives.
async function explainStoredChange(changeId, changes) {
  if (process.env.EXPLAIN_ENABLED === 'false') return null;

  const db = getDb();
  try {
    const explanation = await explainChange(changes);
    db.prepare(
      `UPDATE changes
       SET category = ?, summary = ?, quotes_json = ?, explained_at = ?, explain_error = NULL
       WHERE id = ?`
    ).run(
      explanation.category,
      explanation.summary,
      JSON.stringify(explanation.quotes || []),
      Date.now(),
      changeId
    );
    return explanation;
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 500);
    console.warn(`[explainer] change ${changeId} could not be explained: ${message}`);
    db.prepare('UPDATE changes SET explain_error = ? WHERE id = ?').run(message, changeId);
    return null;
  }
}

class CheckInProgressError extends Error {
  constructor(watchId) {
    super(`A check for watch ${watchId} is already running`);
    this.name = 'CheckInProgressError';
  }
}

// Two overlapping checks of one watch would both diff against the same old
// snapshot and record the same change twice. In memory on purpose: a restart
// ends every in-flight check, so there is nothing to persist.
const checksInFlight = new Set();

// Runs the snapshot pipeline for one watch: fetch -> hash -> store only on
// change -> diff against the previous snapshot. The scheduler calls this on
// each watch's cadence; exposed here so a check can also be triggered manually.
async function runCheck(watchId) {
  if (checksInFlight.has(watchId)) throw new CheckInProgressError(watchId);
  checksInFlight.add(watchId);
  try {
    return await checkWatchNow(watchId);
  } finally {
    checksInFlight.delete(watchId);
  }
}

async function checkWatchNow(watchId) {
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
        .prepare('INSERT INTO changes (watch_id, from_snapshot_id, to_snapshot_id, diff_json, diff_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(watchId, latest.id, snapshotId, JSON.stringify(diffResult.changes), hashChanges(diffResult.changes), now);
      change = { id: changeResult.lastInsertRowid, changes: diffResult.changes };

      const explanation = await explainStoredChange(change.id, diffResult.changes);
      if (explanation) change.explanation = explanation;
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
    if (err instanceof CheckInProgressError) {
      res.set('Retry-After', '5');
      return res.status(409).json({ error: 'This page is already being checked, please retry shortly.' });
    }
    console.error('[watches/check] error:', err.message);
    res.status(502).json({ error: 'Could not check the watched page.' });
  }
});

module.exports = router;
module.exports.runCheck = runCheck;
module.exports.CheckInProgressError = CheckInProgressError;
module.exports.hashContent = hashContent;
