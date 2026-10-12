# AI-Assisted-scraper

## Project Overview
AI-Assisted-scraper is a watchdog for subscription, pricing and terms-of-service pages. You add a URL. The page is checked on a schedule, and when something meaningful changes you get a short, plain-language alert by email or RSS. The alert quotes the changed text and links to a before/after view, so you can check the claim yourself.

Changes are found by a plain text comparison. The AI (Groq) only classifies and explains a change that comparison has already proved, and it can only cite text from the change itself. See [docs/PLAN.md](docs/PLAN.md) for the product plan.

It has a React frontend and a Node.js/Express backend, backed by SQLite.

## Status
- **Backend watchdog: complete for a single user.** It covers watches, scheduled checks, change detection with noise filtering, AI explanations, email and RSS alerts, before/after evidence pages, and useful/noise feedback.
- **Frontend: still the original scrape-and-chat demo.** Watch-centric screens are the next step (Phase 1 step 7). Until then, watches are managed through the API below.
- **Next:** a trial on real pricing and terms pages, to tune the noise filter and the AI explanations against real pages instead of test content.

## Capabilities
- Watches: add, list, pause and delete URLs to watch, checked daily or weekly
- Change detection: a paragraph-level comparison with no AI, which ignores noise such as timestamps, counters and copyright years
- Explanations: one plain-language sentence per change, classified as price, fees, cancellation, data use or cosmetic, and grounded in the changed text
- Alerts by email, RSS, or both, chosen per watch, with repeat alerts suppressed
- An evidence page per change: the exact changed text, and the before and after versions with screenshots
- Feedback: mark each change useful or noise
- A hardened scraper: all browsing goes through a filtering proxy that blocks private and internal addresses, including via redirects
- The original demo: scrape a page, rewrite it with AI, and chat about it

---

## Instructions to Run

### Option 1: Docker Compose (Recommended)

Requirements: Docker and Docker Compose installed.

```bash
# Set up environment
cp backend/.env.example backend/.env  # then set GROQ_API_KEY

# Start all services
docker-compose up --build
```

