// Adds the real-page trial watches (docs/TRIAL.md) to a running backend.
// It goes through POST /watches, so every URL passes validateScrapeUrl and is
// later fetched by the guarded scraper, like any other watch.
//
//   node scripts/seedTrial.js [baseUrl]     (default http://localhost:5000)
//
// Safe to re-run: pages that are already watched are skipped.

const TRIAL_PAGES = [
  { group: 'SaaS pricing', url: 'https://github.com/pricing' },
  { group: 'SaaS pricing', url: 'https://slack.com/pricing' },
  { group: 'SaaS pricing', url: 'https://www.notion.com/pricing' },
  { group: 'SaaS pricing', url: 'https://www.dropbox.com/plans' },
  { group: 'SaaS pricing', url: 'https://zoom.us/pricing' },
  { group: 'SaaS terms', url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service' },
  { group: 'SaaS terms', url: 'https://www.dropbox.com/terms' },
  { group: 'SaaS terms', url: 'https://slack.com/terms-of-service' },
  { group: 'Streaming', url: 'https://help.netflix.com/en/node/24926' },
  { group: 'Streaming', url: 'https://www.spotify.com/us/premium/' },
  { group: 'Streaming', url: 'https://www.spotify.com/us/legal/end-user-agreement/' },
  { group: 'Streaming', url: 'https://www.youtube.com/premium' },
  { group: 'Telecom', url: 'https://www.jio.com/selfcare/plans/mobility/prepaid-plans-home/' },
  { group: 'Telecom', url: 'https://www.airtel.in/recharge-online' },
  { group: 'Telecom', url: 'https://www.t-mobile.com/cell-phone-plans' },
  { group: 'Likely blocked', url: 'https://www.amazon.com/gp/help/customer/display.html?nodeId=G2B9L3YR7LR8J4XP' },
  { group: 'Likely blocked', url: 'https://www.canva.com/pricing/' },
  { group: 'Likely blocked', url: 'https://www.verizon.com/plans/unlimited/' },
  { group: 'Likely blocked', url: 'https://www.disneyplus.com/legal/subscriber-agreement' }
];

const WATCH_SETTINGS = { frequency: 'daily', alertChannels: ['email', 'rss'] };

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// Returns one result per page: created (with the watch id), exists,
// rejected (the API refused the URL, with its reason: a trial finding), or
// failed (anything else, such as a rate limit: re-run the script).
async function seedTrial({ baseUrl, pages = TRIAL_PAGES, fetchImpl = fetch }) {
  const listRes = await fetchImpl(`${baseUrl}/watches`);
  if (!listRes.ok) {
    throw new Error(`GET /watches failed with HTTP ${listRes.status}`);
  }
  const existing = new Map((await listRes.json()).map((watch) => [watch.url, watch.id]));

  const results = [];
  for (const page of pages) {
    const normalized = new URL(page.url).toString();
    if (existing.has(normalized)) {
      results.push({ ...page, outcome: 'exists', id: existing.get(normalized) });
      continue;
    }

    const res = await fetchImpl(`${baseUrl}/watches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: page.url, ...WATCH_SETTINGS })
    });
    const body = await readJson(res);
    const error = body.error || `HTTP ${res.status}`;
    if (res.status === 201) {
      existing.set(body.url, body.id);
      results.push({ ...page, outcome: 'created', id: body.id });
    } else if (res.status === 400) {
      results.push({ ...page, outcome: 'rejected', error });
    } else {
      results.push({ ...page, outcome: 'failed', error: `HTTP ${res.status}: ${error}` });
    }
  }
  return results;
}

if (require.main === module) {
  const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/+$/, '');
  seedTrial({ baseUrl })
    .then((results) => {
      for (const r of results) {
        const detail = r.error || `watch ${r.id}`;
        console.log(`${r.outcome.padEnd(8)} ${r.url}  (${detail})`);
      }
      const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
      console.log(`\n${count('created')} created, ${count('exists')} already watched, ${count('rejected')} rejected, ${count('failed')} failed`);
      if (count('failed')) console.log('Some requests failed for reasons unrelated to the page. Re-run the script to add them.');
    })
    .catch((err) => {
      console.error(`Could not seed the trial: ${err.message}. Is the backend running at ${baseUrl}?`);
      process.exitCode = 1;
    });
}

module.exports = { seedTrial, TRIAL_PAGES, WATCH_SETTINGS };
