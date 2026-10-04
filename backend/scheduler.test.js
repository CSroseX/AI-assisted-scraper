const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-sched-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.GROQ_API_KEY = 'test-key';

const scheduler = require('./scheduler');
const { getDb, closeDb } = require('./db');

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;
function makeWatch({ status = 'active', frequency = 'daily', nextCheckAt = 0, failureCount = 0 } = {}) {
  seq++;
  const now = 1000;
  const result = getDb()
    .prepare(
      `INSERT INTO watches (url, selector, frequency, status, created_at, updated_at, next_check_at, failure_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`https://example.com/page-${seq}`, null, frequency, status, now, now, nextCheckAt, failureCount);
  return getDb().prepare('SELECT * FROM watches WHERE id = ?').get(result.lastInsertRowid);
}

function readWatch(id) {
  return getDb().prepare('SELECT * FROM watches WHERE id = ?').get(id);
}

// --- pure functions -------------------------------------------------------

test('intervalForFrequency maps daily and weekly', () => {
  assert.equal(scheduler.intervalForFrequency('daily'), DAY_MS);
  assert.equal(scheduler.intervalForFrequency('weekly'), 7 * DAY_MS);
  assert.equal(scheduler.intervalForFrequency('nonsense'), DAY_MS);
});

test('applyJitter stays within the configured spread', () => {
  // Default ratio is 0.1, so results must land inside +/-10%.
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const jittered = scheduler.applyJitter(DAY_MS, () => r);
    assert.ok(jittered >= DAY_MS * 0.9, `${jittered} below lower bound`);
    assert.ok(jittered <= DAY_MS * 1.1, `${jittered} above upper bound`);
  }
});

test('applyJitter is centred: rand 0.5 returns the interval unchanged', () => {
  assert.equal(scheduler.applyJitter(DAY_MS, () => 0.5), DAY_MS);
});

test('backoffDelay grows exponentially and then caps', () => {
  const first = scheduler.backoffDelay(1);
  const second = scheduler.backoffDelay(2);
  const third = scheduler.backoffDelay(3);
  assert.ok(second > first);
  assert.ok(third > second);

  // Far past the cap it must stop growing, not overflow.
  const capped = scheduler.backoffDelay(50);
  assert.equal(capped, scheduler.backoffDelay(99));
  assert.ok(Number.isFinite(capped));
});

test('nextCheckAt uses the frequency on success and backoff on failure', () => {
  const watch = { frequency: 'daily', failure_count: 0 };
  const success = scheduler.nextCheckAt(watch, 'success', 0, () => 0.5);
  assert.equal(success, DAY_MS);

  const failure = scheduler.nextCheckAt({ frequency: 'daily', failure_count: 1 }, 'failure', 0);
  assert.equal(failure, scheduler.backoffDelay(1));
  assert.ok(failure < DAY_MS, 'first retry should come sooner than a normal interval');
});

// --- claiming due watches -------------------------------------------------

test('claimDueWatches returns only due active watches, oldest first', () => {
  const dueOld = makeWatch({ nextCheckAt: 100 });
  const dueNew = makeWatch({ nextCheckAt: 200 });
  const notDue = makeWatch({ nextCheckAt: 999999 });
  const paused = makeWatch({ status: 'paused', nextCheckAt: 100 });
  const broken = makeWatch({ status: 'broken', nextCheckAt: 100 });

  const claimed = scheduler.claimDueWatches(500, 10);
  const ids = claimed.map((w) => w.id);

  assert.deepEqual(ids, [dueOld.id, dueNew.id]);
  assert.ok(!ids.includes(notDue.id), 'not-yet-due watch must be skipped');
  assert.ok(!ids.includes(paused.id), 'paused watch must be skipped');
  assert.ok(!ids.includes(broken.id), 'broken watch must be skipped');

  for (const w of [dueOld, dueNew, notDue, paused, broken]) {
    getDb().prepare('DELETE FROM watches WHERE id = ?').run(w.id);
  }
});

test('claimDueWatches honours the batch limit', () => {
  const made = [makeWatch({ nextCheckAt: 1 }), makeWatch({ nextCheckAt: 2 }), makeWatch({ nextCheckAt: 3 })];
  assert.equal(scheduler.claimDueWatches(500, 2).length, 2);
  for (const w of made) getDb().prepare('DELETE FROM watches WHERE id = ?').run(w.id);
});

// --- tick -----------------------------------------------------------------

const neverBusy = () => false;

test('tick runs a due watch and schedules it one interval out', async () => {
  const watch = makeWatch({ nextCheckAt: 100 });
  const calls = [];

  const result = await scheduler.tick({
    now: 500,
    busy: neverBusy,
    rand: () => 0.5,
    runCheck: async (id) => {
      calls.push(id);
      return { changed: false, change: null };
    }
  });

  assert.deepEqual(calls, [watch.id]);
  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);

  const after = readWatch(watch.id);
  assert.equal(after.last_checked_at, 500);
  assert.equal(after.next_check_at, 500 + DAY_MS);
  assert.equal(after.failure_count, 0);

  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
});

