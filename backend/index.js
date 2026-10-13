const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const app = express();
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { isPrivateIPv4, isPrivateIPv6 } = require('./ssrf');
const { SCREENSHOT_DIR, validateScrapeUrl, closeScraper } = require('./scraper');
const { closeDb } = require('./db');
const { sweepEvidence, adoptLegacyScreenshots } = require('./evidence');
const watchesRouter = require('./watches');
const feedsRouter = require('./feeds');
const evidencePageRouter = require('./evidencePage');
const scheduler = require('./scheduler');
const emailAlerts = require('./emailAlerts');
const { checkEmailSetup } = require('./mailer');

function parseAllowedOrigins(raw = '') {
  const parsed = String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return parsed.length ? parsed : ['http://localhost:3000'];
}

const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (no Origin header) such as health checks and curl.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: false
};

app.disable('x-powered-by');
// The API serves JSON, feeds and images, never pages of its own, so nothing needs to load.
// The evidence page replaces this CSP with its own.
app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
}

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

const limiterDefaults = {
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
};
const apiLimiter = rateLimit({
  ...limiterDefaults,
  limit: Number(process.env.RATE_LIMIT_MAX || 60),
  skip: (req) => req.path === '/health'
});
const scrapeLimiter = rateLimit({
  ...limiterDefaults,
  limit: Number(process.env.SCRAPE_RATE_LIMIT_MAX || 10)
});
app.use(apiLimiter);

const SCREENSHOT_TTL_MS = Number(process.env.SCREENSHOT_TTL_MS || 60 * 60 * 1000);

// Screenshots here are transient: delete anything older than the TTL. Those a
// watch snapshot needs were already copied to evidence storage (evidence.js).
function cleanupScreenshots(now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(SCREENSHOT_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.png')) continue;
    const file = path.join(SCREENSHOT_DIR, name);
    try {
      if (now - fs.statSync(file).mtimeMs > SCREENSHOT_TTL_MS) fs.unlinkSync(file);
    } catch {
      // File vanished or is unreadable; nothing to do.
    }
  }
}

// A check launches a browser page, so it gets a much tighter budget than the
// rest of the API.
app.use('/watches/:id/check', scrapeLimiter);
app.use('/watches', watchesRouter);
app.use(feedsRouter);
app.use(evidencePageRouter);

app.get('/scheduler/status', (_req, res) => {
  res.json(scheduler.status());
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Body-parser and CORS failures should be clean 4xx responses, not stack traces.
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed' });
  console.error('Unhandled error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
});

const PORT = Number(process.env.PORT || 5000);
if (require.main === module) {
  // Adopt before the first cleanup, which would delete the files being adopted.
  adoptLegacyScreenshots(SCREENSHOT_DIR);
  const cleanupFiles = () => {
    cleanupScreenshots();
    sweepEvidence();
  };
  cleanupFiles();
  setInterval(cleanupFiles, Math.max(60000, Math.floor(SCREENSHOT_TTL_MS / 4))).unref();
  if (process.env.SCHEDULER_ENABLED !== 'false') {
    scheduler.start();
    console.log(`Scheduler started, ticking every ${scheduler.TICK_MS}ms`);
  }
  emailAlerts.start();
  const email = checkEmailSetup();
  console.log(email.ok
    ? `Email alerts on (${email.mode})`
    : `Email alerts not set up, missing: ${email.missing.join(', ')}. Email alerts will wait until they are set.`);
  if (email.mode === 'ethereal') {
    // Ethereal message pages are public, and every alert email carries an
    // evidence link with LINK_TOKEN in it.
    console.warn('Ethereal is a test inbox: anyone with a message link can read it, including the LINK_TOKEN in its links. Use a throwaway LINK_TOKEN while testing.');
  }
  app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

  const shutdown = async () => {
    scheduler.stop();
    emailAlerts.stop();
    await closeScraper();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  app,
  validateScrapeUrl,
  isPrivateIPv4,
  isPrivateIPv6,
  parseAllowedOrigins,
  cleanupScreenshots,
  scheduler
};
