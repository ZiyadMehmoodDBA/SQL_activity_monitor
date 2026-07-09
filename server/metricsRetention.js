'use strict';

const DAY = 86_400_000;

// samples_1h intentionally absent: kept forever.
const RETENTION = [
  { table: 'samples_raw',     keepMs: 7 * DAY },
  { table: 'samples_1m',      keepMs: 90 * DAY },
  { table: 'samples_15m',     keepMs: 365 * DAY },
  { table: 'waits_samples',   keepMs: 90 * DAY },
  { table: 'blocking_events', keepMs: 365 * DAY },
];

function prune(db, now = Date.now()) {
  const deleted = {};
  for (const r of RETENTION) {
    deleted[r.table] = db.prepare(`DELETE FROM ${r.table} WHERE ts < ?`).run(now - r.keepMs).changes;
  }
  return deleted;
}

// VACUUM rewrites the whole file — only worthwhile when >25% of the file
// (or >10k pages) is reclaimable free space.
function vacuumIfNeeded(db) {
  const freelist = db.pragma('freelist_count', { simple: true });
  const pages    = db.pragma('page_count', { simple: true });
  if (freelist > Math.max(10_000, pages / 4)) {
    db.exec('VACUUM');
    return true;
  }
  return false;
}

function checkpoint(db) {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

module.exports = { RETENTION, prune, vacuumIfNeeded, checkpoint };