Services will start in order with health checks:
- Frontend: [http://localhost:3000](http://localhost:3000)
- Backend API: [http://localhost:5000](http://localhost:5000)

### Option 2: Manual Setup (Two Terminals)

#### 1. Frontend (React)
```bash
npm install
npm start
```
- Runs on [http://localhost:3000](http://localhost:3000)

#### 2. Backend (Node.js/Express)
```bash
cd backend
npm install
npm exec playwright install chromium   # once, before the first scrape
cp .env.example .env                   # then set GROQ_API_KEY
npm start
```
- Runs on [http://localhost:5000](http://localhost:5000). It also starts the scheduler and the email sender.
- `backend/.env.example` documents every setting. The ones to know first:
  - `GROQ_API_KEY`: required for AI features. Set `EXPLAIN_ENABLED=false` to detect changes without it.
  - `LINK_TOKEN`: turns on RSS feeds and evidence pages.
  - `EMAIL_TRANSPORT=ethereal`: try email alerts in a throwaway test inbox, with no signup.

---

## Testing

### Run Backend Tests
```bash
cd backend
npm test
```
Tests include:
- SSRF protection (private/reserved IP ranges, IPv4-mapped IPv6, redirect and DNS-rebinding defence via the egress proxy)
- URL credential blocking
- Request validation, body-size limits and rate limiting
- CORS origin parsing
- Watches API, snapshot pipeline, diff engine, scheduler and explainer
- Alerts and dedup, RSS feeds, email delivery and retries, evidence storage and the evidence page

All backend tests run offline: the browser, the AI model and the email server are replaced with test stand-ins.

### Run Frontend Tests
```bash
npm run lint
npm run test:ci
```
Unit tests for the API client, hooks and utilities, plus an integration test that drives the scrape → write → chat flow with the network mocked.

CI (`.github/workflows/ci.yml`) runs both suites, plus lint and a production frontend build, on every pull request and on pushes to `master`.

### Dependency files
- `package.json` (repo root): the React frontend.
- `backend/package.json`: the Node/Express backend.

---

## Watches API

Single fixed owner for now (no accounts yet; see `docs/PLAN.md` Phase 2). All endpoints are on the Express backend.

- `POST /watches` — create a watch. Body: `{ url, frequency: 'daily'|'weekly', selector?, alertChannels? }`. `alertChannels` is any of `['email', 'rss']` and defaults to `['rss']`.
- `GET /watches` — list all watches
- `GET /watches/:id` — get one watch
- `PATCH /watches/:id` — update status and/or alert channels. Body: `{ status?: 'active'|'paused'|'broken', alertChannels?: [...] }`
- `DELETE /watches/:id` — delete a watch and everything recorded for it
- `GET /watches/:id/snapshots` — list stored snapshots (newest first)
- `GET /watches/:id/changes` — list detected changes with their diff and the user's `feedback` (newest first)
- `PUT /watches/:id/changes/:changeId/feedback` — rate a change. Body: `{ vote: 'useful'|'noise' }`. Voting again replaces the vote.
- `DELETE /watches/:id/changes/:changeId/feedback` — clear a change's rating
- `GET /watches/:id/alerts` — list the watch's alerts and their delivery status (newest first)
- `POST /watches/:id/check` — run the snapshot pipeline now: fetch the page, hash its content, store a new snapshot only if the hash changed, and diff it against the previous snapshot if one exists. Active watches are also checked automatically on their own cadence by the scheduler; this endpoint is for triggering a check out of band.

The diff is a deterministic paragraph-level comparison (`backend/diff.js`) with noise filtering for timestamps, counters and copyright-year footers — no LLM is involved in detection.

### Explainer

Once the diff has proved a change, `backend/explainer.js` asks the LLM what kind of change it is (`price`, `fees`, `cancellation`, `data_use`, `cosmetic`) and what it means in one sentence. `GET /watches/:id/changes` then returns `category`, `summary` and `quotes` alongside the raw diff.

The model is never asked to quote. It receives the changed paragraphs numbered, and replies with the numbers its summary rests on; the quoted text is resolved from the stored diff. A quote the model was not given therefore cannot be produced. A summary that asserts a figure absent from the diff is discarded, leaving the change recorded but unexplained.

Cost is bounded by the diff running first: an unchanged page makes no model call at all. A diff larger than `EXPLAIN_MAX_PARAGRAPHS` is recorded as a `layout_change` without calling the model, since a redesign is not a change in terms. Set `EXPLAIN_ENABLED=false` to detect changes without explaining them, which also allows running without a `GROQ_API_KEY`.

### Alerts and RSS feeds

Each detected change raises one alert per channel the watch has switched on. A watch can use RSS, email, both or neither. If the same change repeats on the same watch within `ALERT_REPEAT_WINDOW_MS` (7 days), for example a page flipping between two versions, it is recorded as `suppressed` instead of alerting again.

RSS feeds and evidence pages are off until `LINK_TOKEN` is set. Then:

- `GET /feed.xml?token=<LINK_TOKEN>` — changes across every watched page
- `GET /watches/:id/feed.xml?token=<LINK_TOKEN>` — changes on one page
- `GET /evidence/changes/:changeId?token=<LINK_TOKEN>` — the evidence page every alert links to: the summary, the exact changed paragraphs, and the before and after versions with their screenshots, so you can check the claim yourself

Paste a feed link into a feed reader. The token is the secret part of every link, so treat the links like a password. Set `PUBLIC_BASE_URL` to the address the backend is reached at, so links in feeds and emails point to the right place.

**Email.** Email alerts go to `ALERT_EMAIL_TO` through any SMTP server, set with `SMTP_*` in `backend/.env`. Each email holds the summary, the changed text and the evidence link. It waits for the AI summary (at most 10 minutes) and is retried with growing gaps (1m, 4m, 16m…). After `EMAIL_MAX_ATTEMPTS` tries it is marked `failed`, and the reason is kept on the alert. Until email is configured, alerts wait as `pending` and record which setting is missing.

To try it without signing up anywhere, set `EMAIL_TRANSPORT=ethereal`. Each email goes to a throwaway test inbox, and the server logs a link to view it. Those pages are public, so use a throwaway `LINK_TOKEN` while testing.

### Scheduler

- `GET /scheduler/status` — per-status watch counts, how many are due now, and the next 10 upcoming checks.

Active watches are checked on their `frequency` (daily or weekly) by a scheduler whose state lives in SQLite (`next_check_at`, `failure_count`), so a restart cannot lose it and a watch that came due during downtime runs on the first tick back. Runs are jittered, deferred while the scraper is at its concurrency cap, and backed off exponentially on failure; a watch is marked `broken` after `SCHEDULER_MAX_FAILURES` consecutive failures. Set `SCHEDULER_ENABLED=false` to run the API without recurring checks.

---

## Environment Variables

**Required:**
- `GROQ_API_KEY`: Your Groq API key for AI features

**Optional:**
- `CORS_ALLOWED_ORIGINS`: Comma-separated allowed origins (default: `http://localhost:3000`)
- `GROQ_MODEL`: AI model selection (default: `openai/gpt-oss-20b`)
- `DB_PATH`: SQLite database file path (default: `backend/data/watchdog.db`, use `/data/watchdog.db` in Docker)
- `HTTP_TIMEOUT_MS`: HTTP request timeout in ms (default: 20000)
- `JSON_BODY_LIMIT`: Max JSON request body (default: `1mb`)
- `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`: General per-IP rate limit (default: 60 requests per 60s)
- `SCRAPE_RATE_LIMIT_MAX`: Per-IP limit for `/scrape` per window (default: 10)
- `MAX_CONCURRENT_SCRAPES`: Simultaneous browser scrapes before returning 503 (default: 3)
- `SCREENSHOT_TTL_MS`: How long transient scrape screenshots are kept before cleanup (default: 3600000). Screenshots that back a watch snapshot are kept as evidence for as long as the snapshot exists.
- `EVIDENCE_DIR`: Where those evidence screenshots are stored (default: an `evidence` folder next to `DB_PATH`, so on the Docker volume)
- `TRUST_PROXY`: Set (e.g. `1`) when running behind a reverse proxy so rate limits use the real client IP
- `SCHEDULER_ENABLED`: Set to `false` to run the API without recurring checks (default: enabled)
- `SCHEDULER_TICK_MS`: How often the scheduler asks the database what is due (default: 60000)
- `SCHEDULER_BATCH_SIZE`: Max watches checked per tick (default: 5)
- `SCHEDULER_JITTER_RATIO`: Spread applied to each reschedule so watches do not fire in lockstep (default: 0.1)
- `SCHEDULER_MAX_FAILURES`: Consecutive failures before a watch is marked `broken` (default: 5)
- `SCHEDULER_BACKOFF_BASE_MS` / `SCHEDULER_BACKOFF_MAX_MS`: Exponential retry backoff bounds (defaults: 300000 / 21600000)
- `EXPLAIN_ENABLED`: Set to `false` to record changes without calling the LLM (default: enabled)
- `EXPLAIN_MAX_PARAGRAPHS`: Diffs larger than this are recorded as a layout change without a model call (default: 40)
- `EXPLAIN_MAX_CHARS`: Character budget for the explainer prompt (default: 8000)
- `ALERT_REPEAT_WINDOW_MS`: A repeat of the same change on the same watch within this window is suppressed (default: 604800000, 7 days)
- `LINK_TOKEN`: Secret required in RSS feed and evidence page links; both are off while it is empty
- `PUBLIC_BASE_URL`: Address the backend is reached at, used to build links in feeds and emails (default: `http://localhost:<PORT>`)
- `EMAIL_TRANSPORT`: `smtp` (default) or `ethereal` for a throwaway test inbox
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`: The SMTP server for email alerts (port defaults to 587; 465 uses TLS from the start)
- `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO`: Sender, and the one address that receives every email alert
- `EMAIL_TICK_MS`: How often waiting emails are sent (default: 30000)
- `EMAIL_MAX_ATTEMPTS`: Tries before an email alert is marked `failed` (default: 5)

See `backend/.env.example` for a ready-to-copy template.

---

## Notes

- **Docker Compose**: Services start with health checks; frontend waits for backend readiness
- **Chrome Binary**: First run may require `npm exec playwright install chromium` in backend folder
- **Security**: The scraper's browser only reaches the network through a local egress-filtering proxy that resolves each hostname, refuses private/loopback/link-local/reserved addresses (including via redirects, iframes and subresources), and connects to the vetted IP itself (no DNS-rebinding window). Non-http schemes and embedded credentials are rejected up front. Still deploy the backend without access to internal networks or cloud metadata endpoints as defence in depth.
- **CORS**: Backend requires explicit origin allowlist; wildcard origins are blocked
- **Data Persistence**: The SQLite database and the evidence screenshots are kept on the `watchdog_data` volume in Docker Compose
- **Public links**: Feeds and evidence pages carry `LINK_TOKEN` in their URL, so treat those links like a password. In deployment they are the only URLs that need to be publicly reachable

---

For the product plan and roadmap, see [docs/PLAN.md](docs/PLAN.md). For a detailed architecture walkthrough, see [CLAUDE.md](CLAUDE.md).
