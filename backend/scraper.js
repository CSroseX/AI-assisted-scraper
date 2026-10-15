const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { validateScrapeUrl, createGuardProxy } = require('./ssrf');
const { PageUnreadableError, classifyPage } = require('./failures');
const { checkRobots } = require('./robots');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

// A scraper owns one browser and the guard proxy all of its traffic goes
// through. The app uses the default instance below. Tests construct their own
// with `guardProxy`, built by createGuardProxy with injected DNS and dialling,
// so the real egress rules run against local fixture pages.
function createScraper({ guardProxy: injectedGuardProxy = null } = {}) {
  let sharedBrowser = null;
  let sharedBrowserPromise = null;
  let guardProxy = null;
  let guardProxyPromise = null;

  function startGuardProxy() {
    if (!guardProxyPromise) {
      guardProxy = injectedGuardProxy || createGuardProxy();
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

  // Widgets that only a bot check shows as its main content. Not a general
  // captcha match: real pages carry invisible reCAPTCHA on their forms.
  const CHALLENGE_SELECTOR = [
    '#challenge-form', '#challenge-running', '#cf-challenge-running', '.cf-browser-verification',
    'iframe[src*="challenges.cloudflare.com"]', '[id^="px-captcha"]'
  ].join(', ');

  // Fetches a URL through the guarded browser and returns { content, screenshotPath }.
  // Throws on navigation/scrape failure; callers map errors to responses.
  // Throws PageUnreadableError when the page loaded but isn't the real page (a
  // bot check, a login wall, an error page, no text), so it is never stored, and
  // when the site's robots.txt asks visitors not to read it (unless
  // `respectRobots` is false).
  async function captureSnapshot(url, { includeScreenshot = true, selector = null, respectRobots = true } = {}) {
    activeScrapes++;
    let context;
    try {
      const browser = await getSharedBrowser();
      context = await browser.newContext();
      const page = await context.newPage();
      if (respectRobots) {
        // robots.txt is read through the same guarded browser as the page.
        await checkRobots(url, {
          fetchRobots: async (robotsUrl) => {
            const res = await page.goto(robotsUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
            return res ? { status: res.status(), text: await res.text() } : null;
          }
        });
      }
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      const read = await page.evaluate(({ sel, challengeSelector }) => {
        const scoped = sel ? document.querySelector(sel) : null;
        const root = scoped || document.querySelector('main') || document.body;
        // Only what is being watched counts: a hidden login pop-up elsewhere on
        // a real page must not make it look like a login wall.
        const visible = (el) => el.getClientRects().length > 0;
        return {
          content: root ? root.innerText : '',
          title: document.title,
          selectorMatched: !!scoped,
          hasPasswordField: !!root && [...root.querySelectorAll('input[type="password"]')].some(visible),
          hasChallengeElement: !!root && !!root.querySelector(challengeSelector)
        };
      }, { sel: selector, challengeSelector: CHALLENGE_SELECTOR });
      const { content } = read;

      const failure = classifyPage({ ...read, text: content, status: response ? response.status() : null });
      if (failure) throw new PageUnreadableError(failure.reason, failure.detail);

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

  return { captureSnapshot, scraperBusy, closeScraper };
}

const { captureSnapshot, scraperBusy, closeScraper } = createScraper();

module.exports = {
  SCREENSHOT_DIR,
  createScraper,
  validateScrapeUrl,
  captureSnapshot,
  scraperBusy,
  closeScraper
};
