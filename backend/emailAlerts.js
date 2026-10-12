// Sends pending email alerts. Like the scheduler, all state lives in the
// alerts table (status, attempts, next_attempt_at, last_error); the interval is
// only a heartbeat, so a restart loses nothing and resumes where it stopped.
//
// Delivery is at-least-once: a crash between the provider accepting a message
// and the row being marked sent will send it again after restart. The
// alternative, marking first, would silently lose alerts instead.

const { getDb } = require('./db');
const { checkEmailSetup, createSender } = require('./mailer');
const { escapeMarkup: h } = require('./publicLinks');
const { NO_SUMMARY, alertTitle, evidenceUrl } = require('./alertContent');

const num = (name, fallback) => Number(process.env[name] || fallback);

const TICK_MS = num('EMAIL_TICK_MS', 30000);
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = num('EMAIL_MAX_ATTEMPTS', 5);
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
// An email waits for the change's explanation so it carries a summary. If the
// explanation never lands (e.g. the process died mid-call), send without one
// after this long rather than never.
const SETTLE_MS = 10 * 60 * 1000;
const MAX_EVIDENCE_PARAGRAPHS = 6;

// 1m, 4m, 16m, 64m... capped at 6h.
function backoffDelay(attempts) {
  return Math.min(BACKOFF_BASE_MS * 4 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

function buildAlertEmail(row) {
  const title = alertTitle(row.category, row.url);
  const summary = row.summary || NO_SUMMARY;
  const diff = JSON.parse(row.diff_json);
  const shown = diff.slice(0, MAX_EVIDENCE_PARAGRAPHS);
  const more = diff.length - shown.length;
  const evidence = evidenceUrl(row.change_id);
  const label = (p) => (p.type === 'removed' ? 'Removed' : 'Added');

  const text = [
    summary,
    '',
    ...shown.map((p) => `${label(p)}: ${p.text}`),
    ...(more > 0 ? [`…and ${more} more changed paragraphs.`] : []),
    '',
    `See before and after: ${evidence}`,
    `Open the page: ${row.url}`,
    '',
    'You get this because email alerts are on for this page.'
  ].join('\n');

  const para = (p) => {
    const colours = p.type === 'removed' ? 'background:#fdecea;color:#8a1c12' : 'background:#e6f4ea;color:#0d5223';
    return `<p style="${colours};padding:8px 10px;border-radius:6px;margin:6px 0"><strong>${label(p)}:</strong> ${h(p.text)}</p>`;
  };
  const html = `<div style="font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1a1a1a;max-width:640px">
<h2 style="font-size:18px;margin:0 0 12px">${h(title)}</h2>
<p style="margin:0 0 12px">${h(summary)}</p>
${shown.map(para).join('\n')}
${more > 0 ? `<p style="color:#5f6368">…and ${more} more changed paragraphs.</p>` : ''}
<p style="margin:16px 0"><a href="${h(evidence)}">See before and after</a> · <a href="${h(row.url)}">Open the page</a></p>
<p style="color:#5f6368;font-size:13px">You get this because email alerts are on for this page.</p>
</div>`;

  return { subject: title, text, html };
}

// Pending email alerts that are due, whose watch still has email on, and whose
// change has settled (explained, failed to explain, or waited long enough).
function claimDue(now, limit = BATCH_SIZE) {
  const explainOff = process.env.EXPLAIN_ENABLED === 'false' ? 1 : 0;
  return getDb()
    .prepare(
      `SELECT a.id, a.attempts, w.url, c.id AS change_id, c.category, c.summary, c.diff_json
       FROM alerts a
       JOIN changes c ON c.id = a.change_id
       JOIN watches w ON w.id = a.watch_id
       WHERE a.channel = 'email' AND a.status = 'pending' AND w.alert_email = 1
         AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)
         AND (c.explained_at IS NOT NULL OR c.explain_error IS NOT NULL OR ? = 1 OR a.created_at <= ?)
       ORDER BY a.created_at ASC, a.id ASC
       LIMIT ?`
    )
    .all(now, explainOff, now - SETTLE_MS, limit);
}

let defaultSender = null;

// One delivery pass. `send` and `setup` are injected so tests run offline.
async function deliverPendingEmails({ now = Date.now(), send, setup = checkEmailSetup() } = {}) {
  const db = getDb();
  const result = { sent: 0, retrying: 0, failed: 0, notSetUp: 0 };

  if (!setup.ok) {
    // Say why on every waiting alert, without spending its attempts: they go
    // out once email is configured.
    const reason = `Email is not set up: missing ${setup.missing.join(', ')}`;
    result.notSetUp = db
      .prepare("UPDATE alerts SET last_error = ? WHERE channel = 'email' AND status = 'pending' AND last_error IS NOT ?")
      .run(reason, reason).changes;
    return result;
  }

  if (!send) {
    defaultSender = defaultSender || createSender();
    send = defaultSender;
  }

  const markSent = db.prepare(
    "UPDATE alerts SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL WHERE id = ?"
  );
  const markFailure = db.prepare(
    'UPDATE alerts SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?'
  );

  // One failing alert must not stop the rest of the batch.
  for (const row of claimDue(now)) {
    try {
      const info = await send(buildAlertEmail(row));
      markSent.run(now, row.id);
      result.sent++;
      if (info && info.previewUrl) console.log(`[email] alert ${row.id} sent, view it at ${info.previewUrl}`);
    } catch (err) {
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      const message = String((err && err.message) || err).slice(0, 500);
      markFailure.run(giveUp ? 'failed' : 'pending', attempts, message, giveUp ? null : now + backoffDelay(attempts), row.id);
      result[giveUp ? 'failed' : 'retrying']++;
      console.warn(`[email] alert ${row.id} attempt ${attempts} failed${giveUp ? ', giving up' : ''}: ${message}`);
    }
  }
  return result;
}

let timer = null;
let running = false;

async function safeTick() {
  if (running) return;
  running = true;
  try {
    await deliverPendingEmails();
  } catch (err) {
    console.error('[email] delivery pass failed:', err.message);
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

module.exports = {
  start,
  stop,
  deliverPendingEmails,
  buildAlertEmail,
  backoffDelay,
  MAX_ATTEMPTS,
  SETTLE_MS,
  TICK_MS
};
