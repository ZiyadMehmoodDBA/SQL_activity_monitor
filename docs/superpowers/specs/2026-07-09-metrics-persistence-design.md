# Historical Metrics Persistence — Design

**Date:** 2026-07-09
**Status:** Approved
**Depends on:** Persistent Connection Manager (2026-07-08)

## Problem

The dashboard keeps only 60 in-memory data points (~2 minutes at the 2-second
poll interval) per connection, held in browser state. Closing the tab or
restarting `server.js` destroys all history. The only persisted data is
`data/db-size-history.json` (daily DB-size snapshots, 10-day retention).

A DBA asking "what happened at 3am?" gets no answer. There is no basis for
trends, baselines, alerting, or capacity forecasting.

## Goal

Persist metrics server-side in an embedded SQLite database so that:

1. Any past time window can be charted ("what happened at 3am").
2. Long-term trends survive restarts with bounded disk growth.
3. Future features (alerting, baselines, forecasting) have a data foundation.

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| Storage engine | `better-sqlite3` (synchronous, WAL). `node:sqlite` rejected (experimental in Node 22); JSON files rejected (no range queries, rewrite-per-poll). |
| What to persist | Scalar KPIs + wait stats + blocking events. Per-session process lists and expensive-query recordsets are NOT persisted. |
| History identity | Keyed by **server name** (e.g. `10.140.13.9`), not profile UUID. History survives profile delete/re-add; profiles pointing at the same server share history. Mirrors `db-size-history.json`. |
| UI scope | History mode on the existing charts (time-range picker), not a separate page. |
| Timestamps | `INTEGER` epoch **milliseconds** everywhere. Never ISO strings. |

## Architecture

```
server/
├── metricsStore.js      — public API; owns DB handle, prepared statements, transactions
├── metricsSchema.js     — DDL, PRAGMAs, schema versioning (PRAGMA user_version)
├── metricsRollup.js     — raw→1m→15m→1h aggregation, watermark-driven
└── metricsRetention.js  — prune expired rows, daily VACUUM + WAL checkpoint
data/metrics.db          — the database (data/ is gitignored)
```

- `collectMetrics()` stays in `server.js`. The poll loop gains one call:
  `metricsStore.insertSnapshot(serverName, metrics)`. No SQL exists outside
  the store modules.
- No queue, no worker thread, no batching. At 2s polls × ~10 servers,
  synchronous inserts cost microseconds under WAL.

### metricsStore public API

```
initialize(dbPath)      — open DB, apply PRAGMAs, run migrations, prepare statements
insertSnapshot(serverName, metrics)
getHistory(serverName, fromMs, toMs, resolution)
getWaitHistory(serverName, fromMs, toMs)
getBlockingHistory(serverName, fromMs, toMs)
rollup()                — called by hourly maintenance timer
prune()                 — called by hourly maintenance timer
vacuum()                — daily
checkpoint()            — daily, after vacuum: PRAGMA wal_checkpoint(TRUNCATE)
health()                — stats for the health endpoint
close()
```

### PRAGMAs (set in metricsSchema.js at open)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA temp_store   = MEMORY;
PRAGMA cache_size   = -64000;   -- 64 MB
PRAGMA foreign_keys = ON;
```

## Schema

Schema version tracked via `PRAGMA user_version` (starts at 1). `initialize()`
runs sequential migrations when `user_version` is behind.

```sql
CREATE TABLE servers (
  id          INTEGER PRIMARY KEY,
  server_name TEXT NOT NULL UNIQUE
);

