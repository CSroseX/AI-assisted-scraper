const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB so runs don't interfere with each other.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-email-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.LINK_TOKEN = 'mail-token';
process.env.PUBLIC_BASE_URL = 'https://watchdog.example';

const nodemailer = require('nodemailer');
const { getDb, closeDb } = require('./db');
const {
  deliverPendingEmails,
  buildAlertEmail,
  backoffDelay,
  MAX_ATTEMPTS,
  SETTLE_MS
} = require('./emailAlerts');
const { checkEmailSetup, createSender } = require('./mailer');

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const READY = { ok: true, mode: 'smtp', missing: [] };
const NOW = 10 * SETTLE_MS;

// A fake transport-level sender that records what it was asked to send.
function fakeSend(fail = null) {
  const sent = [];
  const fn = async (message) => {
    if (fail && fail(message, sent.length)) throw new Error('SMTP 451 try again later');
    sent.push(message);
    return { messageId: `<m${sent.length}@test>`, previewUrl: null };
  };
  fn.sent = sent;
  return fn;
}

let seq = 0;
// Seeds a watch, a change and an email alert. `explained` controls whether the
// change has settled; `createdAt` is when the alert was queued.
function seedEmailAlert({ explained = true, createdAt = NOW, emailOn = 1, summary = 'Price rose to $12.', url } = {}) {
  seq++;
  const db = getDb();
  const watchId = db
    .prepare("INSERT INTO watches (url, frequency, status, created_at, updated_at, alert_email, alert_rss) VALUES (?, 'daily', 'active', 0, 0, ?, 1)")
    .run(url || `https://shop${seq}.test/pricing`, emailOn).lastInsertRowid;
  const snap = db.prepare("INSERT INTO snapshots (watch_id, content, content_hash, created_at) VALUES (?, 'x', 'h', 0)").run(watchId).lastInsertRowid;
  const diff = [{ type: 'removed', text: 'Price: $10/month.' }, { type: 'added', text: 'Price: $12/month.' }];
  const changeId = db
    .prepare('INSERT INTO changes (watch_id, to_snapshot_id, diff_json, diff_hash, category, summary, explained_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(watchId, snap, JSON.stringify(diff), `hash-${seq}`, explained ? 'price' : null, explained ? summary : null, explained ? createdAt : null, createdAt)
    .lastInsertRowid;
  const alertId = db
    .prepare("INSERT INTO alerts (watch_id, change_id, channel, diff_hash, status, created_at) VALUES (?, ?, 'email', ?, 'pending', ?)")
    .run(watchId, changeId, `hash-${seq}`, createdAt).lastInsertRowid;
  return { watchId, changeId, alertId };
}

const alert = (id) => getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id);

