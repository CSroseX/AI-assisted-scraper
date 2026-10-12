const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { isPrivateIPv4, isPrivateIPv6 } = require('./ssrf');
const { SCREENSHOT_DIR, validateScrapeUrl, captureSnapshot, scraperBusy, closeScraper } = require('./scraper');
const { closeDb } = require('./db');
const { sweepEvidence, adoptLegacyScreenshots } = require('./evidence');
const { callGroq, withRetries, clampTextForModel } = require('./groq');
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
// Scraping launches a browser page, so it gets a much tighter budget.
const scrapeLimiter = rateLimit({
  ...limiterDefaults,
  limit: Number(process.env.SCRAPE_RATE_LIMIT_MAX || 10)
});
app.use(apiLimiter);

const SCREENSHOT_TTL_MS = Number(process.env.SCREENSHOT_TTL_MS || 60 * 60 * 1000);
app.use('/screenshots', express.static(SCREENSHOT_DIR));

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

// Maps scraper/browser failures to safe client responses. Shared with the
// watches snapshot pipeline so both surfaces report failures consistently.
function sendScrapeError(res, err, label = 'Scrape API') {
  const message = String(err.message || '');
  if (message.includes('Executable doesn\'t exist')) {
    console.error(`${label} error: Playwright browser binaries are not installed.`);
    return res.status(500).json({
      error: 'Playwright browser binaries are not installed.',
      fix: 'Run `npx playwright install chromium` inside the backend folder.'
    });
  }
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED/.test(message)) {
    return res.status(502).json({ error: 'The page could not be fetched: the destination is unreachable or blocked (private addresses are not allowed, including via redirects).' });
  }
  console.error(`${label} error:`, message);
  return res.status(500).json({ error: 'Scrape failed' });
}

app.post('/scrape', scrapeLimiter, async (req, res) => {
  const { url, includeScreenshot = true } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'No URL provided' });
  }

  const urlCheck = await validateScrapeUrl(url);
  if (!urlCheck.ok) {
    return res.status(400).json({ error: urlCheck.reason });
  }

  if (scraperBusy()) {
    res.set('Retry-After', '5');
    return res.status(503).json({ error: 'Scraper is busy, please retry shortly.' });
  }

  try {
    const result = await captureSnapshot(urlCheck.parsedUrl, { includeScreenshot });
    res.json(result);
  } catch (err) {
    sendScrapeError(res, err);
  }
});

function classifyIntentHeuristic(message = '') {
  const text = String(message).toLowerCase();
  if (!text.trim()) return 'chat';

  // Keep broad "what is ... about" style questions in conversational chat.
  if (/\bwhat(?:'s| is)\b.*\babout\b/.test(text)) return 'chat';

  if (/summarize|summary|tldr|key points|overview/.test(text)) return 'summarize';
  if (/review|grammar|quality|well written|critique/.test(text)) return 'review';
  if (/rewrite|rephrase|simplify|paraphrase|change tone|spin/.test(text)) return 'spin';
  return 'chat';
}

// Extracted handler: spin content
async function handleSpin(content, customPrompt = "Rewrite in modern English and simplify the tone.") {
  const clamped = clampTextForModel(content, 12000);
  const prompt = `${customPrompt}\n\n${clamped.text}`;
  const spun = await callGroq([{ role: 'user', content: prompt }])
  return { spun, metadata: { prompt: customPrompt, timestamp: Date.now(), truncated: clamped.truncated } };
}

// Extracted handler: review content
async function handleReview(content) {
  const clamped = clampTextForModel(content, 12000);
  const reviewerPrompt = "You are an expert editor and reviewer. Refine and critique the following text for clarity, coherence, and style. Suggest improvements and rewrite as needed.\n\n" + clamped.text;
  const reviewed = await callGroq([{ role: 'user', content: reviewerPrompt }]);
  return { reviewed, metadata: { truncated: clamped.truncated } };
}

// Extracted handler: chat contextually
async function handleChat(content, userMessage, history = []) {
  const clampedContext = clampTextForModel(content, 8000);
  const trimmedHistory = Array.isArray(history) ? history.slice(-8) : [];
  const messages = [
    { role: 'system', content: 'Context: ' + clampedContext.text }
  ];
  if (trimmedHistory.length) {
    for (const msg of trimmedHistory) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        messages.push({ role: 'assistant', content: msg.content });
      }
    }
  }
  messages.push({ role: 'user', content: userMessage });

  const reply = await callGroq(messages);
  return { reply };
}

// NEW handler: summarize content
async function handleSummarize(content) {
  const clamped = clampTextForModel(content, 12000);
  const summarizePrompt = "Summarize the following text concisely. Focus on key points and main ideas.\n\n" + clamped.text;
  const summary = await callGroq([{ role: 'user', content: summarizePrompt }]);
  return { summary, metadata: { truncated: clamped.truncated } };
}

