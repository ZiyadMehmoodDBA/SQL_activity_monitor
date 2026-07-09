# Alerting + Baselines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn each server's normal hour-of-week workload rhythm from persisted `samples_1m` history and raise in-dashboard alerts (bell + toasts + panel + chart baseline band) when a core KPI deviates ≥3σ from baseline for 5 consecutive minutes.

**Architecture:** Daily baseline recompute (`baselineCalc.js`, inside the existing HH:05 maintenance after-03:00 branch) writes a 168-bucket × 6-KPI `baselines` table. A 60s server-side evaluator (`alertEvaluator.js`) with an in-memory baseline cache opens/resolves rows in an `alerts` table and emits Socket.io `alert` events. Evaluation covers every monitored server, independent of dashboard clients. Frontend: reducer-held alert state, header bell, toasts, alert panel dialog with deep-link into history mode, and a translucent mean±2σ rangeArea band on history charts.

**Tech Stack:** Node.js + Express + Socket.io + better-sqlite3 (server, CommonJS); React + ApexCharts + Tailwind (frontend, ESM); Vitest.

**Spec:** `docs/superpowers/specs/2026-07-09-alerting-baselines-design.md`

## Global Constraints

- No new npm dependencies.
- Fail-open everywhere: alert/baseline errors are logged with `[alerts]` prefix and never throw into the poll loop or maintenance; disabled persistence → empty results / no-ops.
- KPI set exactly: `cpu_pct`, `waiting_tasks`, `io_mb`, `batch_req`, `ple_sec`, `mem_grants_pending`. Direction: `ple_sec` alerts `below` only; the other five `above` only.
- Open threshold: value beyond mean±3σ for **5 consecutive** 60s evaluations. Resolve: inside mean±2σ for **5 consecutive** evaluations.
- `effective_stddev = max(stddev, 0.05 * |mean|, minStddev)` with per-KPI floors: cpu_pct 5, waiting_tasks 2, io_mb 5, batch_req 10, ple_sec 100, mem_grants_pending 1.
- Baseline staleness: `computed_at` older than 35 days → skip evaluation for that KPI (treat as no baseline).
- Dedupe invariant: at most one active (`resolved_at IS NULL`) alert per (server_id, kpi); INSERT guarded by existence check.
- Baseline cache reloads exactly twice: evaluator startup and after each successful recompute.
- 168 hour-of-week buckets, Mon 00:00 UTC = bucket 0. **All bucket math UTC only.** 28-day lookback. Fallback ladder: hour-of-week → hour-of-day → silence.
- All timestamps epoch ms UTC.
- All SQLite SQL lives in `server/` modules via prepared statements — no inline SQL in `server.js`.
- Severity column written as `'critical'` always (schema-ready for future levels).
- Server tests: `// @vitest-environment node` pragma + in-memory `better-sqlite3` DBs.
- React auto-escaping only; no `dangerouslySetInnerHTML`.
- Git: stage files by name (never `git add .` / `-A`); never commit `.env` or credentials.
- No SQL Server T-SQL is added or changed by this feature — all new SQL is SQLite.

## Deviation from spec (documented)

The spec's fallback-ladder gate reads "`sample_count >= 60` (≈1 week of that slot in minutes)". But `samples_1m.sample_count` counts **raw 2s rows** (~30 per minute), so a summed `sample_count` of 60 is only ~2 minutes of data — not the spec's intent. This plan gates on the **count of contributing 1-minute rows** (`COUNT(*) >= 60`, i.e. ≥60 minutes of that slot) while still **weighting** mean/stddev by `sample_count`. The `baselines.sample_count` column stores the minute-row count (the gated quantity). Spec intent ("≈1 week of that slot in minutes") preserved.

---

### Task 1: Migration v2 — baselines + alerts tables

**Files:**
- Modify: `server/metricsSchema.js` (append to `MIGRATIONS` array)
- Test: `tests/server/metricsSchema.test.js` (extend)

**Interfaces:**
- Consumes: existing `MIGRATIONS` array + `migrate(db)` in `server/metricsSchema.js` (v1 already creates `servers`, `samples_raw`, `samples_1m`, `meta`, etc.).
- Produces: tables `baselines` and `alerts` + index `ix_alerts_server`; `PRAGMA user_version = 2`. Later tasks rely on the exact column names below.

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/metricsSchema.test.js` (inside the existing describe or a new one, matching the file's existing style — in-memory DB, `migrate(db)`):

```js
describe('migration v2 (alerting)', () => {
  it('creates baselines and alerts tables and bumps user_version to 2', () => {
    const db = new Database(':memory:');
    migrate(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('baselines','alerts')"
    ).all().map((r) => r.name).sort();
    expect(tables).toEqual(['alerts', 'baselines']);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    db.close();
  });

  it('baselines has composite PK columns and alerts has severity default critical', () => {
    const db = new Database(':memory:');
    migrate(db);
    const bCols = db.prepare('SELECT name FROM pragma_table_info(?)').all('baselines').map((r) => r.name);
    expect(bCols).toEqual(['server_id', 'kpi', 'hour_of_week', 'mean', 'stddev', 'sample_count', 'computed_at']);
    const aCols = db.prepare('SELECT name FROM pragma_table_info(?)').all('alerts').map((r) => r.name);
    expect(aCols).toEqual(['id', 'server_id', 'kpi', 'started_at', 'resolved_at', 'peak_value', 'peak_at', 'baseline_mean', 'baseline_stddev', 'direction', 'severity', 'acked_at']);
    db.prepare("INSERT INTO servers (instance_key, display_name, first_seen, last_seen) VALUES ('S','S',0,0)").run();
    db.prepare("INSERT INTO alerts (server_id, kpi, started_at, direction) VALUES (1, 'cpu_pct', 0, 'above')").run();
    expect(db.prepare('SELECT severity FROM alerts').get().severity).toBe('critical');
    db.close();
  });

  it('migrate is idempotent at v2', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    db.close();
  });

  it('has index ix_alerts_server', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_alerts_server'").get();
    expect(idx).toBeTruthy();
    db.close();
  });
});
```

Note: the `servers` insert column list must match the existing v1 schema — read the top of `metricsSchema.js` first and adjust the INSERT if the column names differ (e.g. `created_at` vs `first_seen`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/metricsSchema.test.js`
Expected: new tests FAIL (`user_version` is 1, no `baselines` table). Existing v1 tests still PASS.

- [ ] **Step 3: Append migration v2**

In `server/metricsSchema.js`, append to the `MIGRATIONS` array (after the v1 entry):

