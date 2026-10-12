// Turns a detected change into one alert row per enabled channel.
//
// Deduplication has two layers:
//   1. Hard: a unique index on (change_id, channel). The database refuses a
//      second alert for the same change on the same channel.
//   2. Soft: a page that flips between two versions repeats the exact same
//      diff. A repeat on the same watch and channel inside the repeat window is
//      stored as 'suppressed' rather than sent, so it stays auditable without
//      alerting again. Outside the window it alerts normally, so a flapping
//      page reminds at most once per window and a recurring change is not lost.

const DAY_MS = 24 * 60 * 60 * 1000;
const REPEAT_WINDOW_MS = Number(process.env.ALERT_REPEAT_WINDOW_MS || 7 * DAY_MS);

const CHANNELS = ['email', 'rss'];

function enabledChannels(watch) {
  return CHANNELS.filter((channel) => Boolean(watch[`alert_${channel}`]));
}

// Returns { email, rss } booleans, or { error } for anything that is not a
// list of distinct known channels. An empty list is valid: alerts off.
function parseChannels(value) {
  if (!Array.isArray(value)) {
    return { error: `alertChannels must be a list containing any of: ${CHANNELS.join(', ')}` };
  }
  if (value.some((c) => !CHANNELS.includes(c)) || new Set(value).size !== value.length) {
    return { error: `alertChannels may only contain each of ${CHANNELS.join(', ')} once` };
  }
  return { email: value.includes('email'), rss: value.includes('rss') };
}

// Must run inside the same transaction that inserts the change, so a change is
// never stored without its alerts: a crash in between would otherwise lose the
// alert for good, because the next check sees no new content and stops early.
function queueAlerts(db, { watch, changeId, diffHash, now }) {
  const recentRepeat = db.prepare(
    `SELECT 1 FROM alerts
     WHERE watch_id = ? AND channel = ? AND diff_hash = ? AND status != 'suppressed' AND created_at > ?
     LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO alerts (watch_id, change_id, channel, diff_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const channel of enabledChannels(watch)) {
    const repeat = recentRepeat.get(watch.id, channel, diffHash, now - REPEAT_WINDOW_MS);
    insert.run(watch.id, changeId, channel, diffHash, repeat ? 'suppressed' : 'pending', now);
  }
}

function serializeAlert(row) {
  return {
    id: row.id,
    watchId: row.watch_id,
    changeId: row.change_id,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    sentAt: row.sent_at,
    createdAt: row.created_at
  };
}

module.exports = {
  CHANNELS,
  REPEAT_WINDOW_MS,
  enabledChannels,
  parseChannels,
  queueAlerts,
  serializeAlert
};