// Intent classifier using Groq
async function classifyIntent(message) {
  // Prefer cheap local heuristics to avoid an extra LLM call per /ask request.
  const heuristicIntent = classifyIntentHeuristic(message);
  if (heuristicIntent !== 'chat') return heuristicIntent;

  const prompt = `
You are an intent classifier. Given a user message, classify it into EXACTLY one of these four categories:
- spin     (rewrite, rephrase, simplify, paraphrase, change tone)
- chat     (question, conversation, explanation, anything unclear)
- review   (grammar check, quality assessment, is it well written)
- summarize (summary, overview, key points, tldr)

User message: "${message}"

Respond with ONLY the single word label. No explanation. No punctuation.
`.trim();

  try {
    const raw = await callGroq([{ role: 'user', content: prompt }])
    const classified = raw?.trim()?.toLowerCase();
    const valid = ['spin', 'chat', 'review', 'summarize'];
    if (!valid.includes(classified)) {
      console.warn(`[classifyIntent] Unexpected Groq output: "${classified}", falling back to chat`);
      return 'chat';
    }
    return classified;
  } catch (err) {
    console.warn('[classifyIntent] Classification error, falling back to chat:', err.message);
    return 'chat';
  }
}

// Route to appropriate handler based on intent
async function routeToHandler(intent, content, message, history = []) {
  switch (intent) {
    case 'spin':
      return await handleSpin(content);
    case 'review':
      return await handleReview(content);
    case 'summarize':
      return await handleSummarize(content);
    case 'chat':
    default:
      return await handleChat(content, message, history);
  }
}

const MAX_TEXT_CHARS = 500000;

function isNonEmptyString(value, max = MAX_TEXT_CHARS) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

// Keeps only well-formed chat turns from client-supplied history.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-8);
}

// Never echo upstream error details to clients; log them instead.
function sendAiError(res, err, label, extra = {}) {
  console.error(`${label} error:`, err.message);
  if (err.status === 429) {
    return res.status(429).json({ error: 'The AI provider is rate limiting requests. Try again shortly.', ...extra });
  }
  return res.status(502).json({ error: 'The AI request failed. Please try again.', ...extra });
}

// The unified /ask endpoint
app.post('/ask', async (req, res) => {
  const { message, content, history = [] } = req.body || {};

  if (!isNonEmptyString(content)) {
    return res.status(400).json({ error: 'content is required' });
  }
  if (typeof message !== 'string' || message.length > 4000) {
    return res.status(400).json({ error: 'message must be a string of at most 4000 characters' });
  }

  let intent = 'chat';
  try {
    intent = await classifyIntent(message);
  } catch (err) {
    console.warn('[/ask] Intent classification failed, falling back to chat:', err.message);
  }

  console.log(`[/ask] intent=${intent} content_chars=${String(content || '').length}`);

  try {
    const result = await routeToHandler(intent, content, message, sanitizeHistory(history));
    console.log(`[/ask] routed_to=${intent} status=success`);
    return res.json({ ...result, _routed_to: intent });
  } catch (err) {
    console.error(`[/ask] routed_to=${intent} status=error`);
    return sendAiError(res, err, '[/ask] Handler', { _routed_to: intent });
  }
});

app.post('/spin', async (req, res) => {
  const { text, prompt = "Rewrite in modern English and simplify the tone." } = req.body || {};
  if (!isNonEmptyString(text)) return res.status(400).json({ error: 'No text provided' });
  if (typeof prompt !== 'string' || prompt.length > 2000) {
    return res.status(400).json({ error: 'prompt must be a string of at most 2000 characters' });
  }

  try {
    const result = await handleSpin(text, prompt);
    res.json(result);
  } catch (err) {
    sendAiError(res, err, 'Spin API');
  }
});

// Contextual chat endpoint for Groq
app.post('/chat', async (req, res) => {
  const { context, history, userMessage } = req.body || {};
  if (!isNonEmptyString(context) || !isNonEmptyString(userMessage, 4000)) {
    return res.status(400).json({ error: 'Missing context or user message' });
  }

  try {
    const result = await handleChat(context, userMessage, sanitizeHistory(history));
    res.json(result);
  } catch (err) {
    sendAiError(res, err, 'Chat API');
  }
});

// AI Reviewer endpoint for Groq
app.post('/review', async (req, res) => {
  const { spunContent } = req.body || {};
  if (!isNonEmptyString(spunContent)) return res.status(400).json({ error: 'No spun content provided' });

  try {
    const result = await handleReview(spunContent);
    res.json(result);
  } catch (err) {
    sendAiError(res, err, 'Review API');
  }
});

// Summarize endpoint for Groq
app.post('/summarize', async (req, res) => {
  const { content } = req.body || {};
  if (!isNonEmptyString(content)) return res.status(400).json({ error: 'No content provided' });

  try {
    const result = await handleSummarize(content);
    res.json(result);
  } catch (err) {
    sendAiError(res, err, 'Summarize API');
  }
});

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
  scheduler,
  sanitizeHistory,
  sendScrapeError,
  // Exposed for unit tests
  clampTextForModel,
  withRetries,
  callGroq,
  classifyIntentHeuristic,
  classifyIntent,
  routeToHandler,
  handleSpin,
  handleReview,
  handleChat,
  handleSummarize
};