```js
  {
    version: 2,
    description: 'alerting: baselines + alerts tables',
    up(db) {
      db.exec(`
        CREATE TABLE baselines (
          server_id    INTEGER NOT NULL REFERENCES servers(id),
          kpi          TEXT    NOT NULL,
          hour_of_week INTEGER NOT NULL,
          mean         REAL    NOT NULL,
          stddev       REAL    NOT NULL,
          sample_count INTEGER NOT NULL,
          computed_at  INTEGER NOT NULL,
          PRIMARY KEY (server_id, kpi, hour_of_week)
        ) WITHOUT ROWID;

        CREATE TABLE alerts (
          id              INTEGER PRIMARY KEY,
          server_id       INTEGER NOT NULL REFERENCES servers(id),
          kpi             TEXT    NOT NULL,
          started_at      INTEGER NOT NULL,
          resolved_at     INTEGER,
          peak_value      REAL,
          peak_at         INTEGER,
          baseline_mean   REAL,
          baseline_stddev REAL,
          direction       TEXT NOT NULL,
          severity        TEXT NOT NULL DEFAULT 'critical',
          acked_at        INTEGER
        );

        CREATE INDEX ix_alerts_server ON alerts (server_id, started_at);
      `);
    },
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/metricsSchema.test.js`
Expected: ALL PASS (v1 + v2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/metricsSchema.js tests/server/metricsSchema.test.js
git commit -m "feat(alerts): migration v2 — baselines + alerts tables"
```

---

### Task 2: alertConfig.js + baselineCalc.js

**Files:**
- Create: `server/alertConfig.js`
- Create: `server/baselineCalc.js`
- Test: `tests/server/baselineCalc.test.js`

**Interfaces:**
- Consumes: `samples_1m` table (columns `server_id`, `ts`, `<kpi>_avg`, `sample_count`), `servers` table, `baselines` table (Task 1).
- Produces:
  - `alertConfig.js` exports `KPI_ALERT_CONFIG` (object keyed by KPI: `{ direction, sigmaOpen, sigmaClose, minStddev }`) and `CORE_KPIS` (array of the 6 KPI keys).
  - `baselineCalc.js` exports `hourOfWeek(tsMs) -> 0..167` and `recomputeBaselines(db, now) -> rowsWritten` (throws on SQL failure — the store wrapper in Task 3 catches).

- [ ] **Step 1: Create `server/alertConfig.js`** (pure constants, no test needed on its own — exercised by every other test)

```js
'use strict';

// Per-KPI evaluation config. A future `kpi_config` table can replace this
// object without restructuring the evaluator (spec: designed-for extension).
const KPI_ALERT_CONFIG = {
  cpu_pct:            { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 5 },
  waiting_tasks:      { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 2 },
  io_mb:              { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 5 },
  batch_req:          { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 10 },
  ple_sec:            { direction: 'below', sigmaOpen: 3, sigmaClose: 2, minStddev: 100 },
  mem_grants_pending: { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 1 },
};

const CORE_KPIS = Object.keys(KPI_ALERT_CONFIG);

module.exports = { KPI_ALERT_CONFIG, CORE_KPIS };
```

- [ ] **Step 2: Write the failing tests**

Create `tests/server/baselineCalc.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../server/metricsSchema.js';
import { hourOfWeek, recomputeBaselines } from '../../server/baselineCalc.js';

// Mon 2026-01-05 00:00 UTC — a Monday, hour_of_week 0
const MON = Date.UTC(2026, 0, 5, 0, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MIN = 60_000;

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare("INSERT INTO servers (instance_key, display_name, first_seen, last_seen) VALUES ('S1','S1',0,0)").run();
  return db;
}

// Seed `count` consecutive 1-minute rows starting at startTs for one KPI.
function seed1m(db, serverId, startTs, count, kpi, avg, sampleCount = 30) {
  const ins = db.prepare(
    `INSERT INTO samples_1m (server_id, ts, ${kpi}_avg, sample_count) VALUES (?, ?, ?, ?)`
  );
  for (let i = 0; i < count; i++) ins.run(serverId, startTs + i * MIN, avg, sampleCount);
}

describe('hourOfWeek', () => {
  it('Mon 00:00 UTC = 0', () => expect(hourOfWeek(MON)).toBe(0));
  it('Mon 01:30 UTC = 1', () => expect(hourOfWeek(MON + HOUR + 30 * MIN)).toBe(1));
  it('Sun 23:00 UTC = 167', () => expect(hourOfWeek(MON + 6 * DAY + 23 * HOUR)).toBe(167));
  it('next Mon 00:00 UTC wraps to 0', () => expect(hourOfWeek(MON + WEEK)).toBe(0));
});

describe('recomputeBaselines', () => {
  let db;
  beforeEach(() => { db = freshDb(); });

  it('computes weighted mean and population stddev per bucket', () => {
    // Two Mondays, same bucket 0: avg=10 (n=60 raw) and avg=20 (n=60 raw), 60 minutes each
    const now = MON + 2 * WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 60);
    seed1m(db, 1, MON + WEEK, 60, 'cpu_pct', 20, 60);
    recomputeBaselines(db, now);
    const row = db.prepare(
      "SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=0"
    ).get();
    expect(row.mean).toBeCloseTo(15, 6);
    expect(row.stddev).toBeCloseTo(5, 6);   // population stddev of {10×,20×} equal weights
    expect(row.sample_count).toBe(120);     // minute-row count, not summed raw count
    expect(row.computed_at).toBe(now);
  });

  it('excludes NULL avg rows from both sums', () => {
    const now = MON + WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 30);
    // 60 NULL rows in the same bucket must not drag the mean
    const ins = db.prepare('INSERT INTO samples_1m (server_id, ts, cpu_pct_avg, sample_count) VALUES (?, ?, NULL, 30)');
    for (let i = 0; i < 60; i++) ins.run(1, MON + WEEK - DAY + i * MIN); // Sunday rows, different bucket — also add same-bucket NULLs:
    for (let i = 0; i < 5; i++) db.prepare('INSERT INTO samples_1m (server_id, ts, cpu_pct_avg, sample_count) VALUES (?, ?, NULL, 30)').run(1, MON + 60 * MIN + i * MIN);
    recomputeBaselines(db, now);
    const row = db.prepare("SELECT mean FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=0").get();
    expect(row.mean).toBeCloseTo(10, 6);
  });

  it('gates on minute-row count >= 60, not summed sample_count', () => {
    // 59 minute rows with huge sample_count (59×30=1770 raw) must NOT produce an hour-of-week row on its own
    const now = MON + WEEK;
    seed1m(db, 1, MON, 59, 'cpu_pct', 10, 30);
    recomputeBaselines(db, now);
    const row = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=0").get();
    expect(row).toBeUndefined(); // fallback ladder also fails: hour-of-day total is 59 < 60
  });

  it('falls back to hour-of-day aggregate written into hour-of-week rows', () => {
    // 30 minutes at Mon 02:00 + 40 minutes at Thu 02:00 → neither bucket reaches 60,
    // but hour-of-day 02 has 70 minute-rows → both buckets get the aggregated stats
    const now = MON + WEEK;
    seed1m(db, 1, MON + 2 * HOUR, 30, 'cpu_pct', 10, 30);
    seed1m(db, 1, MON + 3 * DAY + 2 * HOUR, 40, 'cpu_pct', 20, 30);
    recomputeBaselines(db, now);
    const monRow = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=2").get();
    const thuRow = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=?").get(3 * 24 + 2);
    const expectedMean = (10 * 30 * 30 + 20 * 40 * 30) / (30 * 30 + 40 * 30); // weighted by sample_count
    expect(monRow.mean).toBeCloseTo(expectedMean, 6);
    expect(thuRow.mean).toBeCloseTo(expectedMean, 6);
    expect(monRow.sample_count).toBe(70);
  });

  it('ignores samples older than 28 days', () => {
    const now = MON + 5 * WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 99, 30); // 5 weeks old — outside lookback
    recomputeBaselines(db, now);
    const row = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct'").get();
    expect(row).toBeUndefined();
  });

  it('replaces a server\'s rows transactionally (old rows gone after recompute)', () => {
    const now1 = MON + WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 30);
    recomputeBaselines(db, now1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM baselines').get().c).toBeGreaterThan(0);
    // Move time so the old data falls outside lookback → recompute should leave zero rows
    recomputeBaselines(db, MON + 6 * WEEK);
    expect(db.prepare('SELECT COUNT(*) AS c FROM baselines').get().c).toBe(0);
  });

  it('returns number of rows written', () => {
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 30);
    const n = recomputeBaselines(db, MON + WEEK);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
```

Note: the `servers` INSERT column list must match v1 schema (same caveat as Task 1). The `samples_1m` KPI column is `cpu_pct_avg` — verify against `KPI_COLUMNS` in `metricsSchema.js` before assuming.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/baselineCalc.test.js`
Expected: FAIL — cannot resolve `../../server/baselineCalc.js`.

- [ ] **Step 4: Create `server/baselineCalc.js`**

```js
'use strict';

const { CORE_KPIS } = require('./alertConfig');

const DAY_MS = 86_400_000;
const LOOKBACK_MS = 28 * DAY_MS;
// Deviation from spec wording (documented in plan header): gate on the COUNT of
// contributing 1-minute rows (>= 60 minutes), not on summed sample_count —
// sample_count counts raw 2s rows (~30/min), so a summed 60 would be ~2 minutes.
const MIN_MINUTES = 60;
// Epoch 1970-01-01 was a Thursday; Monday 00:00 UTC alignment needs a 4-day shift.
const MONDAY_OFFSET_S = 4 * 86_400;
const WEEK_S = 7 * 86_400;

function hourOfWeek(tsMs) {
  const s = Math.floor(tsMs / 1000);
  return Math.floor(((((s - MONDAY_OFFSET_S) % WEEK_S) + WEEK_S) % WEEK_S) / 3600);
}

// Recompute all baselines from samples_1m (trailing 28d). Transactional per
// server: DELETE + INSERT atomic, so failure keeps previous baselines.
// Returns total rows written. Throws on SQL failure (caller catches).
function recomputeBaselines(db, now = Date.now()) {
  const since = now - LOOKBACK_MS;
  const servers = db.prepare('SELECT id FROM servers').all();
  const del = db.prepare('DELETE FROM baselines WHERE server_id = ?');
  const ins = db.prepare(`
    INSERT INTO baselines (server_id, kpi, hour_of_week, mean, stddev, sample_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // KPI names come from the CORE_KPIS constant, never user input — safe to interpolate.
  const statStmts = {};
  for (const kpi of CORE_KPIS) {
    statStmts[kpi] = db.prepare(`
      SELECT
        CAST((((ts / 1000 - ${MONDAY_OFFSET_S}) % ${WEEK_S} + ${WEEK_S}) % ${WEEK_S}) / 3600 AS INTEGER) AS how,
        SUM(${kpi}_avg * sample_count)              AS wsum,
        SUM(${kpi}_avg * ${kpi}_avg * sample_count) AS wsq,
        SUM(sample_count)                           AS n,
        COUNT(*)                                    AS mins
      FROM samples_1m
      WHERE server_id = ? AND ts >= ? AND ${kpi}_avg IS NOT NULL
      GROUP BY how
    `);
  }

  let written = 0;
  const recomputeServer = db.transaction((serverId) => {
    del.run(serverId);
    for (const kpi of CORE_KPIS) {
      const buckets = new Map(); // how -> {wsum, wsq, n, mins}
      for (const r of statStmts[kpi].all(serverId, since)) buckets.set(r.how, r);

      // Precompute hour-of-day aggregates for the fallback ladder.
      const hod = new Map(); // 0..23 -> {wsum, wsq, n, mins}
      for (const [how, s] of buckets) {
        const h = how % 24;
        const agg = hod.get(h) || { wsum: 0, wsq: 0, n: 0, mins: 0 };
        agg.wsum += s.wsum; agg.wsq += s.wsq; agg.n += s.n; agg.mins += s.mins;
        hod.set(h, agg);
      }

      for (let how = 0; how < 168; how++) {
        const direct = buckets.get(how);
        let src = null;
        if (direct && direct.mins >= MIN_MINUTES) src = direct;
        else {
          const agg = hod.get(how % 24);
          if (agg && agg.mins >= MIN_MINUTES) src = agg;
        }
        if (!src || !src.n) continue; // ladder exhausted → silence for this bucket
        const mean = src.wsum / src.n;
        const variance = Math.max(0, src.wsq / src.n - mean * mean);
        ins.run(serverId, kpi, how, mean, Math.sqrt(variance), src.mins, now);
        written++;
      }
    }
  });

  for (const s of servers) recomputeServer(s.id);
  return written;
}

module.exports = { hourOfWeek, recomputeBaselines, LOOKBACK_MS, MIN_MINUTES };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/baselineCalc.test.js`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add server/alertConfig.js server/baselineCalc.js tests/server/baselineCalc.test.js
git commit -m "feat(alerts): KPI alert config + baseline computation with fallback ladder"
```

---

### Task 3: metricsStore alert/baseline wrappers + alerts retention

**Files:**
- Modify: `server/metricsStore.js` (new prepared statements + exported functions)
- Modify: `server/metricsRetention.js` (alerts prune entry, per-table ts column)
- Test: `tests/server/metricsAlertsStore.test.js` (new)

**Interfaces:**
- Consumes: Task 1 tables, Task 2 `recomputeBaselines(db, now)`, existing store internals (`db`, `enabled`, `stmts`, `resolveServerId(instanceKey)`, `_db()` test hatch, `metaSet`).
- Produces (all exported from `metricsStore.js`; every function is a no-op / empty result when store disabled):
  - `recomputeBaselines(now) -> rowsWritten|0` — wraps Task 2, sets `meta.last_baseline_at`, fail-open (catch → log `[alerts]`, return 0).
  - `getServerIdForKey(instanceKey) -> id|null`
  - `getRecentKpiAverages(serverId, now) -> { cpu_pct, waiting_tasks, io_mb, batch_req, ple_sec, mem_grants_pending, n }|null` — AVG over last 60s of `samples_raw`, `n` = row count.
  - `getAllBaselines() -> rows[]` (all servers, raw snake_case rows)
  - `getBaselines(instanceKey, kpi) -> rows[]` (`hour_of_week, mean, stddev, sample_count, computed_at` ordered by hour_of_week)
  - `getActiveAlerts() -> rows[]` (all servers, `resolved_at IS NULL`)
  - `getAlerts(instanceKey, { activeOnly, from, to }) -> rows[]` (activeOnly → unresolved, else `started_at` in [from, to], newest first)
  - `openAlert({ serverId, kpi, startedAt, value, mean, stddev, direction }) -> id|null` — **null if an active alert already exists for (serverId, kpi)** (dedupe invariant); writes `peak_value=value, peak_at=startedAt, severity='critical'`.
  - `updateAlertPeak(id, value, ts) -> void`
  - `resolveAlert(id, ts) -> void`
  - `ackAlert(instanceKey, alertId, now) -> boolean` — idempotent via `COALESCE(acked_at, ?)`; false when alert not found or belongs to another server.

- [ ] **Step 1: Read `server/metricsStore.js` and the existing store test file**

Read `server/metricsStore.js` fully and `tests/server/metricsStore.test.js` (or the equivalent existing store test) to copy: the init call used in tests, the `stmts` preparation location, the fail-open wrapper style, and `resolveServerId`. All new code below must follow those exact patterns.

- [ ] **Step 2: Write the failing tests**

Create `tests/server/metricsAlertsStore.test.js` (mirror the init/teardown of the existing store test file exactly — same init function, same in-memory path):

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as store from '../../server/metricsStore.js';

// Use the SAME init/reset helpers as tests/server/metricsStore.test.js —
// read that file first and copy its beforeEach/afterEach verbatim.

const MON = Date.UTC(2026, 0, 5); // Monday 00:00 UTC → hour_of_week 0
const MIN = 60_000;

function seedServer() {
  // Insert one snapshot so the server row exists, then return its id.
  store.insertSnapshot('SRV\\INST', 'Srv', { cpu_pct: 10 }, MON);
  return store.getServerIdForKey('SRV\\INST');
}

describe('alert store wrappers', () => {
  // beforeEach/afterEach copied from existing store test

  it('getServerIdForKey returns null for unknown key', () => {
    expect(store.getServerIdForKey('nope')).toBeNull();
  });

  it('getRecentKpiAverages averages last 60s of samples_raw', () => {
    const id = seedServer();
    const db = store._db();
    const ins = db.prepare('INSERT INTO samples_raw (server_id, ts, cpu_pct) VALUES (?, ?, ?)');
    ins.run(id, MON - 10_000, 40);
    ins.run(id, MON - 5_000, 60);
    ins.run(id, MON - 120_000, 999); // outside 60s window
    const avg = store.getRecentKpiAverages(id, MON);
    expect(avg.cpu_pct).toBeCloseTo(50, 6);
    expect(avg.n).toBeGreaterThanOrEqual(2);
  });

  it('openAlert enforces one active alert per (server, kpi)', () => {
    const id = seedServer();
    const a1 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    expect(a1).toBeTypeOf('number');
    const a2 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON + MIN, value: 95, mean: 30, stddev: 5, direction: 'above' });
    expect(a2).toBeNull();
    store.resolveAlert(a1, MON + 10 * MIN);
    const a3 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON + 11 * MIN, value: 91, mean: 30, stddev: 5, direction: 'above' });
    expect(a3).toBeTypeOf('number');
  });

  it('openAlert writes peak, severity critical, baseline stats', () => {
    const id = seedServer();
    const alertId = store.openAlert({ serverId: id, kpi: 'ple_sec', startedAt: MON, value: 50, mean: 3000, stddev: 200, direction: 'below' });
    const row = store._db().prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
    expect(row.peak_value).toBe(50);
    expect(row.peak_at).toBe(MON);
    expect(row.severity).toBe('critical');
    expect(row.baseline_mean).toBe(3000);
    expect(row.direction).toBe('below');
  });

  it('updateAlertPeak and resolveAlert', () => {
    const id = seedServer();
    const alertId = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    store.updateAlertPeak(alertId, 97, MON + 2 * MIN);
    store.resolveAlert(alertId, MON + 9 * MIN);
    const row = store._db().prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
    expect(row.peak_value).toBe(97);
    expect(row.peak_at).toBe(MON + 2 * MIN);
    expect(row.resolved_at).toBe(MON + 9 * MIN);
  });

  it('getAlerts activeOnly and range modes', () => {
    const id = seedServer();
    const a1 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    store.resolveAlert(a1, MON + MIN);
    store.openAlert({ serverId: id, kpi: 'io_mb', startedAt: MON + 2 * MIN, value: 200, mean: 20, stddev: 5, direction: 'above' });
    const active = store.getAlerts('SRV\\INST', { activeOnly: true });
    expect(active).toHaveLength(1);
    expect(active[0].kpi).toBe('io_mb');
    const ranged = store.getAlerts('SRV\\INST', { from: MON - MIN, to: MON + 5 * MIN });
    expect(ranged).toHaveLength(2);
  });

  it('ackAlert is idempotent and scoped to the server', () => {
    const id = seedServer();
    const alertId = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    expect(store.ackAlert('SRV\\INST', alertId, MON + MIN)).toBe(true);
    expect(store.ackAlert('SRV\\INST', alertId, MON + 5 * MIN)).toBe(true); // idempotent
    expect(store._db().prepare('SELECT acked_at FROM alerts WHERE id=?').get(alertId).acked_at).toBe(MON + MIN); // first ack wins
    expect(store.ackAlert('OTHER\\KEY', alertId, MON)).toBe(false);
    expect(store.ackAlert('SRV\\INST', 999999, MON)).toBe(false);
  });

  it('recomputeBaselines wrapper writes rows, sets meta, and getBaselines reads them', () => {
    const id = seedServer();
    const db = store._db();
    const ins = db.prepare('INSERT INTO samples_1m (server_id, ts, cpu_pct_avg, sample_count) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 60; i++) ins.run(id, MON + i * MIN, 25, 30);
    const written = store.recomputeBaselines(MON + 7 * 86_400_000);
    expect(written).toBeGreaterThanOrEqual(1);
    const meta = db.prepare("SELECT value FROM meta WHERE key='last_baseline_at'").get();
    expect(meta).toBeTruthy();
    const rows = store.getBaselines('SRV\\INST', 'cpu_pct');
    expect(rows.find((r) => r.hour_of_week === 0).mean).toBeCloseTo(25, 6);
    expect(store.getAllBaselines().length).toBe(rows.length);
  });

  it('disabled mode: wrappers are no-ops / empty', () => {
    // Use the same disable technique as the existing store test (init with disabled flag or no init).
    // getAlerts → [], getBaselines → [], openAlert → null, ackAlert → false, recomputeBaselines → 0.
  });
});
```

Adjust the two seeding details to the real schema before running: `insertSnapshot` signature and `samples_raw`/`samples_1m` column names (verify against `metricsSchema.js` `KPI_COLUMNS`). Fill in the disabled-mode test using the existing store test's disable technique.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/metricsAlertsStore.test.js`
Expected: FAIL — exported functions undefined.

