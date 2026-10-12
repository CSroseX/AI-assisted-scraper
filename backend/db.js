const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { hashChanges } = require('./diff');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'watchdog.db');

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    selector TEXT,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'broken')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    screenshot_path TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_watch_id ON snapshots(watch_id, created_at);

  CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    from_snapshot_id INTEGER REFERENCES snapshots(id),
    to_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    diff_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_changes_watch_id ON changes(watch_id, created_at);
  `
];

// Columns added after the initial schema shipped. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so each is applied only when absent.
const ADDED_COLUMNS = [
  { table: 'watches', column: 'next_check_at', ddl: 'ALTER TABLE watches ADD COLUMN next_check_at INTEGER' },
  { table: 'watches', column: 'last_checked_at', ddl: 'ALTER TABLE watches ADD COLUMN last_checked_at INTEGER' },
  { table: 'watches', column: 'failure_count', ddl: 'ALTER TABLE watches ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0' },
  { table: 'watches', column: 'last_error', ddl: 'ALTER TABLE watches ADD COLUMN last_error TEXT' },
  // The explainer's output, stored on the change it describes. `summary` stays
  // NULL when the explanation could not be verified or the model was
  // unreachable -- the change itself is still a fact either way.
  { table: 'changes', column: 'category', ddl: 'ALTER TABLE changes ADD COLUMN category TEXT' },
  { table: 'changes', column: 'summary', ddl: 'ALTER TABLE changes ADD COLUMN summary TEXT' },
  { table: 'changes', column: 'quotes_json', ddl: 'ALTER TABLE changes ADD COLUMN quotes_json TEXT' },
  { table: 'changes', column: 'explained_at', ddl: 'ALTER TABLE changes ADD COLUMN explained_at INTEGER' },
  { table: 'changes', column: 'explain_error', ddl: 'ALTER TABLE changes ADD COLUMN explain_error TEXT' },
  { table: 'changes', column: 'diff_hash', ddl: 'ALTER TABLE changes ADD COLUMN diff_hash TEXT' }
];

function applyAddedColumns(database) {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const existing = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!existing.some((col) => col.name === column)) {
      database.exec(ddl);
    }
  }
  // Watches created before the scheduler existed have no due time; make them
  // due immediately so they are picked up on the first tick.
  database.exec('UPDATE watches SET next_check_at = created_at WHERE next_check_at IS NULL');
}

// Changes recorded before the fingerprint was computed at insert time only got
// one when the explainer succeeded. Alert dedup needs it on every change.
function backfillDiffHashes(database) {
  const missing = database.prepare('SELECT id, diff_json FROM changes WHERE diff_hash IS NULL').all();
  const update = database.prepare('UPDATE changes SET diff_hash = ? WHERE id = ?');
  database.transaction(() => {
    for (const row of missing) update.run(hashChanges(JSON.parse(row.diff_json)), row.id);
  })();
}

let db = null;

function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  applyAddedColumns(db);
  backfillDiffHashes(db);

  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb, DB_PATH };
