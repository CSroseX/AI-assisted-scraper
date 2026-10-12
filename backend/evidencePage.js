// The page every alert links to, so a user can check a claim themselves: the
// summary, the exact changed paragraphs, and the before and after versions
// with their screenshots. Server-rendered on purpose, because alerts need a
// working link before the step 7 UI exists; that UI can replace it.
//
// Guarded by LINK_TOKEN like the feeds. The page shows scraped text, so it is
// locked down: every page-derived string is escaped, a strict CSP forbids
// scripts, and no-referrer stops the token leaking when a link is followed.

const fs = require('fs');
const express = require('express');
const { getDb } = require('./db');
const { requireLinkToken, escapeMarkup: h } = require('./publicLinks');
const { NO_SUMMARY, alertTitle } = require('./alertContent');
const { evidenceFile } = require('./evidence');

const router = express.Router();

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

const STYLE = `
  :root { --bg: #fff; --fg: #1a1a1a; --muted: #5f6368; --line: #dadce0;
          --del-bg: #fdecea; --del-fg: #8a1c12; --add-bg: #e6f4ea; --add-fg: #0d5223; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16181b; --fg: #e8eaed; --muted: #9aa0a6; --line: #3c4043;
            --del-bg: #3b1d1a; --del-fg: #f6aea9; --add-bg: #17301f; --add-fg: #a8dab5; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 32px 0 12px; }
  .meta { color: var(--muted); margin: 0 0 20px; overflow-wrap: anywhere; }
  .summary { font-size: 1.1rem; padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; }
  .para { margin: 8px 0; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .removed { background: var(--del-bg); color: var(--del-fg); }
  .added { background: var(--add-bg); color: var(--add-fg); }
  .tag { font-weight: 600; margin-right: 6px; }
  .versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .version { border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
  .version h3 { margin: 0 0 4px; font-size: 1rem; }
  .shot { max-height: 70vh; overflow: auto; border: 1px solid var(--line); border-radius: 4px; }
  .shot img { display: block; width: 100%; height: auto; }
  .shot + .meta { margin: 8px 0 0; }
  details pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9rem; max-height: 480px; overflow: auto; }
  a { color: inherit; }
`;

const when = (ms) => new Date(ms).toUTCString();

function loadChange(id) {
  return getDb()
    .prepare(
      `SELECT c.id, c.category, c.summary, c.diff_json, c.created_at, w.url,
              b.content AS before_content, b.screenshot_path AS before_shot, b.created_at AS before_at,
              a.content AS after_content, a.screenshot_path AS after_shot, a.created_at AS after_at
       FROM changes c
       JOIN watches w ON w.id = c.watch_id
       JOIN snapshots a ON a.id = c.to_snapshot_id
       LEFT JOIN snapshots b ON b.id = c.from_snapshot_id
       WHERE c.id = ?`
    )
    .get(id);
}

function versionCard(label, { at, shot, content }, token) {
  if (at == null) {
    return `<section class="version"><h3>${label}</h3><p class="meta">This version is no longer stored.</p></section>`;
  }
  const file = shot ? shot.slice('evidence/'.length) : null;
  const src = file ? `../files/${encodeURIComponent(file)}?token=${encodeURIComponent(token)}` : null;
  // Full-page captures of long terms pages run to thousands of pixels, so the
  // image scrolls inside a frame instead of stretching the page.
  const image = src
    ? `<div class="shot"><img src="${h(src)}" alt="Screenshot of the page, ${label.toLowerCase()} version"></div>
    <p class="meta"><a href="${h(src)}">Open full size</a></p>`
    : '<p class="meta">No screenshot was captured for this version.</p>';
  return `<section class="version">
    <h3>${label}</h3>
    <p class="meta">Captured ${h(when(at))}</p>
    ${image}
    <details><summary>Full page text</summary><pre>${h(content)}</pre></details>
  </section>`;
}

function renderPage(row, token) {
  const diff = JSON.parse(row.diff_json);
  const paragraphs = diff
    .map((p) => `<div class="para ${p.type === 'removed' ? 'removed' : 'added'}"><span class="tag">${p.type === 'removed' ? 'Removed' : 'Added'}</span>${h(p.text)}</div>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${h(alertTitle(row.category, row.url))}</title>
<style>${STYLE}</style>
</head>
<body><main>
  <h1>${h(alertTitle(row.category, row.url))}</h1>
  <p class="meta">Detected ${h(when(row.created_at))} on <a href="${h(row.url)}" rel="noreferrer noopener">${h(row.url)}</a></p>
  <p class="summary">${h(row.summary || NO_SUMMARY)}</p>

  <h2>What changed</h2>
  <p class="meta">The exact paragraphs that differ. Detection compares the page text directly; the summary above is only an explanation of these.</p>
  ${paragraphs}

  <h2>Before and after</h2>
  <div class="versions">
    ${versionCard('Before', { at: row.before_at, shot: row.before_shot, content: row.before_content }, token)}
    ${versionCard('After', { at: row.after_at, shot: row.after_shot, content: row.after_content }, token)}
  </div>
</main></body>
</html>`;
}

router.get('/evidence/changes/:changeId', requireLinkToken, (req, res) => {
  const id = Number.parseInt(req.params.changeId, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid change id' });
  const row = loadChange(id);
  if (!row) return res.status(404).json({ error: 'Change not found' });

  res.set({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
  res.type('html').send(renderPage(row, req.query.token));
});

router.get('/evidence/files/:name', requireLinkToken, (req, res) => {
  const file = evidenceFile(`evidence/${req.params.name}`);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Screenshot not found' });

  res.set({ ...SECURITY_HEADERS, 'Cache-Control': 'private, max-age=86400' });
  res.type('png').sendFile(file);
});

module.exports = router;
