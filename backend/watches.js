const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { getDb } = require('./db');
const scraper = require('./scraper');
const { computeDiff, hashChanges } = require('./diff');
const { explainChange } = require('./explainer');
const { enabledChannels, parseChannels, queueAlerts, serializeAlert } = require('./alerts');
const { preserveScreenshot, discardEvidence, evidenceFile } = require('./evidence');
const { failureMessage, failureResponse } = require('./failures');

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
    lastError: row.last_error,
    // Why the last check failed, as a reason code and in plain words.
    lastErrorReason: row.last_error_reason,
    lastErrorMessage: failureMessage(row.last_error_reason),
    alertChannels: enabledChannels(row),
    ignoreRobots: row.ignore_robots === 1
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
  const { url, selector = null, frequency, alertChannels = ['rss'], ignoreRobots = false } = req.body || {};

  if (!isNonEmptyString(url, MAX_URL_LENGTH)) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (selector != null && (typeof selector !== 'string' || selector.length > MAX_SELECTOR_LENGTH)) {
    return res.status(400).json({ error: `selector must be a string of at most ${MAX_SELECTOR_LENGTH} characters` });
  }
  if (!FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ error: `frequency must be one of: ${FREQUENCIES.join(', ')}` });
  }
  const channels = parseChannels(alertChannels);
  if (channels.error) {
    return res.status(400).json({ error: channels.error });
  }
  if (typeof ignoreRobots !== 'boolean') {
    return res.status(400).json({ error: 'ignoreRobots must be true or false' });
  }

  const urlCheck = await scraper.validateScrapeUrl(url);
  if (!urlCheck.ok) {
    return res.status(400).json({ error: urlCheck.reason });
  }

  const now = Date.now();
  // Due immediately: the scheduler takes the baseline snapshot on its next tick.
  const result = getDb()
    .prepare(
      `INSERT INTO watches (url, selector, frequency, status, created_at, updated_at, next_check_at, alert_email, alert_rss, ignore_robots)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(urlCheck.parsedUrl, selector, frequency, 'active', now, now, now, Number(channels.email), Number(channels.rss), Number(ignoreRobots));

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

// Pause or resume a watch, change its alert channels, and/or set its
// robots.txt exception.
router.patch('/:id', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;

  const { status, alertChannels, ignoreRobots } = req.body || {};
  if (status === undefined && alertChannels === undefined && ignoreRobots === undefined) {
    return res.status(400).json({ error: 'Provide status, alertChannels and/or ignoreRobots' });
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const channels = alertChannels === undefined ? null : parseChannels(alertChannels);
  if (channels && channels.error) {
    return res.status(400).json({ error: channels.error });
  }
  if (ignoreRobots !== undefined && typeof ignoreRobots !== 'boolean') {
    return res.status(400).json({ error: 'ignoreRobots must be true or false' });
  }

  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    if (status === 'active') {
      // Resuming a paused or broken watch clears its backoff so it runs again
      // promptly rather than staying parked at a far-future due time.
      db.prepare('UPDATE watches SET status = ?, failure_count = 0, last_error = NULL, last_error_reason = NULL, next_check_at = ?, updated_at = ? WHERE id = ?')
        .run(status, now, now, watch.id);
    } else if (status !== undefined) {
      db.prepare('UPDATE watches SET status = ?, updated_at = ? WHERE id = ?').run(status, now, watch.id);
    }
    if (channels) {
      db.prepare('UPDATE watches SET alert_email = ?, alert_rss = ?, updated_at = ? WHERE id = ?')
        .run(Number(channels.email), Number(channels.rss), now, watch.id);
    }
    if (ignoreRobots !== undefined) {
      db.prepare('UPDATE watches SET ignore_robots = ?, updated_at = ? WHERE id = ?').run(Number(ignoreRobots), now, watch.id);
    }
  })();
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

// Anything that isn't a positive integer can't name a snapshot, so it is
// simply not found. The file a snapshot points at comes from the database and
// is resolved only through evidenceFile(), never from the request.
function getSnapshotOr404(req, res, watch) {
  const id = /^\d+$/.test(req.params.snapshotId) ? Number(req.params.snapshotId) : 0;
  const snapshot = id > 0
    ? getDb().prepare('SELECT * FROM snapshots WHERE id = ? AND watch_id = ?').get(id, watch.id)
    : null;
  if (!snapshot) {
    res.status(404).json({ error: 'Snapshot not found' });
    return null;
  }
  return snapshot;
}

// One snapshot with its captured text, for the UI's before/after view.
router.get('/:id/snapshots/:snapshotId', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const snapshot = getSnapshotOr404(req, res, watch);
  if (!snapshot) return;
  res.json({
    id: snapshot.id,
    contentHash: snapshot.content_hash,
    screenshotPath: snapshot.screenshot_path,
    createdAt: snapshot.created_at,
    content: snapshot.content
  });
});

// A snapshot's screenshot for the UI. Unlike /evidence/files it needs no
// LINK_TOKEN, which the frontend must never hold. It is guarded like the rest
// of the watches API instead.
router.get('/:id/snapshots/:snapshotId/screenshot', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const snapshot = getSnapshotOr404(req, res, watch);
  if (!snapshot) return;
  const file = evidenceFile(snapshot.screenshot_path);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Screenshot not found' });

  // The frontend shows this in an <img> from another origin, which helmet's
  // same-origin CORP would block. Evidence files never change once written.
  res.set({ 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'private, max-age=86400' });
  res.type('png').sendFile(file);
});

// List a watch's detected changes (newest first).
router.get('/:id/changes', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.from_snapshot_id, c.to_snapshot_id, c.diff_json, c.created_at,
              c.category, c.summary, c.quotes_json, c.explained_at, c.explain_error,
              f.vote AS feedback
       FROM changes c LEFT JOIN feedback f ON f.change_id = c.id
       WHERE c.watch_id = ? ORDER BY c.created_at DESC, c.id DESC`
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
    explainError: r.explain_error,
    // The user's verdict: 'useful', 'noise', or null when not rated.
    feedback: r.feedback
  })));
});

