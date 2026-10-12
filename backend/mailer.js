// Email transport, configured entirely by environment variables so switching
// between a test inbox and a real provider is a settings change, not a code
// change.
//
//   EMAIL_TRANSPORT=smtp (default)  any SMTP server: Gmail with an app password,
//                                   Amazon SES, Resend, Brevo, Mailtrap...
//   EMAIL_TRANSPORT=ethereal        nodemailer's free throwaway test inbox; no
//                                   signup, nothing reaches a real person, and
//                                   each send logs a link to view the message.

const nodemailer = require('nodemailer');

function emailMode(env = process.env) {
  return env.EMAIL_TRANSPORT === 'ethereal' ? 'ethereal' : 'smtp';
}

// Says whether email can be sent and, if not, exactly which settings are
// missing, so an alert can record why it was not sent rather than fail quietly.
function checkEmailSetup(env = process.env) {
  const mode = emailMode(env);
  const required = mode === 'smtp' ? ['SMTP_HOST', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO'] : [];
  const missing = required.filter((name) => !env[name]);
  return { ok: missing.length === 0, mode, missing };
}

function addresses(env = process.env) {
  if (emailMode(env) === 'ethereal') {
    return {
      from: env.ALERT_EMAIL_FROM || 'Watchdog <watchdog@example.test>',
      to: env.ALERT_EMAIL_TO || 'you@example.test'
    };
  }
  return { from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO };
}

// Timeouts keep one unreachable server from stalling the whole sender loop.
const TIMEOUTS = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 };

async function createTransport(env = process.env) {
  if (emailMode(env) === 'ethereal') {
    const account = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
      ...TIMEOUTS
    });
  }
  const port = Number(env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    // Port 465 speaks TLS from the start; 587 upgrades with STARTTLS.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    ...TIMEOUTS
  });
}

// Returns send({ subject, text, html }) -> { messageId, previewUrl }. The
// transport is created on first use and reused; a failed creation (e.g.
// Ethereal unreachable) is retried on the next send instead of being cached.
// `transport` can be injected, which is how tests run without a network.
function createSender({ transport = null, env = process.env } = {}) {
  let pending = transport ? Promise.resolve(transport) : null;

  return async function send(message) {
    if (!pending) {
      pending = createTransport(env).catch((err) => {
        pending = null;
        throw err;
      });
    }
    const t = await pending;
    const info = await t.sendMail({
      ...addresses(env),
      ...message,
      // We never attach files or fetch URLs; refuse both outright.
      disableFileAccess: true,
      disableUrlAccess: true
    });
    return { messageId: info.messageId, previewUrl: nodemailer.getTestMessageUrl(info) || null };
  };
}

module.exports = { checkEmailSetup, createSender, emailMode };
