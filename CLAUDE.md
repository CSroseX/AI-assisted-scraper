# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branches and direction

`master` is the integration branch; work lands on a feature branch off an up-to-date `master` and merges via PR. The `protect-master` ruleset enforces this with no bypass for anyone: no direct pushes or force pushes, squash merges only, and `backend (node)` and `frontend (react)` must pass on a branch that is up to date with `master`. Merged branches (`Schedular`, `explainer`, `alerts`) and the stale `dev`/`phase-1` may still exist locally or on the remote. Don't branch from them. Run `git fetch` before trusting a local view.

The GitHub CLI is installed at `C:\Program Files\GitHub CLI\gh.exe` and logged in as `CSroseX` with `repo` and `workflow` scopes, so use it for PRs and CI status (`gh run list`). A shell that started before it was installed won't have it on `PATH`; call it by full path (`"/c/Program Files/GitHub CLI/gh.exe"` from Git Bash). Cloud sessions have no `gh`; they use the claude.ai GitHub connector, which can read the repo, open PRs and merge them.

`docs/PLAN.md` is the product direction, and it **pivoted the project**: from a scrape-and-rewrite demo to a **watchdog for ToS/pricing pages** that snapshots URLs on a schedule and alerts on meaningful changes. Phase 0 and Phase 1 steps 0–6 are done and merged; alerts landed in PR #12 on 2026-10-12, and CI is green.

Its governing principle for new work: **detect deterministically, explain with the LLM** — changes come from a plain diff, the model only classifies and explains, and every claim must quote text present in the diff or be dropped.

### Where we are (2026-10-13)