test('tick counts a detected change', async () => {
  const watch = makeWatch({ nextCheckAt: 100 });
  const result = await scheduler.tick({
    now: 500,
    busy: neverBusy,
    runCheck: async () => ({ changed: true, change: { id: 7, changes: [] } })
  });
  assert.equal(result.changed, 1);
  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
});

test('tick defers entirely while the scraper is busy', async () => {
  const watch = makeWatch({ nextCheckAt: 100 });
  let called = false;

  const result = await scheduler.tick({
    now: 500,
    busy: () => true,
    runCheck: async () => {
      called = true;
      return { changed: false, change: null };
    }
  });

  assert.equal(called, false, 'must not scrape when the cap is reached');
  assert.equal(result.skipped, 1);
  assert.equal(result.checked, 0);
  // The watch stays due so the next tick picks it up.
  assert.equal(readWatch(watch.id).next_check_at, 100);

  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
});

test('a watch due during downtime runs on the first tick back', async () => {
  // next_check_at is far in the past, as if the process was down for a week.
  const watch = makeWatch({ nextCheckAt: 1 });
  const seen = [];

  await scheduler.tick({
    now: 7 * DAY_MS,
    busy: neverBusy,
    runCheck: async (id) => {
      seen.push(id);
      return { changed: false, change: null };
    }
  });

  assert.deepEqual(seen, [watch.id], 'overdue watch must run immediately after restart');
  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
});

test('failures back off, then flip the watch to broken at the threshold', async () => {
  const watch = makeWatch({ nextCheckAt: 100 });
  const failing = async () => {
    throw new Error('page unreachable');
  };

  let now = 500;
  for (let attempt = 1; attempt < scheduler.MAX_FAILURES; attempt++) {
    // Make the watch due again for each attempt.
    getDb().prepare('UPDATE watches SET next_check_at = ? WHERE id = ?').run(now - 1, watch.id);
    const result = await scheduler.tick({ now, busy: neverBusy, runCheck: failing });

    assert.equal(result.failed, 1);
    const row = readWatch(watch.id);
    assert.equal(row.failure_count, attempt);
    assert.equal(row.status, 'active', `should still be active after ${attempt} failure(s)`);
    assert.ok(row.next_check_at > now, 'must be pushed into the future by backoff');
    assert.match(row.last_error, /page unreachable/);
    now += 1000;
  }

  // The final failure crosses MAX_FAILURES.
  getDb().prepare('UPDATE watches SET next_check_at = ? WHERE id = ?').run(now - 1, watch.id);
  const last = await scheduler.tick({ now, busy: neverBusy, runCheck: failing });

  assert.equal(last.broken, 1);
  const broken = readWatch(watch.id);
  assert.equal(broken.failure_count, scheduler.MAX_FAILURES);
  assert.equal(broken.status, 'broken');

  // A broken watch is no longer claimed.
  assert.equal(scheduler.claimDueWatches(now + DAY_MS, 10).some((w) => w.id === watch.id), false);

  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
});

test('a success after failures clears the counter and the error', async () => {
  const watch = makeWatch({ nextCheckAt: 100, failureCount: 3 });
  getDb().prepare('UPDATE watches SET last_error = ? WHERE id = ?').run('earlier failure', watch.id);

  await scheduler.tick({
    now: 500,
    busy: neverBusy,
    rand: () => 0.5,
    runCheck: async () => ({ changed: true, change: null })
  });

  const after = readWatch(watch.id);
  assert.equal(after.failure_count, 0);
  assert.equal(after.last_error, null);
  assert.equal(after.next_check_at, 500 + DAY_MS, 'should return to its normal cadence');

  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
});

test('one failing watch does not stop the others in the batch', async () => {
  const bad = makeWatch({ nextCheckAt: 100 });
  const good = makeWatch({ nextCheckAt: 200 });

  const result = await scheduler.tick({
    now: 500,
    busy: neverBusy,
    runCheck: async (id) => {
      if (id === bad.id) throw new Error('boom');
      return { changed: false, change: null };
    }
  });

  assert.equal(result.failed, 1);
  assert.equal(result.checked, 1);
  assert.equal(readWatch(good.id).last_checked_at, 500);

  for (const w of [bad, good]) getDb().prepare('DELETE FROM watches WHERE id = ?').run(w.id);
});

// --- start/stop and status ------------------------------------------------

test('start is idempotent and stop clears the timer', () => {
  const first = scheduler.start();
  const second = scheduler.start();
  assert.equal(first, second, 'start must not install a second interval');
  scheduler.stop();
  assert.equal(scheduler.status().enabled, false);
});

test('status reports counts, due watches and upcoming checks', () => {
  const active = makeWatch({ nextCheckAt: 100 });
  const paused = makeWatch({ status: 'paused', nextCheckAt: 100 });

  const snapshot = scheduler.status(500);
  assert.equal(snapshot.dueNow, 1);
  assert.equal(snapshot.byStatus.active, 1);
  assert.equal(snapshot.byStatus.paused, 1);
  assert.equal(snapshot.upcoming[0].id, active.id);
  assert.equal(snapshot.tickMs, scheduler.TICK_MS);

  for (const w of [active, paused]) getDb().prepare('DELETE FROM watches WHERE id = ?').run(w.id);
});