// Leaves only the given alerts pending, so each test sees just its own.
function only(...ids) {
  getDb().prepare(`UPDATE alerts SET status = 'sent' WHERE status = 'pending' AND id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

// --- content ----------------------------------------------------------------

test('the email says what changed, quotes it, and links to the evidence', () => {
  const email = buildAlertEmail({
    change_id: 7,
    url: 'https://shop.test/pricing',
    category: 'price',
    summary: 'The monthly price rose from $10 to $12.',
    diff_json: JSON.stringify([{ type: 'removed', text: 'Price: $10/month.' }, { type: 'added', text: 'Price: $12/month.' }])
  });
  assert.equal(email.subject, 'Price change on shop.test');
  assert.match(email.text, /The monthly price rose from \$10 to \$12\./);
  assert.match(email.text, /Removed: Price: \$10\/month\./);
  assert.match(email.text, /Added: Price: \$12\/month\./);
  assert.match(email.text, /See before and after: https:\/\/watchdog\.example\/evidence\/changes\/7\?token=mail-token/);
  assert.match(email.html, /href="https:\/\/watchdog\.example\/evidence\/changes\/7\?token=mail-token"/);
});

test('scraped markup in an email is shown as text, and a missing summary is said plainly', () => {
  const email = buildAlertEmail({
    change_id: 8,
    url: 'https://hostile.test',
    category: null,
    summary: null,
    diff_json: JSON.stringify([{ type: 'added', text: '<script>alert(1)</script><a href="https://evil.test">Win</a>' }])
  });
  assert.equal(email.subject, 'Change detected on hostile.test');
  assert.match(email.text, /No verified summary is available yet/);
  assert.doesNotMatch(email.html, /<script/i);
  assert.doesNotMatch(email.html, /href="https:\/\/evil\.test"/);
  assert.match(email.html, /&lt;script&gt;/);
});

test('long diffs are capped in the email too', () => {
  const diff = Array.from({ length: 9 }, (_, i) => ({ type: 'added', text: `Clause ${i}.` }));
  const email = buildAlertEmail({ change_id: 9, url: 'https://long.test', category: 'cosmetic', summary: 'x', diff_json: JSON.stringify(diff) });
  assert.equal((email.text.match(/Added:/g) || []).length, 6);
  assert.match(email.text, /and 3 more changed paragraphs/);
});

// --- delivery ---------------------------------------------------------------

test('a settled pending alert is sent once and marked sent', async () => {
  const { alertId } = seedEmailAlert();
  only(alertId);
  const send = fakeSend();

  const first = await deliverPendingEmails({ now: NOW, send, setup: READY });
  assert.equal(first.sent, 1);
  assert.equal(send.sent.length, 1);
  const row = alert(alertId);
  assert.equal(row.status, 'sent');
  assert.equal(row.sent_at, NOW);
  assert.equal(row.attempts, 1);

  const second = await deliverPendingEmails({ now: NOW + 1, send, setup: READY });
  assert.equal(second.sent, 0, 'never sent twice');
});

test('an email waits for the explanation, but not forever', async () => {
  const { alertId, changeId } = seedEmailAlert({ explained: false, createdAt: NOW });
  only(alertId);
  const send = fakeSend();

  await deliverPendingEmails({ now: NOW + 1000, send, setup: READY });
  assert.equal(send.sent.length, 0, 'still being explained: wait so the email has a summary');

  getDb().prepare("UPDATE changes SET summary = 'Explained now.', explained_at = ? WHERE id = ?").run(NOW + 2000, changeId);
  await deliverPendingEmails({ now: NOW + 3000, send, setup: READY });
  assert.equal(send.sent.length, 1);
  assert.match(send.sent[0].text, /Explained now\./);
});

test('an explanation that never lands does not hold the email back past the settle time', async () => {
  const { alertId } = seedEmailAlert({ explained: false, createdAt: NOW });
  only(alertId);
  const send = fakeSend();
  await deliverPendingEmails({ now: NOW + SETTLE_MS, send, setup: READY });
  assert.equal(send.sent.length, 1);
  assert.match(send.sent[0].text, /No verified summary is available yet/);
});

test('with the explainer off, emails go at once', async (t) => {
  process.env.EXPLAIN_ENABLED = 'false';
  t.after(() => { delete process.env.EXPLAIN_ENABLED; });
  const { alertId } = seedEmailAlert({ explained: false, createdAt: NOW });
  only(alertId);
  const send = fakeSend();
  await deliverPendingEmails({ now: NOW + 1, send, setup: READY });
  assert.equal(send.sent.length, 1);
});

test('a failed send backs off, retries, and gives up after the last attempt', async () => {
  const { alertId } = seedEmailAlert();
  only(alertId);
  const failing = fakeSend(() => true);

  let now = NOW;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await deliverPendingEmails({ now, send: failing, setup: READY });
    assert.equal(result.retrying, 1);
    const row = alert(alertId);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, attempt);
    assert.match(row.last_error, /SMTP 451/);
    assert.equal(row.next_attempt_at, now + backoffDelay(attempt));

    // Not retried before its time.
    await deliverPendingEmails({ now: row.next_attempt_at - 1, send: failing, setup: READY });
    assert.equal(alert(alertId).attempts, attempt);
    now = row.next_attempt_at;
  }

  const last = await deliverPendingEmails({ now, send: failing, setup: READY });
  assert.equal(last.failed, 1);
  const row = alert(alertId);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.match(row.last_error, /SMTP 451/, 'the reason is kept for the user to see');
});

test('a retry that succeeds clears the error', async () => {
  const { alertId } = seedEmailAlert();
  only(alertId);
  await deliverPendingEmails({ now: NOW, send: fakeSend(() => true), setup: READY });
  const due = alert(alertId).next_attempt_at;
  await deliverPendingEmails({ now: due, send: fakeSend(), setup: READY });
  const row = alert(alertId);
  assert.equal(row.status, 'sent');
  assert.equal(row.last_error, null);
  assert.equal(row.attempts, 2);
});

test('one failing email does not stop the rest of the batch', async () => {
  const bad = seedEmailAlert({ url: 'https://bad.test' });
  const good = seedEmailAlert({ url: 'https://good.test' });
  only(bad.alertId, good.alertId);
  const send = fakeSend((message) => message.subject.includes('bad.test'));
  const result = await deliverPendingEmails({ now: NOW, send, setup: READY });
  assert.equal(result.retrying, 1);
  assert.equal(result.sent, 1);
  assert.equal(alert(good.alertId).status, 'sent');
});

test('without email set up, nothing is sent and each alert says why', async () => {
  const { alertId } = seedEmailAlert();
  only(alertId);
  const send = fakeSend();
  const setup = checkEmailSetup({});

  const result = await deliverPendingEmails({ now: NOW, send, setup });
  assert.equal(result.notSetUp, 1);
  assert.equal(send.sent.length, 0);
  const row = alert(alertId);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0, 'waiting for setup does not spend attempts');
  assert.equal(row.last_error, 'Email is not set up: missing SMTP_HOST, ALERT_EMAIL_FROM, ALERT_EMAIL_TO');

  // It is written once, not on every pass.
  assert.equal((await deliverPendingEmails({ now: NOW, send, setup })).notSetUp, 0);

  // Once configured, the waiting alert goes out.
  await deliverPendingEmails({ now: NOW, send, setup: READY });
  assert.equal(alert(alertId).status, 'sent');
});

test('only pending email alerts are sent: never RSS, suppressed, or a watch with email turned off', async () => {
  const off = seedEmailAlert({ emailOn: 0 });
  const rss = seedEmailAlert();
  getDb().prepare("UPDATE alerts SET channel = 'rss', status = 'sent' WHERE id = ?").run(rss.alertId);
  const suppressed = seedEmailAlert();
  getDb().prepare("UPDATE alerts SET status = 'suppressed' WHERE id = ?").run(suppressed.alertId);
  only(off.alertId);

  const send = fakeSend();
  await deliverPendingEmails({ now: NOW, send, setup: READY });
  assert.equal(send.sent.length, 0);
  assert.equal(alert(off.alertId).status, 'pending', 'kept, in case email is turned back on');
});

test('backoffDelay grows by four and caps at six hours', () => {
  assert.equal(backoffDelay(1), 60000);
  assert.equal(backoffDelay(2), 240000);
  assert.equal(backoffDelay(3), 960000);
  assert.equal(backoffDelay(20), 6 * 60 * 60 * 1000);
});

// --- mailer -----------------------------------------------------------------

test('checkEmailSetup lists exactly what is missing; the test inbox needs nothing', () => {
  assert.deepEqual(checkEmailSetup({}), { ok: false, mode: 'smtp', missing: ['SMTP_HOST', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO'] });
  assert.deepEqual(
    checkEmailSetup({ SMTP_HOST: 'smtp.test', ALERT_EMAIL_FROM: 'a@b.test', ALERT_EMAIL_TO: 'c@d.test' }),
    { ok: true, mode: 'smtp', missing: [] }
  );
  assert.deepEqual(checkEmailSetup({ EMAIL_TRANSPORT: 'ethereal' }), { ok: true, mode: 'ethereal', missing: [] });
});

test('the real nodemailer message carries the addresses, subject and both bodies', async () => {
  // nodemailer's own no-network transport, wrapped to capture what it builds.
  const real = nodemailer.createTransport({ jsonTransport: true });
  let built;
  const transport = {
    sendMail: async (message) => {
      const info = await real.sendMail(message);
      built = JSON.parse(info.message);
      return info;
    }
  };
  const env = { ALERT_EMAIL_FROM: 'Watchdog <alerts@watchdog.example>', ALERT_EMAIL_TO: 'me@example.com' };
  const send = createSender({ transport, env });
  const email = buildAlertEmail({
    change_id: 3,
    url: 'https://shop.test',
    category: 'fees',
    summary: 'A $2 service fee was added.',
    diff_json: JSON.stringify([{ type: 'added', text: 'Service fee: $2.' }])
  });

  const info = await send(email);
  assert.ok(info.messageId);
  assert.equal(info.previewUrl, null);
  assert.equal(built.subject, 'Fee change on shop.test');
  assert.deepEqual(built.from, { address: 'alerts@watchdog.example', name: 'Watchdog' });
  assert.deepEqual(built.to, [{ address: 'me@example.com', name: '' }]);
  assert.match(built.text, /A \$2 service fee was added\./);
  assert.match(built.html, /Service fee: \$2\./);
});

test('createSender hands nodemailer the right envelope', async () => {
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { messageId: '<x@test>' }; } };
  const send = createSender({ transport, env: { ALERT_EMAIL_FROM: 'from@test.example', ALERT_EMAIL_TO: 'to@test.example' } });
  await send({ subject: 'S', text: 'T', html: '<p>H</p>' });
  assert.equal(sent[0].from, 'from@test.example');
  assert.equal(sent[0].to, 'to@test.example');
  assert.equal(sent[0].subject, 'S');
  assert.equal(sent[0].disableFileAccess, true);
  assert.equal(sent[0].disableUrlAccess, true);
});

test('a failed transport setup is retried on the next send, not cached', async () => {
  // Ethereal mode with no network: account creation is stubbed to fail once.
  let calls = 0;
  const original = nodemailer.createTestAccount;
  nodemailer.createTestAccount = async () => {
    calls++;
    if (calls === 1) throw new Error('ethereal unreachable');
    return { user: 'u', pass: 'p', smtp: { host: '127.0.0.1', port: 1, secure: false } };
  };
  try {
    const send = createSender({ env: { EMAIL_TRANSPORT: 'ethereal' } });
    await assert.rejects(send({ subject: 'a', text: 'b' }), /ethereal unreachable/);
    // Second attempt re-creates the transport (then fails to connect to port 1).
    await assert.rejects(send({ subject: 'a', text: 'b' }));
    assert.equal(calls, 2);
  } finally {
    nodemailer.createTestAccount = original;
  }
});
