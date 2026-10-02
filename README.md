# AI-Assisted-scraper

## Project Overview
AI-Assisted-scraper is moving from a scrape-and-rewrite demo toward a watchdog for ToS/pricing pages: add a URL, it is checked on a schedule, and meaningful changes raise a quoted, plain-language alert. See [docs/PLAN.md](docs/PLAN.md) for the full product plan. It features a React frontend and a Node.js/Express backend (scraping, AI integration, watches API) backed by SQLite.

## Capabilities
- Scrape web pages and extract main content and screenshots
- Rewrite and simplify content using Groq AI
- Contextual chat with the scraped content
- Watches API: create, list, pause and delete URL watches, stored in SQLite
- Snapshot pipeline: hash-gated snapshots of a watched page's content
- Deterministic paragraph-level diff engine (no LLM) between snapshots

---

## Instructions to Run

### Option 1: Docker Compose (Recommended)

Requirements: Docker and Docker Compose installed.

```bash
# Set up environment
cp backend/.env.example backend/.env  # then set GROQ_API_KEY and CLEAR_API_TOKEN

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
- Watches API, snapshot pipeline and diff engine

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
