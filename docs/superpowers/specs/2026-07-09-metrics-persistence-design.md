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
| What to persist | Scalar KPIs + wait stats (as deltas) + blocking events. Per-session process lists and expensive-query recordsets are NOT persisted. |
| History identity | Keyed by **instance key** — `@@SERVERNAME` queried once per connection after the pool opens (falls back to the profile's server string if that query fails). Stable across IP changes, DNS renames, and connection-string edits; profiles pointing at the same instance share history. `display_name` stored separately for UI. |
| UI scope | History mode on the existing charts (time-range picker), not a separate page. |
| Timestamps | `INTEGER` epoch **milliseconds** everywhere (epoch is UTC by definition; no local-time values stored). Never ISO strings. |
| Wait stats | Stored as **deltas** between consecutive samples, not cumulative DMV values — historical graphs need per-interval values, not staircases. |

## Architecture

```
server/
├── metricsStore.js      — public API; owns DB handle, prepared statements, transactions
├── metricsSchema.js     — DDL, PRAGMAs, schema versioning (PRAGMA user_version)
├── metricsRollup.js     — raw→1m→15m→1h aggregation, watermark-driven
└── metricsRetention.js  — prune expired rows, daily VACUUM + WAL checkpoint
data/metrics.db          — the database (data/ is gitignored)
```

- `collectMetrics()` stays in `server.js`. After a pool connects, `server.js`
  queries `SELECT @@SERVERNAME` once and stores the result as
  `conn.instanceKey` (fallback: the profile's server string). The poll loop
  gains one call: `metricsStore.insertSnapshot(instanceKey, displayName, metrics)`.
  No SQL exists outside the store modules.
- No queue, no worker thread, no batching. At 2s polls × ~10 servers,
  synchronous inserts cost microseconds under WAL.

### metricsStore public API

```
initialize(dbPath)      — open DB, apply PRAGMAs, run migrations, prepare statements
insertSnapshot(instanceKey, displayName, metrics)
getHistory(instanceKey, fromMs, toMs, resolution)
getWaitHistory(instanceKey, fromMs, toMs)
getBlockingHistory(instanceKey, fromMs, toMs)
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
  id           INTEGER PRIMARY KEY,
  instance_key TEXT NOT NULL UNIQUE,   -- @@SERVERNAME (fallback: profile server string)
  display_name TEXT,                    -- latest profile displayName, updated on connect
  first_seen   INTEGER NOT NULL,       -- epoch ms
  last_seen    INTEGER NOT NULL
);

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,        -- epoch ms
  description TEXT NOT NULL
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

-- Wait stats: written at most once per 60s per server. All three metric
-- columns are DELTAS since the previous sample, not cumulative DMV values.
CREATE TABLE waits_samples (
  server_id           INTEGER NOT NULL REFERENCES servers(id),
  ts                  INTEGER NOT NULL,
  wait_type           TEXT NOT NULL,
  wait_time_ms        INTEGER,          -- delta
  waiting_tasks_count INTEGER,          -- delta
  signal_wait_time_ms INTEGER,          -- delta
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
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL           -- epoch ms
);
-- rows: created_at, last_rollup_at, last_prune_at, last_vacuum_at,
--       last_checkpoint_at, last_insert_at, insert_error_count
```

All writes go through prepared statements created once in `initialize()` and
held for the process lifetime. The `instance_key → server_id` cache is a
per-process Map populated on first insert; a renamed instance produces a new
`instance_key` and therefore a new `servers` row (old history remains under
the old key); disconnecting a server simply leaves its cache entry unused —
no invalidation needed since ids never change.

No further indexes. Time-series SQLite slows from over-indexing, not inserts.

## Write path

```
poll (2s) → collectMetrics() → insertSnapshot()  ← single transaction
                             → io.emit('metricsUpdated')  (unchanged)
```

`insertSnapshot` in one transaction, ordered so that if it ever aborts
partway, event data (blocking) is preserved ahead of periodic telemetry
(waits):

1. Upsert `servers` row (per-process `instance_key → server_id` Map cache;
   `display_name`/`last_seen` refreshed on connect).
2. Insert `samples_raw` row from scalar KPIs + `metrics.serverPerf`.
3. If `metrics.blocking` is non-empty: insert one `blocking_events` row per
   blocking pair. Dedupe guard: skip only if the identical tuple
   **(blocking_sid, blocked_sid, wait_type, database_name)** was written for
   this server within the last 60s — a long-running block does not insert 30
   rows/minute, but the same blocker hitting a new victim (or a new wait
   type/database) is recorded immediately.
4. If ≥60s since last waits write for this server: compute per-wait-type
   **deltas** against the previous cumulative snapshot (held in store memory,
   like the poll loop's `prevIO`) and insert into `waits_samples`.
   - First sample after connect: no previous snapshot → establish baseline,
     write nothing.
   - Any negative delta (SQL Server restart or `DBCC SQLPERF` clear reset the
     counters): re-baseline, skip that write.

### Error handling

- `initialize()` failure (disk full, corrupt file): log one warning, set store
  to disabled no-op mode. Dashboard runs exactly as today, without history.
- Any insert/rollup/prune error: caught and logged with a `[metrics-db]`
  prefix. Never propagates into the poll loop or crashes the process.

## Rollup + retention

Maintenance runs **clock-aligned at HH:05** (startup computes the delay to
the next HH:05, then repeats every 60 min) — restarts do not drift the
schedule, and multiple monitored servers roll up at the same wall-clock
moment:

1. **Rollup** (`metricsRollup.js`), per server, per resolution, watermark-driven:
   - Bucket boundaries are **fixed to epoch multiples** of the resolution
     (`bucket_ts = ts - ts % 60000` for 1m, etc.) — never relative to
     application start time.
   - `1m` ← aggregate `samples_raw` buckets fully in the past, starting after
     `rollup_state.watermark_ts`; advance watermark.
   - `15m` ← from `samples_1m` (avg of avgs weighted by `sample_count`,
     min of mins, max of maxes). `1h` ← from `samples_15m`.
   - **NULL handling:** NULL KPI values are ignored by avg/min/max (SQL
     aggregate semantics); they never count as zero. `sample_count` records
     the number of contributing rows per bucket. A bucket where every value
     of a KPI is NULL stores NULL for that KPI's triplet.
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

3. **Daily** (first maintenance run after 03:00 local):
   - `VACUUM` **only when worthwhile**: run if
     `PRAGMA freelist_count > max(10000, page_count / 4)` — i.e. more than
     25% of the file (or >10k pages) is reclaimable. Otherwise skip; VACUUM
     rewrites the whole file and is wasted work on a compact database.
   - `PRAGMA wal_checkpoint(TRUNCATE)` always, so the WAL file cannot grow
     unbounded.
   - Timestamps of each recorded in `meta` (with `updated_at`).

Expected steady-state size: low hundreds of MB for ~10 servers.

## API

All endpoints resolve `:id` (live connection) → `instance_key`, then query
the store. `from`/`to` validated as positive integers (epoch ms); `to`
defaults to now, `from` defaults to `to - 1h`. Invalid input → 400.

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

`GET /api/persistence/status` returns: enabled flag, db file size, WAL file
size, `freelist_count`/`page_count` (fragmentation), schema version +
migration history, per-server oldest/newest raw sample, row counts per table,
last successful insert timestamp, cumulative insert error count, current raw
insert rate (rows/sec over the last minute), last
rollup/prune/vacuum/checkpoint timestamps (from `meta`).

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
  cadence; wait deltas computed correctly (first sample = baseline only,
  negative delta after counter reset = re-baseline, no row); blocking dedupe
  tuple works (same pair suppressed, new victim/wait_type recorded);
  disabled mode is a no-op.
- **metricsRollup**: synthetic raw samples → assert 1m avg/min/max math,
  epoch-aligned bucket boundaries, NULLs ignored (not zero), watermark
  advance, idempotent re-run, 1m→15m weighted averaging.
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
