# AI-Assisted-scraper

## Project Overview
AI-Assisted-scraper is moving from a scrape-and-rewrite demo toward a watchdog for ToS/pricing pages: add a URL, it is checked on a schedule, and meaningful changes raise a quoted, plain-language alert. See [docs/PLAN.md](docs/PLAN.md) for the full product plan. It features a React frontend and a Node.js/Express backend (scraping, AI integration, watches API) backed by SQLite.

## Capabilities
- Scrape web pages and extract main content and screenshots
- Rewrite and simplify content using Groq AI
- Contextual chat with the scraped content
- Watches API: create, list, pause and delete URL watches, stored in SQLite
- Snapshot pipeline: hash-gated snapshots of a watched page's content
- Change explanations: plain-language summaries with quoted evidence from the page
- Deterministic paragraph-level diff engine (no LLM) between snapshots

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
npm start
```
- Runs on [http://localhost:5000](http://localhost:5000)
- Create `.env` file with:
  ```
  GROQ_API_KEY=your_groq_api_key
  CORS_ALLOWED_ORIGINS=http://localhost:3000
  # Optional
  GROQ_MODEL=openai/gpt-oss-20b
  HTTP_TIMEOUT_MS=20000
  DB_PATH=./data/watchdog.db
  ```

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

### Run Frontend Tests
```bash
npm run lint
npm run test:ci
```
Unit tests for the API client, hooks and utilities, plus an integration test that drives the scrape → write → chat flow with the network mocked.

CI (`.github/workflows/ci.yml`) runs both suites plus lint and a production frontend build.

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

RSS feeds are off until `FEED_TOKEN` is set. Then:

- `GET /feed.xml?token=<FEED_TOKEN>` — changes across every watched page
- `GET /watches/:id/feed.xml?token=<FEED_TOKEN>` — changes on one page

Paste either link into a feed reader. The token is the secret part of the link, so treat the link like a password. Email delivery is not built yet; email alerts are recorded as `pending`.

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
- `SCREENSHOT_TTL_MS`: How long screenshots are kept before cleanup (default: 3600000)
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
- `FEED_TOKEN`: Secret required in RSS feed links; feeds are off while it is empty

See `backend/.env.example` for a ready-to-copy template.

---

## Notes

- **Docker Compose**: Services start with health checks; frontend waits for backend readiness
- **Chrome Binary**: First run may require `npm exec playwright install chromium` in backend folder
- **Security**: The scraper's browser only reaches the network through a local egress-filtering proxy that resolves each hostname, refuses private/loopback/link-local/reserved addresses (including via redirects, iframes and subresources), and connects to the vetted IP itself (no DNS-rebinding window). Non-http schemes and embedded credentials are rejected up front. Still deploy the backend without access to internal networks or cloud metadata endpoints as defence in depth.
- **CORS**: Backend requires explicit origin allowlist; wildcard origins are blocked
- **Data Persistence**: SQLite database is persisted via the `watchdog_data` volume in Docker Compose

---

For detailed architecture and API documentation, see [PROJECT_FULL_DOCUMENTATION.md](PROJECT_FULL_DOCUMENTATION.md).
