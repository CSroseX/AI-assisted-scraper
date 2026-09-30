const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const {
  isPrivateIPv4,
  isPrivateIPv6,
  validateScrapeUrl,
  createGuardProxy
} = require('./ssrf');

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
  methods: ['GET', 'POST', 'OPTIONS'],
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

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const SCREENSHOT_TTL_MS = Number(process.env.SCREENSHOT_TTL_MS || 60 * 60 * 1000);
app.use('/screenshots', express.static(SCREENSHOT_DIR));

const { chromium } = require('playwright');

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 20000);
let sharedBrowser = null;
let sharedBrowserPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  const status = err?.response?.status;
  if (!status) return true;
  return status === 408 || status === 429 || status >= 500;
}

async function withRetries(fn, { attempts = 2, baseDelayMs = 300 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || i === attempts - 1) break;
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastError;
}

let guardProxy = null;
let guardProxyPromise = null;

function startGuardProxy() {
  if (!guardProxyPromise) {
    guardProxy = createGuardProxy();
    guardProxyPromise = guardProxy.listen();
  }
  return guardProxyPromise;
}

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  if (sharedBrowserPromise) {
    return sharedBrowserPromise;
  }

  sharedBrowserPromise = startGuardProxy()
    .then((proxyPort) => chromium.launch({
      // All browser traffic, including redirects, goes through the egress filter.
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
      // Chromium bypasses proxies for loopback by default; force it through too
      // so requests to 127.0.0.1 are seen (and refused) by the filter.
      args: ['--proxy-bypass-list=<-loopback>']
    }))
    .then((browser) => {
      sharedBrowser = browser;
      browser.on('disconnected', () => {
        sharedBrowser = null;
      });
      return browser;
    })
    .finally(() => {
      sharedBrowserPromise = null;
    });

  return sharedBrowserPromise;
}

function clampTextForModel(text, maxChars = 12000) {
  const source = String(text || '');
  if (source.length <= maxChars) {
    return { text: source, truncated: false };
  }

  return {
    text: source.slice(0, maxChars) + '\n\n[Content truncated to fit model limits.]',
    truncated: true
  };
}

// Caps simultaneous browser contexts so a burst of requests cannot exhaust memory.
const MAX_CONCURRENT_SCRAPES = Number(process.env.MAX_CONCURRENT_SCRAPES || 3);
let activeScrapes = 0;

// Screenshots are transient: delete anything older than the TTL.
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

app.post('/scrape', scrapeLimiter, async (req, res) => {
  const { url, includeScreenshot = true } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'No URL provided' });
  }

  const urlCheck = await validateScrapeUrl(url);
  if (!urlCheck.ok) {
    return res.status(400).json({ error: urlCheck.reason });
  }

  if (activeScrapes >= MAX_CONCURRENT_SCRAPES) {
    res.set('Retry-After', '5');
    return res.status(503).json({ error: 'Scraper is busy, please retry shortly.' });
  }

  activeScrapes++;
  let context;
  try {
    const browser = await getSharedBrowser();
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(urlCheck.parsedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const content = await page.evaluate(() => {
      // Try to get main content, fallback to body text
      const main = document.querySelector('main');
      return main ? main.innerText : document.body.innerText;
    });

    // Attempt screenshot only when requested; do not fail scrape on image errors.
    let relativeScreenshotPath = null;
    if (includeScreenshot) {
      try {
        const fileName = `${crypto.randomUUID()}.png`;
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, fileName), fullPage: true, timeout: 10000 });
        relativeScreenshotPath = 'screenshots/' + fileName;
      } catch (shotErr) {
        console.warn('Screenshot failed, continuing without image:', shotErr.message);
      }
    }

    res.json({ content, screenshotPath: relativeScreenshotPath });
  } catch (err) {
    const message = String(err.message || '');
    if (message.includes('Executable doesn\'t exist')) {
      console.error('Scrape API error: Playwright browser binaries are not installed.');
      return res.status(500).json({
        error: 'Playwright browser binaries are not installed.',
        fix: 'Run `npx playwright install chromium` inside the backend folder.'
      });
    }
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED/.test(message)) {
      return res.status(502).json({ error: 'The page could not be fetched: the destination is unreachable or blocked (private addresses are not allowed, including via redirects).' });
    }
    console.error('Scrape API error:', message);
    return res.status(500).json({ error: 'Scrape failed' });
  } finally {
    activeScrapes--;
    if (context) {
      await context.close().catch(() => {});
    }
  }
});

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

