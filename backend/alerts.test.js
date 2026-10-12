const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-alerts-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const { getDb, closeDb } = require('./db');
const { parseChannels, enabledChannels, queueAlerts, REPEAT_WINDOW_MS } = require('./alerts');

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

let seq = 0;
function makeWatch({ email = 0, rss = 1 } = {}) {
  seq++;
  const id = getDb()
    .prepare(
      `INSERT INTO watches (url, frequency, status, created_at, updated_at, next_check_at, alert_email, alert_rss)
       VALUES (?, 'daily', 'active', 0, 0, 0, ?, ?)`
    )
    .run(`https://example.com/${seq}`, email, rss).lastInsertRowid;
  return getDb().prepare('SELECT * FROM watches WHERE id = ?').get(id);
}

function makeChange(watch, diffHash) {
  const db = getDb();
  const snapshotId = db
    .prepare('INSERT INTO snapshots (watch_id, content, content_hash, created_at) VALUES (?, ?, ?, 0)')
    .run(watch.id, 'x', 'h').lastInsertRowid;
  return db
    .prepare('INSERT INTO changes (watch_id, to_snapshot_id, diff_json, diff_hash, created_at) VALUES (?, ?, ?, ?, 0)')
    .run(watch.id, snapshotId, '[]', diffHash).lastInsertRowid;
}

function alertsFor(watch) {
  return getDb().prepare('SELECT * FROM alerts WHERE watch_id = ? ORDER BY id').all(watch.id);
}

function queue(watch, diffHash, now) {
  const changeId = makeChange(watch, diffHash);
  queueAlerts(getDb(), { watch, changeId, diffHash, now });
  return changeId;
}

// --- channel parsing --------------------------------------------------------

test('parseChannels accepts any combination of known channels, including none', () => {
  assert.deepEqual(parseChannels(['email', 'rss']), { email: true, rss: true });
  assert.deepEqual(parseChannels(['rss']), { email: false, rss: true });
  assert.deepEqual(parseChannels([]), { email: false, rss: false });
});

test('parseChannels rejects unknown, duplicate and non-list input', () => {
  assert.ok(parseChannels(['sms']).error);
  assert.ok(parseChannels(['rss', 'rss']).error);
  assert.ok(parseChannels('rss').error);
  assert.ok(parseChannels(null).error);
});

test('enabledChannels reads the watch row flags', () => {
  assert.deepEqual(enabledChannels({ alert_email: 1, alert_rss: 0 }), ['email']);
  assert.deepEqual(enabledChannels({ alert_email: 0, alert_rss: 0 }), []);
});

// --- queueing ---------------------------------------------------------------

test('a change queues one alert per enabled channel: email waits, RSS is published at once', () => {
  const watch = makeWatch({ email: 1, rss: 1 });
  queue(watch, 'hash-a', 1000);
  const rows = alertsFor(watch);
  assert.deepEqual(rows.map((r) => [r.channel, r.status, r.sent_at]), [['email', 'pending', null], ['rss', 'sent', 1000]]);
});

test('a watch with every channel off queues nothing', () => {
  const watch = makeWatch({ email: 0, rss: 0 });
  queue(watch, 'hash-b', 1000);
  assert.equal(alertsFor(watch).length, 0);
});

test('the database refuses a second alert for the same change and channel', () => {
  const watch = makeWatch({ rss: 1 });
  const changeId = queue(watch, 'hash-c', 1000);
  // Queueing the same change again (e.g. a retry) must not add a row.
  queueAlerts(getDb(), { watch, changeId, diffHash: 'hash-c', now: 2000 });
  assert.equal(alertsFor(watch).length, 1);
});

test('the same diff repeating inside the window is suppressed, not re-sent', () => {
  const watch = makeWatch({ rss: 1 });
  queue(watch, 'flap', 1000);
  queue(watch, 'flap', 1000 + REPEAT_WINDOW_MS - 1);
  assert.deepEqual(alertsFor(watch).map((r) => [r.status, r.sent_at]), [['sent', 1000], ['suppressed', null]]);
});

test('the same diff after the window alerts again, so a recurring change is not lost', () => {
  const watch = makeWatch({ rss: 1 });
  queue(watch, 'recur', 1000);
  queue(watch, 'recur', 1000 + REPEAT_WINDOW_MS + 1);
  assert.deepEqual(alertsFor(watch).map((r) => r.status), ['sent', 'sent']);
});

test('a page that keeps flapping is reminded once per window, not never', () => {
  const watch = makeWatch({ rss: 1 });
  // Daily flaps for longer than the window. Suppressed rows must not extend it.
  const day = 24 * 60 * 60 * 1000;
  const days = Math.ceil(REPEAT_WINDOW_MS / day) + 1;
  for (let d = 0; d <= days; d++) queue(watch, 'daily-flap', d * day + 1);
  const published = alertsFor(watch).filter((r) => r.status === 'sent');
  assert.equal(published.length, 2);
});

test('repeats are judged per watch: the same edit on another page still alerts', () => {
  const first = makeWatch({ rss: 1 });
  const second = makeWatch({ rss: 1 });
  queue(first, 'shared-edit', 1000);
  queue(second, 'shared-edit', 1001);
  assert.equal(alertsFor(second)[0].status, 'sent');
});

test('repeats are judged per channel: email turned on later still gets its first alert', () => {
  const watch = makeWatch({ email: 0, rss: 1 });
  queue(watch, 'per-channel', 1000);
  getDb().prepare('UPDATE watches SET alert_email = 1 WHERE id = ?').run(watch.id);
  const updated = getDb().prepare('SELECT * FROM watches WHERE id = ?').get(watch.id);
  queue(updated, 'per-channel', 2000);
  const rows = alertsFor(watch).map((r) => [r.channel, r.status]);
  assert.deepEqual(rows, [['rss', 'sent'], ['email', 'pending'], ['rss', 'suppressed']]);
});

test('deleting a watch removes its alerts and feedback', () => {
  const watch = makeWatch({ rss: 1 });
  const changeId = queue(watch, 'cascade', 1000);
  getDb().prepare("INSERT INTO feedback (change_id, vote, created_at, updated_at) VALUES (?, 'noise', 0, 0)").run(changeId);
  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
  assert.equal(alertsFor(watch).length, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM feedback WHERE change_id = ?').get(changeId).n, 0);
});
