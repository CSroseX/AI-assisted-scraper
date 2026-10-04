// Recurring checks for active watches.
//
// Scheduling state lives in SQLite (`next_check_at`, `failure_count`), never in
// memory, so a restart cannot lose it and a watch whose due time passed during
// downtime runs on the first tick back. The interval below is only a heartbeat
// that asks the database what is due; it holds no state of its own.

const { getDb } = require('./db');
const scraper = require('./scraper');
const watches = require('./watches');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const num = (name, fallback) => Number(process.env[name] || fallback);

const TICK_MS = num('SCHEDULER_TICK_MS', 60000);
const BATCH_SIZE = num('SCHEDULER_BATCH_SIZE', 5);
const JITTER_RATIO = num('SCHEDULER_JITTER_RATIO', 0.1);
const MAX_FAILURES = num('SCHEDULER_MAX_FAILURES', 5);
const BACKOFF_BASE_MS = num('SCHEDULER_BACKOFF_BASE_MS', 5 * 60 * 1000);
const BACKOFF_MAX_MS = num('SCHEDULER_BACKOFF_MAX_MS', 6 * HOUR_MS);

const INTERVALS = { daily: DAY_MS, weekly: 7 * DAY_MS };

function intervalForFrequency(frequency) {
  return INTERVALS[frequency] || DAY_MS;
}

// Spreads runs by +/- JITTER_RATIO so watches created together do not all fire
// in the same tick forever. `rand` is injectable to keep tests deterministic.
function applyJitter(intervalMs, rand = Math.random) {
  const spread = intervalMs * JITTER_RATIO;
  const offset = (rand() * 2 - 1) * spread;
  return Math.max(1, Math.round(intervalMs + offset));
}

// Exponential backoff on consecutive failures, capped so a permanently broken
// page is still retried occasionally rather than never.
function backoffDelay(failureCount) {
  const exponent = Math.max(0, failureCount - 1);
  const raw = BACKOFF_BASE_MS * Math.pow(2, Math.min(exponent, 20));
  return Math.min(raw, BACKOFF_MAX_MS);
}

// The single decision point: given a watch and how its check went, when next?
function nextCheckAt(watch, outcome, now, rand = Math.random) {
  if (outcome === 'success') {
    return now + applyJitter(intervalForFrequency(watch.frequency), rand);
  }
  return now + backoffDelay(watch.failure_count || 0);
}

function claimDueWatches(now, limit = BATCH_SIZE) {
  return getDb()
    .prepare(
      `SELECT * FROM watches
       WHERE status = 'active' AND next_check_at IS NOT NULL AND next_check_at <= ?
       ORDER BY next_check_at ASC
       LIMIT ?`
    )
    .all(now, limit);
}

function recordSuccess(watch, now, rand = Math.random) {
  const due = nextCheckAt({ ...watch, failure_count: 0 }, 'success', now, rand);
  getDb()
    .prepare(
      `UPDATE watches
       SET failure_count = 0, last_error = NULL, last_checked_at = ?, next_check_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(now, due, now, watch.id);
  return due;
}

function recordFailure(watch, error, now) {
  const failureCount = (watch.failure_count || 0) + 1;
  const broken = failureCount >= MAX_FAILURES;
  const due = nextCheckAt({ ...watch, failure_count: failureCount }, 'failure', now);
  getDb()
    .prepare(
      `UPDATE watches
       SET failure_count = ?, last_error = ?, last_checked_at = ?, next_check_at = ?, status = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(failureCount, String(error && error.message ? error.message : error).slice(0, 500), now, due, broken ? 'broken' : watch.status, now, watch.id);
  return { failureCount, broken, due };
}

// One scheduling pass. `runCheck` and `busy` are injected so tests can run the
// whole loop without launching a browser.
async function tick({ now = Date.now(), runCheck = watches.runCheck, busy = scraper.scraperBusy, rand = Math.random } = {}) {
  const result = { checked: 0, changed: 0, failed: 0, skipped: 0, broken: 0 };

  if (busy()) {
    result.skipped = 1;
    return result;
  }

  for (const watch of claimDueWatches(now)) {
    // Re-check between watches: a manual /check may have taken the last slot.
    if (busy()) {
      result.skipped++;
      break;
    }

    try {
      const outcome = await runCheck(watch.id);
      recordSuccess(watch, now, rand);
      result.checked++;
      if (outcome && outcome.change) result.changed++;
    } catch (err) {
      const { broken } = recordFailure(watch, err, now);
      result.failed++;
      if (broken) {
        result.broken++;
        console.warn(`[scheduler] watch ${watch.id} marked broken after repeated failures: ${err.message}`);
      }
    }
  }

  return result;
}

let timer = null;
let running = false;

// Guards against overlapping ticks if one pass outlives the interval.
async function safeTick() {
  if (running) return;
  running = true;
  try {
    await tick();
  } catch (err) {
    console.error('[scheduler] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return timer;
  timer = setInterval(safeTick, TICK_MS);
  timer.unref();
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function status(now = Date.now()) {
  const db = getDb();
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM watches GROUP BY status').all();
  const due = db
    .prepare("SELECT COUNT(*) AS n FROM watches WHERE status = 'active' AND next_check_at <= ?")
    .get(now);
  const upcoming = db
    .prepare(
      `SELECT id, url, frequency, next_check_at, last_checked_at, failure_count, last_error
       FROM watches WHERE status = 'active' ORDER BY next_check_at ASC LIMIT 10`
    )
    .all();

  return {
    enabled: Boolean(timer),
    tickMs: TICK_MS,
    byStatus: counts.reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {}),
    dueNow: due.n,
    upcoming: upcoming.map((w) => ({
      id: w.id,
      url: w.url,
      frequency: w.frequency,
      nextCheckAt: w.next_check_at,
      lastCheckedAt: w.last_checked_at,
      failureCount: w.failure_count,
      lastError: w.last_error
    }))
  };
}

module.exports = {
  start,
  stop,
  tick,
  status,
  claimDueWatches,
  recordSuccess,
  recordFailure,
  intervalForFrequency,
  applyJitter,
  backoffDelay,
  nextCheckAt,
  MAX_FAILURES,
  TICK_MS
};