// Shared LLM API call helper (Groq OpenAI-compatible endpoint)
async function callGroq(messages, temperature = 0.2) {
  try {
    const response = await withRetries(() => axios.post(
      `${GROQ_API_BASE}/chat/completions`,
      {
        model: GROQ_MODEL,
        messages,
        temperature
      },
      {
        timeout: HTTP_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        }
      }
    ), { attempts: 3 });

    return response.data?.choices?.[0]?.message?.content;
  } catch (err) {
    const status = err.response?.status;
    const details = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    const wrapped = new Error(status === 429
      ? `Groq rate limit reached (429): ${details}`
      : `Groq request failed${status ? ` (${status})` : ''}: ${details}`);
    wrapped.status = status;
    throw wrapped;
  }
}

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

// Version service base URL (FastAPI wrapper).
// In Docker, set VERSION_API_BASE to http://chromadb:8001.
const VERSION_API_BASE = process.env.VERSION_API_BASE || 'http://localhost:8001';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maps upstream version-service failures to safe client responses.
function sendVersionError(res, err, label) {
  const upstream = err.response?.status;
  console.error(`${label} error:`, err.message);
  if (upstream === 404) return res.status(404).json({ error: 'Version not found' });
  if (upstream && upstream >= 400 && upstream < 500) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  return res.status(502).json({ error: 'Version service unavailable' });
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Proxy: Add version using Python FastAPI service
app.post('/version', async (req, res) => {
  const { content, editor } = req.body || {};
  // The UI sends "" for a root version; treat empty as absent.
  const parent_version = req.body?.parent_version || null;
  if (!isNonEmptyString(content)) {
    return res.status(400).json({ error: 'content is required' });
  }
  if (parent_version != null && (typeof parent_version !== 'string' || !UUID_RE.test(parent_version))) {
    return res.status(400).json({ error: 'parent_version must be a valid version id' });
  }
  if (editor != null && (typeof editor !== 'string' || editor.length > 100)) {
    return res.status(400).json({ error: 'editor must be a string of at most 100 characters' });
  }

  const payload = { content };
  if (parent_version != null) payload.parent_version = parent_version;
  if (editor != null) payload.editor = editor;

  try {
    const response = await withRetries(
      () => axios.post(`${VERSION_API_BASE}/version`, payload, { timeout: HTTP_TIMEOUT_MS }),
      { attempts: 2 }
    );
    res.json(response.data);
  } catch (err) {
    sendVersionError(res, err, '/version');
  }
});

// Proxy: List version history using Python FastAPI service
app.get('/version/history', async (req, res) => {
  const limit = clampInt(req.query.limit, 50, 1, 200);
  const offset = clampInt(req.query.offset, 0, 0, 1000000);
  try {
    const response = await withRetries(
      () => axios.get(`${VERSION_API_BASE}/version/history`, {
        timeout: HTTP_TIMEOUT_MS,
        params: { limit, offset }
      }),
      { attempts: 2 }
    );
    res.json(response.data);
  } catch (err) {
    sendVersionError(res, err, '/version/history');
  }
});

// Proxy: Get version by ID
app.get('/version/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid version id' });
  }
  try {
    const response = await withRetries(
      () => axios.get(`${VERSION_API_BASE}/version/${req.params.id}`, { timeout: HTTP_TIMEOUT_MS }),
      { attempts: 2 }
    );
    res.json(response.data);
  } catch (err) {
    sendVersionError(res, err, '/version/:id');
  }
});

// Proxy: Restore version
app.post('/version/restore/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid version id' });
  }
  try {
    const response = await withRetries(
      () => axios.post(`${VERSION_API_BASE}/version/restore/${req.params.id}`, {}, { timeout: HTTP_TIMEOUT_MS }),
      { attempts: 2 }
    );
    res.json(response.data);
  } catch (err) {
    sendVersionError(res, err, '/version/restore/:id');
  }
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
  cleanupScreenshots();
  setInterval(cleanupScreenshots, Math.max(60000, Math.floor(SCREENSHOT_TTL_MS / 4))).unref();
  app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

  const shutdown = async () => {
    if (sharedBrowser && sharedBrowser.isConnected()) {
      await sharedBrowser.close().catch(() => {});
    }
    if (guardProxy) await guardProxy.close().catch(() => {});
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
  sanitizeHistory,
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