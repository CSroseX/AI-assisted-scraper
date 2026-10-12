# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branches and direction

`master` is the integration branch; work lands on a feature branch and merges via PR. `dev` and `phase-1` are both **behind** `master` now and are stale — don't branch from them. Run `git fetch` before trusting a local view.

`docs/PLAN.md` is the product direction, and it **pivoted the project**: from a scrape-and-rewrite demo to a **watchdog for ToS/pricing pages** that snapshots URLs on a schedule and alerts on meaningful changes. Phase 0 and Phase 1 steps 0–4 are done and merged.

Its governing principle for new work: **detect deterministically, explain with the LLM** — changes come from a plain diff, the model only classifies and explains, and every claim must quote text present in the diff or be dropped.

### What's built vs. what's left

Built: RL/Chroma cleanup, SQLite storage + watches API, snapshot pipeline, diff engine with noise filtering, persistent scheduler, LLM explainer.

Remaining in Phase 1 — **this is where new work goes**:

- **Step 6, Alerts — storage done, delivery not.** Decided: users choose email, RSS or both per watch. Email goes through nodemailer, configured by env vars, with a test inbox (Ethereal/Mailtrap) during development and a free-tier delivery service later. Email goes to one app-wide address held in settings until accounts exist. RSS is served both per watch and as one global feed. Built: the `alerts` and `feedback` tables, per-watch channel flags, alert queueing, the feedback API, RSS feeds, durable screenshots, and the evidence page each alert links to (see the "Alerts and feedback", "Evidence storage", "Evidence page" and "RSS feeds" sections below). **Still to build:** email sending, which picks up `pending` email alerts.
- **CORS only allows `GET`/`POST`/`OPTIONS`** (`corsOptions.methods` in `index.js`). A browser on another origin cannot call `PATCH`/`DELETE /watches/:id` or `PUT`/`DELETE` feedback. The current chat UI never does, but step 7's UI will.
- **Step 7, UI.** The frontend is **still the original chat demo** and has had no watchdog work at all — no watch list, no change timeline, no diff viewer, no feedback thumbs. Also needs honest failure messaging: many ToS pages sit behind logins or bot protection, and the system should say *why* a page can't be read rather than failing quietly.

The `users` table and snapshot retention/size caps are also unbuilt. Accounts are Phase 2 — there is a single implicit owner for now, and no `users` table.

## Commands

### Frontend (repo root, Create React App)
```bash
npm install
npm start                      # dev server on :3000
npm run build
npm run lint                   # eslint src --max-warnings=0
npm run test:ci                # single run, no watch
npm test -- --watchAll=false -t "renders app title"   # single test by name
```

### Backend (`backend/`, Express + Playwright + SQLite)
```bash
cd backend
npm install
npm start                                  # :5000, starts the scheduler too
npm run dev                                # nodemon
npm test                                   # node:test runner (no jest/mocha); 161 tests
node --test ssrf.test.js                   # single file
node --test --test-name-pattern "isPrivateIPv4" ssrf.test.js   # single test
npm exec playwright install chromium       # required once before scraping works
```

`better-sqlite3` is a native module, so `npm ci` compiles it; CI sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` because no test launches a browser (the scraper is always injected or stubbed).

Set `SCHEDULER_ENABLED=false` to run the API without recurring checks.

### All services
```bash
cp backend/.env.example backend/.env   # then set GROQ_API_KEY
docker-compose up --build
```

### CI
`.github/workflows/ci.yml` runs two jobs on push to `main`/`master`/`dev` and on PRs: **backend** (`npm test`) and **frontend** (`lint` + `test:ci` + `build` with `CI=true`, so warnings fail the build). The python job is gone along with the Python services. Concurrency is grouped per ref with `cancel-in-progress`.

## Architecture

**Two services.** The React frontend talks only to the Express backend.

```
React (:3000)
  └── REACT_APP_API_BASE → Express (:5000) ──┬── Playwright chromium → guard proxy (127.0.0.1, random port)
                                              ├── Groq API (all LLM calls)
                                              └── SQLite (better-sqlite3, DB_PATH)
                                             + scheduler (setInterval heartbeat, state in SQLite)