- [ ] **Step 4: Implement store wrappers**

In `server/metricsStore.js`, add to the statement-preparation block (exact style of existing `stmts`):

```js
    // --- alerting (migration v2) ---
    serverIdByKey: db.prepare('SELECT id FROM servers WHERE instance_key = ?'),
    recentKpiAvg: db.prepare(`
      SELECT AVG(cpu_pct) AS cpu_pct, AVG(waiting_tasks) AS waiting_tasks,
             AVG(io_mb) AS io_mb, AVG(batch_req) AS batch_req,
             AVG(ple_sec) AS ple_sec, AVG(mem_grants_pending) AS mem_grants_pending,
             COUNT(*) AS n
      FROM samples_raw WHERE server_id = ? AND ts > ?
    `),
    allBaselines: db.prepare('SELECT * FROM baselines'),
    baselinesByKpi: db.prepare(`
      SELECT hour_of_week, mean, stddev, sample_count, computed_at
      FROM baselines WHERE server_id = ? AND kpi = ? ORDER BY hour_of_week
    `),
    activeAlerts: db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL'),
    activeAlertForPair: db.prepare('SELECT id FROM alerts WHERE server_id = ? AND kpi = ? AND resolved_at IS NULL'),
    insertAlert: db.prepare(`
      INSERT INTO alerts (server_id, kpi, started_at, peak_value, peak_at, baseline_mean, baseline_stddev, direction, severity)
      VALUES (@serverId, @kpi, @startedAt, @value, @startedAt, @mean, @stddev, @direction, 'critical')
    `),
    updateAlertPeak: db.prepare('UPDATE alerts SET peak_value = ?, peak_at = ? WHERE id = ?'),
    resolveAlert: db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?'),
    ackAlert: db.prepare('UPDATE alerts SET acked_at = COALESCE(acked_at, ?) WHERE id = ? AND server_id = ?'),
    alertsActiveByServer: db.prepare('SELECT * FROM alerts WHERE server_id = ? AND resolved_at IS NULL ORDER BY started_at DESC'),
    alertsRangeByServer: db.prepare('SELECT * FROM alerts WHERE server_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC'),
```

(The raw-sample column names in `recentKpiAvg` must match `samples_raw` — verify against `KPI_COLUMNS`.)

Add functions (before `module.exports`, following the existing fail-open wrapper style):

```js
const baselineCalc = require('./baselineCalc');

function recomputeBaselines(now = Date.now()) {
  if (!enabled) return 0;
  try {
    const written = baselineCalc.recomputeBaselines(db, now);
    stmts.metaSet.run('last_baseline_at', String(now));
    return written;
  } catch (e) {
    console.error('[alerts] baseline recompute failed:', e.message);
    return 0;
  }
}

function getServerIdForKey(instanceKey) {
  if (!enabled) return null;
  try {
    const row = stmts.serverIdByKey.get(instanceKey);
    return row ? row.id : null;
  } catch (e) { console.error('[alerts] getServerIdForKey failed:', e.message); return null; }
}

function getRecentKpiAverages(serverId, now = Date.now()) {
  if (!enabled) return null;
  try { return stmts.recentKpiAvg.get(serverId, now - 60_000); }
  catch (e) { console.error('[alerts] getRecentKpiAverages failed:', e.message); return null; }
}

function getAllBaselines() {
  if (!enabled) return [];
  try { return stmts.allBaselines.all(); }
  catch (e) { console.error('[alerts] getAllBaselines failed:', e.message); return []; }
}

function getBaselines(instanceKey, kpi) {
  if (!enabled) return [];
  try {
    const serverId = getServerIdForKey(instanceKey);
    if (serverId == null) return [];
    return stmts.baselinesByKpi.all(serverId, kpi);
  } catch (e) { console.error('[alerts] getBaselines failed:', e.message); return []; }
}

function getActiveAlerts() {
  if (!enabled) return [];
  try { return stmts.activeAlerts.all(); }
  catch (e) { console.error('[alerts] getActiveAlerts failed:', e.message); return []; }
}

function getAlerts(instanceKey, { activeOnly = false, from = 0, to = Date.now() } = {}) {
  if (!enabled) return [];
  try {
    const serverId = getServerIdForKey(instanceKey);
    if (serverId == null) return [];
    return activeOnly
      ? stmts.alertsActiveByServer.all(serverId)
      : stmts.alertsRangeByServer.all(serverId, from, to);
  } catch (e) { console.error('[alerts] getAlerts failed:', e.message); return []; }
}

function openAlert({ serverId, kpi, startedAt, value, mean, stddev, direction }) {
  if (!enabled) return null;
  try {
    if (stmts.activeAlertForPair.get(serverId, kpi)) return null; // dedupe invariant
    const info = stmts.insertAlert.run({ serverId, kpi, startedAt, value, mean, stddev, direction });
    return Number(info.lastInsertRowid);
  } catch (e) { console.error('[alerts] openAlert failed:', e.message); return null; }
}

function updateAlertPeak(id, value, ts) {
  if (!enabled) return;
  try { stmts.updateAlertPeak.run(value, ts, id); }
  catch (e) { console.error('[alerts] updateAlertPeak failed:', e.message); }
}

function resolveAlert(id, ts) {
  if (!enabled) return;
  try { stmts.resolveAlert.run(ts, id); }
  catch (e) { console.error('[alerts] resolveAlert failed:', e.message); }
}

function ackAlert(instanceKey, alertId, now = Date.now()) {
  if (!enabled) return false;
  try {
    const serverId = getServerIdForKey(instanceKey);
    if (serverId == null) return false;
    return stmts.ackAlert.run(now, alertId, serverId).changes > 0;
  } catch (e) { console.error('[alerts] ackAlert failed:', e.message); return false; }
}
```

Note on `ackAlert` idempotency test: `COALESCE` keeps the first `acked_at`, but `UPDATE ... changes` still reports 1 on re-ack (row matched). That satisfies "idempotent → true".

Export all new functions in `module.exports`.

In `server/metricsRetention.js`: add `{ table: 'alerts', keepMs: 365 * DAY, tsCol: 'started_at' }` to the `RETENTION` array and change the prune SQL to use `${r.tsCol || 'ts'}` as the timestamp column.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/metricsAlertsStore.test.js tests/server/metricsRetention.test.js`
Expected: ALL PASS (add one retention test asserting alerts older than 365d prune on `started_at` if the retention test file exists — mirror its existing per-table test style).

- [ ] **Step 6: Commit**

```bash
git add server/metricsStore.js server/metricsRetention.js tests/server/metricsAlertsStore.test.js
git commit -m "feat(alerts): store wrappers for baselines/alerts + 365d alerts retention"
```

(Stage the retention test file too if modified.)

---

### Task 4: alertEvaluator.js — 60s evaluation state machine

**Files:**
- Create: `server/alertEvaluator.js`
- Test: `tests/server/alertEvaluator.test.js`

**Interfaces:**
- Consumes: Task 3 store functions (`getServerIdForKey`, `getRecentKpiAverages`, `getAllBaselines`, `getActiveAlerts`, `openAlert`, `updateAlertPeak`, `resolveAlert`), Task 2 `hourOfWeek`, `KPI_ALERT_CONFIG`/`CORE_KPIS`.
- Produces: `createAlertEvaluator({ listServers, emit }) -> { start(), evaluate(now?), reloadCache() }`.
  - `listServers() -> [{ connectionId, instanceKey }]` — supplied by server.js (Task 5); every monitored server, independent of dashboard clients.
  - `emit(connectionId, payload)` — payload `{ id, kpi, direction, severity, value, mean, stddev, startedAt, resolvedAt }` (`resolvedAt: null` on open).

- [ ] **Step 1: Write the failing tests**

Create `tests/server/alertEvaluator.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as store from '../../server/metricsStore.js';
import { createAlertEvaluator } from '../../server/alertEvaluator.js';

// Same store init/teardown as tests/server/metricsAlertsStore.test.js.

const MON = Date.UTC(2026, 0, 5); // hour_of_week 0
const MIN = 60_000;
const KEY = 'SRV\\INST';

let emits;
let evaluator;

function setup({ mean = 30, stddev = 1, kpi = 'cpu_pct', computedAt = MON } = {}) {
  store.insertSnapshot(KEY, 'Srv', { cpu_pct: 10 }, MON - MIN);
  const id = store.getServerIdForKey(KEY);
  // Seed a baseline row for every hour bucket the test touches (bucket 0 and 1 in eval window)
  const ins = store._db().prepare(
    'INSERT INTO baselines (server_id, kpi, hour_of_week, mean, stddev, sample_count, computed_at) VALUES (?,?,?,?,?,?,?)'
  );
  for (const how of [0, 1]) ins.run(id, kpi, how, mean, stddev, 100, computedAt);
  emits = [];
  evaluator = createAlertEvaluator({
    listServers: () => [{ connectionId: 'c1', instanceKey: KEY }],
    emit: (connId, payload) => emits.push({ connId, payload }),
  });
  evaluator.start();
  return id;
}

