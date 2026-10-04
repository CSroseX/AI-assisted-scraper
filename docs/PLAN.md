# Product plan: from demo to a usable tool

Status: draft, high-level. Open decisions are listed at the end and are marked **(open)** where they affect the plan.

## 1. Goal

Turn the project from a scrape-and-rewrite demo into a **watchdog for subscription and ToS/pricing pages**.

A user adds a URL. The system checks the page on a schedule and, when something that matters changes, sends a short plain-language alert with quotes from the page. It is judged usable when a non-technical person can set it up in about two minutes and still trust the alerts a month later.

### Why this and not "web search"

Web search answers "what is true now?" once, when asked. This product answers "what changed since last time, and does it matter to me?":

| Need | Web search | This project |
|---|---|---|
| Memory of past versions | No | Stored snapshots |
| Proactive (tell me without asking) | No | Scheduled checks and alerts |
| Personal relevance | Generic | User profile (Phase 2) |
| Evidence | Paraphrased, can hallucinate | Deterministic diff, quoted text, screenshots |

Search can be used as a supporting step later (for example to corroborate a change); it is not the product.

## 2. Design principles

1. **Detect deterministically, explain with the LLM.** Changes are found by a plain diff. The model only classifies and explains them, and every claim must quote the changed text. Claims whose quote is not in the diff are dropped.
2. **Noise filtering is the product.** Cookie banners, timestamps, counters and ad rotation must not trigger alerts.
3. **Everything is auditable.** Each alert links to the before and after snapshots and screenshots.
4. **Safe by default.** All fetching goes through the egress-filtering proxy (SSRF, redirect and DNS-rebinding protection), with rate limits and concurrency caps.

## 3. Target architecture

Two services instead of four.

| Component | Decision |
|---|---|
| Node/Express backend | Keep. Add watches API, scheduler, diff engine, explainer, alerts. |
| Hardened scraper (egress proxy, limits) | Keep. Core asset. |
| Groq client | Keep. Used only to explain changes. |
| React frontend | Keep. Rebuild screens around watches instead of chat sessions. |
| SQLite (single file, migrations, Docker volume, backups) | ✅ **New.** Tables: `users`, `watches`, `snapshots`, `changes`, `alerts`, `feedback`. (`watches`, `snapshots`, `changes` exist; `users`, `alerts`, `feedback` and backups are not built yet.) |
| Flask "RL" review service | ✅ **Remove.** The RL work is dropped (issue #6, closed as not planned). Thumbs up/down become plain stored `feedback` used to tune thresholds, not a learning system. |
| ChromaDB version service | ✅ **Remove** as the version store; SQLite replaces it. Semantic search over history can be revisited later. |

The removals are one-way simplifications but everything remains in git history.

## 4. Roadmap

### Phase 0: foundations ✅ (done)
SSRF hardening via egress proxy, rate limiting and input validation, repo cleanup, tests and CI (Node, Python, frontend), `App.js` refactor into hooks and components.

### Phase 1: it works for one person
Order reflects dependencies.

0. ✅ **Cleanup:** remove the RL and Chroma services (code, Docker services, CI jobs, README) and the frontend calls to them.
1. ✅ **Storage and watches API:** SQLite schema with migrations; create, list, pause and delete watches. A watch has a URL, an optional CSS selector, and a frequency (daily or weekly). Single fixed owner until Phase 2.
2. ✅ **Snapshot pipeline:** fetch via the guarded proxy, extract main text, normalise, take a screenshot, and store a new snapshot only when the content hash changes. (Size caps and a retention policy are not built yet.)
3. ✅ **Diff engine (no LLM):** paragraph-level diff with noise filtering. (Not yet tuned against a corpus of 20-30 real ToS and pricing pages — only unit-tested on synthetic examples.)
4. ✅ **Scheduler:** jittered runs that survive restarts, respect the scrape concurrency cap, back off on failures, and mark a watch "broken" after repeated failures. (Scheduling state is persisted in `watches.next_check_at`/`failure_count`, so a watch due during downtime runs on the first tick back.)
5. **Explainer:** runs only when a real diff exists. Classifies each change (price, fees, cancellation, data use, cosmetic) and explains it with quoted text; output is validated against the diff.
6. **Alerts:** email and RSS **(open)**, with links to before/after and screenshots. Deduplicated.
7. **UI:** watchlist, per-watch change timeline, diff viewer, and thumbs up/down on alerts stored as feedback. Clear messaging when a page cannot be read (login required, bot protection, heavy JavaScript).

**Done when:**
- A real change on a real pricing or ToS page produces a correct, quoted alert within one check interval.
- Fewer than 1 in 3 alerts are marked as noise.
- A page unchanged for 30 days produces zero alerts.

### Phase 2: it works for other people
- Accounts and authentication; per-user limits.
- User profile (for example "Standard plan, living in Germany") used by the explainer to say why a change matters.
- Digests and quiet hours.
- Deployment **(open)**: HTTPS, backups, monitoring, and cost caps on model usage.

### Phase 3: it is worth keeping
- Shared watch templates for popular services (one fetch serves many users).
- Authenticated pages via a browser extension.
- Price and date extraction with trend charts.

## 5. Risks

1. **Noise** (false alerts from page chrome). Mitigation: build the filter against a real corpus first; track the useful/noise feedback ratio.
2. **Unreadable pages** (logins, bot protection, JavaScript-heavy). Mitigation: detect and report clearly instead of failing silently.
3. **Scraping terms and etiquette.** Mitigation: respect robots.txt, polite intervals, cache shared pages once.
4. **Competition** (Visualping, Distill and similar detect changes but mostly do not explain them). The quoted, personalised explanation is the differentiator and must be proven with real users.
5. **Model cost and reliability.** Mitigation: the diff runs first so the model is only called on real changes; cap usage per user.

## 6. Success metrics

- Share of alerts marked useful (target above 60%).
- Changes users confirm they would otherwise have missed.
- Weekly retention of watches (users do not delete them).

## 7. Open decisions

1. **Scope cut:** confirm removal of the RL and Chroma services in favour of SQLite only (assumed in this plan).
2. **Alert channel for the MVP:** email only, or email plus RSS (recommended: both, RSS is nearly free).
3. **Hosting target:** self-hosted on a small server with Docker Compose (assumed), or a hosted service for others. This decides how much weight Phase 2 carries.