```

The Flask RL service and the FastAPI/ChromaDB version service were **deleted** (commit `5121ef9`); `backend/chroma_service/` no longer exists. Don't reintroduce either. Version history, thumbs-up/down feedback and change records all belong in SQLite.

### The watchdog pipeline (the product)

`backend/watches.js` → `runCheck(watchId)` is the core, and both the scheduler and `POST /watches/:id/check` call it:

1. Fetch via `scraper.captureSnapshot` (guarded browser, optional CSS selector, full-page screenshot).
2. SHA-256 the extracted text. **If the hash matches the latest snapshot, stop** — no row is written.
3. Otherwise insert a `snapshots` row.
4. If a previous snapshot existed, run `computeDiff`; insert a `changes` row only when `hasMeaningfulChange`, with its `diff_hash` (`hashChanges` in `diff.js`, no LLM).

`runCheck` holds an in-memory per-watch lock: a second check of the same watch while one runs throws `CheckInProgressError` (manual `/check` → 409, scheduler → skipped). Without it, overlapping checks diff against the same old snapshot and record the change twice.

5. Explain the change with the LLM (`explainStoredChange`), writing the result onto the `changes` row.

So `snapshots` rows mean "content changed"; `changes` rows mean "changed in a way that survived noise filtering". The explainer runs only at step 5, after the diff has proved a change — never before.

Text extraction prefers the watch's `selector`, falls back to `<main>`, then `document.body` (`backend/scraper.js`).

### Diff engine (`backend/diff.js`)
Paragraph-level LCS, then noise filtering — no LLM, by design. Paragraphs split on blank lines, whitespace collapsed so rewrapping isn't a change. `NOISE_PATTERNS` drops timestamps, `© <year>` footers, "last updated" lines, live counters and loading text. Returns `{ changes, hasMeaningfulChange }` with unchanged paragraphs dropped.

Per the plan this is **not yet tuned against a real corpus** (20–30 actual ToS/pricing pages) — only synthetic unit tests. Noise filtering is explicitly called "the product", so tuning it against real pages is high-value work.

### Explainer (`backend/explainer.js`)
The LLM half of the principle. Runs only on a diff the engine already proved, and classifies into `price | fees | cancellation | data_use | cosmetic`.

**The model is never asked to quote.** It receives numbered diff paragraphs (`[1] REMOVED: ...`) and replies with `quote_ids`, which we resolve against our own array. A fabricated quote is therefore not merely detected but *impossible to express* — the model can only point at text we already hold. Keep this property if you change the prompt: the moment the model is asked for quote text, the guarantee is gone.

- `validateExplanation` is the gate; nothing reaches storage without passing it. Out-of-range ids are discarded; **no surviving ids means no evidence, so the summary is dropped**; an unknown category becomes `null`; and any `"quoted span"` inside the summary must occur in the diff (this catches a figure invented in prose, e.g. claiming `$15` when the diff only says `$10`→`$12`).
- `explainChange(changes, { callModel })` injects the model call, so **every test runs offline**. Follow that seam — no test should hit the network.
- **Triage is the cost guarantee:** a diff above `EXPLAIN_MAX_PARAGRAPHS` (40) is labelled `layout_change` with **no LLM call at all**, since a redesign is not a price change and no sentence summarises it. A test asserts the model was never called; that assertion *is* the guarantee.
- JSON parsing is defensive (first `{...}` block, try/catch) because models wrap JSON in prose or fences. A parse failure is an unverified explanation, never a throw.
- `EXPLAIN_ENABLED=false` runs detection with no LLM, for working without a `GROQ_API_KEY`.

`explainStoredChange` in `watches.js` is **deliberately best-effort**: the change row is written *first*, then explained, and every failure is caught into `explain_error`. A model outage must never roll back a detection the diff proved — that would break "detect deterministically". `summary` being `NULL` means unexplained or unverified; the diff is still there either way.

`backend/groq.js` holds `callGroq`, `withRetries` and `clampTextForModel` as a leaf module. They used to live in `index.js`, but `index.js` requires `watches.js` which requires `explainer.js`, so keeping them there would be a circular import. `index.js` re-exports them, so existing test imports still work.

### Scheduler (`backend/scheduler.js`)
**Scheduling state lives in SQLite, never in memory** — that's the design constraint. `watches.next_check_at` and `watches.failure_count` are the source of truth; `setInterval` is only a heartbeat that asks the DB what's due, so a restart can't lose state and a watch whose due time passed during downtime runs on the first tick back.

- `tick()` takes `{ now, runCheck, busy, rand }` as injected deps so the whole loop is testable without a browser — keep that seam when extending it.
- Defers entirely while `scraper.scraperBusy()`, and re-checks between watches because a manual `/check` may have taken the last slot.
- Success reschedules one interval out with ±`JITTER_RATIO` jitter so watches created together don't fire in lockstep forever.
- Failure backs off exponentially (capped), and flips `status` to `broken` at `SCHEDULER_MAX_FAILURES`. One failing watch doesn't stop the rest of the batch.
- `PATCH /watches/:id` back to `active` clears `failure_count` and resets `next_check_at` to now, so resuming doesn't leave a watch parked at a far-future due time.
- `GET /scheduler/status` reports per-status counts, due-now count and the next 10 upcoming checks.

### Storage (`backend/db.js`)
Single better-sqlite3 file at `DB_PATH` (`/data/watchdog.db` under Compose, volume `watchdog_data`). WAL mode, `foreign_keys = ON`, so deleting a watch cascades its snapshots, changes, alerts and feedback.

Migrations are two mechanisms: the `MIGRATIONS` array of idempotent `CREATE TABLE IF NOT EXISTS`, plus `ADDED_COLUMNS`, which exists because SQLite has no `ADD COLUMN IF NOT EXISTS` — each entry checks `PRAGMA table_info` before altering. **Add a new column there, not to the `CREATE TABLE` body**, or existing databases won't get it. New tables (e.g. `users`) go in `MIGRATIONS` as a new array entry.

### SSRF defense (`backend/ssrf.js`) — the security boundary
The most carefully built part of the codebase, and the plan calls the hardened scraper the project's core asset. Do not weaken it:

- A `net.BlockList` covers private, loopback, link-local (incl. the `169.254.169.254` cloud-metadata address), CGNAT, multicast, reserved and IPv6 ULA/site-local ranges. Both IP checks **fail closed** on malformed input, and `extractMappedIPv4` unwraps IPv4-mapped IPv6 (`::ffff:a.b.c.d`, including hex form) so a mapped private address cannot slip past.
- `validateHostname` checks **every** resolved address, not just the first, and rejects `localhost`, `.localhost`, `.local`, `.internal`.
- `createGuardProxy` is the key piece. Playwright's request interception is **not re-run for redirects the browser follows internally**, so route-based checks miss "public page → 302 → internal host". All browser traffic is routed through this local forward proxy, so every hop (initial request, redirect, iframe, subresource) is a fresh CONNECT/absolute-form request that gets re-vetted. It then **dials the already-vetted IP**, which also closes the DNS-rebinding window between check and use. Blocked plain-HTTP requests destroy the socket rather than returning an error page, so the browser reports a network error instead of letting an error page be scraped as content.
- Chromium is launched with `--proxy-bypass-list=<-loopback>` because it otherwise bypasses proxies for loopback, which would hide `127.0.0.1` requests from the filter.

Watch creation runs `validateScrapeUrl` up front and stores the normalized URL, so a watch can't be used to smuggle a blocked target past the check.

### Express backend (`backend/index.js`)
- **`/ask` is the router** (legacy demo surface, still live). `classifyIntentHeuristic` runs regex first and only falls back to a Groq classification call when it returns `'chat'`, avoiding an extra LLM round-trip. Intents are exactly `spin | chat | review | summarize`; each maps to a `handleX` that is also its own endpoint. The response carries `_routed_to` so the frontend knows which field (`spun`/`reply`/`reviewed`/`summary`) to read. Adding an intent means touching the heuristic, the classifier prompt, `routeToHandler`, and the frontend's route→field map.
- **Abuse protection**, all env-tunable (see `.env.example`): a global `apiLimiter` plus a tighter `scrapeLimiter`, a JSON body limit, `MAX_CONCURRENT_SCRAPES` rejecting over-cap scrapes with 503 + `Retry-After`, and `cleanupScreenshots` on an interval (`.unref()`'d) expiring files past `SCREENSHOT_TTL_MS`. Note screenshots are **transient by design** — alerts linking to screenshots (step 6) will need a retention policy that outlives this TTL.
- `sendScrapeError` is shared between `/scrape` and the watches pipeline so both report failures consistently. Extend it rather than duplicating error mapping — step 7's honest failure messaging belongs here.
- `sanitizeHistory` bounds and validates chat history before it reaches the model; `clampTextForModel` caps content per call (12000 chars, 8000 for chat context) and reports `truncated`.
- CORS is an explicit allowlist from `CORS_ALLOWED_ORIGINS`; no-`Origin` requests are allowed for health checks/curl. No wildcard path exists.
- `app` is exported and `listen` is guarded by `require.main === module` so tests import without binding a port. The `module.exports` block also re-exports internals purely for unit tests, including `callGroq`, `routeToHandler` and every handler.
- A graceful `SIGINT`/`SIGTERM` shutdown stops the scheduler, closes the browser and guard proxy, then closes the DB.

### Alerts and feedback (`backend/alerts.js`)
Each watch has two on/off flags, `alert_rss` (default on: it needs no setup and sends nothing) and `alert_email` (default off). The API exposes them as `alertChannels: ['email', 'rss']`.

When `runCheck` records a change, `queueAlerts` writes one `alerts` row per enabled channel. **This happens in the same transaction as the snapshot and change inserts.** Writing only the snapshot would make the next check see identical content and stop early, losing the change and its alerts for good. The LLM explanation runs *after* the transaction, so the model stays out of it.

Dedup has two layers:
- **Hard:** a unique index on `(change_id, channel)`. A retry can never queue the same change twice on one channel.
- **Soft:** a repeat of the same `diff_hash` on the same watch and channel within `ALERT_REPEAT_WINDOW_MS` (default 7 days) is stored as `suppressed` instead of `pending`. This stops a page that flips between two versions from alerting every check. Only non-suppressed rows open a window, so a flapping page re-alerts once per window, and a change that genuinely recurs later isn't lost. The check-then-insert is race-free because it runs inside the transaction and under `runCheck`'s per-watch lock.

Alert statuses are `pending | sent | failed | suppressed`, and there are `attempts`/`last_error`/`sent_at` columns ready for email delivery. **An RSS alert is stored as `sent` immediately**, because RSS has no delivery step: being in the feed is being delivered. Email alerts start as `pending`. `feedback` holds one `useful | noise` vote per change (`change_id` UNIQUE, upserted), and it rates the *change*, not the alert. The "fewer than 1 in 3 alerts marked noise" goal in PLAN.md is measured from it.

### Evidence storage (`backend/evidence.js`)
The scraper writes every screenshot to `SCREENSHOT_DIR` (`backend/screenshots`). That folder is **transient**: `cleanupScreenshots` deletes files past `SCREENSHOT_TTL_MS`, and it sits outside the Docker volume. When `runCheck` stores a snapshot, `preserveScreenshot` **copies** its screenshot to `EVIDENCE_DIR`, which defaults to `evidence/` next to `DB_PATH`, so `/data/evidence` on the volume under Compose. It copies rather than renames because the two folders can be on different filesystems. `snapshots.screenshot_path` then holds `evidence/<uuid>.png`.

- The copy happens just before the write transaction. If the transaction fails, `discardEvidence` removes the copy.
- A missing screenshot never fails a check; the snapshot is stored without one.
- Paths are matched against strict `screenshots/<uuid>.png` / `evidence/<uuid>.png` patterns, which rules out path traversal. Use `evidenceFile()` to resolve a stored path; never join one yourself.
- `sweepEvidence` runs with the transient cleanup and deletes evidence no snapshot references, such as a deleted watch's screenshots, once it's older than an hour. The grace period protects a copy whose snapshot is about to be committed.
- At startup, `adoptLegacyScreenshots` moves screenshots of older snapshots out of the transient folder if they still exist, and clears the path if they don't. It runs before the first cleanup, which would otherwise delete them.

### Public links (`backend/publicLinks.js`, `backend/alertContent.js`)
Feeds and evidence pages are opened by feed readers and email clients, not by our frontend, so in deployment they are the only URLs that must be public. They share one secret:

- `requireLinkToken` needs `?token=` to match `LINK_TOKEN` (compared via SHA-256 and `timingSafeEqual`), and returns 503 until `LINK_TOKEN` is set.
- `publicUrl(path)` builds an absolute link from `PUBLIC_BASE_URL` (default `http://localhost:<PORT>`) with the token attached. Emails have no request to take a host from, so links never use `req.host`.
- `escapeMarkup` escapes for both HTML and XML, and drops characters XML 1.0 forbids, since one would break a whole feed. **Every page-derived string goes through it**, because scraped text is untrusted.
- `alertContent.js` holds the wording every channel shares: `alertTitle` ("Price change on host"), `NO_SUMMARY` and `evidenceUrl(changeId)`. Email must use it too, so a change reads the same everywhere.

