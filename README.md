# AI-Assisted-scraper

## Project Overview
AI-Assisted-scraper is a multi-service application that leverages AI to scrape, process, and review web content. It features a React frontend, a Node.js/Express backend for scraping and AI integration, a FastAPI service for versioning with ChromaDB, and a Flask-based RL backend for reinforcement learning-based review.

## Capabilities
- Scrape web pages and extract main content and screenshots
- Rewrite and simplify content using Groq AI
- Contextual chat and AI-powered review of rewritten content
- Version control for content using ChromaDB (FastAPI)
- Reinforcement learning-based review and feedback (Flask RL backend)

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
- Version Service: [http://localhost:8001](http://localhost:8001)
- RL Service: [http://localhost:5050](http://localhost:5050)

### Option 2: Manual Setup (Four Terminals)

This project requires **four terminals** to run all services simultaneously.

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
  VERSION_API_BASE=http://localhost:8001
  CORS_ALLOWED_ORIGINS=http://localhost:3000
  CLEAR_API_TOKEN=your_secure_token
  # Optional
  GROQ_MODEL=openai/gpt-oss-20b
  HTTP_TIMEOUT_MS=20000
  ```

#### 3. ChromaDB FastAPI Service (Python 3.10+)
```bash
cd backend/chroma_service
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install fastapi uvicorn chromadb pydantic
python -m uvicorn main:app --host 0.0.0.0 --port 8001
```
- Runs on [http://localhost:8001](http://localhost:8001)

#### 4. RL Backend (Flask Service)
```bash
cd backend/chroma_service
# Use same venv as step 3, or create new:
pip install flask flask-cors numpy
python rl_backend.py
```
- Runs on [http://localhost:5050](http://localhost:5050)

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

### Run Frontend Tests
```bash
npm run lint
npm run test:ci
```
Unit tests for the API client, hooks and utilities, plus an integration test that drives the full scrape → write → review → chat flow with the network mocked.

### Run Python Service Tests
```bash
pip install -r backend/chroma_service/requirements-test.txt
ruff check backend/chroma_service
cd backend/chroma_service && python -m pytest
```
Covers the version service (FastAPI + ChromaDB) and the RL review service (Flask).

CI (`.github/workflows/ci.yml`) runs all three suites plus lint and a production frontend build.

### Dependency files
- `package.json` (repo root): the React frontend.
- `backend/package.json`: the Node/Express backend.
- `backend/requirements.txt`: installs both Python services for local development. Each service also has its own pinned file in `backend/chroma_service/` (`requirements-fastapi.txt`, `requirements-rl.txt`) used by its Docker image; `requirements-test.txt` adds test/lint tools.

---

## Environment Variables

**Required:**
- `GROQ_API_KEY`: Your Groq API key for AI features

**Optional:**
- `CORS_ALLOWED_ORIGINS`: Comma-separated allowed origins (default: `http://localhost:3000`)
- `GROQ_MODEL`: AI model selection (default: `openai/gpt-oss-20b`)
- `VERSION_API_BASE`: Version service URL (default: `http://localhost:8001`, use `http://chromadb:8001` in Docker)
- `CLEAR_API_TOKEN`: Token for `/version/clear` endpoint (required to clear version history)
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
- **Data Persistence**: ChromaDB data is persisted via `chroma_data` volume in Docker Compose

---

For detailed architecture and API documentation, see [PROJECT_FULL_DOCUMENTATION.md](PROJECT_FULL_DOCUMENTATION.md).
