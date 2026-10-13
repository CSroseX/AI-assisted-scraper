# Real-page trial

Started 2026-10-13. Tracks issue #14.

Every test so far uses made-up page content. This trial watches real pricing and terms pages for 30 days to find out whether the watchdog works on them.

## What "works" means

These are the "done when" criteria from `docs/PLAN.md`:

1. A real change produces a correct, quoted alert within one check interval.
2. Fewer than 1 in 3 alerts are noise. Noise is an alert for a change that doesn't matter, such as a rotating banner.
3. A page that doesn't change for 30 days produces zero alerts.

## How it runs

The trial uses its own database in `backend/data/trial/`, so it never mixes with the normal one. That folder is gitignored. It also holds the backend log and the throwaway `LINK_TOKEN` (in `LINK_TOKEN.txt`).

Start the trial backend from `backend/` (Git Bash):

```bash
PORT=5050 DB_PATH="$PWD/data/trial/trial.db" EMAIL_TRANSPORT=ethereal \
  LINK_TOKEN="$(cat data/trial/LINK_TOKEN.txt)" node index.js >> data/trial/backend.log 2>&1
```

- **Ethereal** is a free fake inbox. Emails are not delivered anywhere. Each sent email logs a link to view it, in `backend.log`. Anyone with that link can read the email, so the `LINK_TOKEN` must stay throwaway.
- If the computer sleeps or the backend stops, nothing is lost. The scheduler keeps its state in the database and runs any missed checks when it starts again.

Add the trial pages (safe to re-run; it skips pages already watched):

```bash
node scripts/seedTrial.js http://localhost:5050
```

The script uses the normal `POST /watches` API, so every URL goes through the same safety checks as any other watch.

### Rating each change

Every change must be rated, because the noise ratio is counted from the ratings:

```bash
curl -X PUT http://localhost:5050/watches/<watchId>/changes/<changeId>/feedback \
  -H "Content-Type: application/json" -d '{"vote":"useful"}'   # or "noise"
```

List a page's changes with `GET /watches/<watchId>/changes`. Read a change's evidence page at `/evidence/changes/<changeId>?token=<LINK_TOKEN>`.

## Pages

All pages are checked daily, with no CSS selector, and alert by email and RSS. The trial runs from India, so some sites show Indian prices or redirect to an Indian site.

"Baseline" is the first snapshot. Later checks are compared against it.

| Watch | Page | Group | Baseline | Notes |
|---|---|---|---|---|
| 1 | github.com/pricing | SaaS pricing | Readable | 6.1k chars of plan text. |
| 2 | slack.com/pricing | SaaS pricing | Readable | Redirects to `/intl/en-in/pricing`. |
| 3 | notion.com/pricing | SaaS pricing | Readable | |
| 4 | dropbox.com/plans | SaaS pricing | Readable | |
| 5 | zoom.us/pricing | SaaS pricing | **Not readable** | The screenshot shows full pricing (in ₹), but the saved text is only footer links. The pricing text is invisible to text extraction. |
| 6 | GitHub Terms of Service | SaaS terms | Readable | 45.7k chars. |
| 7 | dropbox.com/terms | SaaS terms | Readable | Has a banner: terms change on 2027-01-01. Worth watching. |
| 8 | slack.com/terms-of-service | SaaS terms | Partly | Redirects to the Main Services Agreement page. Saved text is mostly legal navigation. |
| 9 | Netflix plans (help article) | Streaming | Readable | Shows India pricing. |
| 10 | spotify.com/us/premium | Streaming | Readable | US prices. |
| 11 | Spotify Terms of Use | Streaming | Readable | 55k chars. |
| 12 | youtube.com/premium | Streaming | **Not readable** | Empty text. The screenshot is a blank skeleton: the page hadn't rendered when it was captured. |
| 13 | Jio prepaid plans | Telecom | Partly | Marketing text only; the plan list itself isn't in the text. |
| 14 | airtel.in/recharge-online | Telecom | **Not readable** | 230 chars of navigation. The plans load later with JavaScript. |
| 15 | t-mobile.com/cell-phone-plans | Telecom | **Failed** | `ERR_CONNECTION_CLOSED`. The site drops the connection, probably bot protection or a block on non-US visitors. |
| 16 | — | — | — | Deleted. It used a wrong Amazon page ID (not the Prime terms). Replaced by watch 20. |
| 17 | canva.com/pricing | Likely blocked | **Blocked** | Cloudflare challenge page saved as content ("We'll have you designing again soon … RayID: …"). |
| 18 | verizon.com/plans/unlimited | Likely blocked | Partly | 1.4k chars of plan names. Not blocked. |
| 19 | Disney+ subscriber agreement | Likely blocked | **Not readable** | From India it redirects to hotstar.com; the screenshot is a black page and the text is empty. |
| 20 | Amazon Prime terms | Likely blocked | **Blocked** | The headless browser gets Amazon's "Sorry, we couldn't find that page" dog page, and the saved text is empty. The same URL fetched with curl returns the real Prime Terms, so Amazon serves the 404 page to suspected bots. |

## Findings so far

These are problems the trial found on day 0. They feed #19 (honest failure messages) and #20 (noise tuning).

1. **A bot wall is saved as if it were the page** (Canva). The challenge text includes a RayID that changes on every request. So every daily check will look like a change and send a noise alert. Expected cause of noise: #20. Better fix: recognise the challenge and report "bot protection": #19.
2. **An empty page is saved as a valid baseline** (YouTube, Disney+, Amazon). When the page later renders properly, the whole page will look "added", which is a false change. An empty or near-empty capture should probably count as a failed read: #19.
3. **A "page not found" page is saved without complaint** (Amazon). The scraper doesn't look at the HTTP status, so a 404 page becomes content. Amazon shows it to bots on a URL that works in a normal fetch, so a 404 here can also mean "blocked": #19.
4. **Text extraction misses visible content** (Zoom, Airtel, Jio). The screenshot shows prices that the saved text doesn't have. Likely causes: content inside shadow DOM, or loaded after the capture. A CSS selector or a wait for content may fix some of these.
5. **Location changes what is watched** (Slack, Netflix, Zoom, Disney+). The same URL gives different content in different countries. A hosted watchdog would see the host's country, not the user's.

## Ratings

| Date | Watch | Change | Vote | Cause | Summary right? |
|---|---|---|---|---|---|

Totals: 0 alerts, 0 useful, 0 noise.

## Log

- **2026-10-13:** Trial started. 19 watches created through the API, none rejected. Wrong Amazon URL replaced (watch 16 → 20). Baselines for the 19 active watches: 9 readable, 3 partly readable, 4 not readable, 2 blocked, 1 failed (see the table).