### Evidence page (`backend/evidencePage.js`)
`GET /evidence/changes/:changeId` is the page every alert links to. It's server-rendered, because alerts needed a working link before the step 7 UI. It shows the summary (or the honest fallback), every changed paragraph, and the before and after versions, each with its capture time, screenshot and full text in a `<details>`. Each screenshot sits in a scroll frame, because full-page captures of long terms pages run to thousands of pixels. `GET /evidence/files/:name` serves the screenshots, resolving names only through `evidenceFile()`.

The page shows scraped content, so it sends a CSP with `default-src 'none'` and **no script source at all**, plus `Referrer-Policy: no-referrer`; otherwise following a link would leak the token. External links also carry `rel="noreferrer"`. Screenshot `src`s are relative (`../files/...`), so the page still works behind a path prefix.

### RSS feeds (`backend/feeds.js`)
`GET /feed.xml` (every watch) and `GET /watches/:id/feed.xml` (one watch), mounted at the app root and guarded by `requireLinkToken`. Each feed renders the latest 50 `sent` RSS alerts as RSS 2.0 on every request. The change's summary is read at render time, so an explanation that lands after the alert still appears. The item `guid` is `watchdog-alert-<alertId>`, which stays stable so a reader never shows an item twice. The item `<link>` opens the evidence page.

