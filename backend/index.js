const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const axios = require('axios');

app.use(cors());
app.use(express.json());
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

const { chromium } = require('playwright');

app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const content = await page.evaluate(() => {
        // Try to get main content, fallback to body text
        const main = document.querySelector('main');
        return main ? main.innerText : document.body.innerText;
    });

    //screenshot
    const screenshotPath = path.join(__dirname, 'screenshots', `${Date.now()}.png`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await browser.close();

    // Return only the relative path for the frontend
    const relativeScreenshotPath = 'screenshots/' + path.basename(screenshotPath);
    res.json({ content, screenshotPath: relativeScreenshotPath });
});

app.post('/spin', async (req, res) => {
  const { text, prompt = "Rewrite in modern English and simplify the tone." } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  // Debug print for API key
  console.log("GEMINI API KEY:", process.env.GEMINI_API_KEY ? "Loaded" : "NOT LOADED");

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          { role: "user", parts: [ { text: `${prompt}\n\n${text}` } ] }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    // Gemini's response format
    const candidates = response.data.candidates;
    const spun = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts[0].text;
    res.json({ spun, metadata: { prompt, timestamp: Date.now() } });
  } catch (err) {
    console.error("Spin API error:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Contextual chat endpoint for Gemini
app.post('/chat', async (req, res) => {
  const { context, history, userMessage } = req.body;
  if (!context || !userMessage) return res.status(400).json({ error: 'Missing context or user message' });

  // Build the contents array for Gemini
  const contents = [
    { role: "model", parts: [{ text: "Context: " + context }] }
  ];
  if (Array.isArray(history)) {
    for (const msg of history) {
      if (msg.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }
  }
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const candidates = response.data.candidates;
    const reply = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts[0].text;
    res.json({ reply });
  } catch (err) {
    console.error("Chat API error:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// AI Reviewer endpoint for Gemini
app.post('/review', async (req, res) => {
  const { spunContent } = req.body;
  if (!spunContent) return res.status(400).json({ error: 'No spun content provided' });

  const reviewerPrompt = "You are an expert editor and reviewer. Refine and critique the following text for clarity, coherence, and style. Suggest improvements and rewrite as needed.";

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          { role: "model", parts: [{ text: reviewerPrompt }] },
          { role: "user", parts: [{ text: spunContent }] }
        ]
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const candidates = response.data.candidates;
    const reviewed = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts[0].text;
    res.json({ reviewed });
  } catch (err) {
    console.error("Review API error:", err.message, err.response?.data);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// ChromaDB FastAPI service base URL
const CHROMA_API = 'http://localhost:8000';
const VERSIONS_COLLECTION = 'versions2';
let versionsCollectionId = null;

// Helper to get the collection ID (UUID) for 'versions'
async function getVersionsCollectionId() {
  if (versionsCollectionId) return versionsCollectionId;
  const response = await axios.get(`${CHROMA_API}/api/v1/collections`);
  console.log("ChromaDB collections response:", response.data);
  let collections = response.data.collections;
  if (!collections && Array.isArray(response.data)) {
    collections = response.data;
  }
  if (!collections) throw new Error("No collections found in ChromaDB response");
  const collection = collections.find(c => c.name === VERSIONS_COLLECTION);
  if (!collection) throw new Error("Versions collection not found");
  versionsCollectionId = collection.id;
  return versionsCollectionId;
}

// Helper to delete the old versions collection if it exists
async function deleteOldVersionsCollection() {
  const response = await axios.get(`${CHROMA_API}/api/v1/collections`);
  let collections = response.data.collections;
  if (!collections && Array.isArray(response.data)) {
    collections = response.data;
  }
  if (!collections) return;
  const collection = collections.find(c => c.name === VERSIONS_COLLECTION);
  if (collection) {
    await axios.delete(`${CHROMA_API}/api/v1/collections/${collection.id}`);
    versionsCollectionId = null;
    console.log(`Deleted old '${VERSIONS_COLLECTION}' collection.`);
  }
}

// Update ensureVersionsCollection to delete old collection before creating new one
async function ensureVersionsCollection() {
  const response = await axios.get(`${CHROMA_API}/api/v1/collections`);
  let collections = response.data.collections;
  if (!collections && Array.isArray(response.data)) {
    collections = response.data;
  }
  const collection = collections.find(c => c.name === VERSIONS_COLLECTION);
  if (!collection) {
    // Create the collection if it doesn't exist
    await axios.post(`${CHROMA_API}/api/v1/collections`, {
      name: VERSIONS_COLLECTION,
      metadata: { description: "Version history for content" },
      type: "document"
    });
    versionsCollectionId = null; // Reset cache
    console.log(`Created '${VERSIONS_COLLECTION}' collection.`);
  }
}

const CHROMA_PY_API = 'http://localhost:8001';

// Proxy: Add version using Python FastAPI service
app.post('/version', async (req, res) => {
  try {
    const response = await axios.post(`${CHROMA_PY_API}/version`, req.body);
    res.json(response.data);
  } catch (err) {
    console.error("Error in /version:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Proxy: List version history using Python FastAPI service
app.get('/version/history', async (req, res) => {
  try {
    const response = await axios.get(`${CHROMA_PY_API}/version/history`);
    res.json(response.data);
  } catch (err) {
    console.error("Error in /version/history:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Proxy: Get version by ID
app.get('/version/:id', async (req, res) => {
  console.log('HIT /version/:id', req.params.id);
  try {
    const response = await axios.get(`${CHROMA_API}/version/${req.params.id}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Proxy: Restore version
app.post('/version/restore/:id', async (req, res) => {
  try {
    const response = await axios.post(`${CHROMA_API}/version/restore/${req.params.id}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});


app.listen(5000, () => console.log('Server is running on port 5000'));