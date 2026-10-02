const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { validateScrapeUrl, createGuardProxy } = require('./ssrf');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

let sharedBrowser = null;
let sharedBrowserPromise = null;
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

// Caps simultaneous browser contexts so a burst of requests cannot exhaust memory.
const MAX_CONCURRENT_SCRAPES = Number(process.env.MAX_CONCURRENT_SCRAPES || 3);
let activeScrapes = 0;

function scraperBusy() {
  return activeScrapes >= MAX_CONCURRENT_SCRAPES;
}

// Fetches a URL through the guarded browser and returns { content, screenshotPath }.
// Throws on navigation/scrape failure; callers map errors to responses.
async function captureSnapshot(url, { includeScreenshot = true, selector = null } = {}) {
  activeScrapes++;
  let context;
  try {
    const browser = await getSharedBrowser();
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const content = await page.evaluate((sel) => {
      const scoped = sel ? document.querySelector(sel) : null;
      if (scoped) return scoped.innerText;
      const main = document.querySelector('main');
      return main ? main.innerText : document.body.innerText;
    }, selector);

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

    return { content, screenshotPath: relativeScreenshotPath };
  } finally {
    activeScrapes--;
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

async function closeScraper() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    await sharedBrowser.close().catch(() => {});
  }
  if (guardProxy) await guardProxy.close().catch(() => {});
}

module.exports = {
  SCREENSHOT_DIR,
  validateScrapeUrl,
  captureSnapshot,
  scraperBusy,
  closeScraper
};