- The token is checked before the watch lookup, so ids can't be probed.
- The item body is HTML built from escaped strings and then XML-escaped as a whole, so `<script>` reaches the reader as visible text.
- The body quotes the diff itself, labelled Removed/Added and capped at 6 paragraphs, with links to the evidence page and the live page.

### Watches API
`backend/watches.js`, mounted at `/watches`. `POST` (validates url/frequency/selector/`alertChannels`, runs `validateScrapeUrl`, inserts due-immediately so the scheduler takes the baseline), `GET /`, `GET /:id`, `PATCH /:id` (`status` and/or `alertChannels`; a bad field rejects the whole request), `DELETE /:id`, `GET /:id/snapshots`, `GET /:id/changes` (includes `feedback`), `PUT`/`DELETE /:id/changes/:changeId/feedback`, `GET /:id/alerts`, `POST /:id/check`. `getWatchOr404` centralizes id validation (400 on a malformed id, 404 on a missing one) — reuse it for new routes. Rows are serialized camelCase at the boundary; the DB uses snake_case.

### Frontend layout
~97-line `src/App.js` composing extracted pieces — write new frontend code in that shape:

- `src/config.js` — `API_BASE` + `apiUrl()` helper (the RL base is gone)
- `src/api/client.js` — all `fetch` calls
- `src/hooks/` — `useSessions`, `useScrapeWorkflow` (the chat pipeline), `useWatchCheck`, `useSpunEditor`, `useNotifications`
- `src/components/` — modals, header, chat input, options bar, toast, spun editor
- `src/utils/` — `messages.js` (incl. `findLastIndexByType`), `markdown.js`, `url.js`, `errors.js`

