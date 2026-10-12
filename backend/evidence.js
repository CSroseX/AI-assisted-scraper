// Durable storage for the screenshots that back a watch's snapshots.
//
// The scraper writes every screenshot to SCREENSHOT_DIR, which is transient:
// files there expire after SCREENSHOT_TTL_MS and the folder sits outside the
// Docker volume. A screenshot that a stored snapshot refers to is evidence an
// alert links to, so it is copied here, next to the database (on the volume
// under Compose), and kept for as long as its snapshot exists.

const path = require('path');
const fs = require('fs');
const { getDb, DB_PATH } = require('./db');

const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(path.dirname(DB_PATH), 'evidence');
const PREFIX = 'evidence/';
// Unreferenced files younger than this are left alone: a copy is made just
// before the snapshot row that refers to it is committed.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

// Scraper output is always `screenshots/<uuid>.png`; anything else is refused,
// which also rules out path traversal.
const TRANSIENT_PATH = /^screenshots\/([0-9a-f-]+\.png)$/;
const STORED_PATH = /^evidence\/([0-9a-f-]+\.png)$/;

// Copies a transient screenshot into evidence storage and returns its stored
// path, or null when there is nothing usable to keep. Copy rather than rename,
// because the two folders may be on different filesystems (a Docker volume).
// A missing screenshot never fails a check: the snapshot is stored without one,
// just as the scraper itself carries on when a screenshot fails.
function preserveScreenshot(transientPath, sourceDir) {
  const match = TRANSIENT_PATH.exec(String(transientPath || ''));
  if (!match) return null;
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.copyFileSync(path.join(sourceDir, match[1]), path.join(EVIDENCE_DIR, match[1]));
    return PREFIX + match[1];
  } catch (err) {
    console.warn(`[evidence] could not keep screenshot ${transientPath}: ${err.message}`);
    return null;
  }
}

// Absolute file path for a stored path, or null if it is not one of ours.
function evidenceFile(storedPath) {
  const match = STORED_PATH.exec(String(storedPath || ''));
  return match ? path.join(EVIDENCE_DIR, match[1]) : null;
}

function discardEvidence(storedPath) {
  const file = evidenceFile(storedPath);
  if (file) fs.rmSync(file, { force: true });
}

// Deletes evidence no snapshot refers to any more, e.g. after a watch is
// deleted, so a deleted watch does not leave its screenshots behind.
function sweepEvidence(now = Date.now(), db = getDb()) {
  let names;
  try {
    names = fs.readdirSync(EVIDENCE_DIR);
  } catch {
    return;
  }
  const referenced = new Set(
    db.prepare("SELECT screenshot_path FROM snapshots WHERE screenshot_path LIKE 'evidence/%'")
      .all()
      .map((row) => row.screenshot_path.slice(PREFIX.length))
  );
  for (const name of names) {
    if (referenced.has(name)) continue;
    const file = path.join(EVIDENCE_DIR, name);
    try {
      if (now - fs.statSync(file).mtimeMs > ORPHAN_GRACE_MS) fs.unlinkSync(file);
    } catch {
      // Vanished or unreadable; nothing to do.
    }
  }
}

// Snapshots stored before evidence storage existed point into the transient
// folder. Keep the screenshots that still exist; clear the path of those
// already expired, so no snapshot claims a screenshot that cannot be shown.
function adoptLegacyScreenshots(sourceDir, db = getDb()) {
  const rows = db.prepare("SELECT id, screenshot_path FROM snapshots WHERE screenshot_path LIKE 'screenshots/%'").all();
  const update = db.prepare('UPDATE snapshots SET screenshot_path = ? WHERE id = ?');
  for (const row of rows) {
    const match = TRANSIENT_PATH.exec(row.screenshot_path);
    const stillThere = match && fs.existsSync(path.join(sourceDir, match[1]));
    update.run(stillThere ? preserveScreenshot(row.screenshot_path, sourceDir) : null, row.id);
  }
}

module.exports = {
  EVIDENCE_DIR,
  ORPHAN_GRACE_MS,
  preserveScreenshot,
  evidenceFile,
  discardEvidence,
  sweepEvidence,
  adoptLegacyScreenshots
};
