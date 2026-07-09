'use strict';

const KPI_COLUMNS = [
  { name: 'cpu_pct',            type: 'REAL' },
  { name: 'waiting_tasks',      type: 'INTEGER' },
  { name: 'io_mb',              type: 'REAL' },
  { name: 'batch_req',          type: 'REAL' },
  { name: 'sql_mem_pct',        type: 'REAL' },
  { name: 'sql_mem_gb',         type: 'REAL' },
  { name: 'ple_sec',            type: 'INTEGER' },
  { name: 'user_conns',         type: 'INTEGER' },
  { name: 'compilations_sec',   type: 'INTEGER' },
  { name: 'recompilations_sec', type: 'INTEGER' },
  { name: 'net_mbs',            type: 'REAL' },
  { name: 'buffer_cache_hit',   type: 'REAL' },
  { name: 'mem_grants_pending', type: 'INTEGER' },
];

function rawTableDDL() {
  const cols = KPI_COLUMNS.map(c => `${c.name} ${c.type}`).join(',\n  ');
  return `CREATE TABLE samples_raw (
  server_id INTEGER NOT NULL REFERENCES servers(id),
  ts        INTEGER NOT NULL,
  ${cols},
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID`;
}

function rollupTableDDL(table) {
  const triplets = KPI_COLUMNS
    .map(c => `${c.name}_avg REAL, ${c.name}_min ${c.type}, ${c.name}_max ${c.type}`)
    .join(',\n  ');
  return `CREATE TABLE ${table} (
  server_id INTEGER NOT NULL REFERENCES servers(id),
  ts        INTEGER NOT NULL,
  ${triplets},
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID`;
}

const MIGRATIONS = [
  {
    version: 1,
    description: 'initial schema: servers, samples (raw/1m/15m/1h), waits, blocking, rollup_state, meta',
    up(db) {
      db.exec(`CREATE TABLE servers (
        id           INTEGER PRIMARY KEY,
        instance_key TEXT NOT NULL UNIQUE,
        display_name TEXT,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL
      )`);
      db.exec(rawTableDDL());
      db.exec(rollupTableDDL('samples_1m'));
      db.exec(rollupTableDDL('samples_15m'));
      db.exec(rollupTableDDL('samples_1h'));
      db.exec(`CREATE TABLE waits_samples (
        server_id           INTEGER NOT NULL REFERENCES servers(id),
        ts                  INTEGER NOT NULL,
        wait_type           TEXT NOT NULL,
        wait_time_ms        INTEGER,
        waiting_tasks_count INTEGER,
        signal_wait_time_ms INTEGER,
        PRIMARY KEY (server_id, ts, wait_type)
      ) WITHOUT ROWID`);
      db.exec(`CREATE INDEX ix_waits_type ON waits_samples (server_id, wait_type, ts)`);
      db.exec(`CREATE TABLE blocking_events (
        id              INTEGER PRIMARY KEY,
        server_id       INTEGER NOT NULL REFERENCES servers(id),
        ts              INTEGER NOT NULL,
        blocking_sid    INTEGER,
        blocked_sid     INTEGER,
        wait_type       TEXT,
        wait_ms         INTEGER,
        database_name   TEXT,
        blocker_login   TEXT,
        blocker_host    TEXT,
        blocker_program TEXT,
        blocked_login   TEXT,
        blocked_host    TEXT,
        blocker_query   TEXT,
        blocked_query   TEXT,
        parent_object   TEXT
      )`);
      db.exec(`CREATE INDEX ix_blocking ON blocking_events (server_id, ts)`);
      db.exec(`CREATE TABLE rollup_state (
        server_id    INTEGER NOT NULL REFERENCES servers(id),
        resolution   TEXT NOT NULL CHECK (resolution IN ('1m','15m','1h')),
        watermark_ts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, resolution)
      )`);
      db.exec(`CREATE TABLE meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.prepare(`INSERT INTO meta (key, value, updated_at) VALUES ('created_at', ?, ?)`)
        .run(String(Date.now()), Date.now());
    },
  },
];

function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');
  db.pragma('foreign_keys = ON');
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT NOT NULL
  )`);
  let current = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)')
        .run(m.version, Date.now(), m.description);
      db.pragma(`user_version = ${m.version}`);
    })();
    current = m.version;
  }
}

module.exports = { KPI_COLUMNS, MIGRATIONS, applyPragmas, migrate, rawTableDDL, rollupTableDDL };