function feed(id, kpi, value, ts) {
  store._db().prepare(`INSERT INTO samples_raw (server_id, ts, ${kpi}) VALUES (?,?,?)`).run(id, ts - 1000, value);
}

function tick(id, kpi, value, ts) {
  feed(id, kpi, value, ts);
  evaluator.evaluate(ts);
}

describe('alertEvaluator', () => {
  it('opens at exactly 5 consecutive breaches, not 4', () => {
    const id = setup(); // mean 30, effective sd = max(1, 1.5, 5) = 5 → open above 45
    for (let i = 0; i < 4; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
    tick(id, 'cpu_pct', 90, MON + 4 * MIN);
    const active = store.getActiveAlerts();
    expect(active).toHaveLength(1);
    expect(emits).toHaveLength(1);
    expect(emits[0].payload.resolvedAt).toBeNull();
    expect(emits[0].payload.severity).toBe('critical');
  });

  it('breach counter resets on a non-breach value', () => {
    const id = setup();
    for (let i = 0; i < 4; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    tick(id, 'cpu_pct', 30, MON + 4 * MIN); // reset
    for (let i = 5; i < 9; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('resolves with 2σ hysteresis after 5 calm evaluations', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    // calm = inside mean+2σ_eff = 30+10 = 40
    for (let i = 5; i < 9; i++) tick(id, 'cpu_pct', 35, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(1);
    tick(id, 'cpu_pct', 35, MON + 9 * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
    const resolveEmit = emits.at(-1);
    expect(resolveEmit.payload.resolvedAt).toBe(MON + 9 * MIN);
  });

  it('value between 2σ and 3σ neither opens nor resolves (hysteresis gap)', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    for (let i = 5; i < 15; i++) tick(id, 'cpu_pct', 42, MON + i * MIN); // 40 < 42 < 45
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('ple_sec alerts on below only', () => {
    const id = setup({ kpi: 'ple_sec', mean: 3000, stddev: 200 });
    for (let i = 0; i < 5; i++) tick(id, 'ple_sec', 9999, MON + i * MIN); // high PLE = healthy
    expect(store.getActiveAlerts()).toHaveLength(0);
    for (let i = 5; i < 10; i++) tick(id, 'ple_sec', 100, MON + i * MIN); // below 3000-3*200=2400
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('three-way stddev floor suppresses noise on near-constant low metrics', () => {
    const id = setup({ mean: 2, stddev: 0.1 }); // relative floor 0.1, absolute floor 5 → open above 2+15=17
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 10, MON + i * MIN); // would breach without floor
    expect(store.getActiveAlerts()).toHaveLength(0);
    for (let i = 5; i < 10; i++) tick(id, 'cpu_pct', 20, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('skips stale baselines (>35d)', () => {
    const id = setup({ computedAt: MON - 36 * 86_400_000 });
    for (let i = 0; i < 6; i++) tick(id, 'cpu_pct', 99, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('no baseline row → silent', () => {
    store.insertSnapshot(KEY, 'Srv', { cpu_pct: 10 }, MON - MIN);
    const id = store.getServerIdForKey(KEY);
    emits = [];
    evaluator = createAlertEvaluator({ listServers: () => [{ connectionId: 'c1', instanceKey: KEY }], emit: () => {} });
    evaluator.start();
    for (let i = 0; i < 6; i++) tick(id, 'cpu_pct', 99, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('tracks peak_value and peak_at while active', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    tick(id, 'cpu_pct', 97, MON + 5 * MIN);
    tick(id, 'cpu_pct', 93, MON + 6 * MIN);
    const row = store.getActiveAlerts()[0];
    expect(row.peak_value).toBe(97);
    expect(row.peak_at).toBe(MON + 5 * MIN);
  });

  it('restart re-adopts active alerts so they can still resolve', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    // New evaluator instance = restart
    const ev2 = createAlertEvaluator({ listServers: () => [{ connectionId: 'c1', instanceKey: KEY }], emit: (c, p) => emits.push({ connId: c, payload: p }) });
    ev2.start();
    for (let i = 5; i < 10; i++) { feed(id, 'cpu_pct', 31, MON + i * MIN); ev2.evaluate(MON + i * MIN); }
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('dedupe: no second active alert per pair even at 5 more breaches', () => {
    const id = setup();
    for (let i = 0; i < 15; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store._db().prepare("SELECT COUNT(*) AS c FROM alerts WHERE kpi='cpu_pct'").get().c).toBe(1);
  });

  it('server with no fresh samples is skipped for the cycle', () => {
    const id = setup();
    for (let i = 0; i < 4; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    evaluator.evaluate(MON + 10 * MIN); // no samples in last 60s → no reset, no advance
    tick(id, 'cpu_pct', 90, MON + 11 * MIN);
    expect(store.getActiveAlerts()).toHaveLength(1); // counter preserved across skipped cycle
  });

  it('emit failure never throws out of evaluate', () => {
    const id = setup();
    evaluator = createAlertEvaluator({
      listServers: () => [{ connectionId: 'c1', instanceKey: KEY }],
      emit: () => { throw new Error('boom'); },
    });
    evaluator.start();
    expect(() => {
      for (let i = 0; i < 6; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    }).not.toThrow();
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('duplicate connections to the same instance evaluate once per cycle', () => {
    const id = setup();
    evaluator = createAlertEvaluator({
      listServers: () => [
        { connectionId: 'c1', instanceKey: KEY },
        { connectionId: 'c2', instanceKey: KEY },
      ],
      emit: () => {},
    });
    evaluator.start();
    for (let i = 0; i < 3; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0); // 3 cycles, not 6 counter increments
  });
});
```

The eval timestamps stay within hour buckets 0–1 (≤ MON+15min), which `setup()` seeds. If a test crosses further buckets, seed those too.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/alertEvaluator.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/alertEvaluator.js`**

```js
'use strict';

const metricsStore = require('./metricsStore');
const { KPI_ALERT_CONFIG, CORE_KPIS } = require('./alertConfig');
const { hourOfWeek } = require('./baselineCalc');

const OPEN_CONSECUTIVE = 5;
const CLOSE_CONSECUTIVE = 5;
const BASELINE_STALE_MS = 35 * 86_400_000;

function effectiveStddev(mean, stddev, minStddev) {
  return Math.max(stddev, 0.05 * Math.abs(mean), minStddev);
}

function createAlertEvaluator({ listServers, emit }) {
  let cache = new Map();      // `${serverId}|${kpi}|${how}` -> baseline row
  const counters = new Map(); // `${serverId}|${kpi}` -> { breach, calm }
  const active = new Map();   // `${serverId}|${kpi}` -> live alert row copy

  function reloadCache() {
    try {
      const next = new Map();
      for (const b of metricsStore.getAllBaselines()) {
        next.set(`${b.server_id}|${b.kpi}|${b.hour_of_week}`, b);
      }
      cache = next;
    } catch (e) { console.error('[alerts] baseline cache reload failed:', e.message); }
  }

  function start() {
    reloadCache();
    try {
      for (const a of metricsStore.getActiveAlerts()) active.set(`${a.server_id}|${a.kpi}`, a);
    } catch (e) { console.error('[alerts] active alert re-adoption failed:', e.message); }
  }

  function safeEmit(connectionId, payload) {
    try { emit(connectionId, payload); }
    catch (e) { console.error('[alerts] emit failed:', e.message); }
  }

  function evaluate(now = Date.now()) {
    let servers;
    try { servers = listServers(); } catch (e) { console.error('[alerts] listServers failed:', e.message); return; }
    const seen = new Set();
    for (const s of servers) {
      if (seen.has(s.instanceKey)) continue; // one evaluation per instance per cycle
      seen.add(s.instanceKey);
      try { evaluateServer(s, now); }
      catch (e) { console.error('[alerts] evaluation error:', e.message); }
    }
  }

  function evaluateServer({ connectionId, instanceKey }, now) {
    const serverId = metricsStore.getServerIdForKey(instanceKey);
    if (serverId == null) return;
    const averages = metricsStore.getRecentKpiAverages(serverId, now);
    if (!averages || !averages.n) return; // no fresh samples → skip cycle, counters preserved
    const how = hourOfWeek(now);

    for (const kpi of CORE_KPIS) {
      const value = averages[kpi];
      if (value == null) continue;
      const cfg = KPI_ALERT_CONFIG[kpi];
      const key = `${serverId}|${kpi}`;
      const b = cache.get(`${serverId}|${kpi}|${how}`);
      if (!b || now - b.computed_at > BASELINE_STALE_MS) {
        counters.delete(key); // silent: no/stale baseline (active alert kept until baseline returns)
        continue;
      }
      const sd = effectiveStddev(b.mean, b.stddev, cfg.minStddev);
      const breach = cfg.direction === 'above'
        ? value > b.mean + cfg.sigmaOpen * sd
        : value < b.mean - cfg.sigmaOpen * sd;
      const calm = cfg.direction === 'above'
        ? value <= b.mean + cfg.sigmaClose * sd
        : value >= b.mean - cfg.sigmaClose * sd;

      const c = counters.get(key) || { breach: 0, calm: 0 };
      const current = active.get(key);

      if (!current) {
        c.breach = breach ? c.breach + 1 : 0;
        if (c.breach >= OPEN_CONSECUTIVE) {
          const id = metricsStore.openAlert({
            serverId, kpi, startedAt: now, value, mean: b.mean, stddev: b.stddev, direction: cfg.direction,
          });
          if (id != null) {
            active.set(key, {
              id, server_id: serverId, kpi, started_at: now,
              peak_value: value, peak_at: now, direction: cfg.direction,
            });
            safeEmit(connectionId, {
              id, kpi, direction: cfg.direction, severity: 'critical',
              value, mean: b.mean, stddev: b.stddev, startedAt: now, resolvedAt: null,
            });
          }
          c.breach = 0;
        }
      } else {
        const worse = current.direction === 'above'
          ? value > current.peak_value
          : value < current.peak_value;
        if (worse) {
          current.peak_value = value;
          current.peak_at = now;
          metricsStore.updateAlertPeak(current.id, value, now);
        }
        c.calm = calm ? c.calm + 1 : 0;
        if (c.calm >= CLOSE_CONSECUTIVE) {
          metricsStore.resolveAlert(current.id, now);
          active.delete(key);
          safeEmit(connectionId, {
            id: current.id, kpi, direction: current.direction, severity: 'critical',
            value, mean: b.mean, stddev: b.stddev, startedAt: current.started_at, resolvedAt: now,
          });
          c.calm = 0; c.breach = 0;
        }
      }
      counters.set(key, c);
    }
  }

  return { start, evaluate, reloadCache };
}

module.exports = { createAlertEvaluator, effectiveStddev };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/alertEvaluator.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/alertEvaluator.js tests/server/alertEvaluator.test.js
git commit -m "feat(alerts): 60s evaluator state machine — 3σ open, 2σ hysteresis close, peak tracking"
```

---

### Task 5: server.js wiring + validation + API endpoints

**Files:**
- Create: `server/alertValidation.js`
- Modify: `server.js` (evaluator wiring ~line 1259 area; maintenance daily branch ~1239-1257; endpoints after history endpoints ~1051)
- Test: `tests/server/alertValidation.test.js`

**Interfaces:**
- Consumes: Task 4 `createAlertEvaluator`, Task 3 store functions, existing `requireConn(req,res)` (server.js:114-118), `parseHistoryRange` from `server/historyRange.js`, `connections` Map (server.js:99, entries have `.instanceKey`), `io.to('conn:${id}')` room pattern, maintenance `runMetricsMaintenance()` after-03:00 daily branch.
- Produces:
  - `alertValidation.js` exports `parseKpi(q) -> kpi|null` (core-6 allowlist) and `parseAlertId(param) -> int|null` (positive integer).
  - Endpoints: `GET /api/connections/:id/alerts` (`?active=1` or `?from=&to=`), `POST /api/connections/:id/alerts/:alertId/ack`, `GET /api/connections/:id/baselines?kpi=`.
  - Socket `alert` event payload: `{ connectionId, id, kpi, direction, severity, value, mean, stddev, startedAt, resolvedAt }` broadcast to room `conn:${connectionId}` (frontend Task 6 consumes).

- [ ] **Step 1: Write the failing validation tests**

Create `tests/server/alertValidation.test.js`:

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseKpi, parseAlertId } from '../../server/alertValidation.js';

describe('parseKpi', () => {
  it('accepts each core-6 KPI', () => {
    for (const k of ['cpu_pct', 'waiting_tasks', 'io_mb', 'batch_req', 'ple_sec', 'mem_grants_pending']) {
      expect(parseKpi(k)).toBe(k);
    }
  });
  it('rejects unknown, empty, injection-ish input', () => {
    expect(parseKpi('cpu_pct; DROP TABLE alerts')).toBeNull();
    expect(parseKpi('')).toBeNull();
    expect(parseKpi(undefined)).toBeNull();
    expect(parseKpi('CPU_PCT')).toBeNull(); // case-sensitive allowlist
  });
});

describe('parseAlertId', () => {
  it('accepts positive integers', () => {
    expect(parseAlertId('42')).toBe(42);
    expect(parseAlertId(7)).toBe(7);
  });
  it('rejects non-integers, zero, negatives, NaN', () => {
    expect(parseAlertId('1.5')).toBeNull();
    expect(parseAlertId('0')).toBeNull();
    expect(parseAlertId('-3')).toBeNull();
    expect(parseAlertId('abc')).toBeNull();
    expect(parseAlertId('')).toBeNull();
    expect(parseAlertId(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/alertValidation.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/alertValidation.js`**

```js
'use strict';

const { CORE_KPIS } = require('./alertConfig');

function parseKpi(q) {
  return CORE_KPIS.includes(q) ? q : null;
}

function parseAlertId(param) {
  if (param === '' || param == null) return null;
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { parseKpi, parseAlertId };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/alertValidation.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Wire evaluator + endpoints in `server.js`**

Requires at top of `server.js` (next to the existing `metricsStore`/`historyRange` requires):

```js
const { createAlertEvaluator } = require('./server/alertEvaluator');
const { parseKpi, parseAlertId } = require('./server/alertValidation');
```

**5a — evaluator wiring.** Next to the maintenance scheduler IIFE (~line 1259), after `connections` and `io` exist:

```js
// --- alert evaluator: runs for every monitored server, independent of dashboard clients ---
const alertEvaluator = createAlertEvaluator({
  listServers: () =>
    [...connections.entries()].map(([id, c]) => ({
      connectionId: id,
      instanceKey: c.instanceKey || c.server,
    })),
  emit: (connectionId, payload) => {
    io.to(`conn:${connectionId}`).emit('alert', { connectionId, ...payload });
  },
});
alertEvaluator.start();
setInterval(() => alertEvaluator.evaluate(), 60_000);
```

**5b — maintenance daily branch.** Inside `runMetricsMaintenance()`'s after-03:00-local daily branch (~1239-1257, alongside vacuum/checkpoint), add:

```js
      const baselineRows = metricsStore.recomputeBaselines(Date.now());
      if (baselineRows > 0) alertEvaluator.reloadCache();
```

(Reload only after **successful** recompute — cache reload happens exactly at startup + here, per spec. Note: `alertEvaluator` must be declared before `runMetricsMaintenance` first fires; place the wiring block above the scheduler IIFE.)

**5c — endpoints.** After the existing history endpoints (~line 1051), same `requireConn` pattern:

```js
app.get('/api/connections/:id/alerts', (req, res) => {
  const c = requireConn(req, res);
  if (!c) return;
  if (req.query.active === '1') {
    return res.json({ alerts: metricsStore.getAlerts(c.instanceKey, { activeOnly: true }) });
  }
  // Mirror the exact parseHistoryRange call + error handling used by the
  // /api/connections/:id/history endpoint above (same 90d span cap, same 400 shape).
  const range = parseHistoryRange(req.query, Date.now());
  if (range.error) return res.status(400).json({ error: range.error });
  res.json({ alerts: metricsStore.getAlerts(c.instanceKey, { from: range.from, to: range.to }) });
});

app.post('/api/connections/:id/alerts/:alertId/ack', (req, res) => {
  const c = requireConn(req, res);
  if (!c) return;
  const alertId = parseAlertId(req.params.alertId);
  if (alertId == null) return res.status(400).json({ error: 'Invalid alert id' });
  const ok = metricsStore.ackAlert(c.instanceKey, alertId, Date.now());
  if (!ok) return res.status(404).json({ error: 'Alert not found' });
  res.json({ ok: true });
});

app.get('/api/connections/:id/baselines', (req, res) => {
  const c = requireConn(req, res);
  if (!c) return;
  const kpi = parseKpi(req.query.kpi);
  if (!kpi) return res.status(400).json({ error: 'Invalid kpi' });
  res.json({ kpi, baselines: metricsStore.getBaselines(c.instanceKey, kpi) });
});
```

Before writing, read the existing history endpoint block and copy its exact `parseHistoryRange` return-shape handling (the `range.error` line above is illustrative — match whatever the history endpoint actually does, including any `?active` short-circuit ordering).

- [ ] **Step 6: Smoke-check server boots**

Run: `node -e "require('./server/alertEvaluator'); require('./server/alertValidation'); console.log('modules ok')"`
Expected: `modules ok`.
Then start the dev server briefly (`npm run dev` or `node server.js`, whichever the repo uses) and confirm no startup errors and `[alerts]` errors absent. Ctrl-C after boot.

- [ ] **Step 7: Run full server test suite**

Run: `npx vitest run tests/server`
Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add server/alertValidation.js tests/server/alertValidation.test.js server.js
git commit -m "feat(alerts): evaluator wiring, daily baseline recompute, alerts/baselines API"
```

---

### Task 6: Reducer alert state + socket listener + initial fetch

**Files:**
- Modify: `src/context/connectionReducer.js`
- Modify: `src/context/ConnectionContext.jsx`
- Create: `src/lib/alertFmt.js` (normalizeAlertRow only — Task 7 extends it)
- Test: `src/__tests__/context/connectionReducer.alerts.test.js`

**Interfaces:**
- Consumes: existing reducer shape — `initialConnectionState`, `makeLive(profile)`, `updateConn(state, connId, patch)`; socket `alert` payload from Task 5 (`{ connectionId, id, kpi, direction, severity, value, mean, stddev, startedAt, resolvedAt }`); `GET /api/connections/:id/alerts?active=1` returning snake_case DB rows.
- Produces:
  - Per-connection live state gains `alerts: []` (array of camelCase alert objects `{ id, kpi, direction, severity, value?, mean?, stddev?, startedAt, resolvedAt, peakValue?, peakAt?, ackedAt? }`).
  - Root state gains `lastAlertEvent: null` (`{ connId, alert, seq }`) and `deepLink: null` (`{ connId, from, to }`).
  - Actions: `ALERT_EVENT {connId, alert}`, `ALERTS_LOADED {connId, alerts}`, `ALERT_ACKED {connId, alertId, ackedAt}`, `SET_DEEP_LINK {connId, from, to}`, `CLEAR_DEEP_LINK`.
  - `alertFmt.js` exports `normalizeAlertRow(row)` — snake_case DB row → camelCase alert object.
  - Context value additionally exposes `lastAlertEvent` and `deepLink` (whole state already exposed if that's the current pattern — match it).

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/context/connectionReducer.alerts.test.js` (match import style of any existing reducer test):

```js
import { describe, it, expect } from 'vitest';
import { connectionReducer, initialConnectionState } from '../../context/connectionReducer.js';
import { normalizeAlertRow } from '../../lib/alertFmt.js';

const CONN = 'c1';

function stateWithConn() {
  // Build a state containing one live connection the way the reducer itself does.
  // If the reducer has a CONNECTED/ADD_CONNECTION action, use it; otherwise construct minimally:
  return {
    ...initialConnectionState,
    connections: {
      [CONN]: { id: CONN, alerts: [] },
    },
  };
}

const openAlert = { id: 1, kpi: 'cpu_pct', direction: 'above', severity: 'critical', value: 90, mean: 30, stddev: 5, startedAt: 1000, resolvedAt: null };

describe('ALERT_EVENT', () => {
  it('adds an open alert to the connection', () => {
    const s = connectionReducer(stateWithConn(), { type: 'ALERT_EVENT', connId: CONN, alert: openAlert });
    expect(s.connections[CONN].alerts).toHaveLength(1);
    expect(s.lastAlertEvent.alert.id).toBe(1);
    expect(s.lastAlertEvent.seq).toBe(1);
  });

  it('removes the alert on resolve event and bumps seq', () => {
    let s = connectionReducer(stateWithConn(), { type: 'ALERT_EVENT', connId: CONN, alert: openAlert });
    s = connectionReducer(s, { type: 'ALERT_EVENT', connId: CONN, alert: { ...openAlert, resolvedAt: 2000 } });
    expect(s.connections[CONN].alerts).toHaveLength(0);
    expect(s.lastAlertEvent.seq).toBe(2);
    expect(s.lastAlertEvent.alert.resolvedAt).toBe(2000);
  });

  it('replaces rather than duplicates the same alert id', () => {
    let s = connectionReducer(stateWithConn(), { type: 'ALERT_EVENT', connId: CONN, alert: openAlert });
    s = connectionReducer(s, { type: 'ALERT_EVENT', connId: CONN, alert: { ...openAlert, value: 95 } });
    expect(s.connections[CONN].alerts).toHaveLength(1);
    expect(s.connections[CONN].alerts[0].value).toBe(95);
  });

  it('ignores events for unknown connections', () => {
    const s0 = stateWithConn();
    const s = connectionReducer(s0, { type: 'ALERT_EVENT', connId: 'nope', alert: openAlert });
    expect(s).toBe(s0);
  });
});

describe('ALERTS_LOADED / ALERT_ACKED', () => {
  it('replaces the alert list', () => {
    const s = connectionReducer(stateWithConn(), { type: 'ALERTS_LOADED', connId: CONN, alerts: [openAlert, { ...openAlert, id: 2 }] });
    expect(s.connections[CONN].alerts).toHaveLength(2);
  });

  it('marks a single alert acked', () => {
    let s = connectionReducer(stateWithConn(), { type: 'ALERTS_LOADED', connId: CONN, alerts: [openAlert, { ...openAlert, id: 2 }] });
    s = connectionReducer(s, { type: 'ALERT_ACKED', connId: CONN, alertId: 2, ackedAt: 5000 });
    expect(s.connections[CONN].alerts.find((a) => a.id === 2).ackedAt).toBe(5000);
    expect(s.connections[CONN].alerts.find((a) => a.id === 1).ackedAt).toBeUndefined();
  });
});

describe('deep link', () => {
  it('SET_DEEP_LINK / CLEAR_DEEP_LINK round-trip', () => {
    let s = connectionReducer(stateWithConn(), { type: 'SET_DEEP_LINK', connId: CONN, from: 100, to: 200 });
    expect(s.deepLink).toEqual({ connId: CONN, from: 100, to: 200 });
    s = connectionReducer(s, { type: 'CLEAR_DEEP_LINK' });
    expect(s.deepLink).toBeNull();
  });
});

describe('normalizeAlertRow', () => {
  it('maps snake_case DB row to camelCase', () => {
    const row = {
      id: 3, server_id: 1, kpi: 'io_mb', started_at: 10, resolved_at: null,
      peak_value: 200, peak_at: 12, baseline_mean: 20, baseline_stddev: 4,
      direction: 'above', severity: 'critical', acked_at: null,
    };
    expect(normalizeAlertRow(row)).toEqual({
      id: 3, kpi: 'io_mb', startedAt: 10, resolvedAt: null,
      peakValue: 200, peakAt: 12, mean: 20, stddev: 4,
      direction: 'above', severity: 'critical', ackedAt: null,
    });
  });
});
```

Adjust `stateWithConn()` to the real reducer: if live connections are created via `makeLive(profile)` through an action, drive it with that action instead of hand-building state (read `connectionReducer.js` first — the export names `connectionReducer`/`initialConnectionState` must match the actual ones).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/context/connectionReducer.alerts.test.js`
Expected: FAIL — unknown actions return unchanged state / `alertFmt.js` missing.

- [ ] **Step 3: Implement**

**3a — `src/lib/alertFmt.js`:**

```js
export function normalizeAlertRow(row) {
  return {
    id: row.id,
    kpi: row.kpi,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    peakValue: row.peak_value,
    peakAt: row.peak_at,
    mean: row.baseline_mean,
    stddev: row.baseline_stddev,
    direction: row.direction,
    severity: row.severity,
    ackedAt: row.acked_at,
  };
}
```

**3b — `src/context/connectionReducer.js`:**
- Add to the root initial state: `lastAlertEvent: null, deepLink: null`.
- Add `alerts: []` to the live-connection object created in `makeLive(profile)`.
- Add cases (using the existing `updateConn` helper):

```js
    case 'ALERT_EVENT': {
      const conn = state.connections[action.connId];
      if (!conn) return state;
      const a = action.alert;
      const rest = (conn.alerts || []).filter((x) => x.id !== a.id);
      const alerts = a.resolvedAt ? rest : [...rest, a];
      const next = updateConn(state, action.connId, { alerts });
      return {
        ...next,
        lastAlertEvent: { connId: action.connId, alert: a, seq: (state.lastAlertEvent?.seq || 0) + 1 },
      };
    }
    case 'ALERTS_LOADED': {
      const conn = state.connections[action.connId];
      if (!conn) return state;
      return updateConn(state, action.connId, { alerts: action.alerts });
    }
    case 'ALERT_ACKED': {
      const conn = state.connections[action.connId];
      if (!conn) return state;
      return updateConn(state, action.connId, {
        alerts: (conn.alerts || []).map((a) => (a.id === action.alertId ? { ...a, ackedAt: action.ackedAt } : a)),
      });
    }
    case 'SET_DEEP_LINK':
      return { ...state, deepLink: { connId: action.connId, from: action.from, to: action.to } };
    case 'CLEAR_DEEP_LINK':
      return { ...state, deepLink: null };
```

**3c — `src/context/ConnectionContext.jsx`:**
- In the socket-listener `useEffect` (~line 119-160), add alongside the existing `metrics` listener:

```js
    const onAlert = (payload) => {
      dispatch({ type: 'ALERT_EVENT', connId: payload.connectionId, alert: payload });
    };
    socket.on('alert', onAlert);
```

and `socket.off('alert', onAlert)` in the cleanup.
- After each successful `subscribe()` in `connectProfile` and `addConnection`, load active alerts:

```js
    fetch(`/api/connections/${id}/alerts?active=1`)
      .then((r) => (r.ok ? r.json() : { alerts: [] }))
      .then(({ alerts }) => dispatch({ type: 'ALERTS_LOADED', connId: id, alerts: alerts.map(normalizeAlertRow) }))
      .catch(() => {});
```

with `import { normalizeAlertRow } from '../lib/alertFmt.js';`
- Ensure `lastAlertEvent` and `deepLink` reach consumers via the context value (if the whole reducer state is already exposed, nothing extra needed — verify).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/context/connectionReducer.alerts.test.js`
Expected: ALL PASS. Also run any existing reducer/context tests: `npx vitest run src/__tests__` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/context/connectionReducer.js src/context/ConnectionContext.jsx src/lib/alertFmt.js src/__tests__/context/connectionReducer.alerts.test.js
git commit -m "feat(alerts): reducer alert state, socket listener, active-alert hydration, deep-link state"
```

---

### Task 7: alertFmt formatting + AlertBell + AlertToasts

**Files:**
- Modify: `src/lib/alertFmt.js` (add labels/formatting)
- Create: `src/components/AlertBell.jsx`
- Create: `src/components/AlertToasts.jsx`
- Modify: `src/components/Header.jsx` (mount bell)
- Modify: `src/App.jsx` (showAlerts state, mount toasts)
- Test: `src/__tests__/lib/alertFmt.test.js`, `src/__tests__/components/AlertBell.test.jsx`, `src/__tests__/components/AlertToasts.test.jsx`

**Interfaces:**
- Consumes: Task 6 state (`connections[*].alerts`, `lastAlertEvent`), context hook (match the existing hook name in `ConnectionContext.jsx`, e.g. `useConnections()`); lucide-react icons (already a dependency — Header uses it).
- Produces:
  - `alertFmt.js` additionally exports `KPI_LABELS` (object), `fmtKpi(kpi, v) -> string`, `alertText(a) -> string` (pattern "CPU 94% vs typical 31±8%").
  - `<AlertBell onClick />` — bell button, badge = active **unacked** alert count across all connections, `animate-pulse` red badge when >0.
  - `<AlertToasts />` — self-contained toast stack (fixed bottom-right); red open toast / green resolve toast, auto-dismiss 8s.
  - `App.jsx` passes `onOpenAlerts={() => setShowAlerts(true)}` to Header; `showAlerts` consumed by Task 8's panel.

- [ ] **Step 1: Write the failing alertFmt tests**

Create `src/__tests__/lib/alertFmt.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { KPI_LABELS, fmtKpi, alertText } from '../../lib/alertFmt.js';

describe('fmtKpi', () => {
  it('formats each KPI with its unit', () => {
    expect(fmtKpi('cpu_pct', 94.26)).toBe('94.3%');
    expect(fmtKpi('io_mb', 12.34)).toBe('12.3 MB/s');
    expect(fmtKpi('ple_sec', 2954.7)).toBe('2955s');
    expect(fmtKpi('batch_req', 1520.4)).toBe('1520/s');
    expect(fmtKpi('waiting_tasks', 7.8)).toBe('8');
    expect(fmtKpi('mem_grants_pending', 3.2)).toBe('3');
  });
  it('null-safe', () => expect(fmtKpi('cpu_pct', null)).toBe('—'));
});

describe('alertText', () => {
  it('matches the spec toast pattern', () => {
    expect(alertText({ kpi: 'cpu_pct', value: 94, mean: 31, stddev: 8 })).toBe('CPU 94% vs typical 31%±8%');
  });
  it('falls back to peakValue when value absent (DB rows)', () => {
    expect(alertText({ kpi: 'cpu_pct', peakValue: 97, mean: 31, stddev: 8 })).toBe('CPU 97% vs typical 31%±8%');
  });
  it('has a label for all core-6', () => {
    expect(Object.keys(KPI_LABELS).sort()).toEqual(
      ['batch_req', 'cpu_pct', 'io_mb', 'mem_grants_pending', 'ple_sec', 'waiting_tasks']
    );
  });
});
```

- [ ] **Step 2: Run to verify fail, then extend `src/lib/alertFmt.js`**

Run: `npx vitest run src/__tests__/lib/alertFmt.test.js` → FAIL (exports missing). Then append:

```js
export const KPI_LABELS = {
  cpu_pct: 'CPU',
  waiting_tasks: 'Waiting Tasks',
  io_mb: 'DB I/O',
  batch_req: 'Batch Req',
  ple_sec: 'PLE',
  mem_grants_pending: 'Mem Grants Pending',
};

export function fmtKpi(kpi, v) {
  if (v == null) return '—';
  switch (kpi) {
    case 'cpu_pct': return `${Math.round(v * 10) / 10}%`;
    case 'io_mb': return `${Math.round(v * 10) / 10} MB/s`;
    case 'ple_sec': return `${Math.round(v)}s`;
    case 'batch_req': return `${Math.round(v)}/s`;
    default: return `${Math.round(v)}`;
  }
}

export function alertText(a) {
  const label = KPI_LABELS[a.kpi] || a.kpi;
  const v = a.value ?? a.peakValue;
  return `${label} ${fmtKpi(a.kpi, v)} vs typical ${fmtKpi(a.kpi, a.mean)}±${fmtKpi(a.kpi, a.stddev)}`;
}
```

Re-run: ALL PASS.

- [ ] **Step 3: Write the failing AlertBell test**

Create `src/__tests__/components/AlertBell.test.jsx` (match the render/mocking style of existing component tests in that directory — read one first; they presumably wrap in the connection provider or mock the context hook):

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AlertBell from '../../components/AlertBell.jsx';

// Mock the context hook — adjust the module path/hook name to the real ones.
const mockState = {
  connections: {
    c1: { id: 'c1', alerts: [
      { id: 1, kpi: 'cpu_pct', startedAt: 1, resolvedAt: null, ackedAt: null },
      { id: 2, kpi: 'io_mb', startedAt: 2, resolvedAt: null, ackedAt: 999 }, // acked → not counted
    ] },
    c2: { id: 'c2', alerts: [
      { id: 3, kpi: 'ple_sec', startedAt: 3, resolvedAt: null, ackedAt: null },
    ] },
  },
};
vi.mock('../../context/ConnectionContext.jsx', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useConnections: () => ({ state: mockState }) };
});

describe('AlertBell', () => {
  it('badge shows active unacked count across all connections', () => {
    render(<AlertBell onClick={() => {}} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });
  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<AlertBell onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /alerts/i }));
    expect(onClick).toHaveBeenCalled();
  });
});
```

(Adapt the mock to the real hook shape — if the hook returns state fields directly rather than `{ state }`, mirror that.)

- [ ] **Step 4: Create `src/components/AlertBell.jsx`, run test**

```jsx
import React from 'react';
import { Bell } from 'lucide-react';
import { useConnections } from '../context/ConnectionContext.jsx';

export default function AlertBell({ onClick }) {
  const { state } = useConnections(); // adjust to the real hook shape
  const count = Object.values(state.connections || {}).reduce(
    (sum, c) => sum + (c.alerts || []).filter((a) => !a.resolvedAt && !a.ackedAt).length,
    0
  );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Alerts"
      className="relative rounded-xl p-2 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
    >
      <Bell size={18} />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white animate-pulse">
          {count}
        </span>
      )}
    </button>
  );
}
```

Style note: match Header's existing button classes (dark theme assumed above — copy the real palette from `Header.jsx`). Run: `npx vitest run src/__tests__/components/AlertBell.test.jsx` → PASS.

- [ ] **Step 5: Write the failing AlertToasts test**

Create `src/__tests__/components/AlertToasts.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import AlertToasts from '../../components/AlertToasts.jsx';

let mockLastAlertEvent = null;
vi.mock('../../context/ConnectionContext.jsx', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useConnections: () => ({ state: { lastAlertEvent: mockLastAlertEvent, connections: {} } }) };
});

describe('AlertToasts', () => {
  beforeEach(() => { vi.useFakeTimers(); mockLastAlertEvent = null; });
  afterEach(() => { vi.useRealTimers(); });

  it('shows an open toast with spec text and auto-dismisses after 8s', () => {
    const { rerender } = render(<AlertToasts />);
    mockLastAlertEvent = { connId: 'c1', seq: 1, alert: { id: 1, kpi: 'cpu_pct', value: 94, mean: 31, stddev: 8, startedAt: 1, resolvedAt: null } };
    rerender(<AlertToasts />);
    expect(screen.getByText(/CPU 94% vs typical 31%±8%/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(8100); });
    expect(screen.queryByText(/CPU 94%/)).not.toBeInTheDocument();
  });

  it('resolve event renders a green resolve toast', () => {
    const { rerender } = render(<AlertToasts />);
    mockLastAlertEvent = { connId: 'c1', seq: 1, alert: { id: 1, kpi: 'cpu_pct', value: 33, mean: 31, stddev: 8, startedAt: 1, resolvedAt: 999 } };
    rerender(<AlertToasts />);
    expect(screen.getByText(/resolved/i)).toBeInTheDocument();
  });

  it('same seq does not duplicate a toast on re-render', () => {
    mockLastAlertEvent = { connId: 'c1', seq: 1, alert: { id: 1, kpi: 'cpu_pct', value: 94, mean: 31, stddev: 8, startedAt: 1, resolvedAt: null } };
    const { rerender } = render(<AlertToasts />);
    rerender(<AlertToasts />);
    expect(screen.getAllByText(/CPU 94%/)).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Create `src/components/AlertToasts.jsx`, run test**

```jsx
import React, { useEffect, useRef, useState } from 'react';
import { useConnections } from '../context/ConnectionContext.jsx';
import { alertText } from '../lib/alertFmt.js';

const TOAST_MS = 8000;

export default function AlertToasts() {
  const { state } = useConnections(); // adjust to the real hook shape
  const event = state.lastAlertEvent;
  const seenSeq = useRef(0);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    if (!event || event.seq <= seenSeq.current) return;
    seenSeq.current = event.seq;
    const toast = { key: event.seq, alert: event.alert };
    setToasts((t) => [...t, toast]);
    const timer = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.key !== toast.key));
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [event]);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(({ key, alert }) => {
        const resolved = alert.resolvedAt != null;
        return (
          <div
            key={key}
            role="status"
            className={`rounded-2xl px-4 py-3 text-sm shadow-lg border ${
              resolved
                ? 'bg-emerald-950/90 border-emerald-700 text-emerald-200'
                : 'bg-red-950/90 border-red-700 text-red-200'
            }`}
          >
            <span className="font-semibold">{resolved ? 'Resolved: ' : 'Alert: '}</span>
            {alertText(alert)}
          </div>
        );
      })}
    </div>
  );
}
```

Run: `npx vitest run src/__tests__/components/AlertToasts.test.jsx` → PASS.

- [ ] **Step 7: Mount in Header + App**

`src/components/Header.jsx`: accept `onOpenAlerts` prop; render `<AlertBell onClick={onOpenAlerts} />` in the right-side flex group (next to the existing buttons).

`src/App.jsx`:

```jsx
const [showAlerts, setShowAlerts] = useState(false);
```

Pass `onOpenAlerts={() => setShowAlerts(true)}` to `<Header />`; mount `<AlertToasts />` at root level (outside the keyed Dashboard). `showAlerts`/`setShowAlerts` are wired to the panel in Task 8 — for now the state exists and the bell toggles it.

- [ ] **Step 8: Run frontend tests + visual check**

Run: `npx vitest run src/__tests__` → ALL PASS.
Then `npm run dev`, open the dashboard: bell renders in header, no badge (no alerts yet), no console errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/alertFmt.js src/components/AlertBell.jsx src/components/AlertToasts.jsx src/components/Header.jsx src/App.jsx src/__tests__/lib/alertFmt.test.js src/__tests__/components/AlertBell.test.jsx src/__tests__/components/AlertToasts.test.jsx
git commit -m "feat(alerts): header bell with unacked badge + open/resolve toasts"
```

---

### Task 8: AlertPanel dialog + ack + deep-link into history mode

**Files:**
- Create: `src/components/AlertPanel.jsx`
- Modify: `src/App.jsx` (mount panel with `showAlerts`)
- Modify: `src/components/Dashboard.jsx` (deep-link consumption effect near histRange state, ~line 309-319)
- Test: `src/__tests__/components/AlertPanel.test.jsx`

**Interfaces:**
- Consumes: `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogBody`/`DialogClose` from `src/components/ui/Dialog.jsx`; Task 6 state + actions (`ALERT_ACKED`, `SET_DEEP_LINK`, `CLEAR_DEEP_LINK`); Task 5 endpoints (`?from=&to=` for resolved history, `POST .../ack`); `alertText`, `fmtKpi`, `normalizeAlertRow`; Dashboard `histRange` state `{ key, from, to }` with `key: 'custom'`; the context's selected connection id (match existing name, e.g. `selectedConnectionId`).
- Produces: `<AlertPanel open onClose />` — active alerts (top) with KPI label, start time, duration, peak vs normal, Ack button; resolved alerts from last 7 days below, muted. Row click → deep-link: `SET_DEEP_LINK { connId, from: startedAt − 15min, to: (resolvedAt ?? now) + 15min }` then `onClose()`. Dashboard watches `deepLink` and, when `deepLink.connId === connId`, sets `histRange = { key: 'custom', from, to }` and dispatches `CLEAR_DEEP_LINK`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/components/AlertPanel.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AlertPanel from '../../components/AlertPanel.jsx';

const activeAlert = { id: 1, kpi: 'cpu_pct', startedAt: Date.now() - 600_000, resolvedAt: null, peakValue: 97, peakAt: Date.now() - 300_000, mean: 31, stddev: 8, direction: 'above', severity: 'critical', ackedAt: null };
const mockDispatch = vi.fn();
const CONN = 'c1';

vi.mock('../../context/ConnectionContext.jsx', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    useConnections: () => ({
      state: { connections: { [CONN]: { id: CONN, alerts: [activeAlert] } }, selectedConnectionId: CONN },
      dispatch: mockDispatch,
    }),
  };
});

beforeEach(() => {
  mockDispatch.mockClear();
  global.fetch = vi.fn((url, opts) => {
    if (opts?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ alerts: [
      { id: 9, kpi: 'io_mb', started_at: Date.now() - 86_400_000, resolved_at: Date.now() - 86_000_000, peak_value: 120, peak_at: 0, baseline_mean: 20, baseline_stddev: 4, direction: 'above', severity: 'critical', acked_at: null },
    ] }) });
  });
});

describe('AlertPanel', () => {
  it('renders active alerts with Ack button and resolved history', async () => {
    render(<AlertPanel open onClose={() => {}} />);
    expect(screen.getByText(/CPU/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ack/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/DB I\/O/)).toBeInTheDocument()); // resolved row fetched
  });

  it('Ack POSTs and dispatches ALERT_ACKED', async () => {
    render(<AlertPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /ack/i }));
    await waitFor(() =>
      expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'ALERT_ACKED', connId: CONN, alertId: 1 }))
    );
    expect(global.fetch).toHaveBeenCalledWith(`/api/connections/${CONN}/alerts/1/ack`, expect.objectContaining({ method: 'POST' }));
  });

  it('row click dispatches SET_DEEP_LINK with ±15min padding and closes', async () => {
    const onClose = vi.fn();
    render(<AlertPanel open onClose={onClose} />);
    fireEvent.click(screen.getByText(/CPU/));
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_DEEP_LINK', connId: CONN })));
    const call = mockDispatch.mock.calls.find((c) => c[0].type === 'SET_DEEP_LINK')[0];
    expect(call.from).toBe(activeAlert.startedAt - 15 * 60_000);
    expect(call.to).toBeGreaterThan(Date.now() - 5000); // unresolved → now + 15min
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/components/AlertPanel.test.jsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Create `src/components/AlertPanel.jsx`**

```jsx
import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogClose } from './ui/Dialog.jsx';
import { useConnections } from '../context/ConnectionContext.jsx';
import { alertText, fmtKpi, KPI_LABELS, normalizeAlertRow } from '../lib/alertFmt.js';

const PAD_MS = 15 * 60_000;
const WEEK_MS = 7 * 86_400_000;

function fmtDuration(ms) {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function AlertPanel({ open, onClose }) {
  const { state, dispatch } = useConnections(); // adjust to the real hook shape
  const connId = state.selectedConnectionId;
  const conn = state.connections[connId];
  const active = (conn?.alerts || []).filter((a) => !a.resolvedAt);
  const [resolved, setResolved] = useState([]);

  useEffect(() => {
    if (!open || !connId) return;
    const now = Date.now();
    fetch(`/api/connections/${connId}/alerts?from=${now - WEEK_MS}&to=${now}`)
      .then((r) => (r.ok ? r.json() : { alerts: [] }))
      .then(({ alerts }) => setResolved(alerts.map(normalizeAlertRow).filter((a) => a.resolvedAt)))
      .catch(() => setResolved([]));
  }, [open, connId]);

  const ack = (alertId) => {
    fetch(`/api/connections/${connId}/alerts/${alertId}/ack`, { method: 'POST' })
      .then((r) => { if (r.ok) dispatch({ type: 'ALERT_ACKED', connId, alertId, ackedAt: Date.now() }); })
      .catch(() => {});
  };

  const deepLink = (a) => {
    const to = (a.resolvedAt ?? Date.now()) + PAD_MS;
    dispatch({ type: 'SET_DEEP_LINK', connId, from: a.startedAt - PAD_MS, to });
    onClose();
  };

  const Row = ({ a, muted }) => (
    <div
      onClick={() => deepLink(a)}
      className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2 cursor-pointer transition-colors ${
        muted ? 'border-slate-800 text-slate-500 hover:bg-slate-900' : 'border-red-900/60 bg-red-950/30 text-slate-200 hover:bg-red-950/50'
      }`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{alertText(a)}</div>
        <div className="text-xs opacity-70">
          {new Date(a.startedAt).toLocaleString()} · {fmtDuration((a.resolvedAt ?? Date.now()) - a.startedAt)}
          {' · peak '}{fmtKpi(a.kpi, a.peakValue)}
        </div>
      </div>
      {!muted && !a.ackedAt && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); ack(a.id); }}
          className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Ack
        </button>
      )}
    </div>
  );

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Alerts{conn ? ` — ${conn.label || connId}` : ''}</DialogTitle>
          <DialogClose onClick={onClose} />
        </DialogHeader>
        <DialogBody>
          <div className="space-y-2">
            {active.length === 0 && <div className="text-sm text-slate-500">No active alerts.</div>}
            {active.map((a) => <Row key={a.id} a={a} />)}
          </div>
          <div className="mt-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">Resolved — last 7 days</div>
            <div className="space-y-2">
              {resolved.length === 0 && <div className="text-sm text-slate-600">Nothing resolved recently.</div>}
              {resolved.map((a) => <Row key={a.id} a={a} muted />)}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
```

Adjust Dialog subcomponent usage to the real API in `src/components/ui/Dialog.jsx` (prop names for open/close — read it first). Match dark-theme palette to existing components.

- [ ] **Step 4: Mount in App + Dashboard deep-link effect**

`src/App.jsx`: `<AlertPanel open={showAlerts} onClose={() => setShowAlerts(false)} />` next to `<AlertToasts />`.

`src/components/Dashboard.jsx` — after the existing histRange state + connId reset effect (~309-319):

```jsx
  // Deep-link from alert panel: jump to alert window in history mode
  useEffect(() => {
    if (!deepLink || deepLink.connId !== connId) return;
    setHistRange({ key: 'custom', from: deepLink.from, to: deepLink.to });
    dispatch({ type: 'CLEAR_DEEP_LINK' });
  }, [deepLink, connId]);
```

with `deepLink` and `dispatch` pulled from the same context hook Dashboard already uses (add to its destructuring). Verify `HistoryRangePicker` renders a `custom` range correctly (it already supports `key: 'custom'` per the custom-range feature).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/components/AlertPanel.test.jsx` → ALL PASS.
Then `npx vitest run src/__tests__` → no regressions.

- [ ] **Step 6: Visual check**

`npm run dev`: open bell → panel renders empty states cleanly; close works. (Live alert flow verified in Task 10 E2E.)

- [ ] **Step 7: Commit**

```bash
git add src/components/AlertPanel.jsx src/App.jsx src/components/Dashboard.jsx src/__tests__/components/AlertPanel.test.jsx
git commit -m "feat(alerts): alert panel with ack + deep-link into history mode"
```

---

### Task 9: Baseline band on history charts

**Files:**
- Create: `src/lib/baselineBand.js`
- Modify: `src/components/Dashboard.jsx` (baseline fetches in hist effect ~328-351; pass `band` in chart render loop ~795-808)
- Modify: `src/components/ChartCard.jsx` (optional `band` prop, rangeArea combo)
- Test: `src/__tests__/lib/baselineBand.test.js`, `src/__tests__/components/ChartCard.test.jsx`

**Interfaces:**
- Consumes: `GET /api/connections/:id/baselines?kpi=` → `{ kpi, baselines: [{ hour_of_week, mean, stddev, sample_count, computed_at }] }`; ChartCard props `{ title, subtitle, value, unit, history, color, yMax, timestamps, events }`; Dashboard histKey→kpi map `{ cpu: 'cpu_pct', wait: 'waiting_tasks', io: 'io_mb', batch: 'batch_req' }`.
- Produces:
  - `baselineBand.js` exports `hourOfWeek(tsMs)` (same math as server) and `bandData(baselineRows, timestamps) -> [{ x, y: [lo, hi] | null }]` where `lo = max(0, mean − 2·stddev)`, `hi = mean + 2·stddev`, `y: null` for missing buckets.
  - `ChartCard` accepts optional `band`; renders a translucent rangeArea series behind the line **only in timestamps (history) mode**.

- [ ] **Step 1: Write the failing baselineBand tests**

Create `src/__tests__/lib/baselineBand.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { hourOfWeek, bandData } from '../../lib/baselineBand.js';

const MON = Date.UTC(2026, 0, 5); // Monday 00:00 UTC → 0
const HOUR = 3_600_000;

describe('hourOfWeek (client)', () => {
  it('matches server bucket math', () => {
    expect(hourOfWeek(MON)).toBe(0);
    expect(hourOfWeek(MON + HOUR)).toBe(1);
    expect(hourOfWeek(MON + 6 * 86_400_000 + 23 * HOUR)).toBe(167);
  });
});

describe('bandData', () => {
  const rows = [
    { hour_of_week: 0, mean: 30, stddev: 5 },
    { hour_of_week: 1, mean: 40, stddev: 25 }, // lo would be −10 → clamp 0
  ];
  it('maps timestamps to mean±2σ ranges', () => {
    const out = bandData(rows, [MON, MON + HOUR]);
    expect(out[0]).toEqual({ x: MON, y: [20, 40] });
    expect(out[1]).toEqual({ x: MON + HOUR, y: [0, 90] }); // clamped at 0
  });
  it('null band for missing buckets', () => {
    const out = bandData(rows, [MON + 2 * HOUR]);
    expect(out[0]).toEqual({ x: MON + 2 * HOUR, y: null });
  });
  it('empty rows → all null', () => {
    expect(bandData([], [MON])[0].y).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail, then create `src/lib/baselineBand.js`**

Run: `npx vitest run src/__tests__/lib/baselineBand.test.js` → FAIL. Then:

```js
// Hour-of-week bucket math — must stay identical to server/baselineCalc.js.
const MONDAY_OFFSET_S = 4 * 86_400; // epoch was a Thursday
const WEEK_S = 7 * 86_400;

export function hourOfWeek(tsMs) {
  const s = Math.floor(tsMs / 1000);
  return Math.floor(((((s - MONDAY_OFFSET_S) % WEEK_S) + WEEK_S) % WEEK_S) / 3600);
}

export function bandData(baselineRows, timestamps) {
  const byHow = new Map((baselineRows || []).map((r) => [r.hour_of_week, r]));
  return (timestamps || []).map((ts) => {
    const b = byHow.get(hourOfWeek(ts));
    if (!b) return { x: ts, y: null };
    return { x: ts, y: [Math.max(0, b.mean - 2 * b.stddev), b.mean + 2 * b.stddev] };
  });
}
```

Re-run: ALL PASS.

- [ ] **Step 3: Write the failing ChartCard band test**

Create `src/__tests__/components/ChartCard.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChartCard from '../../components/ChartCard.jsx';

vi.mock('react-apexcharts', () => ({
  default: (props) => (
    <div
      data-testid="chart"
      data-series-count={Array.isArray(props.series) ? props.series.length : 0}
      data-first-type={props.series?.[0]?.type || ''}
    />
  ),
}));

const base = { title: 'CPU', value: 50, unit: '%', history: [10, 20, 30], color: '#f00' };
const ts = [1000, 2000, 3000];
const band = [{ x: 1000, y: [20, 40] }, { x: 2000, y: [20, 40] }, { x: 3000, y: [20, 40] }];

describe('ChartCard band prop', () => {
  it('live mode (no timestamps): band ignored, single series', () => {
    render(<ChartCard {...base} band={band} />);
    expect(screen.getByTestId('chart').dataset.seriesCount).toBe('1');
  });
  it('history mode without band: single series', () => {
    render(<ChartCard {...base} timestamps={ts} />);
    expect(screen.getByTestId('chart').dataset.seriesCount).toBe('1');
  });
  it('history mode with band: rangeArea series first + line series', () => {
    render(<ChartCard {...base} timestamps={ts} band={band} />);
    const el = screen.getByTestId('chart');
    expect(el.dataset.seriesCount).toBe('2');
    expect(el.dataset.firstType).toBe('rangeArea');
  });
  it('band of all-null y values is treated as absent', () => {
    render(<ChartCard {...base} timestamps={ts} band={ts.map((x) => ({ x, y: null }))} />);
    expect(screen.getByTestId('chart').dataset.seriesCount).toBe('1');
  });
});
```

(If existing tests already mock react-apexcharts globally via setup file, reuse that mock instead.)

- [ ] **Step 4: Run to verify fail, then modify `src/components/ChartCard.jsx`**

Run: `npx vitest run src/__tests__/components/ChartCard.test.jsx` → FAIL (always 1 series).

Modify `ChartCard.jsx`:
- Add `band` to the props destructuring.
- Compute: `const hasBand = Boolean(timestamps && band && band.some((p) => p.y));`
- When `hasBand`, switch to a mixed chart:
  - `chart.type: 'rangeArea'` (ApexCharts mixed rangeArea+line requires the chart type to be `rangeArea`),
  - series:

```js
const series = hasBand
  ? [
      { type: 'rangeArea', name: 'Typical', data: band },
      { type: 'line', name: title, data: points },
    ]
  : [{ name: title, data: points }];
```

  - options adjustments only when `hasBand`: `stroke: { width: [0, 1.5], curve: 'smooth' }`, `fill: { opacity: [0.10, 1] }`, `colors: [color, color]`, legend stays hidden. Keep every existing option untouched in the non-band path.
- Both series' data must be `{x, y}` points in history mode (the line series already is when `timestamps` present — verify and reuse the existing `points` construction).
- `React.memo` comparison: if the component uses a custom props comparator, include `band` in it.

Run: `npx vitest run src/__tests__/components/ChartCard.test.jsx` → ALL PASS.

- [ ] **Step 5: Dashboard — fetch baselines in history mode + pass band**

In `src/components/Dashboard.jsx`:

Add near the hist fetch effect:

```js
const HIST_KPI_BY_CHART = { cpu: 'cpu_pct', wait: 'waiting_tasks', io: 'io_mb', batch: 'batch_req' };
const [histBaselines, setHistBaselines] = useState({}); // chartKey -> baseline rows
```

Extend the existing history fetch effect (~328-351): alongside the current `Promise.all` fetches, add one fetch per entry of `HIST_KPI_BY_CHART`:

```js
    Promise.all(
      Object.entries(HIST_KPI_BY_CHART).map(([chartKey, kpi]) =>
        fetch(`/api/connections/${connId}/baselines?kpi=${kpi}`)
          .then((r) => (r.ok ? r.json() : { baselines: [] }))
          .then(({ baselines }) => [chartKey, baselines])
          .catch(() => [chartKey, []])
      )
    ).then((entries) => setHistBaselines(Object.fromEntries(entries)));
```

Clear on leaving history mode / connId change (same place the effect resets hist data): `setHistBaselines({})`.

In the chart render loop (~795-808), for the four mapped charts in history mode pass:

```jsx
band={histKey && histBaselines[chartKey] ? bandData(histBaselines[chartKey], timestamps) : undefined}
```

with `import { bandData } from '../lib/baselineBand.js';` — adapt variable names (`chartKey`, `timestamps`) to the loop's actual identifiers; charts without a KPI mapping (netMb, compilations) get no band.

- [ ] **Step 6: Run all frontend tests + visual check**

Run: `npx vitest run src/__tests__` → ALL PASS.
`npm run dev` → switch a connection to history mode: charts render (band only appears once baselines exist — empty response must render charts unchanged, no errors).

- [ ] **Step 7: Commit**

```bash
git add src/lib/baselineBand.js src/components/ChartCard.jsx src/components/Dashboard.jsx src/__tests__/lib/baselineBand.test.js src/__tests__/components/ChartCard.test.jsx
git commit -m "feat(alerts): mean±2σ baseline band on history charts (rangeArea combo)"
```

---

### Task 10: Full verification + E2E

**Files:** none created — verification only.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all alerting + persistence + existing tests PASS; only the 4 pre-existing WhoIsActive failures remain (known, unrelated). Any other failure → fix before proceeding.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: vite build succeeds, no errors.

- [ ] **Step 3: End-to-end manual checklist (dev SQL instance ONLY — per devInstruction.md, never point AI-assisted testing at production)**

1. `npm run dev`, connect to the dev instance (dev API port 3001).
2. `curl "http://localhost:3001/api/connections/<id>/alerts?active=1"` → `{ "alerts": [] }` (200, empty — learning period).
3. Validation 400s: `curl "http://localhost:3001/api/connections/<id>/baselines?kpi=bogus"` → 400; `curl -X POST "http://localhost:3001/api/connections/<id>/alerts/abc/ack"` → 400.
4. `curl "http://localhost:3001/api/connections/<id>/baselines?kpi=cpu_pct"` → 200 with `baselines: []` on a fresh DB (no baselines until ≥60 minutes per bucket + a daily recompute has run) — **empty is correct during learning; no false alarms**.
5. UI: bell renders, no badge; alert panel opens with both empty states; history mode charts render without band; no `[alerts]` errors in server console over several minutes.
6. Evaluator liveness: server log shows no errors at the 60s cadence; `data/metrics.db` `alerts` table exists (`npx better-sqlite3` or a quick node one-liner: `node -e "const D=require('better-sqlite3');const db=new D('data/metrics.db');console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE name IN ('alerts','baselines')\").all())"`).
7. Optional fast-forward check (dev only): manually run `node -e "require('dotenv').config(); const s=require('./server/metricsStore'); /* init as server.js does */"` is NOT required — instead verify baseline recompute by waiting for the after-03:00 maintenance or seeding `samples_1m` in a throwaway copy of the DB. Do not modify the live dev DB by hand.
8. Full alert lifecycle (open → toast → bell badge → panel → ack → deep-link → resolve) requires ≥28h of learning + a real deviation; defer to the human operator. The unit suite covers the state machine exhaustively.

- [ ] **Step 4: Review AI-generated SQL**

Per CLAUDE.md policy: confirm **no SQL Server T-SQL was added or changed** by this feature — all new SQL is SQLite (local file, no server exposure). Manually skim the new SQLite statements in `metricsSchema.js` (v2), `baselineCalc.js`, `metricsStore.js` for correctness; confirm the only string interpolation into SQL is from the `CORE_KPIS` constant and `RETENTION[].tsCol` (both hardcoded allowlists, never user input).

- [ ] **Step 5: Final commit (only if steps 1–4 surfaced fixes)**

```bash
git add <specific files changed during verification>
git commit -m "fix(alerts): address E2E verification findings"
```

---

## Self-Review Notes

- **Spec coverage:** migration v2 tables/index (T1), baseline computation — weighted single-pass stats, NULL exclusion, UTC buckets, 28d lookback, fallback ladder, transactional replace, `last_baseline_at` (T2+T3), store wrappers + prepared statements + disabled mode + 365d alerts retention (T3), evaluator — every monitored server, 60s loop, 3σ×5 open, 2σ×5 hysteresis, three-way stddev floor, 35d staleness, dedupe invariant, peak tracking, severity 'critical', restart re-adoption, cache reload ×2, zero-client safety (T4), API endpoints + validation + requireConn + 90d cap (T5), socket event + reducer state + hydration (T6), bell + toasts with spec text pattern (T7), panel + ack (idempotent, UI-only silence — alert still auto-resolves) + deep-link ±15min fixed padding (T8), baseline band mean±2σ history-mode-only with `band` prop guard (T9), verification + AI-SQL review (T10). Out of scope untouched (no email/webhook/static thresholds/config UI).
- **Documented deviation:** fallback-ladder gate counts 1-minute rows (≥60), not summed raw `sample_count` — spec's literal wording would gate at ~2 minutes of data; intent ("≈1 week of that slot in minutes") preserved. `baselines.sample_count` stores the minute count.
- **Known adaptation points (implementer must verify against real code, flagged inline per task):** `servers` insert column names in test seeds; `insertSnapshot` signature; store test init/teardown helpers; `parseHistoryRange` return shape; context hook name/shape (`useConnections`); Dialog subcomponent API; ChartCard points construction and memo comparator; Dashboard loop identifiers. Each task's Step 1 or notes call these out explicitly.
- **Type consistency:** `hourOfWeek` identical (server `baselineCalc.js` CJS, client `baselineBand.js` ESM — duplicated by design, server/client cannot share modules here); socket payload camelCase everywhere (`startedAt`/`resolvedAt`); DB rows snake_case normalized once via `normalizeAlertRow`; `KPI_ALERT_CONFIG` keys = `CORE_KPIS` = allowlist for API + labels; alert object shape `{ id, kpi, direction, severity, value?, mean, stddev, startedAt, resolvedAt, peakValue?, peakAt?, ackedAt? }` consistent across T4 emit, T6 reducer, T7 fmt, T8 panel.





