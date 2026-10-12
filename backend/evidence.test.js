const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own on-disk DB (and so its own evidence folder).
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-evidence-test-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-transient-'));

const { getDb, closeDb } = require('./db');
const {
  EVIDENCE_DIR,
  ORPHAN_GRACE_MS,
  preserveScreenshot,
  evidenceFile,
  discardEvidence,
  sweepEvidence,
  adoptLegacyScreenshots
} = require('./evidence');

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

// A screenshot as the scraper would leave it: screenshots/<uuid>.png
function transientShot(body = 'png-bytes') {
  const name = `${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(sourceDir, name), body);
  return `screenshots/${name}`;
}

function snapshotWith(screenshotPath) {
  const db = getDb();
  const watchId = db
    .prepare("INSERT INTO watches (url, frequency, status, created_at, updated_at) VALUES ('https://e.test', 'daily', 'active', 0, 0)")
    .run().lastInsertRowid;
  return db
    .prepare("INSERT INTO snapshots (watch_id, content, content_hash, screenshot_path, created_at) VALUES (?, 'x', 'h', ?, 0)")
    .run(watchId, screenshotPath).lastInsertRowid;
}

const age = (file, ms) => {
  const past = new Date(Date.now() - ms);
  fs.utimesSync(file, past, past);
};

test('evidence lives next to the database, so a Docker volume keeps it', () => {
  assert.equal(EVIDENCE_DIR, path.join(dbDir, 'evidence'));
});

test('preserveScreenshot copies into evidence and leaves the transient file alone', () => {
  const transient = transientShot('the-image');
  const stored = preserveScreenshot(transient, sourceDir);
  assert.match(stored, /^evidence\/[0-9a-f-]+\.png$/);
  assert.equal(fs.readFileSync(evidenceFile(stored), 'utf8'), 'the-image');
  assert.ok(fs.existsSync(path.join(sourceDir, path.basename(transient))));
});

test('preserveScreenshot refuses anything that is not a scraper screenshot path', () => {
  for (const bad of [null, '', '../secret.png', 'screenshots/../../secret.png', 'evidence/abc.png', 'screenshots/a.txt', '/etc/passwd']) {
    assert.equal(preserveScreenshot(bad, sourceDir), null, String(bad));
  }
});

test('a screenshot that vanished is not kept, and does not throw', () => {
  assert.equal(preserveScreenshot(`screenshots/${crypto.randomUUID()}.png`, sourceDir), null);
});

test('evidenceFile only resolves our own stored paths', () => {
  assert.equal(evidenceFile('evidence/0a-1b.png'), path.join(EVIDENCE_DIR, '0a-1b.png'));
  for (const bad of ['evidence/../db.sqlite', 'evidence/x.png/../../a', 'screenshots/0a.png', null]) {
    assert.equal(evidenceFile(bad), null, String(bad));
  }
});

test('discardEvidence removes a stored file and ignores anything else', () => {
  const stored = preserveScreenshot(transientShot(), sourceDir);
  discardEvidence(stored);
  assert.equal(fs.existsSync(evidenceFile(stored)), false);
  discardEvidence('../../nope.png');
  discardEvidence(null);
});

test('sweep keeps referenced evidence, deletes old orphans, spares fresh ones', () => {
  const kept = preserveScreenshot(transientShot(), sourceDir);
  snapshotWith(kept);
  const orphan = preserveScreenshot(transientShot(), sourceDir);
  const fresh = preserveScreenshot(transientShot(), sourceDir);

  age(evidenceFile(kept), 2 * ORPHAN_GRACE_MS);
  age(evidenceFile(orphan), 2 * ORPHAN_GRACE_MS);
  sweepEvidence();

  assert.ok(fs.existsSync(evidenceFile(kept)), 'a snapshot still needs it');
  assert.equal(fs.existsSync(evidenceFile(orphan)), false, 'nothing refers to it any more');
  assert.ok(fs.existsSync(evidenceFile(fresh)), 'may belong to a snapshot about to be committed');
});

test('deleting a watch lets the sweep remove its screenshots', () => {
  const stored = preserveScreenshot(transientShot(), sourceDir);
  const snapshotId = snapshotWith(stored);
  const { watch_id: watchId } = getDb().prepare('SELECT watch_id FROM snapshots WHERE id = ?').get(snapshotId);
  getDb().prepare('DELETE FROM watches WHERE id = ?').run(watchId);
  age(evidenceFile(stored), 2 * ORPHAN_GRACE_MS);
  sweepEvidence();
  assert.equal(fs.existsSync(evidenceFile(stored)), false);
});

test('legacy snapshots: surviving screenshots are adopted, expired ones are cleared', () => {
  const surviving = transientShot('old-but-present');
  const survivingId = snapshotWith(surviving);
  const expiredId = snapshotWith(`screenshots/${crypto.randomUUID()}.png`);
  const alreadyKept = preserveScreenshot(transientShot(), sourceDir);
  const keptId = snapshotWith(alreadyKept);

  adoptLegacyScreenshots(sourceDir);

  const pathOf = (id) => getDb().prepare('SELECT screenshot_path FROM snapshots WHERE id = ?').get(id).screenshot_path;
  assert.match(pathOf(survivingId), /^evidence\//);
  assert.equal(fs.readFileSync(evidenceFile(pathOf(survivingId)), 'utf8'), 'old-but-present');
  assert.equal(pathOf(expiredId), null, 'no snapshot may claim a screenshot that is gone');
  assert.equal(pathOf(keptId), alreadyKept, 'already-kept evidence is untouched');
});
