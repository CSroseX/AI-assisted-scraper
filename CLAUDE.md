# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branches and direction

`master` is the integration branch; work lands on `dev` and merges via PR. **`origin/dev` is ahead of `master`** with a frontend refactor, a test/CI expansion, and `docs/PLAN.md`. Run `git fetch` before trusting a local view — the local checkout has been stale by several commits.

`docs/PLAN.md` (on `dev`) is the product direction and it **pivots the project**: from a scrape-and-rewrite demo to a **watchdog for ToS/pricing pages** that snapshots URLs on a schedule and alerts on meaningful changes. Consequences for anyone touching this code:

- The **Flask RL service is slated for removal** ✅ — the RL approach was dropped (issue #6, closed as not planned). Thumbs up/down become plain stored feedback used to tune thresholds, not a learning signal.
- The **ChromaDB version service is slated for removal** ✅, replaced by SQLite (`users`, `watches`, `snapshots`, `changes`, `alerts`, `feedback`).
- The **Express backend, the hardened scraper, the Groq client and the React shell are keepers.** The scraper hardening is described in the plan as the project's core asset.
- Phase 1 step 0 is explicitly the cleanup of the RL and Chroma services. ✅

So prefer not to invest in the RL or Chroma paths unless asked. Its governing principle for new work: **detect deterministically, explain with the LLM** — changes come from a plain diff, the model only classifies and explains, and every claim must quote text present in the diff or be dropped.

## Commands

### Frontend (repo root, Create React App)
```bash
npm install
npm start                      # dev server on :3000
npm run build
npm run lint                   # eslint src --max-warnings=0   (dev branch)
npm run test:ci                # single run, no watch           (dev branch)
npm test -- --watchAll=false -t "renders app title"   # single test by name
```

### Backend (`backend/`, Express + Playwright)
```bash
cd backend
npm install
npm start                                  # :5000
npm run dev                                # nodemon
npm test                                   # node:test runner (no jest/mocha)
node --test ssrf.test.js                   # single file
node --test --test-name-pattern "isPrivateIPv4" ssrf.test.js   # single test
npm exec playwright install chromium       # required once before /scrape works
```

### Python services (`backend/chroma_service/`)
Two services share this directory with **separate** requirement files; install per service.
```bash
pip install -r requirements-fastapi.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8001   # version service

pip install -r requirements-rl.txt
python rl_backend.py                                    # RL service on :5050

# dev branch adds tests + lint:
pip install -r requirements-test.txt
ruff check backend/chroma_service                       # line-length 120, rules E,F
cd backend/chroma_service && python -m pytest -q
python -m pytest -q tests/test_versions.py::test_name   # single test
```

### All services
```bash
cp backend/.env.example backend/.env   # then set GROQ_API_KEY + CLEAR_API_TOKEN
docker-compose up --build
```

### CI
`.github/workflows/ci.yml` runs three jobs on push to `main`/`master`/`dev` and on PRs: **backend** (`npm test` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`), **python** (`ruff check` + `pytest`), **frontend** (`lint` + `test:ci` + `build` with `CI=true`, so warnings fail the build). The backend job is the only one on `master`; the python and frontend jobs arrive with `dev`.

## Architecture

Four services. The Express backend is the only one the frontend uses for scraping/LLM/versioning; the RL service is called **directly from the browser**.

```
React (:3000)
  ├── REACT_APP_API_BASE  → Express (:5000) ──┬── Playwright chromium → guard proxy (127.0.0.1, random port)
  │                                            ├── Groq API (all LLM calls)
  │                                            └── proxy → FastAPI (:8001) → ChromaDB
  └── REACT_APP_RL_BASE   → Flask RL (:5050)   (review + feedback, bypasses Express)
```

### The pipeline
URL submit drives a fixed chain: `/scrape` → `/spin` (AI Writer, Groq) → `POST /version` as `editor: 'ai-writer'` → RL `/review` (AI Reviewer). Thumbs/feedback POST a reward to RL `/feedback` keyed by `review_id`, re-run `/review`, and save the result as `editor: 'ai-reviewer'`. User edits save as `editor: 'user'` with `parent_version` set to the previous version id.

Messages are tagged with a `type` field (`'loader'`, `'spunContent'`, `'reviewedContent'`) and the UI finds the relevant one by scanning **backwards** for the last match — keep that convention when adding message kinds.

### Frontend layout
On `master` this is one ~800-line `src/App.js`. **On `dev` it is refactored** to ~113 lines that compose extracted pieces — write new frontend code in that shape:

- `src/config.js` — `API_BASE`/`RL_BASE` + `apiUrl()`/`rlUrl()` helpers
- `src/api/client.js` — all `fetch` calls
- `src/hooks/` — `useSessions`, `useScrapeWorkflow` (the pipeline), `useVersionHistory`, `useReviewFeedback`, `useSpunEditor`, `useNotifications`
- `src/components/` — modals, header, chat input, options bar, toast, spun editor
- `src/utils/` — `messages.js` (incl. `findLastIndexByType`), `markdown.js`, `url.js`, `errors.js`

`src/setupTests.js` stubs `HTMLElement.prototype.scrollIntoView` because jsdom lacks it and `Chat` calls it to follow new messages.

### SSRF defense (`backend/ssrf.js`) — the security boundary
Extracted into its own module and the most carefully built part of the codebase. Do not weaken it:

- A `net.BlockList` covers private, loopback, link-local (incl. the `169.254.169.254` cloud-metadata address), CGNAT, multicast, reserved and IPv6 ULA/site-local ranges. Both IP checks **fail closed** on malformed input, and `extractMappedIPv4` unwraps IPv4-mapped IPv6 (`::ffff:a.b.c.d`, including hex form) so a mapped private address cannot slip past.
- `validateHostname` checks **every** resolved address, not just the first, and rejects `localhost`, `.localhost`, `.local`, `.internal`.
- `createGuardProxy` is the key piece. Playwright's request interception is **not re-run for redirects the browser follows internally**, so route-based checks miss "public page → 302 → internal host". All browser traffic is routed through this local forward proxy, so every hop (initial request, redirect, iframe, subresource) is a fresh CONNECT/absolute-form request that gets re-vetted. It then **dials the already-vetted IP**, which also closes the DNS-rebinding window between check and use. Blocked plain-HTTP requests destroy the socket rather than returning an error page, so the browser reports a network error instead of letting an error page be scraped as content.

### Express backend (`backend/index.js`)
- **`/ask` is the router.** `classifyIntentHeuristic` runs regex first and only falls back to a Groq classification call when it returns `'chat'`, avoiding an extra LLM round-trip. Intents are exactly `spin | chat | review | summarize`; each maps to a `handleX` that is also its own endpoint. The response carries `_routed_to` so the frontend knows which field (`spun`/`reply`/`reviewed`/`summary`) to read. Adding an intent means touching the heuristic, the classifier prompt, `routeToHandler`, and the frontend's route→field map.
- **Abuse protection**, all env-tunable (see `.env.example`): a global `apiLimiter` plus a tighter `scrapeLimiter`, a JSON body limit, `MAX_CONCURRENT_SCRAPES` rejecting over-cap scrapes, and `cleanupScreenshots` on an interval (`.unref()`'d) expiring files past `SCREENSHOT_TTL_MS`.
- `sanitizeHistory` bounds and validates chat history before it reaches the model; `clampTextForModel` caps content per call (12000 chars, 8000 for chat context) and reports `truncated`.
- CORS is an explicit allowlist from `CORS_ALLOWED_ORIGINS`; no-`Origin` requests are allowed for health checks/curl. No wildcard path exists.
- `app` is exported and `listen` is guarded by `require.main === module` so tests import without binding a port. The `module.exports` block also re-exports internals purely for unit tests — on `dev` that extends to `callGroq`, `routeToHandler` and every handler.

### Version service (`backend/chroma_service/main.py`)
FastAPI over a ChromaDB `PersistentClient` collection `chapter_versions` at `CHROMA_PERSIST_PATH` (volume `chroma_data`). Restore **appends** a new version whose `parent_version` is the restored id rather than mutating history. `/version/history` returns the **raw ChromaDB shape** (parallel `ids`/`metadatas`/`documents` arrays) which the frontend zips into objects. `parent_version` is `""` not `null` because Chroma metadata rejects nulls. `/version/clear` is gated by `compare_digest` against `CLEAR_API_TOKEN` and is not proxied through Express.

### RL service (`backend/chroma_service/rl_backend.py`)
A two-armed epsilon-greedy bandit (0 = concise, 1 = detailed), **not** a trained model — reviews are templates rendered from word/sentence statistics, no LLM. State (`action_values`, `action_counts`, `review_store`) is in-process and **lost on restart**. Slated for removal per `docs/PLAN.md`.

## Environment

Backend reads `backend/.env` (gitignored; copy `backend/.env.example`). `GROQ_API_KEY` is required or every LLM endpoint fails; `CLEAR_API_TOKEN` must be set for `/version/clear` to work at all. `VERSION_API_BASE` must be `http://chromadb:8001` under Compose, `http://localhost:8001` otherwise. Frontend overrides `REACT_APP_API_BASE`/`REACT_APP_RL_BASE` are **inlined by CRA at build time**, so Docker images need them at build, not run.

`PROJECT_FULL_DOCUMENTATION.md` is gitignored but present locally with detailed API/architecture notes.