This is still largely the **demo chat UI**: submit URL → `/scrape` → `/spin`, then free-form chat through `/ask`. The version-history and review/feedback hooks were removed with the services behind them. Phase 1 step 7 replaces these screens with watch-centric ones; the hooks/components/utils split is the pattern to follow, not the chat flow itself.

The one watchdog touchpoint is a **"Check for Changes" button** in `OptionsBar`, driving `useWatchCheck`: it creates a watch for the session's URL, runs a check now, and renders the newest change as a `ChangeExplanation` card in the chat. Both that hook and the card are marked disposable in their own comments — step 7 replaces them with a real watchlist and timeline, so don't build on them.

Messages are tagged with a `type` field (`MESSAGE_TYPES` in `src/utils/messages.js`: `'loader'`, `'spunContent'`, `'changeExplanation'`) and the UI finds the relevant one by scanning **backwards** for the last match — keep that convention when adding message kinds.

`Chat` renders a non-string `msg.content` through a plain `<span>`, so a React element can be passed as a message's content. That is how both `SpunEditor` and `ChangeExplanation` are injected without `Chat` knowing about either.

`src/setupTests.js` stubs `HTMLElement.prototype.scrollIntoView` because jsdom lacks it and `Chat` calls it to follow new messages.

## Environment

Backend reads `backend/.env` (gitignored; copy `backend/.env.example`). `GROQ_API_KEY` is required or every LLM endpoint fails. `DB_PATH` must be `/data/watchdog.db` under Compose so the volume persists it. Frontend overrides of `REACT_APP_API_BASE` are **inlined by CRA at build time**, so Docker images need them at build, not run.

`PROJECT_FULL_DOCUMENTATION.md` is gitignored but present locally with detailed API/architecture notes.