-- One row per poll (2s cadence)
CREATE TABLE samples_raw (
  server_id         INTEGER NOT NULL REFERENCES servers(id),
  ts                INTEGER NOT NULL,          -- epoch ms
  cpu_pct           REAL,
  waiting_tasks     INTEGER,
  io_mb             REAL,
  batch_req         REAL,
  sql_mem_pct       REAL,
  sql_mem_gb        REAL,
  ple_sec           INTEGER,
  user_conns        INTEGER,
  compilations_sec  INTEGER,
  recompilations_sec INTEGER,
  net_mbs           REAL,
  buffer_cache_hit  REAL,
  mem_grants_pending INTEGER,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

-- Rollup tables: identical KPI set as avg/min/max triplets.
-- samples_1m, samples_15m, samples_1h:
CREATE TABLE samples_1m (
  server_id INTEGER NOT NULL REFERENCES servers(id),
  ts        INTEGER NOT NULL,                  -- bucket start, epoch ms
  cpu_pct_avg REAL, cpu_pct_min REAL, cpu_pct_max REAL,
  -- ... same triplet pattern for every KPI column above ...
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;
-- samples_15m and samples_1h: same shape.

-- Wait stats: written at most once per 60s per server
CREATE TABLE waits_samples (
  server_id           INTEGER NOT NULL REFERENCES servers(id),
  ts                  INTEGER NOT NULL,
  wait_type           TEXT NOT NULL,
  wait_time_ms        INTEGER,
  waiting_tasks_count INTEGER,
  signal_wait_time_ms INTEGER,
  PRIMARY KEY (server_id, ts, wait_type)
) WITHOUT ROWID;
CREATE INDEX ix_waits_type ON waits_samples (server_id, wait_type, ts);

-- Blocking: event-driven, only when Q.blocking returns rows
CREATE TABLE blocking_events (
  id                 INTEGER PRIMARY KEY,
  server_id          INTEGER NOT NULL REFERENCES servers(id),
  ts                 INTEGER NOT NULL,
  blocking_sid       INTEGER,
  blocked_sid        INTEGER,
  wait_type          TEXT,
  wait_ms            INTEGER,
  database_name      TEXT,
  blocker_login      TEXT,
  blocker_host       TEXT,
  blocker_program    TEXT,
  blocked_login      TEXT,
  blocked_host       TEXT,
  blocker_query      TEXT,     -- LEFT(...,300) from Q.blocking
  blocked_query      TEXT,
  parent_object      TEXT
);
CREATE INDEX ix_blocking ON blocking_events (server_id, ts);

-- Watermarks so rollups are idempotent and crash-safe
CREATE TABLE rollup_state (
  server_id    INTEGER NOT NULL REFERENCES servers(id),
  resolution   TEXT NOT NULL CHECK (resolution IN ('1m','15m','1h')),
  watermark_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, resolution)
);

-- Diagnostics
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- rows: created_at, last_rollup_at, last_prune_at, last_vacuum_at
```

No further indexes. Time-series SQLite slows from over-indexing, not inserts.

## Write path

```
poll (2s) → collectMetrics() → insertSnapshot()  ← single transaction
                             → io.emit('metricsUpdated')  (unchanged)
```

`insertSnapshot` in one transaction:

1. Upsert `servers` row (cached in a Map after first hit).
2. Insert `samples_raw` row from scalar KPIs + `metrics.serverPerf`.
3. If ≥60s since last waits write for this server: insert `metrics.resourceWaits`
   rows (top 25) into `waits_samples`.
4. If `metrics.blocking` is non-empty: insert one `blocking_events` row per
   blocking pair. Dedupe guard: skip if an identical
   (blocking_sid, blocked_sid) pair was written for this server within the
   last 60s, so a long block does not insert 30 rows/minute.

### Error handling

- `initialize()` failure (disk full, corrupt file): log one warning, set store
  to disabled no-op mode. Dashboard runs exactly as today, without history.
- Any insert/rollup/prune error: caught and logged with a `[metrics-db]`
  prefix. Never propagates into the poll loop or crashes the process.

## Rollup + retention

Hourly maintenance timer (same pattern as the existing `snapshotHandle`):

1. **Rollup** (`metricsRollup.js`), per server, per resolution, watermark-driven:
   - `1m` ← aggregate `samples_raw` buckets fully in the past, starting after
     `rollup_state.watermark_ts`; advance watermark.
   - `15m` ← from `samples_1m` (avg of avgs weighted by `sample_count`,
     min of mins, max of maxes). `1h` ← from `samples_15m`.
   - Idempotent: re-running after a crash re-aggregates from the watermark;
     `INSERT OR REPLACE` prevents duplicates.
2. **Prune** (`metricsRetention.js`):

   | Table | Kept |
   |---|---|
   | samples_raw | 7 days |
   | samples_1m | 90 days |
   | samples_15m | 1 year |
   | samples_1h | forever |
   | waits_samples | 90 days |
   | blocking_events | 1 year |

3. **Daily** (first maintenance run after 03:00 local): `VACUUM`, then
   `PRAGMA wal_checkpoint(TRUNCATE)` so the WAL file cannot grow unbounded.
   Timestamps of each recorded in `meta`.

Expected steady-state size: low hundreds of MB for ~10 servers.

## API

All endpoints resolve `:id` (live connection) → `server_name`, then query the
store. `from`/`to` validated as positive integers (epoch ms); `to` defaults to
now, `from` defaults to `to - 1h`. Invalid input → 400.

```
GET /api/connections/:id/history?from=&to=&resolution=auto|raw|1m|15m|1h
GET /api/connections/:id/history/waits?from=&to=
GET /api/connections/:id/history/blocking?from=&to=
GET /api/persistence/status
```

`resolution=auto` (default) selects by span:

| Span | Resolution |
|---|---|
| ≤ 2 h | raw |
| ≤ 48 h | 1m |
| ≤ 14 d | 15m |
| > 14 d | 1h |

**Rolled-tail gap:** rollups run hourly, so the most recent ≤1h of a range has
no rollup rows yet. `getHistory` at 1m/15m/1h fills the tail past the rollup
watermark by aggregating `samples_raw` on the fly with the same avg/min/max
SQL, so charts never show a hole at the right edge.

`GET /api/persistence/status` returns: enabled flag, db file size, WAL size,
schema version, per-server oldest/newest raw sample, row counts per table,
last rollup/prune/vacuum timestamps (from `meta`).

## UI — history mode

Range picker in the chart section header: `Live | 1h | 6h | 24h | 7d | 30d | Custom`.

- **Live** (default): current socket-driven behavior, untouched.
- **Historical range**: one `GET /history` fetch; charts render the static
  series; live appends paused; banner shows "Viewing history — Back to Live"
  which returns to Live mode.
- **Custom**: from/to datetime inputs.
- Blocking events render as point markers on the CPU chart in history mode;
  clicking a marker shows the blocking detail (who blocked whom, queries).
- Resource Waits panel shows wait history for the selected range when not Live.
- If the store is disabled or the range predates available data, show an
  empty-state message in the chart area; picker stays usable.

## Testing

Vitest, node environment, store tested against `:memory:` SQLite:

- **metricsStore**: insertSnapshot writes KPI row; waits respect the 60s
  cadence; blocking dedupe window works; disabled mode is a no-op.
- **metricsRollup**: synthetic raw samples → assert 1m avg/min/max math,
  watermark advance, idempotent re-run, 1m→15m weighted averaging.
- **metricsRetention**: rows older than each cutoff removed, newer retained.
- **API**: history endpoints with a stubbed store — resolution auto-selection,
  input validation, 404 on unknown connection.
- **UI**: ConnectionContext/chart tests for range-picker state and
  live-pause behavior, following existing Testing Library patterns.

**Prerequisite fix:** `src/test/setup.js` currently references `window`
unconditionally, which breaks every `@vitest-environment node` test file
(the 9 pre-existing `tests/server/` failures). Guard browser-specific mocks
with `typeof window !== 'undefined'` so server tests can run. New store tests
depend on this.

## Out of scope

- Alerting, baseline overlays, capacity forecasting (future features that
  consume this data).
- Persisting per-session process lists or expensive-query recordsets.
- Migrating `data/db-size-history.json` into SQLite (stays as-is).
- PostgreSQL/TimescaleDB (migration path exists: only `metricsStore`
  internals would change).
- Compression (revisit only if the DB reaches several GB).
