const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');

app.use(cors());
app.use(express.json());
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

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

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  if (sharedBrowserPromise) {
    return sharedBrowserPromise;
  }

  sharedBrowserPromise = chromium.launch()
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

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const normalized = String(ip || '').toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

async function validateScrapeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const blockedHostnames = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (blockedHostnames.has(hostname) || hostname.endsWith('.local')) {
    return { ok: false, reason: 'Local/internal hostnames are not allowed' };
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) {
      return { ok: false, reason: 'Hostname resolution failed' };
    }

    for (const rec of records) {
      const ip = rec.address;
      const family = net.isIP(ip);

      if (
        (family === 4 && isPrivateIPv4(ip)) ||
        (family === 6 && isPrivateIPv6(ip)) ||
        family === 0
      ) {
        return { ok: false, reason: 'Resolved IP is private or loopback and is blocked' };
      }
    }
  } catch {
    return { ok: false, reason: 'Hostname resolution failed' };
  }

  return { ok: true, parsedUrl: parsed.toString() };
}

app.post('/scrape', async (req, res) => {
  const { url, includeScreenshot = true } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const urlCheck = await validateScrapeUrl(url);
    if (!urlCheck.ok) {
      return res.status(400).json({ error: urlCheck.reason });
    }

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
          const screenshotPath = path.join(__dirname, 'screenshots', `${Date.now()}.png`);
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
          await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10000 });
          relativeScreenshotPath = 'screenshots/' + path.basename(screenshotPath);
        } catch (shotErr) {
          console.warn('Screenshot failed, continuing without image:', shotErr.message);
        }
      }

      res.json({ content, screenshotPath: relativeScreenshotPath });
    } catch (err) {
      const isMissingBrowser = String(err.message || '').includes('Executable doesn\'t exist');
      if (isMissingBrowser) {
        return res.status(500).json({
          error: 'Playwright browser binaries are not installed.',
          fix: 'Run `npm.cmd exec playwright install chromium` inside backend folder.'
        });
      }
      console.error('Scrape API error:', err.message);
      return res.status(500).json({ error: err.message || 'Scrape failed' });
    } finally {
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

// The unified /ask endpoint
app.post('/ask', async (req, res) => {
  const { message, content, history = [] } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  let intent = 'chat';
  try {
    intent = await classifyIntent(message);
  } catch (err) {
    console.warn('[/ask] Intent classification failed, falling back to chat:', err.message);
  }

  console.log(`[/ask] intent=${intent} content_chars=${String(content || '').length}`);

  try {
    const result = await routeToHandler(intent, content, message, history);
    console.log(`[/ask] routed_to=${intent} status=success`);
    return res.json({ ...result, _routed_to: intent });
  } catch (err) {
    console.error('[/ask] Handler error:', err.message);
    console.error(`[/ask] routed_to=${intent} status=error`);
    return res.status(500).json({ error: 'Something went wrong', _routed_to: intent });
  }
});

app.post('/spin', async (req, res) => {
  const { text, prompt = "Rewrite in modern English and simplify the tone." } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const result = await handleSpin(text, prompt);
    res.json(result);
  } catch (err) {
    console.error("Spin API error:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Contextual chat endpoint for Groq
app.post('/chat', async (req, res) => {
  const { context, history, userMessage } = req.body;
  if (!context || !userMessage) return res.status(400).json({ error: 'Missing context or user message' });

  try {
    const result = await handleChat(context, userMessage, history);
    res.json(result);
  } catch (err) {
    console.error("Chat API error:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// AI Reviewer endpoint for Groq
app.post('/review', async (req, res) => {
  const { spunContent } = req.body;
  if (!spunContent) return res.status(400).json({ error: 'No spun content provided' });

  try {
    const result = await handleReview(spunContent);
    res.json(result);
  } catch (err) {
    console.error("Review API error:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Summarize endpoint for Groq
app.post('/summarize', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'No content provided' });

  try {
    const result = await handleSummarize(content);
    res.json(result);
  } catch (err) {
    console.error("Summarize API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Version service base URL (FastAPI wrapper).
// In Docker, set VERSION_API_BASE to http://chromadb:8001.
const VERSION_API_BASE = process.env.VERSION_API_BASE || 'http://localhost:8001';

// Proxy: Add version using Python FastAPI service
app.post('/version', async (req, res) => {
  try {
    const response = await withRetries(
      () => axios.post(`${VERSION_API_BASE}/version`, req.body, { timeout: HTTP_TIMEOUT_MS }),
      { attempts: 2 }
    );
    res.json(response.data);
  } catch (err) {
    console.error("Error in /version:", err.message);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Proxy: List version history using Python FastAPI service
app.get('/version/history', async (req, res) => {
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
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
    console.error("Error in /version/history:", err.message);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Proxy: Get version by ID
app.get('/version/:id', async (req, res) => {
  try {
    const response = await withRetries(
      () => axios.get(`${VERSION_API_BASE}/version/${req.params.id}`, { timeout: HTTP_TIMEOUT_MS }),
      { attempts: 2 }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Proxy: Restore version
app.post('/version/restore/:id', async (req, res) => {
  try {
    const response = await withRetries(
      () => axios.post(`${VERSION_API_BASE}/version/restore/${req.params.id}`, {}, { timeout: HTTP_TIMEOUT_MS }),
      { attempts: 2 }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = Number(process.env.PORT || 5000);
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

  const shutdown = async () => {
    if (sharedBrowser && sharedBrowser.isConnected()) {
      await sharedBrowser.close().catch(() => {});
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  app,
  validateScrapeUrl,
  isPrivateIPv4,
  isPrivateIPv6
};