const VOTES = ['useful', 'noise'];

function getChangeOr404(req, res, watch) {
  const id = Number.parseInt(req.params.changeId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid change id' });
    return null;
  }
  const change = getDb().prepare('SELECT id FROM changes WHERE id = ? AND watch_id = ?').get(id, watch.id);
  if (!change) {
    res.status(404).json({ error: 'Change not found' });
    return null;
  }
  return change;
}

// Rate a change as useful or noise. One verdict per change; voting again
// replaces it.
router.put('/:id/changes/:changeId/feedback', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const change = getChangeOr404(req, res, watch);
  if (!change) return;

  const { vote } = req.body || {};
  if (!VOTES.includes(vote)) {
    return res.status(400).json({ error: `vote must be one of: ${VOTES.join(', ')}` });
  }

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO feedback (change_id, vote, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(change_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`
    )
    .run(change.id, vote, now, now);
  res.json({ changeId: change.id, vote });
});

// Clear a change's rating.
router.delete('/:id/changes/:changeId/feedback', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const change = getChangeOr404(req, res, watch);
  if (!change) return;
  getDb().prepare('DELETE FROM feedback WHERE change_id = ?').run(change.id);
  res.status(204).end();
});

// List a watch's alerts (newest first), including suppressed repeats.
router.get('/:id/alerts', (req, res) => {
  const watch = getWatchOr404(req, res);
  if (!watch) return;
  const rows = getDb()
    .prepare('SELECT * FROM alerts WHERE watch_id = ? ORDER BY created_at DESC, id DESC')
    .all(watch.id);
  res.json(rows.map(serializeAlert));
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

  const captured = await scraper.captureSnapshot(watch.url, {
    includeScreenshot: true,
    selector: watch.selector,
    respectRobots: !watch.ignore_robots
  });
  const contentHash = hashContent(captured.content);

  if (latest && latest.content_hash === contentHash) {
    return { changed: false, snapshot: null, change: null };
  }

  const now = Date.now();
  const diffResult = latest ? computeDiff(latest.content, captured.content) : null;

  // Kept before the snapshot row that refers to it is written, and discarded
  // again if that write fails.
  const screenshotPath = preserveScreenshot(captured.screenshotPath, scraper.SCREENSHOT_DIR);

  // Snapshot, change and alerts are written together or not at all. If only
  // the snapshot landed, the next check would see identical content and stop
  // early, so the change and its alerts would be lost for good.
  const writeAll = db.transaction(() => {
    const snapshotId = db
      .prepare('INSERT INTO snapshots (watch_id, content, content_hash, screenshot_path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(watchId, captured.content, contentHash, screenshotPath, now)
      .lastInsertRowid;

    if (!diffResult || !diffResult.hasMeaningfulChange) return { snapshotId, change: null };

    const diffHash = hashChanges(diffResult.changes);
    const changeId = db
      .prepare('INSERT INTO changes (watch_id, from_snapshot_id, to_snapshot_id, diff_json, diff_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(watchId, latest.id, snapshotId, JSON.stringify(diffResult.changes), diffHash, now)
      .lastInsertRowid;

    // Re-read so a channel toggled during the scrape is respected.
    const current = db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId);
    queueAlerts(db, { watch: current, changeId, diffHash, now });

    return { snapshotId, change: { id: changeId, changes: diffResult.changes } };
  });

  let written;
  try {
    written = writeAll();
  } catch (err) {
    discardEvidence(screenshotPath);
    throw err;
  }
  const { snapshotId, change } = written;

  if (change) {
    const explanation = await explainStoredChange(change.id, change.changes);
    if (explanation) change.explanation = explanation;
  }

  return { changed: true, snapshot: { id: snapshotId, contentHash }, change };
}

// A manual check records when it ran and how it ended, like a scheduled one,
// so "last checked" isn't stale. It leaves the schedule alone: failure count,
// backoff and status stay the scheduler's to manage.
function recordManualCheck(watchId, error = null, reason = null) {
  const now = Date.now();
  getDb()
    .prepare('UPDATE watches SET last_checked_at = ?, last_error = ?, last_error_reason = ?, updated_at = ? WHERE id = ?')
    .run(now, error ? String(error.message || error).slice(0, 500) : null, reason, now, watchId);
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
    recordManualCheck(watch.id);
    res.json(result);
  } catch (err) {
    if (err instanceof CheckInProgressError) {
      res.set('Retry-After', '5');
      return res.status(409).json({ error: 'This page is already being checked, please retry shortly.' });
    }
    const { status, body } = failureResponse(err);
    recordManualCheck(watch.id, err, body.reason);
    console.error(`[watches/check] error (${body.reason}):`, err.message);
    res.status(status).json(body);
  }
});

module.exports = router;
module.exports.runCheck = runCheck;
module.exports.CheckInProgressError = CheckInProgressError;
module.exports.hashContent = hashContent;