The **backend watchdog is complete for one user**:
- SQLite storage and the watches API
- the snapshot pipeline, and the diff engine with noise filtering
- the persistent scheduler
- the grounded LLM explainer
- alerts: per-watch email/RSS channels, two-layer dedup, RSS feeds, email with retries, durable evidence screenshots, and an evidence page per change
- useful/noise feedback per change
- hardening (PRs #52–#56): CORS allows `PATCH`/`PUT`/`DELETE`; `helmet` security headers; `.dockerignore` files; Docker images pinned by digest and running as non-root; a CI job that builds and runs the Docker stack; and 0 known vulnerabilities in backend production dependencies

The backend has 183 tests, all offline.

The roadmap lives in GitHub issues #14–#49, in three milestones: "Phase 1: works for you", "Testing and security" and "Phase 2: production". Issues labelled `Automated` are worked by the routine in "Automated issues" below.

**Nothing has been run against real pages yet.** Every test uses synthetic content, so whether the noise filter and the explainer work on real ToS and pricing pages is unproven. The frontend is the watched pages screen from step 7; the chat demo is gone.

Step 6 decisions, for context:
- Users choose email, RSS or both per watch.
- Email goes through nodemailer, configured by env vars: Ethereal during development, then a free-tier SMTP provider.
- Email goes to one app-wide address until accounts exist.
- RSS is served per watch and as one global feed.

### Next up — this is where new work goes

The owner's approach: small, testable features first, and production tooling only after. Prefer free tiers of production-grade services; nothing that costs money without asking.

**1. Real-page trial (start now; it runs for days or weeks).** This is how PLAN.md's "done when" criteria get measured:
- a real change produces a correct, quoted alert within one interval;
- fewer than 1 in 3 alerts are noise;
- a page unchanged for 30 days produces zero alerts.

Steps:
- Pick 15–20 real ToS/pricing pages. Mix big SaaS, streaming and telecom, and include a few known to sit behind logins or bot protection.
- Add them as watches with `alertChannels: ['email', 'rss']`, and run the backend with `EMAIL_TRANSPORT=ethereal` and a **throwaway** `LINK_TOKEN`.
- Rate every change `useful` or `noise` through the feedback API, because the noise ratio is computed from those ratings.
- Log findings per page in `docs/TRIAL.md`, which doesn't exist yet; create it when the trial starts. Record whether the page was readable, why not if not, each noise alert and its cause, and whether the summary was right.
- The first task is a small script that adds the trial watches. It must use the API, so every URL goes through `validateScrapeUrl` and the guarded scraper. Never bypass `ssrf.js`.
- Real scraping needs `npm exec playwright install chromium` once.

**2. Step 7, UI: built** (#16, #17, #18, #19, #21): the watch list with an add form, a change timeline per page, token-free snapshot routes, plain failure reasons, and the chat demo removed. Two design constraints still hold for any new screen:
- The evidence page and `/evidence/files` need `LINK_TOKEN`, and CRA inlines `REACT_APP_*` into the public bundle, so the frontend must **not** carry that token. CI fails the build if it does. Render evidence from the watches API instead.
- A route the frontend loads in an `<img>` must send `Cross-Origin-Resource-Policy: cross-origin`, as `GET /watches/:id/snapshots/:snapshotId/screenshot` does. `helmet`'s default is `same-origin`, and that blocks an `<img>` on the frontend's origin (:3000 vs :5000).

**3. Tune from the trial findings:**
- Extend `NOISE_PATTERNS` in `diff.js` and the explainer prompt.
- Turn every real noise case into a unit-test fixture, so a fix can't silently regress.

**4. Open decisions (the owner's):**
- Should `cosmetic` changes alert at all? They do today. Skipping them would cut noise but trusts the LLM's label.
- Hosting target (PLAN.md §7).

**5. Before anyone else uses it (Phase 2 prep).** The Docker image work is done (#38): a working Chromium, pinned base images, non-root users, and secrets kept out. Still to do:
- free-tier hosting with HTTPS, and a free-tier SMTP provider;
- database and evidence backups, plus snapshot retention and size caps (unbuilt);
- the `users` table and accounts. There's a single implicit owner today.
- Respecting robots.txt and polite intervals (PLAN.md risk 3) is also unbuilt.

## Automated issues

Open issues labelled `Automated` are worked by a scheduled routine: every 6 hours, a fresh session, no owner in the loop. This section is the routine's contract; its prompt only points here. An interactive session working an `Automated` issue follows it too. Only the owner adds or removes the `Automated` label.

### One run
1. **Maintain before starting.** At most one open PR from an `automated/` branch may be in flight, not counting PRs labelled `needs-owner`. If one exists: merge `master` into it (a merge commit, never a rebase), fix red CI, answer every open review thread, then merge it if it qualifies (see "Merge or stop") and end the run without starting new work.
2. **Answered questions.** For each `needs-owner` PR where the owner has replied after the routine's question, act on the answer, remove the label, and treat it as the PR in flight.
3. **A red `master` comes first.** If CI on `master` went red after an automated merge, open and merge a revert of that merge before anything else.
4. **Pick the next issue:** open, labelled `Automated`, with no open PR from any branch that references it, no closed-unmerged PR from `automated/issue-<N>` (that means the owner rejected it), and no merged one (on a partial issue, the automatable part is done). Order: #15, #28, #35, #25, #24, #32, #30, #29, #19, #47, #38, #39, #33, then any other `Automated` issue, lowest number first. #35 goes before the other Docker issues so CI builds the images before they change.
5. **Research, then plan.** Read the issue and its comments, docs/PLAN.md, the sections of this file that cover the code involved, and that code and its tests. Write a plan before editing: files, rough size, approach, and what is out of scope.
6. **Build it** on `automated/issue-<N>` from a fresh `origin/master`, validate, self-review, push, open the PR, then merge or stop.

### Size and scope
- Make the smallest change that meets the acceptance criteria. Touch only the files in the plan; an unplanned file needs a reason in the PR.
- No drive-by refactors, renames, reformatting, dependency bumps, or fixes that belong to another issue.
- Above about 300 changed lines of non-test, non-lockfile code, split the work into issue-sized steps or stop for the owner.

Some issues are only partly automatable. Do this part, list the rest under "Out of scope", and start the PR body with `Part of #N` instead of `Closes #N`, so merging leaves the issue open for the remaining work:
- **#32:** `dependabot.yml`, a CodeQL workflow, and `npm audit --omit=dev --audit-level=high` for `backend/` only; the frontend audit waits on #31. No repository settings.
- **#29:** code and tests only. The hosting-specific `TRUST_PROXY` documentation waits on #23.
- **#19:** backend only. Showing the message in the UI waits on #16.

### Code
- Match the surrounding style, naming and comment density, and the patterns this file describes: `ADDED_COLUMNS` for new columns, injected seams for tests, `getWatchOr404`, `failureResponse`, `escapeMarkup`.
- No comments about the change or its history ("fixed for #15", "added by Claude"), no TODOs, no commented-out code, no leftover debug logging.
- Every behaviour change gets a test, and no test touches the network.

### Before pushing
- In `backend/`: `npm ci` and `npm test`. If frontend files changed, at the root: `npm ci`, `npm run lint`, `npm run test:ci` and `CI=true npm run build`.
- Run the `code-review` skill on the diff, fix what it finds, and re-check the size against the plan.

### Merge or stop
Squash-merge when CI is green on a branch up to date with `master`, the self-review is clean, and no review thread is open.

Stop for the owner only when:
- the issue, PLAN.md and this file leave a real trade-off open;
- the fix needs money, an account, a secret or a repository setting;
- the acceptance criteria can't be met as written;
- the change is still over the size limit after splitting;
- it changes the behaviour of `backend/ssrf.js`.

To stop, label the PR `needs-owner` and post one comment that asks the question as options, recommendation first. Then the next issue can start.

### PR description
Fill in `.github/pull_request_template.md`, starting with `Closes #N` (or `Part of #N` for a partial issue). A reader who never opened the issue should understand what was wrong and what changed.

### Run report
A run that implements or merges a fix ends its session (not GitHub) with a report that teaches the owner:
1. **What the issue meant:** the concept behind it and why it matters for this project.
2. **How it was reasoned:** the options considered and why this one won.
3. **How it's usually done:** common industry practice and tools for this kind of problem.
4. **The edits, walked through:** each meaningful change, what it does and the idea behind it.
5. **Takeaways:** two or three points worth remembering.

It closes with the PR link and its state: merged, or `needs-owner` with the question. A run that only maintained a PR or found nothing to do ends with two or three lines.

## Commands

### Frontend (repo root, Create React App)
```bash
npm install
npm start                      # dev server on :3000
npm run build
npm run lint                   # eslint src --max-warnings=0
npm run test:ci                # single run, no watch
npm test -- --watchAll=false -t "plain reason"   # single test by name
```

### Backend (`backend/`, Express + Playwright + SQLite)
```bash
cd backend
npm install
npm start                                  # :5000, starts the scheduler and the email sender too
npm run dev                                # nodemon
npm test                                   # node:test runner (no jest/mocha); 183 tests
node --test ssrf.test.js                   # single file
node --test --test-name-pattern "isPrivateIPv4" ssrf.test.js   # single test
npm run test:browser                       # real Chromium + guard proxy on fixture pages; needs the browser installed
npm exec playwright install chromium       # required once before scraping works
```

`better-sqlite3` is a native module that ships prebuilt binaries. The backend Docker image runs `npm ci --omit=dev --ignore-scripts` and loads the bundled Linux binary, because the image has no compiler.

The backend CI job sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` because no unit test launches a browser; the scraper is always injected or stubbed. Real scrapes run in two places: `browser-tests/scraper.browser.js` (`npm run test:browser`), and the Docker CI job. The browser test builds its own scraper with `createScraper({ guardProxy })`, passing a guard proxy with injected DNS and dialling. That way fixture pages on loopback are reachable as a fake public host, while the proxy's real rules still block loopback, private and metadata targets and redirects to them. There is deliberately no environment variable for this.

Set `SCHEDULER_ENABLED=false` to run the API without recurring checks.

### All services
```bash
cp backend/.env.example backend/.env   # then set GROQ_API_KEY
docker-compose up --build
```

The images:
- **Backend** (`backend/dockerfile`): `mcr.microsoft.com/playwright` pinned by digest, running as `pwuser`, with `/data` owned by that user so the named volume is writable. **Its tag must match the `playwright` version in `backend/package-lock.json`**, because the bundled Chromium has to be the one that package expects. Bump both together.
- **Frontend** (`dockerfile`): two stages, both pinned by digest. `node:*-alpine` runs `npm run build` as `node`, with `REACT_APP_API_BASE` as a build argument. `nginxinc/nginx-unprivileged` then serves only the built files as a non-root user on port 8080 (`nginx.conf`), which Compose maps to :3000.
- `.dockerignore` files keep `.env`, the database, screenshots and `node_modules` out of both build contexts.

### CI
`.github/workflows/ci.yml` runs on PRs and on pushes to `main`/`master`/`dev`. `main` and `dev` no longer exist on the remote, so in practice that means `master` and PRs. Concurrency is grouped per ref with `cancel-in-progress`. There are four jobs:
- **backend:** `npm test`.
- **browser (playwright):** installs Chromium and runs `npm run test:browser`: one successful scrape, plus blocked loopback, private-DNS and redirect targets and a robots.txt refusal.
- **frontend:** `lint` + `test:ci` + `build` with `CI=true`, so warnings fail the build.
- **docker (compose):** builds both images, starts the stack and waits for health. It then adds this repo's README (on raw.githubusercontent.com) as a watch, checks it *inside* the backend container, and reads the stored snapshot back, and checks that the backend runs as non-root and can write `/data`. It's the only job that runs the browser inside the image, so it catches a Playwright/image version mismatch.

The `protect-master` ruleset requires only `backend (node)` and `frontend (react)`, so **a red `docker (compose)` does not block a merge**. Treat a red docker job as blocking anyway.

## Architecture

**Two services.** The React frontend talks only to the Express backend.

```
React (:3000)
  └── REACT_APP_API_BASE → Express (:5000) ──┬── Playwright chromium → guard proxy (127.0.0.1, random port)
                                              ├── Groq API (all LLM calls)
                                              ├── SQLite (better-sqlite3, DB_PATH) + evidence/ screenshots beside it
                                              └── SMTP server (nodemailer; Ethereal in development)
                                             + scheduler and email sender (setInterval heartbeats, state in SQLite)

Feed readers and email clients ──→ /feed.xml, /watches/:id/feed.xml, /evidence/...   (?token=LINK_TOKEN)
```

The Flask RL service and the FastAPI/ChromaDB version service were **deleted** (commit `5121ef9`); `backend/chroma_service/` no longer exists. Don't reintroduce either. Version history, thumbs-up/down feedback and change records all belong in SQLite.

### The watchdog pipeline (the product)

`backend/watches.js` → `runCheck(watchId)` is the core, and both the scheduler and `POST /watches/:id/check` call it:

1. Fetch via `scraper.captureSnapshot`: a guarded browser, an optional CSS selector and a full-page screenshot.
2. SHA-256 the extracted text. **If the hash matches the latest snapshot, stop.** No row is written.
3. Copy the screenshot into evidence storage (`preserveScreenshot`).
4. **In one transaction:**
   - insert the `snapshots` row;
   - if a previous snapshot existed, run `computeDiff`;
   - when `hasMeaningfulChange`, insert a `changes` row with its `diff_hash` (`hashChanges` in `diff.js`, no LLM), then `queueAlerts` one alert per enabled channel.

   If the transaction fails, the evidence copy is discarded.
5. After commit, explain the change with the LLM (`explainStoredChange`), which writes the result onto the `changes` row.

Delivery happens outside `runCheck`. RSS alerts are published the moment they are inserted, and `emailAlerts.js` sends `pending` email alerts on its own heartbeat.

`runCheck` holds an in-memory per-watch lock. A second check of the same watch while one runs throws `CheckInProgressError`: manual `/check` answers 409, and the scheduler skips it. Without the lock, overlapping checks diff against the same old snapshot and record the change twice.

So `snapshots` rows mean "content changed", and `changes` rows mean "changed in a way that survived noise filtering". The explainer runs only at step 5, after the diff has proved a change, never before.

Text extraction prefers the watch's `selector`, falls back to `<main>`, then `document.body` (`backend/scraper.js`).

**A page that loaded but isn't the real page is a failure, never a snapshot.** `captureSnapshot` passes the HTTP status, the title, the text, whether the selector matched, and whether a visible password field or a challenge widget sits inside the watched part to `classifyPage` in `backend/failures.js`. It throws `PageUnreadableError` on a bot check, a login wall, a bare 403, a 404, any other HTTP error, or no text. Status and challenge rules apply only to short pages (under 3000 characters), since a long page is real content whatever its status says. Stored, such a page would turn into a false "change" when the real page came back. `classifyError` maps every check error to a reason code (`login_required`, `access_denied`, `bot_protection`, `not_found`, `http_error`, `timeout`, `blocked_address`, `unreachable`, `no_text`, `unknown`). The watch stores it in `last_error_reason`, and the API returns it with a plain message as `lastErrorReason`/`lastErrorMessage`. `last_error` keeps the technical detail. `failureResponse` gives `POST /watches/:id/check` its answer: 502 when the page is at fault, 500 when we are (no browser, a database error).

### Diff engine (`backend/diff.js`)
Paragraph-level LCS, then noise filtering — no LLM, by design. Paragraphs split on blank lines, whitespace collapsed so rewrapping isn't a change. `NOISE_PATTERNS` drops timestamps, `© <year>` footers, "last updated" lines, live counters and loading text. Returns `{ changes, hasMeaningfulChange }` with unchanged paragraphs dropped.

Per the plan this is **not yet tuned against a real corpus** (20–30 actual ToS/pricing pages); it has only synthetic unit tests. Noise filtering is explicitly called "the product", so this is what the real-page trial in "Next up" exists to fix.

### Explainer (`backend/explainer.js`)
The LLM half of the principle. Runs only on a diff the engine already proved, and classifies into `price | fees | cancellation | data_use | cosmetic`.

**The model is never asked to quote.** It receives numbered diff paragraphs (`[1] REMOVED: ...`) and replies with `quote_ids`, which we resolve against our own array. A fabricated quote is therefore not merely detected but *impossible to express* — the model can only point at text we already hold. Keep this property if you change the prompt: the moment the model is asked for quote text, the guarantee is gone.

- `validateExplanation` is the gate; nothing reaches storage without passing it. Out-of-range ids are discarded; **no surviving ids means no evidence, so the summary is dropped**; an unknown category becomes `null`; and any `"quoted span"` inside the summary must occur in the diff (this catches a figure invented in prose, e.g. claiming `$15` when the diff only says `$10`→`$12`).
- `explainChange(changes, { callModel })` injects the model call, so **every test runs offline**. Follow that seam — no test should hit the network.
- **Triage is the cost guarantee:** a diff above `EXPLAIN_MAX_PARAGRAPHS` (40) is labelled `layout_change` with **no LLM call at all**, since a redesign is not a price change and no sentence summarises it. A test asserts the model was never called; that assertion *is* the guarantee.
- JSON parsing is defensive (first `{...}` block, try/catch) because models wrap JSON in prose or fences. A parse failure is an unverified explanation, never a throw.
- `EXPLAIN_ENABLED=false` runs detection with no LLM, for working without a `GROQ_API_KEY`.

`explainStoredChange` in `watches.js` is **deliberately best-effort**: the change row is written *first*, then explained, and every failure is caught into `explain_error`. A model outage must never roll back a detection the diff proved — that would break "detect deterministically". `summary` being `NULL` means unexplained or unverified; the diff is still there either way.

`backend/groq.js` holds `callGroq`, `withRetries` and `clampTextForModel` as a leaf module. They used to live in `index.js`, but `index.js` requires `watches.js` which requires `explainer.js`, so keeping them there would be a circular import. Their tests import them from `groq.js` (`groq.test.js`).

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
- **Abuse protection**, all env-tunable (see `.env.example`): a global `apiLimiter` plus a tighter `scrapeLimiter` on `POST /watches/:id/check` (each check launches a browser page), a JSON body limit, `MAX_CONCURRENT_SCRAPES` rejecting over-cap checks with 503 + `Retry-After`, and `cleanupScreenshots` on an interval (`.unref()`'d) expiring files past `SCREENSHOT_TTL_MS`. That cleanup only touches the transient `backend/screenshots`. Screenshots a snapshot needs live in evidence storage (see below), and `sweepEvidence` runs on the same interval.
- `clampTextForModel` (in `groq.js`) caps the text sent per model call and reports `truncated`.
- CORS is an explicit allowlist from `CORS_ALLOWED_ORIGINS`, allowing `GET`/`POST`/`PATCH`/`PUT`/`DELETE`/`OPTIONS`. No-`Origin` requests are allowed for health checks and curl. No wildcard path exists.
- `helmet` sets security headers on every response, and `x-powered-by` is disabled. The CSP is `default-src 'none'; frame-ancestors 'none'`, because the API serves no pages of its own; the evidence page replaces it with its own CSP. Note two of its defaults:
  - `Cross-Origin-Resource-Policy: same-origin` blocks the frontend (another origin) from showing an image, so image routes the frontend uses must override it, as `/screenshots` does.
  - HSTS is sent with `includeSubDomains`. It's ignored over plain HTTP, but on a real HTTPS domain it applies to every subdomain for a year.
- `app` is exported and `listen` is guarded by `require.main === module` so tests import without binding a port. The `module.exports` block also exports a few internals for unit tests.
- A graceful `SIGINT`/`SIGTERM` shutdown stops the scheduler and the email sender, closes the browser and guard proxy, then closes the DB.

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

### Email (`backend/mailer.js`, `backend/emailAlerts.js`)
`mailer.js` owns the transport, and everything is set by env vars, so switching providers is a settings change:
- `EMAIL_TRANSPORT=smtp` (default) uses `SMTP_HOST`/`PORT`/`USER`/`PASS`.
- `EMAIL_TRANSPORT=ethereal` creates a throwaway test inbox and logs a public view link per message.
- `checkEmailSetup()` returns exactly which settings are missing.
- `createSender({ transport })` takes an injected transport, so **tests never touch the network**. The real transport is created on first send, and a failed creation is retried rather than cached.
- Messages set `disableFileAccess`/`disableUrlAccess`.
- nodemailer is pinned to `^10.0.11`. Everything up to 10.0.5 has 15 advisories, including recipient-domain bypasses and SMTP injection.

`emailAlerts.js` is the sender, built like the scheduler: all state is in `alerts` (`status`, `attempts`, `next_attempt_at`, `last_error`), and `setInterval` (`EMAIL_TICK_MS`) is only a heartbeat. `deliverPendingEmails({ now, send, setup })` is the injectable seam.
- It sends `pending` email alerts whose watch still has `alert_email = 1`, once the change has **settled**: explained, failed to explain, `EXPLAIN_ENABLED=false`, or `SETTLE_MS` (10 min) has passed. This way an email carries the summary when there is one, but never waits forever.
- On failure, `attempts` increments and the alert backs off ×4 from 1 minute, capped at 6h. At `EMAIL_MAX_ATTEMPTS` it becomes `failed`, keeping `last_error`. One failure doesn't stop the batch.
- When email is not set up, nothing is sent and attempts aren't spent. Each pending alert's `last_error` says which settings are missing (written once), and the alerts go out when email is configured.
- **Delivery is at-least-once:** a crash between the provider accepting and the row being marked sent re-sends after restart. Marking first would silently lose alerts instead.
- `buildAlertEmail` uses `alertContent.js` and `escapeMarkup`, so the subject and wording match RSS and the evidence page.

### RSS feeds (`backend/feeds.js`)
`GET /feed.xml` (every watch) and `GET /watches/:id/feed.xml` (one watch), mounted at the app root and guarded by `requireLinkToken`. Each feed renders the latest 50 `sent` RSS alerts as RSS 2.0 on every request. The change's summary is read at render time, so an explanation that lands after the alert still appears. The item `guid` is `watchdog-alert-<alertId>`, which stays stable so a reader never shows an item twice. The item `<link>` opens the evidence page.

- The token is checked before the watch lookup, so ids can't be probed.
- The item body is HTML built from escaped strings and then XML-escaped as a whole, so `<script>` reaches the reader as visible text.
- The body quotes the diff itself, labelled Removed/Added and capped at 6 paragraphs, with links to the evidence page and the live page.

### Watches API
`backend/watches.js`, mounted at `/watches`. `POST` (validates url/frequency/selector/`alertChannels`, runs `validateScrapeUrl`, inserts due-immediately so the scheduler takes the baseline), `GET /`, `GET /:id`, `PATCH /:id` (`status` and/or `alertChannels`; a bad field rejects the whole request), `DELETE /:id`, `GET /:id/snapshots`, `GET /:id/snapshots/:snapshotId` (with its text), `GET /:id/snapshots/:snapshotId/screenshot` (no `LINK_TOKEN`; sends `Cross-Origin-Resource-Policy: cross-origin` for the frontend's `<img>`), `GET /:id/changes` (includes `feedback`), `PUT`/`DELETE /:id/changes/:changeId/feedback`, `GET /:id/alerts`, `POST /:id/check`. `getWatchOr404` centralizes id validation (400 on a malformed id, 404 on a missing one) — reuse it for new routes. Rows are serialized camelCase at the boundary; the DB uses snake_case.

### Frontend layout
The frontend is one screen, the watched pages, built from small pieces. Write new frontend code in the same shape:

- `src/App.js`: the top bar and `WatchesPage`.
- `src/config.js`: `API_BASE` and the `apiUrl()` helper.
- `src/api/client.js`: every `fetch` call. Each function throws an `Error` carrying the API's `error` message.
- `src/hooks/`:
  - `useWatches` loads the list and runs row actions. Every action reloads the list, because the backend owns each watch's state, and only the newest reload may set it.
  - `useChangeTimeline` loads one watch's changes and alerts and saves ratings.
- `src/components/`:
  - `WatchesPage` with `AddWatchForm` and `WatchList`.
  - `ChangeTimeline`, `ChangeCard` and `SnapshotCompare`.
- `src/utils/url.js`: `isValidUrl`.

Errors are shown, never swallowed: form errors under the form, action errors above the list, a rating error on its own change. `ChangeCard` copies the category titles and the no-summary sentence from `backend/alertContent.js`, so a change reads the same in the UI, email and RSS. A test fails if the two drift apart.

## Environment

Backend reads `backend/.env` (gitignored; copy `backend/.env.example`, which documents every variable). Compose passes the whole file in via `env_file`.

- `GROQ_API_KEY` is required, or every LLM endpoint fails. `EXPLAIN_ENABLED=false` lets detection run without it.
- `LINK_TOKEN` turns on feeds and evidence pages. `PUBLIC_BASE_URL` is used to build their links.
- `EMAIL_TRANSPORT` plus `SMTP_*`/`ALERT_EMAIL_*` turn on email. Without them, email alerts wait as `pending` and say what's missing.
- `DB_PATH` must be `/data/watchdog.db` under Compose so the volume persists it. Evidence screenshots sit beside it, in `/data/evidence`.
- Frontend overrides of `REACT_APP_API_BASE` are **inlined by CRA at build time**, so Docker images need them at build, not run. For the same reason, never put a secret in a `REACT_APP_*` variable.

`PROJECT_FULL_DOCUMENTATION.md` is gitignored and local-only: a plain-language guide for the owner. It was rewritten on 2026-10-13; the pre-watchdog version was saved outside the repo as `../PROJECT_FULL_DOCUMENTATION.pre-watchdog.md`. The repo's own docs are authoritative: this file, README.md and docs/PLAN.md.
