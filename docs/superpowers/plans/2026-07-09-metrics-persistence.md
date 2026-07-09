# Historical Metrics Persistence (SQLite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-server KPI, wait-stat, and blocking-event history in an embedded SQLite database with multi-resolution rollups, history API endpoints, and a history mode on the existing dashboard charts.

**Architecture:** `server.js` poll loop calls `metricsStore.insertSnapshot()` after each `collectMetrics()`. Store modules (`server/metricsStore.js`, `metricsSchema.js`, `metricsRollup.js`, `metricsRetention.js`) own all SQLite access via better-sqlite3 (synchronous, WAL). Hourly clock-aligned maintenance rolls raw 2s samples into 1m/15m/1h buckets and prunes per retention ladder. Four new HTTP endpoints serve history; the React dashboard gains a range picker that pauses live appends and renders fetched series.

**Tech Stack:** Node.js (CommonJS server), better-sqlite3, Express, React 18, ApexCharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-09-metrics-persistence-design.md` (frozen, approved).

## Global Constraints

- Timestamps are `INTEGER` epoch **milliseconds** everywhere. Never ISO strings.
- Wait stats stored as **deltas**, never cumulative DMV values.
- History identity = `instance_key` (`SELECT @@SERVERNAME`; fallback: profile server string).
- No SQL (SQLite) exists outside `server/metrics*.js` modules.
- Retention: raw 7d, 1m 90d, 15m 1yr, 1h forever, waits 90d, blocking 1yr.
- PRAGMAs: `journal_mode=WAL, synchronous=NORMAL, temp_store=MEMORY, cache_size=-64000, foreign_keys=ON`.
- Store failures never break the poll loop: `initialize()` failure → disabled no-op mode; runtime errors logged with `[metrics-db]` prefix.
- Bucket boundaries fixed to epoch multiples: `bucket_ts = ts - ts % resolutionMs`.
- Rollup order per pass: 1m → 15m → 1h. Insert transaction order: servers → raw → blocking → waits.
- Maintenance clock-aligned at HH:05; daily VACUUM (conditional on `freelist_count > max(10000, page_count/4)`) + `wal_checkpoint(TRUNCATE)` (always) on first run after 03:00 local.
- `data/` is already gitignored — `data/metrics.db` never committed.
- Server modules are CommonJS (`require`/`module.exports`), matching `server.js`.
- Server-side tests carry `// @vitest-environment node` as line 1 (existing convention in `tests/server/`).
- Never `git add .` — stage files by name (user's global git-safety rule).

## File Structure

| File | Responsibility |
|---|---|
| `src/test/setup.js` (modify) | Guard browser-only mocks so node-env tests run |
| `server/metricsSchema.js` (create) | KPI column list, DDL builders, PRAGMAs, migrations (`user_version`) |
| `server/metricsStore.js` (create) | Public API, DB handle, prepared statements, insert transaction, history getters, health |
| `server/metricsRollup.js` (create) | Watermark-driven raw→1m→15m→1h aggregation SQL |
| `server/metricsRetention.js` (create) | Prune, conditional VACUUM, WAL checkpoint |
| `server/historyRange.js` (create) | `from`/`to`/`resolution` query validation (unit-testable without Express) |
| `server.js` (modify) | initialize store, `@@SERVERNAME` capture, poll insert, HH:05 timer, 4 endpoints, SIGINT close |
| `src/lib/historySeries.js` (create) | Map history rows → per-chart arrays + timestamps; client-side waits aggregation |
| `src/components/HistoryRangePicker.jsx` (create) | `Live | 1h | 6h | 24h | 7d | 30d | Custom` picker |
| `src/components/ChartCard.jsx` (modify) | Optional `timestamps` (datetime tooltip) + `events` (blocking scatter markers) props |
| `src/components/Dashboard.jsx` (modify) | History mode state, fetch, banner, wire picker/charts/waits panel |
| Tests | `tests/server/metricsSchema.test.js`, `metricsStore.test.js`, `metricsWaitsBlocking.test.js`, `metricsRollup.test.js`, `metricsRetention.test.js`, `metricsHistory.test.js`, `historyRange.test.js`; `src/__tests__/lib/historySeries.test.js`, `src/__tests__/components/HistoryRangePicker.test.jsx` |

---

### Task 1: Guard browser mocks in `src/test/setup.js` (prerequisite)

`src/test/setup.js` unconditionally references `window`, breaking all 9 pre-existing `// @vitest-environment node` test files in `tests/server/` with "window is not defined". Guard browser-specific parts.

**Files:**
- Modify: `src/test/setup.js`

**Interfaces:**
- Produces: node-environment test files can run with the global setup file. All later server-side tests depend on this.

- [ ] **Step 1: Run the currently failing server tests to confirm the failure mode**

Run: `npx vitest run tests/server/smoke.test.js`
Expected: FAIL with `ReferenceError: window is not defined` originating in `src/test/setup.js`.

- [ ] **Step 2: Wrap browser-only sections in a `typeof window !== 'undefined'` guard**

Replace the entire contents of `src/test/setup.js` with:

```js
// Guard browser-specific mocks: this setup file also runs for
// `@vitest-environment node` test files (tests/server/**), where `window`,
// `global.fetch` stubs, and DOM mocks must not be installed.
const isBrowser = typeof window !== 'undefined'

if (isBrowser) {
  await import('@testing-library/jest-dom')

  // ── localStorage mock ──────────────────────────────────────────────────────
  const localStorageMock = (() => {
    let store = {}
    return {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
      clear: () => { store = {} },
    }
  })()
  Object.defineProperty(window, 'localStorage', { value: localStorageMock })

  // ── sessionStorage mock ────────────────────────────────────────────────────
  const sessionStorageMock = (() => {
    let store = {}
    return {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
      clear: () => { store = {} },
    }
  })()
  Object.defineProperty(window, 'sessionStorage', { value: sessionStorageMock })

  // ── ResizeObserver stub ──────────────────────────────────────────────────
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  // ── window.confirm / alert stubs ─────────────────────────────────────────
  global.confirm = vi.fn(() => true)
  global.alert   = vi.fn()

  // ── fetch stub ───────────────────────────────────────────────────────────
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
  )

  // ── jest shim for @testing-library + Vitest fake timers ──────────────────
  // @testing-library/dom's waitFor only advances fake timers when a global
  // `jest` object with `advanceTimersByTime` is present.
  globalThis.jest = {
    advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })
}

// vi.mock calls are hoisted and safe in both environments (no-op when the
// module is never imported by a node test).
const makeSocket = () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: false })
vi.mock('socket.io-client', () => ({
  io: vi.fn(makeSocket),
  default: vi.fn(makeSocket),
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }) => ({
    getTotalSize: () => count * (estimateSize ? estimateSize(0) : 40),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: i,
        index: i,
        start: i * (estimateSize ? estimateSize(i) : 40),
        size: estimateSize ? estimateSize(i) : 40,
      })),
    measureElement: vi.fn(),
  }),
}))
```

- [ ] **Step 3: Verify node-env tests now run**

Run: `npx vitest run tests/server/`
Expected: `tests/server/smoke.test.js`, `indexScanStore.test.js`, `indexScanOrchestrator.test.js`, `indexScanQueries.test.js` and `tests/server/scanners/*` all PASS (no "window is not defined").

- [ ] **Step 4: Verify browser-env tests still pass**

Run: `npx vitest run src/`
Expected: same pass/fail profile as before this change (the 4 pre-existing WhoIsActive failures are known and unrelated; no NEW failures).

- [ ] **Step 5: Commit**

```bash
git add src/test/setup.js
git commit -m "test: guard browser-only mocks in global setup so node-env server tests run"
```

---

### Task 2: Install better-sqlite3 + `server/metricsSchema.js`

**Files:**
- Modify: `package.json` (via npm install)
- Create: `server/metricsSchema.js`
- Test: `tests/server/metricsSchema.test.js`

**Interfaces:**
- Produces: `KPI_COLUMNS` (array of `{ name, type }`, 13 entries, order significant), `applyPragmas(db)`, `migrate(db)`, `rawTableDDL()`, `rollupTableDDL(table)`. Consumed by metricsStore (Task 3) and metricsRollup (Task 5).

- [ ] **Step 1: Install better-sqlite3**

Run: `npm install better-sqlite3`
Expected: exit 0; `better-sqlite3` appears under `dependencies` in `package.json`. (Native module — prebuilt binaries exist for win32/Node 22; if a build-from-source error appears, stop and report rather than installing build toolchains.)

- [ ] **Step 2: Write the failing test**

Create `tests/server/metricsSchema.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { KPI_COLUMNS, applyPragmas, migrate } from '../../server/metricsSchema.js'

describe('metricsSchema', () => {
  let db
  beforeEach(() => { db = new Database(':memory:') })

  it('exposes the 13 KPI columns in spec order', () => {
    expect(KPI_COLUMNS.map(c => c.name)).toEqual([
      'cpu_pct', 'waiting_tasks', 'io_mb', 'batch_req', 'sql_mem_pct',
      'sql_mem_gb', 'ple_sec', 'user_conns', 'compilations_sec',
      'recompilations_sec', 'net_mbs', 'buffer_cache_hit', 'mem_grants_pending',
    ])
  })

  it('applyPragmas sets WAL-compatible pragmas', () => {
    applyPragmas(db)
    // :memory: databases report journal_mode "memory"; the pragma call itself must not throw.
    expect(db.pragma('synchronous', { simple: true })).toBe(1)  // NORMAL
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('migrate creates all tables and sets user_version', () => {
    applyPragmas(db)
    migrate(db)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name)
    for (const t of ['servers', 'schema_migrations', 'samples_raw', 'samples_1m',
      'samples_15m', 'samples_1h', 'waits_samples', 'blocking_events',
      'rollup_state', 'meta']) {
      expect(tables).toContain(t)
    }
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    const mig = db.prepare('SELECT version, description FROM schema_migrations').all()
    expect(mig).toHaveLength(1)
    expect(mig[0].version).toBe(1)
  })

  it('rollup tables have avg/min/max triplets per KPI plus sample_count', () => {
    migrate(db)
    const cols = db.prepare("SELECT name FROM pragma_table_info('samples_1m')").all().map(r => r.name)
    expect(cols).toContain('cpu_pct_avg')
    expect(cols).toContain('cpu_pct_min')
    expect(cols).toContain('cpu_pct_max')
    expect(cols).toContain('mem_grants_pending_max')
    expect(cols).toContain('sample_count')
    // server_id + ts + 13*3 triplets + sample_count = 42
    expect(cols).toHaveLength(42)
  })

  it('migrate is idempotent', () => {
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n).toBe(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/server/metricsSchema.test.js`
Expected: FAIL — `Cannot find module '../../server/metricsSchema.js'`.

- [ ] **Step 4: Implement `server/metricsSchema.js`**

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/server/metricsSchema.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/metricsSchema.js tests/server/metricsSchema.test.js
git commit -m "feat(persistence): add better-sqlite3 and metrics schema module (DDL, PRAGMAs, migrations)"
```

---

### Task 3: `server/metricsStore.js` core — initialize, disabled mode, raw insert

**Files:**
- Create: `server/metricsStore.js`
- Test: `tests/server/metricsStore.test.js`

**Interfaces:**
- Consumes: `applyPragmas`, `migrate`, `KPI_COLUMNS` from `server/metricsSchema.js`.
- Produces (public API, held stable for Tasks 4–8):
  - `initialize(dbPath) → boolean` (false = disabled no-op mode)
  - `insertSnapshot(instanceKey, displayName, metrics, now = Date.now())` — `metrics` is the `collectMetrics()` result: scalars `cpu_percent, waiting_tasks, db_io_mb, batch_requests`; `serverPerf` object `{ sqlMemPct, sqlMemGb, pleSec, userConns, compilationsSec, recompilationsSec, netMbs, bufferCacheHit, memGrantsPending }`; arrays `resourceWaits`, `blocking`.
  - `close()` — closes DB, resets all module state (tests re-`initialize` after)
  - `_db()` — internal accessor for tests/rollup wiring (returns better-sqlite3 handle or null)
  - Later tasks add: `rollup()`, `prune()`, `vacuum()`, `checkpoint()`, `health()`, `getHistory()`, `getWaitHistory()`, `getBlockingHistory()`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/metricsStore.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'

function fakeMetrics(over = {}) {
  return {
    cpu_percent: 42, waiting_tasks: 3, db_io_mb: 1.5, batch_requests: 200,
    serverPerf: {
      sqlMemPct: 80.5, sqlMemGb: 12.2, pleSec: 3000, userConns: 55,
      compilationsSec: 10, recompilationsSec: 1, netMbs: 0.7,
      bufferCacheHit: 99.9, memGrantsPending: 0,
    },
    resourceWaits: [], blocking: [],
    ...over,
  }
}

describe('metricsStore core', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('initialize on :memory: returns true', () => {
    store.close()
    expect(store.initialize(':memory:')).toBe(true)
  })

  it('initialize failure → disabled no-op mode, insertSnapshot does not throw', () => {
    store.close()
    // A directory path is not a valid database file → open fails
    expect(store.initialize('.')).toBe(false)
    expect(() => store.insertSnapshot('SRV1', 'Server 1', fakeMetrics())).not.toThrow()
  })

  it('insertSnapshot writes one samples_raw row with mapped KPI values', () => {
    const now = 1_700_000_000_000
    store.insertSnapshot('SRV1\\PROD', 'Prod box', fakeMetrics(), now)
    const row = store._db().prepare('SELECT * FROM samples_raw').get()
    expect(row.ts).toBe(now)
    expect(row.cpu_pct).toBe(42)
    expect(row.waiting_tasks).toBe(3)
    expect(row.io_mb).toBe(1.5)
    expect(row.batch_req).toBe(200)
    expect(row.sql_mem_pct).toBe(80.5)
    expect(row.ple_sec).toBe(3000)
    expect(row.buffer_cache_hit).toBe(99.9)
    expect(row.mem_grants_pending).toBe(0)
  })

  it('missing/non-numeric KPI values store NULL, not 0', () => {
    const m = fakeMetrics()
    delete m.serverPerf.pleSec
    m.cpu_percent = 'n/a'
    store.insertSnapshot('SRV1', 'S1', m, 1_700_000_000_000)
    const row = store._db().prepare('SELECT cpu_pct, ple_sec FROM samples_raw').get()
    expect(row.cpu_pct).toBeNull()
    expect(row.ple_sec).toBeNull()
  })

  it('upserts servers row: same instance_key reused, display_name/last_seen refreshed', () => {
    store.insertSnapshot('SRV1', 'Old name', fakeMetrics(), 1000)
    store.insertSnapshot('SRV1', 'New name', fakeMetrics(), 2000)
    const rows = store._db().prepare('SELECT * FROM servers').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].instance_key).toBe('SRV1')
    expect(rows[0].display_name).toBe('New name')
    expect(rows[0].first_seen).toBe(1000)
    expect(rows[0].last_seen).toBe(2000)
  })

  it('different instance_key creates a second servers row', () => {
    store.insertSnapshot('SRV1', 'A', fakeMetrics(), 1000)
    store.insertSnapshot('SRV2', 'B', fakeMetrics(), 1000)
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM servers').get().n).toBe(2)
  })

  it('duplicate (server, ts) insert is caught, does not throw', () => {
    store.insertSnapshot('SRV1', 'A', fakeMetrics(), 1000)
    expect(() => store.insertSnapshot('SRV1', 'A', fakeMetrics(), 1000)).not.toThrow()
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM samples_raw').get().n).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/metricsStore.test.js`
Expected: FAIL — `Cannot find module '../../server/metricsStore.js'`.

- [ ] **Step 3: Implement `server/metricsStore.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./metricsSchema');

let db = null;
let enabled = false;
let stmts = null;
let insertTx = null;
let insertErrors = 0;
const serverIds = new Map();      // instance_key -> server_id
const waitState = new Map();      // server_id -> { lastWriteTs, baseline: Map }
const blockingRecent = new Map(); // server_id -> Map(dedupeKey -> ts)

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function kpiValues(metrics) {
  const sp = metrics.serverPerf || {};
  return {
    cpu_pct:            num(metrics.cpu_percent),
    waiting_tasks:      num(metrics.waiting_tasks),
    io_mb:              num(metrics.db_io_mb),
    batch_req:          num(metrics.batch_requests),
    sql_mem_pct:        num(sp.sqlMemPct),
    sql_mem_gb:         num(sp.sqlMemGb),
    ple_sec:            num(sp.pleSec),
    user_conns:         num(sp.userConns),
    compilations_sec:   num(sp.compilationsSec),
    recompilations_sec: num(sp.recompilationsSec),
    net_mbs:            num(sp.netMbs),
    buffer_cache_hit:   num(sp.bufferCacheHit),
    mem_grants_pending: num(sp.memGrantsPending),
  };
}

function prepareStatements() {
  const names = schema.KPI_COLUMNS.map(c => c.name);
  stmts = {
    upsertServer: db.prepare(`
      INSERT INTO servers (instance_key, display_name, first_seen, last_seen)
      VALUES (@key, @name, @now, @now)
      ON CONFLICT(instance_key) DO UPDATE SET
        display_name = excluded.display_name,
        last_seen    = excluded.last_seen`),
    getServerId: db.prepare('SELECT id FROM servers WHERE instance_key = ?'),
    insertRaw: db.prepare(`
      INSERT INTO samples_raw (server_id, ts, ${names.join(', ')})
      VALUES (@server_id, @ts, ${names.map(n => '@' + n).join(', ')})`),
    insertWait: db.prepare(`
      INSERT INTO waits_samples (server_id, ts, wait_type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)`),
    insertBlocking: db.prepare(`
      INSERT INTO blocking_events (server_id, ts, blocking_sid, blocked_sid, wait_type, wait_ms,
        database_name, blocker_login, blocker_host, blocker_program, blocked_login, blocked_host,
        blocker_query, blocked_query, parent_object)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    metaSet: db.prepare(`
      INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
  };

  insertTx = db.transaction((instanceKey, displayName, metrics, now) => {
    const serverId = getServerId(instanceKey, displayName, now);
    stmts.insertRaw.run({ server_id: serverId, ts: now, ...kpiValues(metrics) });
    writeBlocking(serverId, metrics.blocking, now);   // Task 4
    writeWaits(serverId, metrics.resourceWaits, now); // Task 4
  });
}

function getServerId(instanceKey, displayName, now) {
  stmts.upsertServer.run({ key: instanceKey, name: displayName ?? null, now });
  let id = serverIds.get(instanceKey);
  if (id === undefined) {
    id = stmts.getServerId.get(instanceKey).id;
    serverIds.set(instanceKey, id);
  }
  return id;
}

// Implemented in Task 4 — no-ops for now so the transaction shape is final.
function writeBlocking(_serverId, _blocking, _now) {}
function writeWaits(_serverId, _resourceWaits, _now) {}

function initialize(dbPath) {
  try {
    const Database = require('better-sqlite3');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    db = new Database(dbPath);
    schema.applyPragmas(db);
    schema.migrate(db);
    prepareStatements();
    enabled = true;
  } catch (err) {
    console.warn('[metrics-db] persistence disabled:', err.message);
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    enabled = false;
  }
  return enabled;
}

function insertSnapshot(instanceKey, displayName, metrics, now = Date.now()) {
  if (!enabled) return;
  try {
    insertTx(instanceKey, displayName, metrics, now);
    stmts.metaSet.run('last_insert_at', String(now), now);
  } catch (err) {
    insertErrors += 1;
    try { stmts.metaSet.run('insert_error_count', String(insertErrors), now); } catch { /* ignore */ }
    console.error('[metrics-db] insert failed:', err.message);
  }
}

function close() {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  enabled = false;
  stmts = null;
  insertTx = null;
  insertErrors = 0;
  serverIds.clear();
  waitState.clear();
  blockingRecent.clear();
}

function _db() { return db; }

module.exports = { initialize, insertSnapshot, close, _db };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/metricsStore.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/metricsStore.js tests/server/metricsStore.test.js
git commit -m "feat(persistence): metricsStore core — initialize, disabled no-op mode, raw KPI insert"
```

---

### Task 4: Wait-stat deltas + blocking dedupe

**Files:**
- Modify: `server/metricsStore.js` (replace the `writeWaits`/`writeBlocking` no-ops)
- Test: `tests/server/metricsWaitsBlocking.test.js`

**Interfaces:**
- Consumes: `metrics.resourceWaits` rows `{ wait_type, waiting_tasks_count, wait_time_ms, max_wait_time_ms, signal_wait_time_ms }` (cumulative DMV values, top 25); `metrics.blocking` rows `{ blocking_session_id, blocked_session_id, wait_type, wait_time, database_name, blocker_login, blocker_host, blocker_program, blocked_login, blocked_host, blocker_query, blocked_query, parent_object }`.
- Produces: `waits_samples` rows are per-interval **deltas** at ≥60s cadence; `blocking_events` rows deduped on `(blocking_sid, blocked_sid, wait_type, database_name)` within 60s.

- [ ] **Step 1: Write the failing test**

Create `tests/server/metricsWaitsBlocking.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'

const T0 = 1_700_000_000_000

function metricsWith(over = {}) {
  return {
    cpu_percent: 10, waiting_tasks: 0, db_io_mb: 0, batch_requests: 0,
    serverPerf: {}, resourceWaits: [], blocking: [], ...over,
  }
}
function wait(type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms) {
  return { wait_type: type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms, max_wait_time_ms: 0 }
}
function block(over = {}) {
  return {
    blocking_session_id: 51, blocked_session_id: 72, wait_type: 'LCK_M_X',
    wait_time: 1234, database_name: 'medcare_db_dev',
    blocker_login: 'app', blocker_host: 'H1', blocker_program: 'P1',
    blocked_login: 'rpt', blocked_host: 'H2',
    blocker_query: 'UPDATE t SET x=1', blocked_query: 'SELECT * FROM t',
    parent_object: 'dbo.t', ...over,
  }
}
const waitRows  = () => store._db().prepare('SELECT * FROM waits_samples ORDER BY ts, wait_type').all()
const blockRows = () => store._db().prepare('SELECT * FROM blocking_events ORDER BY id').all()

describe('wait-stat deltas', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('first sample establishes baseline, writes nothing', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('PAGEIOLATCH_SH', 1000, 10, 100)] }), T0)
    expect(waitRows()).toHaveLength(0)
  })

  it('second sample ≥60s later writes deltas', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('PAGEIOLATCH_SH', 1000, 10, 100)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('PAGEIOLATCH_SH', 1500, 13, 130)] }), T0 + 60_000)
    const rows = waitRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].wait_time_ms).toBe(500)
    expect(rows[0].waiting_tasks_count).toBe(3)
    expect(rows[0].signal_wait_time_ms).toBe(30)
    expect(rows[0].ts).toBe(T0 + 60_000)
  })

  it('respects 60s cadence: sample 2s after baseline writes nothing', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 100, 1, 10)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 200, 2, 20)] }), T0 + 2_000)
    expect(waitRows()).toHaveLength(0)
  })

  it('negative delta (counter reset) → re-baseline, no row', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 5000, 50, 500)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 100, 1, 10)] }), T0 + 60_000)
    expect(waitRows()).toHaveLength(0)
    // next interval works off the new baseline
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 300, 4, 40)] }), T0 + 120_000)
    const rows = waitRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].wait_time_ms).toBe(200)
  })

  it('wait type without baseline entry is skipped (added to next baseline)', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 100, 1, 10)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 200, 2, 20), wait('B', 999, 9, 99)] }), T0 + 60_000)
    let rows = waitRows()
    expect(rows.map(r => r.wait_type)).toEqual(['A'])
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 300, 3, 30), wait('B', 1099, 10, 109)] }), T0 + 120_000)
    rows = waitRows()
    const b = rows.find(r => r.wait_type === 'B')
    expect(b.wait_time_ms).toBe(100)
  })

  it('all-zero delta rows are not written', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 100, 1, 10)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 100, 1, 10)] }), T0 + 60_000)
    expect(waitRows()).toHaveLength(0)
  })
})

describe('blocking dedupe', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('inserts a blocking event with all columns mapped', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    const rows = blockRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].blocking_sid).toBe(51)
    expect(rows[0].blocked_sid).toBe(72)
    expect(rows[0].wait_type).toBe('LCK_M_X')
    expect(rows[0].wait_ms).toBe(1234)
    expect(rows[0].database_name).toBe('medcare_db_dev')
    expect(rows[0].blocker_query).toBe('UPDATE t SET x=1')
    expect(rows[0].parent_object).toBe('dbo.t')
  })

  it('same tuple within 60s is suppressed', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0 + 2_000)
    expect(blockRows()).toHaveLength(1)
  })

  it('same tuple after 60s is recorded again', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0 + 61_000)
    expect(blockRows()).toHaveLength(2)
  })

  it('new victim / new wait_type / new database is recorded immediately', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [
      block({ blocked_session_id: 99 }),
      block({ wait_type: 'LCK_M_S' }),
      block({ database_name: 'tempdb' }),
    ] }), T0 + 2_000)
    expect(blockRows()).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/metricsWaitsBlocking.test.js`
Expected: FAIL — delta/dedupe assertions fail (the two functions are still no-ops).

- [ ] **Step 3: Replace the no-op `writeWaits` / `writeBlocking` in `server/metricsStore.js`**

```js
const WAITS_INTERVAL_MS = 60_000;
const BLOCKING_DEDUPE_MS = 60_000;

function writeWaits(serverId, resourceWaits, now) {
  if (!Array.isArray(resourceWaits) || resourceWaits.length === 0) return;
  let state = waitState.get(serverId);
  if (!state) { state = { lastWriteTs: 0, baseline: null }; waitState.set(serverId, state); }
  if (state.baseline && now - state.lastWriteTs < WAITS_INTERVAL_MS) return;

  const current = new Map(resourceWaits.map(w => [w.wait_type, w]));
  if (!state.baseline) {
    state.baseline = current;
    state.lastWriteTs = now;
    return;
  }
  // Any negative delta means the DMV counters were reset (SQL restart or
  // DBCC SQLPERF clear) — re-baseline and skip this write entirely.
  for (const [type, w] of current) {
    const prev = state.baseline.get(type);
    if (prev && (num(w.wait_time_ms) < num(prev.wait_time_ms)
              || num(w.signal_wait_time_ms) < num(prev.signal_wait_time_ms)
              || num(w.waiting_tasks_count) < num(prev.waiting_tasks_count))) {
      state.baseline = current;
      state.lastWriteTs = now;
      return;
    }
  }
  for (const [type, w] of current) {
    const prev = state.baseline.get(type);
    if (!prev) continue; // first sighting: no baseline for this type yet
    const dWait   = num(w.wait_time_ms)        - num(prev.wait_time_ms);
    const dTasks  = num(w.waiting_tasks_count) - num(prev.waiting_tasks_count);
    const dSignal = num(w.signal_wait_time_ms) - num(prev.signal_wait_time_ms);
    if (dWait === 0 && dTasks === 0 && dSignal === 0) continue;
    stmts.insertWait.run(serverId, now, type, dWait, dTasks, dSignal);
  }
  state.baseline = current;
  state.lastWriteTs = now;
}

function writeBlocking(serverId, blocking, now) {
  if (!Array.isArray(blocking) || blocking.length === 0) return;
  let recent = blockingRecent.get(serverId);
  if (!recent) { recent = new Map(); blockingRecent.set(serverId, recent); }
  for (const [k, ts] of recent) if (now - ts >= BLOCKING_DEDUPE_MS) recent.delete(k);
  for (const b of blocking) {
    const key = `${b.blocking_session_id}|${b.blocked_session_id}|${b.wait_type ?? ''}|${b.database_name ?? ''}`;
    if (recent.has(key)) continue;
    recent.set(key, now);
    stmts.insertBlocking.run(
      serverId, now,
      num(b.blocking_session_id), num(b.blocked_session_id),
      b.wait_type ?? null, num(b.wait_time), b.database_name ?? null,
      b.blocker_login ?? null, b.blocker_host ?? null, b.blocker_program ?? null,
      b.blocked_login ?? null, b.blocked_host ?? null,
      b.blocker_query ?? null, b.blocked_query ?? null, b.parent_object ?? null
    );
  }
}
```

Also delete the two placeholder no-op function definitions from Task 3.

Note: `num(x) < num(y)` comparisons treat `null` as not-less-than (both `null < null` and `5 < null` are false in JS) — a missing counter never triggers a spurious re-baseline.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/metricsWaitsBlocking.test.js tests/server/metricsStore.test.js`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
git add server/metricsStore.js tests/server/metricsWaitsBlocking.test.js
git commit -m "feat(persistence): wait-stat deltas with 60s cadence and blocking-event dedupe"
```

---

### Task 5: `server/metricsRollup.js` — watermark-driven aggregation

**Files:**
- Create: `server/metricsRollup.js`
- Modify: `server/metricsStore.js` (add `rollup()` wrapper to public API)
- Test: `tests/server/metricsRollup.test.js`

**Interfaces:**
- Consumes: `KPI_COLUMNS` from `server/metricsSchema.js`; a better-sqlite3 `db` handle.
- Produces: `runRollup(db, now = Date.now())` — advances `samples_1m` ← `samples_raw`, `samples_15m` ← `samples_1m`, `samples_1h` ← `samples_15m` per server, watermarks in `rollup_state`. Store gains `rollup(now = Date.now())` (no-op when disabled; updates `meta.last_rollup_at`).

- [ ] **Step 1: Write the failing test**

Create `tests/server/metricsRollup.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'
import { runRollup } from '../../server/metricsRollup.js'

// T0 on an exact hour boundary so bucket math is easy to eyeball
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000)

function metricsWith(cpu, ple = 300) {
  return {
    cpu_percent: cpu, waiting_tasks: 1, db_io_mb: 0.5, batch_requests: 100,
    serverPerf: { pleSec: ple }, resourceWaits: [], blocking: [],
  }
}

describe('metricsRollup', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('1m rollup: avg/min/max/sample_count with epoch-aligned buckets', () => {
    // 3 samples inside the first minute bucket, 1 in the next
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    store.insertSnapshot('S', 'S', metricsWith(20), T0 + 2_000)
    store.insertSnapshot('S', 'S', metricsWith(60), T0 + 4_000)
    store.insertSnapshot('S', 'S', metricsWith(50), T0 + 61_000)
    runRollup(store._db(), T0 + 180_000) // both buckets fully in the past
    const rows = store._db().prepare('SELECT * FROM samples_1m ORDER BY ts').all()
    expect(rows).toHaveLength(2)
    expect(rows[0].ts).toBe(T0)                 // exact epoch multiple of 60000
    expect(rows[0].cpu_pct_avg).toBe(30)
    expect(rows[0].cpu_pct_min).toBe(10)
    expect(rows[0].cpu_pct_max).toBe(60)
    expect(rows[0].sample_count).toBe(3)
    expect(rows[1].ts).toBe(T0 + 60_000)
    expect(rows[1].sample_count).toBe(1)
  })

  it('incomplete current bucket is NOT rolled up', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    runRollup(store._db(), T0 + 30_000) // bucket [T0, T0+60s) still open
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM samples_1m').get().n).toBe(0)
  })

  it('NULL KPI values are ignored by aggregates, never counted as zero', () => {
    const m = metricsWith(40)
    const mNull = metricsWith(null)
    store.insertSnapshot('S', 'S', m, T0)
    store.insertSnapshot('S', 'S', mNull, T0 + 2_000)
    runRollup(store._db(), T0 + 120_000)
    const row = store._db().prepare('SELECT * FROM samples_1m').get()
    expect(row.cpu_pct_avg).toBe(40) // not 20
    expect(row.cpu_pct_min).toBe(40)
    expect(row.sample_count).toBe(2) // rows counted, values ignored
  })

  it('all-NULL KPI stores NULL for the whole triplet', () => {
    store.insertSnapshot('S', 'S', metricsWith(null), T0)
    runRollup(store._db(), T0 + 120_000)
    const row = store._db().prepare('SELECT * FROM samples_1m').get()
    expect(row.cpu_pct_avg).toBeNull()
    expect(row.cpu_pct_min).toBeNull()
    expect(row.cpu_pct_max).toBeNull()
  })

  it('watermark advances and re-run is idempotent', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    runRollup(store._db(), T0 + 120_000)
    const wm = store._db().prepare(
      "SELECT watermark_ts FROM rollup_state WHERE resolution='1m'").get().watermark_ts
    expect(wm).toBe(T0 + 120_000)
    runRollup(store._db(), T0 + 120_000) // second run: nothing new
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM samples_1m').get().n).toBe(1)
  })

  it('15m rollup weights averages by sample_count', () => {
    // bucket A: 30 samples of cpu=10; bucket B: 10 samples of cpu=50
    for (let i = 0; i < 30; i++) store.insertSnapshot('S', 'S', metricsWith(10), T0 + i * 2_000)
    for (let i = 0; i < 10; i++) store.insertSnapshot('S', 'S', metricsWith(50), T0 + 60_000 + i * 2_000)
    runRollup(store._db(), T0 + 2 * 3_600_000)
    const row15 = store._db().prepare('SELECT * FROM samples_15m').get()
    // weighted: (30*10 + 10*50) / 40 = 20, NOT the unweighted (10+50)/2 = 30
    expect(row15.cpu_pct_avg).toBeCloseTo(20, 5)
    expect(row15.cpu_pct_min).toBe(10)
    expect(row15.cpu_pct_max).toBe(50)
    expect(row15.sample_count).toBe(40)
    // 1h chained from 15m
    const row1h = store._db().prepare('SELECT * FROM samples_1h').get()
    expect(row1h.cpu_pct_avg).toBeCloseTo(20, 5)
    expect(row1h.ts).toBe(T0)
  })

  it('rolls up each server independently', () => {
    store.insertSnapshot('S1', 'S1', metricsWith(10), T0)
    store.insertSnapshot('S2', 'S2', metricsWith(90), T0)
    runRollup(store._db(), T0 + 120_000)
    const rows = store._db().prepare(
      'SELECT s.instance_key, r.cpu_pct_avg FROM samples_1m r JOIN servers s ON s.id = r.server_id ORDER BY s.instance_key').all()
    expect(rows).toEqual([
      { instance_key: 'S1', cpu_pct_avg: 10 },
      { instance_key: 'S2', cpu_pct_avg: 90 },
    ])
  })

  it('store.rollup() is a no-op when disabled', () => {
    store.close()
    store.initialize('.')  // forces disabled mode
    expect(() => store.rollup()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/metricsRollup.test.js`
Expected: FAIL — `Cannot find module '../../server/metricsRollup.js'`.

- [ ] **Step 3: Implement `server/metricsRollup.js`**

```js
'use strict';

const { KPI_COLUMNS } = require('./metricsSchema');

const LADDER = [
  { resolution: '1m',  ms: 60_000,    source: 'samples_raw', target: 'samples_1m',  fromRaw: true  },
  { resolution: '15m', ms: 900_000,   source: 'samples_1m',  target: 'samples_15m', fromRaw: false },
  { resolution: '1h',  ms: 3_600_000, source: 'samples_15m', target: 'samples_1h',  fromRaw: false },
];

function targetColumns() {
  return KPI_COLUMNS.map(c => `${c.name}_avg, ${c.name}_min, ${c.name}_max`).join(', ');
}

// SQL AVG/MIN/MAX/SUM ignore NULLs — NULL KPI values never count as zero, and
// an all-NULL bucket yields NULL for the triplet.
function tripletSelect(fromRaw) {
  if (fromRaw) {
    return KPI_COLUMNS.map(c => `AVG(${c.name}), MIN(${c.name}), MAX(${c.name})`).join(', ');
  }
  // avg-of-avgs weighted by sample_count; denominator counts only rows where
  // the column is non-NULL so NULL buckets don't dilute the weighted average.
  return KPI_COLUMNS.map(c =>
    `SUM(${c.name}_avg * sample_count) / ` +
    `CAST(SUM(CASE WHEN ${c.name}_avg IS NOT NULL THEN sample_count END) AS REAL), ` +
    `MIN(${c.name}_min), MAX(${c.name}_max)`
  ).join(', ');
}

function rollupSql(step) {
  const countExpr = step.fromRaw ? 'COUNT(*)' : 'SUM(sample_count)';
  return `INSERT OR REPLACE INTO ${step.target} (server_id, ts, ${targetColumns()}, sample_count)
    SELECT server_id, ts - ts % ${step.ms} AS bucket, ${tripletSelect(step.fromRaw)}, ${countExpr}
    FROM ${step.source}
    WHERE server_id = @serverId AND ts >= @from AND ts < @to
    GROUP BY bucket`;
}

function runRollup(db, now = Date.now()) {
  const servers = db.prepare('SELECT id FROM servers').all();
  const getWm = db.prepare('SELECT watermark_ts FROM rollup_state WHERE server_id = ? AND resolution = ?');
  const setWm = db.prepare(`INSERT INTO rollup_state (server_id, resolution, watermark_ts) VALUES (?, ?, ?)
    ON CONFLICT(server_id, resolution) DO UPDATE SET watermark_ts = excluded.watermark_ts`);
  const stepStmts = LADDER.map(step => ({ step, stmt: db.prepare(rollupSql(step)) }));

  for (const { id } of servers) {
    for (const { step, stmt } of stepStmts) {
      const wm = getWm.get(id, step.resolution)?.watermark_ts ?? 0;
      const to = now - (now % step.ms); // current (incomplete) bucket start — exclusive
      if (to <= wm) continue;
      db.transaction(() => {
        stmt.run({ serverId: id, from: wm, to });
        setWm.run(id, step.resolution, to);
      })();
    }
  }
}

module.exports = { LADDER, runRollup, rollupSql, tripletSelect, targetColumns };
```

- [ ] **Step 4: Add `rollup()` to `server/metricsStore.js`**

Add near the top: `const { runRollup } = require('./metricsRollup');`

Add before `module.exports`:

```js
function rollup(now = Date.now()) {
  if (!enabled) return;
  try {
    runRollup(db, now);
    stmts.metaSet.run('last_rollup_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] rollup failed:', err.message);
  }
}
```

Update exports: `module.exports = { initialize, insertSnapshot, rollup, close, _db };`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/metricsRollup.test.js tests/server/metricsStore.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/metricsRollup.js server/metricsStore.js tests/server/metricsRollup.test.js
git commit -m "feat(persistence): watermark-driven 1m/15m/1h rollups with weighted averages"
```

---

### Task 6: `server/metricsRetention.js` — prune, conditional VACUUM, checkpoint + `health()`

**Files:**
- Create: `server/metricsRetention.js`
- Modify: `server/metricsStore.js` (add `prune()`, `vacuum()`, `checkpoint()`, `health()`)
- Test: `tests/server/metricsRetention.test.js`

**Interfaces:**
- Produces: `RETENTION` table→keepMs map; `prune(db, now)` → `{ table: deletedCount }`; `vacuumIfNeeded(db)` → boolean; `checkpoint(db)`. Store gains `prune(now)`, `vacuum()`, `checkpoint()`, `health(now)` (all no-op / `{ enabled: false }` when disabled). `health()` shape consumed by the `/api/persistence/status` endpoint (Task 8): `{ enabled, dbPath, dbSizeBytes, walSizeBytes, freelistCount, pageCount, schemaVersion, migrations, servers, counts, meta, insertErrorCount, rawInsertRatePerSec }`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/metricsRetention.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'
import { prune, RETENTION } from '../../server/metricsRetention.js'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

function metricsWith() {
  return { cpu_percent: 1, waiting_tasks: 0, db_io_mb: 0, batch_requests: 0,
    serverPerf: {}, resourceWaits: [], blocking: [] }
}

describe('metricsRetention', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('retention ladder matches the spec', () => {
    const map = Object.fromEntries(RETENTION.map(r => [r.table, r.keepMs]))
    expect(map.samples_raw).toBe(7 * DAY)
    expect(map.samples_1m).toBe(90 * DAY)
    expect(map.samples_15m).toBe(365 * DAY)
    expect(map.waits_samples).toBe(90 * DAY)
    expect(map.blocking_events).toBe(365 * DAY)
    expect(map.samples_1h).toBeUndefined() // kept forever
  })

  it('prune removes only rows older than each cutoff', () => {
    const db = store._db()
    store.insertSnapshot('S', 'S', metricsWith(), NOW - 8 * DAY)  // expired raw
    store.insertSnapshot('S', 'S', metricsWith(), NOW - 6 * DAY)  // kept raw
    const sid = db.prepare('SELECT id FROM servers').get().id
    db.prepare(`INSERT INTO samples_1h (server_id, ts, sample_count) VALUES (?, ?, 1)`)
      .run(sid, NOW - 400 * DAY) // ancient 1h row must survive
    db.prepare(`INSERT INTO waits_samples (server_id, ts, wait_type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms)
      VALUES (?, ?, 'X', 1, 1, 1)`).run(sid, NOW - 91 * DAY)
    const deleted = prune(db, NOW)
    expect(deleted.samples_raw).toBe(1)
    expect(deleted.waits_samples).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM samples_raw').get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM samples_1h').get().n).toBe(1)
  })

  it('store.prune/vacuum/checkpoint do not throw (enabled or disabled)', () => {
    expect(() => { store.prune(); store.vacuum(); store.checkpoint() }).not.toThrow()
    store.close()
    store.initialize('.') // disabled mode
    expect(() => { store.prune(); store.vacuum(); store.checkpoint() }).not.toThrow()
  })

  it('health() reports enabled:false in disabled mode', () => {
    store.close()
    store.initialize('.')
    expect(store.health()).toEqual({ enabled: false })
  })

  it('health() reports counts, servers, schema version, meta', () => {
    store.insertSnapshot('S', 'Server S', metricsWith(), NOW - 1_000)
    const h = store.health(NOW)
    expect(h.enabled).toBe(true)
    expect(h.schemaVersion).toBe(1)
    expect(h.counts.samples_raw).toBe(1)
    expect(h.servers).toHaveLength(1)
    expect(h.servers[0].instance_key).toBe('S')
    expect(h.servers[0].oldest_raw).toBe(NOW - 1_000)
    expect(h.servers[0].newest_raw).toBe(NOW - 1_000)
    expect(h.meta.last_insert_at).toBe(String(NOW - 1_000))
    expect(h.insertErrorCount).toBe(0)
    expect(h.rawInsertRatePerSec).toBeCloseTo(1 / 60, 5)
    expect(h.migrations).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/metricsRetention.test.js`
Expected: FAIL — `Cannot find module '../../server/metricsRetention.js'`.

- [ ] **Step 3: Implement `server/metricsRetention.js`**

```js
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
```

- [ ] **Step 4: Add wrappers + `health()` to `server/metricsStore.js`**

Add near the top: `const retention = require('./metricsRetention');`

Add before `module.exports`:

```js
function prune(now = Date.now()) {
  if (!enabled) return;
  try {
    retention.prune(db, now);
    stmts.metaSet.run('last_prune_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] prune failed:', err.message);
  }
}

function vacuum(now = Date.now()) {
  if (!enabled) return;
  try {
    if (retention.vacuumIfNeeded(db)) stmts.metaSet.run('last_vacuum_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] vacuum failed:', err.message);
  }
}

function checkpoint(now = Date.now()) {
  if (!enabled) return;
  try {
    retention.checkpoint(db);
    stmts.metaSet.run('last_checkpoint_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] checkpoint failed:', err.message);
  }
}

const COUNTED_TABLES = ['samples_raw', 'samples_1m', 'samples_15m', 'samples_1h', 'waits_samples', 'blocking_events'];

function health(now = Date.now()) {
  if (!enabled) return { enabled: false };
  try {
    const fileSize = p => { try { return fs.statSync(p).size; } catch { return 0; } };
    const counts = {};
    for (const t of COUNTED_TABLES) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    }
    const servers = db.prepare(`
      SELECT s.id, s.instance_key, s.display_name, s.first_seen, s.last_seen,
        (SELECT MIN(ts) FROM samples_raw WHERE server_id = s.id) AS oldest_raw,
        (SELECT MAX(ts) FROM samples_raw WHERE server_id = s.id) AS newest_raw
      FROM servers s ORDER BY s.instance_key`).all();
    const meta = Object.fromEntries(
      db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
    const recentRows = db.prepare('SELECT COUNT(*) AS n FROM samples_raw WHERE ts > ?').get(now - 60_000).n;
    return {
      enabled: true,
      dbPath: db.name,
      dbSizeBytes: fileSize(db.name),
      walSizeBytes: fileSize(db.name + '-wal'),
      freelistCount: db.pragma('freelist_count', { simple: true }),
      pageCount: db.pragma('page_count', { simple: true }),
      schemaVersion: db.pragma('user_version', { simple: true }),
      migrations: db.prepare('SELECT version, applied_at, description FROM schema_migrations ORDER BY version').all(),
      servers, counts, meta,
      insertErrorCount: insertErrors,
      rawInsertRatePerSec: recentRows / 60,
    };
  } catch (err) {
    console.error('[metrics-db] health failed:', err.message);
    return { enabled: true, error: err.message };
  }
}
```

Update exports: `module.exports = { initialize, insertSnapshot, rollup, prune, vacuum, checkpoint, health, close, _db };`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/`
Expected: PASS (all metrics tests + pre-existing server tests).

- [ ] **Step 6: Commit**

```bash
git add server/metricsRetention.js server/metricsStore.js tests/server/metricsRetention.test.js
git commit -m "feat(persistence): retention pruning, conditional VACUUM, WAL checkpoint, health snapshot"
```

---

### Task 7: History getters — `getHistory` (auto resolution + rolled-tail fill), `getWaitHistory`, `getBlockingHistory`

**Files:**
- Modify: `server/metricsStore.js`
- Test: `tests/server/metricsHistory.test.js`

**Interfaces:**
- Produces:
  - `getHistory(instanceKey, fromMs, toMs, resolution = 'auto') → { resolution: 'raw'|'1m'|'15m'|'1h', rows }` — raw rows carry `ts` + KPI columns; rollup rows carry `ts` + `<kpi>_avg/_min/_max` + `sample_count`. Unknown instanceKey → `{ resolution, rows: [] }`. Disabled → `{ resolution: null, rows: [] }`.
  - `getWaitHistory(instanceKey, fromMs, toMs) → { rows }` (delta rows, ordered by ts).
  - `getBlockingHistory(instanceKey, fromMs, toMs) → { rows }` (ordered by ts).
  - `pickResolution(spanMs)` exported for the API layer: ≤2h raw, ≤48h 1m, ≤14d 15m, else 1h.

- [ ] **Step 1: Write the failing test**

Create `tests/server/metricsHistory.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'
import { runRollup } from '../../server/metricsRollup.js'

const H = 3_600_000, DAY = 86_400_000
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H)

function metricsWith(cpu) {
  return { cpu_percent: cpu, waiting_tasks: 0, db_io_mb: 0, batch_requests: 0,
    serverPerf: {}, resourceWaits: [], blocking: [] }
}

describe('pickResolution', () => {
  it('selects by span per spec', async () => {
    const { pickResolution } = await import('../../server/metricsStore.js')
    expect(pickResolution(2 * H)).toBe('raw')
    expect(pickResolution(2 * H + 1)).toBe('1m')
    expect(pickResolution(48 * H)).toBe('1m')
    expect(pickResolution(48 * H + 1)).toBe('15m')
    expect(pickResolution(14 * DAY)).toBe('15m')
    expect(pickResolution(14 * DAY + 1)).toBe('1h')
  })
})

describe('getHistory', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('raw resolution returns raw rows in range, ordered', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    store.insertSnapshot('S', 'S', metricsWith(20), T0 + 2_000)
    store.insertSnapshot('S', 'S', metricsWith(30), T0 + 10 * H) // outside range
    const { resolution, rows } = store.getHistory('S', T0, T0 + H, 'raw')
    expect(resolution).toBe('raw')
    expect(rows.map(r => r.cpu_pct)).toEqual([10, 20])
  })

  it('auto picks raw for a 1h span', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    expect(store.getHistory('S', T0, T0 + H).resolution).toBe('raw')
  })

  it('unknown instance key → empty rows, no throw', () => {
    expect(store.getHistory('NOPE', T0, T0 + H)).toEqual({ resolution: 'raw', rows: [] })
  })

  it('disabled store → { resolution: null, rows: [] }', () => {
    store.close(); store.initialize('.')
    expect(store.getHistory('S', T0, T0 + H)).toEqual({ resolution: null, rows: [] })
  })

  it('1m resolution serves rolled rows AND fills the un-rolled tail from raw', () => {
    // 2 rolled minutes, then raw-only samples past the watermark
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    store.insertSnapshot('S', 'S', metricsWith(30), T0 + 2_000)
    store.insertSnapshot('S', 'S', metricsWith(50), T0 + 60_000)
    runRollup(store._db(), T0 + 120_000)          // watermark = T0+120000
    store.insertSnapshot('S', 'S', metricsWith(70), T0 + 125_000) // past watermark
    const { rows } = store.getHistory('S', T0, T0 + 180_000, '1m')
    expect(rows.map(r => r.ts)).toEqual([T0, T0 + 60_000, T0 + 120_000])
    expect(rows[0].cpu_pct_avg).toBe(20)       // rolled
    expect(rows[1].cpu_pct_avg).toBe(50)       // rolled
    expect(rows[2].cpu_pct_avg).toBe(70)       // tail aggregated on the fly
    expect(rows[2].sample_count).toBe(1)
  })

  it('tail fill does not duplicate buckets already rolled', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    runRollup(store._db(), T0 + 60_000)
    const { rows } = store.getHistory('S', T0, T0 + 60_000, '1m')
    expect(rows.filter(r => r.ts === T0)).toHaveLength(1)
  })
})

describe('getWaitHistory / getBlockingHistory', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('returns wait delta rows in range', () => {
    const w = v => [{ wait_type: 'X', wait_time_ms: v, waiting_tasks_count: v, signal_wait_time_ms: 0, max_wait_time_ms: 0 }]
    store.insertSnapshot('S', 'S', { ...metricsWith(1), resourceWaits: w(100) }, T0)
    store.insertSnapshot('S', 'S', { ...metricsWith(1), resourceWaits: w(300) }, T0 + 60_000)
    const { rows } = store.getWaitHistory('S', T0, T0 + H)
    expect(rows).toHaveLength(1)
    expect(rows[0].wait_time_ms).toBe(200)
  })

  it('returns blocking rows in range; unknown key → empty', () => {
    store.insertSnapshot('S', 'S', { ...metricsWith(1), blocking: [{
      blocking_session_id: 5, blocked_session_id: 6, wait_type: 'LCK_M_X',
      wait_time: 10, database_name: 'db1',
    }] }, T0)
    expect(store.getBlockingHistory('S', T0, T0 + H).rows).toHaveLength(1)
    expect(store.getBlockingHistory('NOPE', T0, T0 + H).rows).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/metricsHistory.test.js`
Expected: FAIL — `store.getHistory is not a function`.

- [ ] **Step 3: Implement getters in `server/metricsStore.js`**

Add near the top: `const { KPI_COLUMNS } = require('./metricsSchema');` (schema is already required — reuse `schema.KPI_COLUMNS` instead if preferred, but keep one style).

Add before `module.exports`:

```js
const RESOLUTION_MS = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000 };

function pickResolution(spanMs) {
  if (spanMs <= 2 * 3_600_000) return 'raw';
  if (spanMs <= 48 * 3_600_000) return '1m';
  if (spanMs <= 14 * 86_400_000) return '15m';
  return '1h';
}

function tailSql(bucketMs) {
  const cols = schema.KPI_COLUMNS.map(c =>
    `AVG(${c.name}) AS ${c.name}_avg, MIN(${c.name}) AS ${c.name}_min, MAX(${c.name}) AS ${c.name}_max`
  ).join(', ');
  return `SELECT server_id, ts - ts % ${bucketMs} AS ts, ${cols}, COUNT(*) AS sample_count
    FROM samples_raw
    WHERE server_id = @serverId AND ts >= @from AND ts <= @to
    GROUP BY 2 ORDER BY 2`;
}

function resolveServerId(instanceKey) {
  return db.prepare('SELECT id FROM servers WHERE instance_key = ?').get(instanceKey)?.id ?? null;
}

function getHistory(instanceKey, fromMs, toMs, resolution = 'auto') {
  if (!enabled) return { resolution: null, rows: [] };
  const res = resolution === 'auto' ? pickResolution(toMs - fromMs) : resolution;
  const serverId = resolveServerId(instanceKey);
  if (serverId === null) return { resolution: res, rows: [] };

  if (res === 'raw') {
    const rows = db.prepare(
      `SELECT * FROM samples_raw WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`
    ).all(serverId, fromMs, toMs);
    return { resolution: 'raw', rows };
  }

  const ms = RESOLUTION_MS[res];
  const rows = db.prepare(
    `SELECT * FROM samples_${res} WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`
  ).all(serverId, fromMs, toMs);

  // Rolled-tail gap: rollups run hourly, so the newest part of the range has
  // no rollup rows yet. Aggregate samples_raw on the fly past the watermark.
  const wm = db.prepare(
    'SELECT watermark_ts FROM rollup_state WHERE server_id = ? AND resolution = ?'
  ).get(serverId, res)?.watermark_ts ?? 0;
  if (toMs > wm) {
    const tail = db.prepare(tailSql(ms)).all({
      serverId, from: Math.max(wm, fromMs - (fromMs % ms)), to: toMs,
    });
    const seen = new Set(rows.map(r => r.ts));
    for (const t of tail) if (!seen.has(t.ts)) rows.push(t);
    rows.sort((a, b) => a.ts - b.ts);
  }
  return { resolution: res, rows };
}

function getWaitHistory(instanceKey, fromMs, toMs) {
  if (!enabled) return { rows: [] };
  const serverId = resolveServerId(instanceKey);
  if (serverId === null) return { rows: [] };
  const rows = db.prepare(
    `SELECT ts, wait_type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms
     FROM waits_samples WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, wait_type`
  ).all(serverId, fromMs, toMs);
  return { rows };
}

function getBlockingHistory(instanceKey, fromMs, toMs) {
  if (!enabled) return { rows: [] };
  const serverId = resolveServerId(instanceKey);
  if (serverId === null) return { rows: [] };
  const rows = db.prepare(
    `SELECT * FROM blocking_events WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, id`
  ).all(serverId, fromMs, toMs);
  return { rows };
}
```

Update exports:

```js
module.exports = {
  initialize, insertSnapshot, rollup, prune, vacuum, checkpoint, health,
  getHistory, getWaitHistory, getBlockingHistory, pickResolution, close, _db,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/metricsStore.js tests/server/metricsHistory.test.js
git commit -m "feat(persistence): history getters with auto resolution and rolled-tail raw fill"
```

---

### Task 8: `server.js` wiring — init, `@@SERVERNAME`, poll insert, HH:05 maintenance, 4 endpoints, SIGINT close

**Files:**
- Create: `server/historyRange.js`
- Modify: `server.js` (landmarks below refer to current line numbers; re-locate by content if drifted)
- Test: `tests/server/historyRange.test.js`

**Interfaces:**
- Consumes: full metricsStore API (Tasks 3–7); `requireConn(req, res)` helper at server.js:111; poll loop inside `/api/connect` handler (~line 824); `path` already required at server.js:7.
- Produces:
  - `parseHistoryRange(query, now = Date.now()) → { from, to } | null` and `VALID_RESOLUTIONS = ['auto','raw','1m','15m','1h']` from `server/historyRange.js`.
  - Endpoints: `GET /api/connections/:id/history`, `GET /api/connections/:id/history/waits`, `GET /api/connections/:id/history/blocking`, `GET /api/persistence/status`.
  - `conn.instanceKey` set on every connection object (frontend Task 9 relies on the endpoints only).

- [ ] **Step 1: Write the failing test for range validation**

Create `tests/server/historyRange.test.js`:

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseHistoryRange, VALID_RESOLUTIONS } from '../../server/historyRange.js'

const NOW = 1_700_000_000_000

describe('parseHistoryRange', () => {
  it('defaults: to = now, from = to - 1h', () => {
    expect(parseHistoryRange({}, NOW)).toEqual({ from: NOW - 3_600_000, to: NOW })
  })
  it('accepts explicit integer strings', () => {
    expect(parseHistoryRange({ from: '1000', to: '2000' }, NOW)).toEqual({ from: 1000, to: 2000 })
  })
  it('defaults from when only to given', () => {
    expect(parseHistoryRange({ to: String(NOW) }, NOW)).toEqual({ from: NOW - 3_600_000, to: NOW })
  })
  it('rejects non-numeric, negative, zero, reversed, NaN, floats', () => {
    expect(parseHistoryRange({ from: 'abc' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '-5', to: '10' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '0', to: '10' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '2000', to: '1000' }, NOW)).toBeNull()
    expect(parseHistoryRange({ from: '1.5', to: '2000' }, NOW)).toBeNull()
  })
  it('exposes the valid resolution list', () => {
    expect(VALID_RESOLUTIONS).toEqual(['auto', 'raw', '1m', '15m', '1h'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/historyRange.test.js`
Expected: FAIL — `Cannot find module '../../server/historyRange.js'`.

- [ ] **Step 3: Implement `server/historyRange.js`**

```js
'use strict';

const VALID_RESOLUTIONS = ['auto', 'raw', '1m', '15m', '1h'];

function toInt(v) {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function parseHistoryRange(query, now = Date.now()) {
  const to = query.to !== undefined ? toInt(query.to) : now;
  if (to === null || to <= 0) return null;
  const from = query.from !== undefined ? toInt(query.from) : to - 3_600_000;
  if (from === null || from <= 0 || from >= to) return null;
  return { from, to };
}

module.exports = { parseHistoryRange, VALID_RESOLUTIONS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/historyRange.test.js`
Expected: PASS.

- [ ] **Step 5: Wire metricsStore into `server.js`**

5a. Near the other requires at the top of `server.js` add:

```js
const metricsStore = require('./server/metricsStore');
const { parseHistoryRange, VALID_RESOLUTIONS } = require('./server/historyRange');
```

5b. After the requires/config section (right after `const scanStore = new MemoryScanStore()` at ~line 103) add:

```js
metricsStore.initialize(path.join(__dirname, 'data', 'metrics.db'));
```

5c. In the `/api/connect` handler, directly after the `SET DEADLOCK_PRIORITY...` session-init batch (~line 792), add:

```js
// History identity: @@SERVERNAME survives IP/DNS/connection-string changes.
let instanceKey = server;
try {
  const r = await pool.request().query('SELECT @@SERVERNAME AS name');
  if (r.recordset?.[0]?.name) instanceKey = r.recordset[0].name;
} catch (e) {
  console.warn('[metrics-db] @@SERVERNAME failed, using profile server string:', e.message);
}
```

and add `instanceKey,` to the `conn` object literal (~line 814):

```js
const conn = {
  pool, label: displayLabel, server, instanceKey,
  database:  database  || 'master',
  ...
```

5d. In the poll function, after `c.prevNet = metrics._prevNet; delete metrics._prevNet;` (~line 830) and before the `io.to(...).emit('metricsUpdated', ...)`, add:

```js
metricsStore.insertSnapshot(c.instanceKey, c.label, metrics);
```

5e. Add the maintenance scheduler just before `httpServer.listen(PORT, HOST, ...)` (~line 1185):

```js
// ─── Metrics persistence maintenance — clock-aligned at HH:05 ────────────────
function runMetricsMaintenance() {
  try {
    metricsStore.rollup();
    metricsStore.prune();
    const h = metricsStore.health();
    if (h.enabled && !h.error) {
      // Daily housekeeping on the first HH:05 run after 03:00 local.
      const today3am = new Date(); today3am.setHours(3, 0, 0, 0);
      const lastCheckpoint = Number(h.meta.last_checkpoint_at || 0);
      if (Date.now() >= today3am.getTime() && lastCheckpoint < today3am.getTime()) {
        metricsStore.vacuum();
        metricsStore.checkpoint();
      }
    }
  } catch (e) {
    console.error('[metrics-db] maintenance failed:', e.message);
  }
}

(function scheduleMetricsMaintenance() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(5, 0, 0);
  if (next <= now) next.setHours(next.getHours() + 1);
  setTimeout(function run() {
    runMetricsMaintenance();
    setTimeout(run, 60 * 60 * 1000);
  }, next - now);
})();

process.on('SIGINT', () => {
  metricsStore.close();
  process.exit(0);
});
```

5f. Add the four endpoints, next to the other `/api/connections/:id/...` GET routes (after `/api/connections/:id/db-size-history`, ~line 1000):

```js
// ─── Metrics history (SQLite persistence) ─────────────────────────────────────
app.get('/api/connections/:id/history', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const range = parseHistoryRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid from/to — positive epoch-ms integers with from < to.' });
  const resolution = req.query.resolution || 'auto';
  if (!VALID_RESOLUTIONS.includes(resolution)) return res.status(400).json({ error: 'Invalid resolution.' });
  res.json(metricsStore.getHistory(conn.instanceKey || conn.server, range.from, range.to, resolution));
});

app.get('/api/connections/:id/history/waits', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const range = parseHistoryRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid from/to — positive epoch-ms integers with from < to.' });
  res.json(metricsStore.getWaitHistory(conn.instanceKey || conn.server, range.from, range.to));
});

app.get('/api/connections/:id/history/blocking', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const range = parseHistoryRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid from/to — positive epoch-ms integers with from < to.' });
  res.json(metricsStore.getBlockingHistory(conn.instanceKey || conn.server, range.from, range.to));
});

app.get('/api/persistence/status', (_req, res) => {
  res.json(metricsStore.health());
});
```

- [ ] **Step 6: Verify the server boots and persists**

Run: `node -e "const s=require('./server/metricsStore'); console.log('init:', s.initialize('./data/metrics.db')); console.log(JSON.stringify(s.health().counts)); s.close()"`
Expected: `init: true` and a counts object — proves the real file path works on this machine.

Then run: `npx vitest run tests/server/`
Expected: PASS.

Manual smoke (requires a reachable dev SQL instance; skip if none): `npm start`, connect to the dev server from the UI, wait ~10s, then `curl "http://localhost:3000/api/persistence/status"` — expect `enabled: true` and `samples_raw` count > 0; `curl "http://localhost:3000/api/connections/<id>/history"` — expect raw rows.

- [ ] **Step 7: Commit**

```bash
git add server.js server/historyRange.js tests/server/historyRange.test.js
git commit -m "feat(persistence): wire metricsStore into server — poll insert, HH:05 maintenance, history endpoints"
```

---

### Task 9: Frontend history mode — series mapping, range picker, Dashboard wiring

**Files:**
- Create: `src/lib/historySeries.js`
- Create: `src/components/HistoryRangePicker.jsx`
- Modify: `src/components/ChartCard.jsx` (optional `timestamps` prop → datetime x-axis + tooltip)
- Modify: `src/components/Dashboard.jsx`
- Test: `src/__tests__/lib/historySeries.test.js`, `src/__tests__/components/HistoryRangePicker.test.jsx`

**Interfaces:**
- Consumes: `GET /api/connections/:id/history` → `{ resolution, rows }`; `GET .../history/blocking` and `.../history/waits` → `{ rows }` (Task 8). Chart keys used by `buildCharts` in Dashboard.jsx:284: `cpu, wait, io, batch, netMb, compilations` (matching `conn.history.*`).
- Produces:
  - `buildHistorySeries(rows, resolution) → { timestamps: number[], series: { cpu, wait, io, batch, netMb, compilations } }` (raw rows read KPI columns; rollup rows read `<kpi>_avg`).
  - `RANGE_PRESETS` — `[{ key, label, ms }]` for 1h/6h/24h/7d/30d.
  - `<HistoryRangePicker value onChange />` — `value` is `null` (Live) or `{ key, from, to }`; `onChange(null)` returns to Live.
  - `ChartCard` accepts optional `timestamps: number[]` — when present, series data becomes `{x: ts, y: value}` pairs, x-axis type datetime (labels stay hidden), tooltip shows wall-clock time instead of "Ns ago". Task 10 adds the `events` prop.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/lib/historySeries.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildHistorySeries, RANGE_PRESETS } from '../../lib/historySeries'

describe('buildHistorySeries', () => {
  it('maps raw rows to chart keys', () => {
    const rows = [
      { ts: 1000, cpu_pct: 10, waiting_tasks: 2, io_mb: 1.5, batch_req: 100, net_mbs: 0.5, compilations_sec: 7 },
      { ts: 3000, cpu_pct: 20, waiting_tasks: 4, io_mb: 2.5, batch_req: 200, net_mbs: 1.5, compilations_sec: 9 },
    ]
    const { timestamps, series } = buildHistorySeries(rows, 'raw')
    expect(timestamps).toEqual([1000, 3000])
    expect(series.cpu).toEqual([10, 20])
    expect(series.wait).toEqual([2, 4])
    expect(series.io).toEqual([1.5, 2.5])
    expect(series.batch).toEqual([100, 200])
    expect(series.netMb).toEqual([0.5, 1.5])
    expect(series.compilations).toEqual([7, 9])
  })

  it('maps rollup rows via *_avg columns', () => {
    const rows = [{ ts: 60000, cpu_pct_avg: 33.3, waiting_tasks_avg: 1, io_mb_avg: 0.1, batch_req_avg: 50, net_mbs_avg: 0.2, compilations_sec_avg: 3, sample_count: 30 }]
    const { series } = buildHistorySeries(rows, '1m')
    expect(series.cpu).toEqual([33.3])
    expect(series.batch).toEqual([50])
  })

  it('missing values become null, not 0', () => {
    const { series } = buildHistorySeries([{ ts: 1000, cpu_pct: null }], 'raw')
    expect(series.cpu).toEqual([null])
    expect(series.io).toEqual([null])
  })

  it('presets cover 1h/6h/24h/7d/30d', () => {
    expect(RANGE_PRESETS.map(p => p.key)).toEqual(['1h', '6h', '24h', '7d', '30d'])
    expect(RANGE_PRESETS[0].ms).toBe(3_600_000)
    expect(RANGE_PRESETS[4].ms).toBe(30 * 86_400_000)
  })
})
```

Create `src/__tests__/components/HistoryRangePicker.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import HistoryRangePicker from '../../components/HistoryRangePicker'

describe('HistoryRangePicker', () => {
  it('renders Live + presets + Custom', () => {
    render(<HistoryRangePicker value={null} onChange={() => {}} />)
    for (const label of ['Live', '1h', '6h', '24h', '7d', '30d', 'Custom']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('clicking a preset emits { key, from, to } spanning that preset', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '6h' }))
    const arg = onChange.mock.calls[0][0]
    expect(arg.key).toBe('6h')
    expect(arg.to - arg.from).toBe(6 * 3_600_000)
    expect(arg.to).toBeLessThanOrEqual(Date.now())
  })

  it('clicking Live emits null', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={{ key: '1h', from: 1, to: 2 }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('Custom shows from/to inputs and Apply emits the parsed range', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-08T10:00' } })
    fireEvent.change(screen.getByLabelText('To'),   { target: { value: '2026-07-08T12:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const arg = onChange.mock.calls[0][0]
    expect(arg.key).toBe('custom')
    expect(arg.to - arg.from).toBe(2 * 3_600_000)
  })

  it('Apply with reversed range does not emit', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-08T12:00' } })
    fireEvent.change(screen.getByLabelText('To'),   { target: { value: '2026-07-08T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/lib/historySeries.test.js src/__tests__/components/HistoryRangePicker.test.jsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/lib/historySeries.js`**

```js
// Maps /api/connections/:id/history rows to the per-chart arrays Dashboard's
// ChartCards consume. Keys match buildCharts / conn.history keys.
const CHART_FIELDS = {
  cpu:          'cpu_pct',
  wait:         'waiting_tasks',
  io:           'io_mb',
  batch:        'batch_req',
  netMb:        'net_mbs',
  compilations: 'compilations_sec',
}

export function buildHistorySeries(rows, resolution) {
  const suffix = resolution === 'raw' ? '' : '_avg'
  const timestamps = rows.map(r => r.ts)
  const series = {}
  for (const [key, col] of Object.entries(CHART_FIELDS)) {
    series[key] = rows.map(r => r[col + suffix] ?? null)
  }
  return { timestamps, series }
}

export const RANGE_PRESETS = [
  { key: '1h',  label: '1h',  ms: 3_600_000 },
  { key: '6h',  label: '6h',  ms: 6 * 3_600_000 },
  { key: '24h', label: '24h', ms: 24 * 3_600_000 },
  { key: '7d',  label: '7d',  ms: 7 * 86_400_000 },
  { key: '30d', label: '30d', ms: 30 * 86_400_000 },
]
```

- [ ] **Step 4: Implement `src/components/HistoryRangePicker.jsx`**

```jsx
import React, { useState } from 'react'
import { RANGE_PRESETS } from '../lib/historySeries'

const btnStyle = (active) => ({
  fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
  border: `1px solid ${active ? 'var(--sort-active)' : 'var(--divider)'}`,
  background: active ? 'var(--sort-active)' : 'var(--input-bg)',
  color: active ? '#fff' : 'var(--text-primary)', cursor: 'pointer',
})

export default function HistoryRangePicker({ value, onChange }) {
  const [customOpen, setCustomOpen] = useState(false)
  const [fromStr, setFromStr] = useState('')
  const [toStr, setToStr] = useState('')
  const activeKey = value?.key ?? 'live'

  const applyCustom = () => {
    const from = fromStr ? new Date(fromStr).getTime() : NaN
    const to = toStr ? new Date(toStr).getTime() : Date.now()
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return
    onChange({ key: 'custom', from, to })
  }

  return (
    <div className="flex items-center gap-2 flex-wrap mb-4">
      <button style={btnStyle(activeKey === 'live')} onClick={() => { setCustomOpen(false); onChange(null) }}>Live</button>
      {RANGE_PRESETS.map(p => (
        <button key={p.key} style={btnStyle(activeKey === p.key)}
          onClick={() => { setCustomOpen(false); const to = Date.now(); onChange({ key: p.key, from: to - p.ms, to }) }}>
          {p.label}
        </button>
      ))}
      <button style={btnStyle(activeKey === 'custom')} onClick={() => setCustomOpen(o => !o)}>Custom</button>
      {customOpen && (
        <span className="flex items-center gap-2" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          <label className="flex items-center gap-1">From
            <input aria-label="From" type="datetime-local" value={fromStr} onChange={e => setFromStr(e.target.value)}
              style={{ fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--divider)', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          </label>
          <label className="flex items-center gap-1">To
            <input aria-label="To" type="datetime-local" value={toStr} onChange={e => setToStr(e.target.value)}
              style={{ fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--divider)', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          </label>
          <button style={btnStyle(false)} onClick={applyCustom}>Apply</button>
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/lib/historySeries.test.js src/__tests__/components/HistoryRangePicker.test.jsx`
Expected: PASS.

- [ ] **Step 6: Add `timestamps` support to `src/components/ChartCard.jsx`**

Change the component signature (ChartCard.jsx:12) to accept `timestamps`:

```jsx
export default memo(function ChartCard({ title, subtitle, value, unit, history, color, yMax, timestamps }) {
```

Replace the `series` memo (lines 13–16) with:

```jsx
  const series = useMemo(() => {
    const data = history && history.length > 0 ? history : Array(60).fill(null)
    if (timestamps && history && history.length > 0 && timestamps.length === history.length) {
      return [{ name: title, data: history.map((y, i) => ({ x: timestamps[i], y })) }]
    }
    return [{ name: title, data }]
  }, [history, timestamps, title])
```

In the `options` memo: change the `xaxis` block (lines 49–53) to:

```jsx
    xaxis: {
      ...(timestamps ? { type: 'datetime' } : {}),
      labels:     { show: false },
      axisBorder: { show: false },
      axisTicks:  { show: false },
    },
```

and change the tooltip `x` formatter (lines 77–83) to:

```jsx
      x: {
        formatter: (val, { dataPointIndex, w }) => {
          if (timestamps) return new Date(val).toLocaleString()
          const total = w.globals.series[0].length
          const ago = (total - 1 - dataPointIndex) * 2
          return ago === 0 ? 'Now' : `${ago}s ago`
        },
      },
```

Finally add `timestamps` to the `options` memo dependency array: `[color, yMax, title, timestamps]`.

- [ ] **Step 7: Wire history mode into `src/components/Dashboard.jsx`**

7a. Imports (top of file):

```jsx
import HistoryRangePicker from './HistoryRangePicker'
import { buildHistorySeries } from '../lib/historySeries'
```

7b. Add `histKey` to each entry in `buildCharts` (Dashboard.jsx:284) — the six ids in order get `histKey: 'cpu'`, `'wait'`, `'io'`, `'batch'`, `'netMb'`, `'compilations'`. Example for the first entry:

```jsx
    { id: 'chart_cpu', histKey: 'cpu', title: '% Processor Time', subtitle: 'SQL CPU utilization', value: m ? m.cpu_percent + '%' : '--', color: p.chartCpu, yMax: 100, history: conn.history.cpu },
```

7c. State inside the Dashboard component (next to the existing useState block, ~line 301):

```jsx
  const [histRange, setHistRange]     = useState(null)  // null = Live
  const [histData, setHistData]       = useState(null)  // { resolution, timestamps, series, blocking, waits }
  const [histLoading, setHistLoading] = useState(false)
  const [histError, setHistError]     = useState(null)
```

Add `setHistRange(null); setHistData(null); setHistError(null)` to the existing connId-reset `useEffect` (~line 307).

7d. Fetch effect (after the reset effect):

```jsx
  useEffect(() => {
    if (!histRange) { setHistData(null); setHistError(null); return }
    let cancelled = false
    setHistLoading(true)
    setHistError(null)
    const qs = `from=${histRange.from}&to=${histRange.to}`
    Promise.all([
      fetch(`/api/connections/${connId}/history?${qs}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`History fetch failed (HTTP ${r.status})`))),
      fetch(`/api/connections/${connId}/history/blocking?${qs}`)
        .then(r => r.ok ? r.json() : { rows: [] }),
      fetch(`/api/connections/${connId}/history/waits?${qs}`)
        .then(r => r.ok ? r.json() : { rows: [] }),
    ]).then(([hist, blocking, waits]) => {
      if (cancelled) return
      const { timestamps, series } = buildHistorySeries(hist.rows, hist.resolution)
      setHistData({ resolution: hist.resolution, timestamps, series, blocking: blocking.rows || [], waits: waits.rows || [] })
    }).catch(err => {
      if (!cancelled) setHistError(err.message)
    }).finally(() => {
      if (!cancelled) setHistLoading(false)
    })
    return () => { cancelled = true }
  }, [histRange, connId])
```

7e. Render the picker and banner directly above the charts grid (before the `<div className="gap-6 mb-6" style={{ display: 'grid', ...` at ~line 712):

```jsx
      <HistoryRangePicker value={histRange} onChange={setHistRange} />
      {histRange && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2 rounded-lg"
          style={{ background: 'rgba(59,130,246,.08)', border: '1px solid rgba(59,130,246,.25)', fontSize: 12 }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            Viewing history{histData?.resolution ? ` — ${histData.resolution} resolution` : ''}
            {histLoading ? ' (loading…)' : ''}
          </span>
          {histError && <span style={{ color: '#dc2626' }}>{histError}</span>}
          {!histLoading && !histError && histData && histData.timestamps.length === 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              No history for this range — the store may be disabled or the range predates available data.
            </span>
          )}
          <button onClick={() => setHistRange(null)} className="ml-auto"
            style={{ fontSize: 11, fontWeight: 600, color: 'var(--sort-active)', cursor: 'pointer', background: 'none', border: 'none' }}>
            Back to Live
          </button>
        </div>
      )}
```

7f. Pass history-mode data into the ChartCards (the `allCharts.map` at ~line 716). Live appends pause automatically because history mode substitutes a static array:

```jsx
        {allCharts.map(c => (
          <div key={c.id} style={on(c.id) ? { overflow: 'hidden' } : { display: 'none' }}>
            <ChartCard
              title={c.title}
              subtitle={histRange ? `History — ${histRange.key}` : c.subtitle}
              value={c.value}
              history={histRange ? (histData?.series?.[c.histKey] ?? []) : c.history}
              timestamps={histRange ? (histData?.timestamps ?? []) : undefined}
              color={c.color}
              yMax={c.yMax}
            />
          </div>
        ))}
```

- [ ] **Step 8: Run the full frontend test suite + manual browser check**

Run: `npx vitest run src/`
Expected: new tests PASS; no new failures elsewhere.

Manual (requires dev SQL instance): `npm run dev`, open http://localhost:5173, connect, let it poll ~2 min, click `1h` — charts switch to a static fetched series with wall-clock tooltips, banner appears, "Back to Live" resumes live appends. Verify picker on a connection with no history shows the empty-state message.

- [ ] **Step 9: Commit**

```bash
git add src/lib/historySeries.js src/components/HistoryRangePicker.jsx src/components/ChartCard.jsx src/components/Dashboard.jsx src/__tests__/lib/historySeries.test.js src/__tests__/components/HistoryRangePicker.test.jsx
git commit -m "feat(persistence): dashboard history mode — range picker, static chart series, live-pause banner"
```

---

### Task 10: Blocking markers on CPU chart + waits history in Resource Waits panel

**Files:**
- Modify: `src/lib/historySeries.js` (add `aggregateWaits`)
- Modify: `src/components/ChartCard.jsx` (optional `events` prop → point annotations)
- Modify: `src/components/Dashboard.jsx` (events on CPU chart, blocking-event list + detail dialog, waits panel history rows)
- Test: `src/__tests__/lib/historySeries.test.js` (extend)

**Interfaces:**
- Consumes: `histData.blocking` rows (blocking_events columns from Task 4) and `histData.waits` rows (delta columns) already fetched in Task 9.
- Produces: `aggregateWaits(rows) → [{ wait_type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms, wait_pct }]` sorted by total wait desc. `ChartCard` `events` prop: `[{ ts }]` → red point annotations at those x positions (requires `timestamps` mode). Marker click-detail is implemented as a clickable "Blocking events" list under the charts (ApexCharts point annotations have no click callback; the list is the click target, the markers are the visual cue).

- [ ] **Step 1: Write the failing test (extend `src/__tests__/lib/historySeries.test.js`)**

Append to the existing file:

```js
import { aggregateWaits } from '../../lib/historySeries'

describe('aggregateWaits', () => {
  it('sums deltas per wait_type and computes wait_pct, sorted desc', () => {
    const rows = [
      { ts: 1, wait_type: 'PAGEIOLATCH_SH', wait_time_ms: 100, waiting_tasks_count: 1, signal_wait_time_ms: 10 },
      { ts: 2, wait_type: 'PAGEIOLATCH_SH', wait_time_ms: 200, waiting_tasks_count: 2, signal_wait_time_ms: 20 },
      { ts: 2, wait_type: 'LCK_M_X',        wait_time_ms: 700, waiting_tasks_count: 5, signal_wait_time_ms: 0 },
    ]
    const agg = aggregateWaits(rows)
    expect(agg).toHaveLength(2)
    expect(agg[0].wait_type).toBe('LCK_M_X')
    expect(agg[0].wait_time_ms).toBe(700)
    expect(agg[0].wait_pct).toBe(70)
    expect(agg[1].wait_time_ms).toBe(300)
    expect(agg[1].waiting_tasks_count).toBe(3)
    expect(agg[1].wait_pct).toBe(30)
  })

  it('empty input → empty array', () => {
    expect(aggregateWaits([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/lib/historySeries.test.js`
Expected: FAIL — `aggregateWaits` is not exported.

- [ ] **Step 3: Add `aggregateWaits` to `src/lib/historySeries.js`**

```js
export function aggregateWaits(rows) {
  const map = new Map()
  for (const r of rows) {
    const cur = map.get(r.wait_type) || {
      wait_type: r.wait_type, wait_time_ms: 0, waiting_tasks_count: 0, signal_wait_time_ms: 0,
    }
    cur.wait_time_ms        += r.wait_time_ms        || 0
    cur.waiting_tasks_count += r.waiting_tasks_count || 0
    cur.signal_wait_time_ms += r.signal_wait_time_ms || 0
    map.set(r.wait_type, cur)
  }
  const out = [...map.values()].sort((a, b) => b.wait_time_ms - a.wait_time_ms)
  const total = out.reduce((s, r) => s + r.wait_time_ms, 0)
  for (const r of out) r.wait_pct = total > 0 ? +((r.wait_time_ms / total) * 100).toFixed(1) : 0
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/lib/historySeries.test.js`
Expected: PASS.

- [ ] **Step 5: Add the `events` prop to `src/components/ChartCard.jsx`**

Add `events` to the signature:

```jsx
export default memo(function ChartCard({ title, subtitle, value, unit, history, color, yMax, timestamps, events }) {
```

Inside the `options` memo add (top level of the options object, before `stroke`):

```jsx
    annotations: (timestamps && events && events.length > 0) ? {
      points: events.map(e => ({
        x: e.ts,
        y: 0,
        marker: { size: 5, fillColor: '#ef4444', strokeColor: '#fff', strokeWidth: 1.5 },
        label: {
          text: '⛔', borderWidth: 0, offsetY: -4,
          style: { background: 'transparent', fontSize: '10px' },
        },
      })),
    } : {},
```

and extend the dependency array: `[color, yMax, title, timestamps, events]`.

- [ ] **Step 6: Wire events, blocking list, and waits history into `src/components/Dashboard.jsx`**

6a. Import `aggregateWaits` (extend the Task 9 import):

```jsx
import { buildHistorySeries, aggregateWaits } from '../lib/historySeries'
```

6b. Add detail-dialog state next to the other history state:

```jsx
  const [blockDetail, setBlockDetail] = useState(null) // null | blocking_events row
```

6c. Pass events to the CPU chart only — in the `allCharts.map` ChartCard call (Task 9 step 7f), add:

```jsx
              events={histRange && c.histKey === 'cpu' ? (histData?.blocking ?? []) : undefined}
```

6d. Blocking-event list — render directly after the charts grid `</div>` (only in history mode):

```jsx
      {histRange && histData && histData.blocking.length > 0 && (
        <div className="mc mb-6" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.065em', marginBottom: 8 }}>
            Blocking events in range ({histData.blocking.length}) — marked ⛔ on the CPU chart
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {histData.blocking.map(b => (
              <button key={b.id} onClick={() => setBlockDetail(b)}
                className="flex items-center gap-3 w-full text-left px-2 py-1.5 rounded hover:bg-black/5"
                style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>
                <span className="tabular-nums" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                  {new Date(b.ts).toLocaleString()}
                </span>
                <span style={{ fontWeight: 600, color: '#ef4444' }}>SPID {b.blocking_sid} → {b.blocked_sid}</span>
                <span className="font-mono" style={{ fontSize: 11 }}>{b.wait_type || '—'}</span>
                <span style={{ color: 'var(--text-muted)' }}>{b.database_name || ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
```

6e. Blocking detail dialog — add next to the existing dialogs (uses the same `Dialog` primitives already imported):

```jsx
      <Dialog open={!!blockDetail} onOpenChange={open => !open && setBlockDetail(null)}>
        <DialogContent style={{ maxWidth: 560 }}>
          <DialogHeader>
            <DialogTitle>Blocking event — {blockDetail ? new Date(blockDetail.ts).toLocaleString() : ''}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {blockDetail && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <p><strong>Blocker</strong> SPID {blockDetail.blocking_sid} — {blockDetail.blocker_login || '—'} @ {blockDetail.blocker_host || '—'} ({blockDetail.blocker_program || '—'})</p>
                <p><strong>Blocked</strong> SPID {blockDetail.blocked_sid} — {blockDetail.blocked_login || '—'} @ {blockDetail.blocked_host || '—'}</p>
                <p><strong>Wait</strong> {blockDetail.wait_type || '—'} · {blockDetail.wait_ms != null ? `${blockDetail.wait_ms.toLocaleString()} ms` : '—'} · {blockDetail.database_name || '—'} {blockDetail.parent_object ? `· ${blockDetail.parent_object}` : ''}</p>
                <p style={{ marginTop: 10, fontWeight: 700 }}>Blocker query</p>
                <pre className="font-mono" style={{ fontSize: 11, background: 'var(--input-bg)', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{blockDetail.blocker_query || '—'}</pre>
                <p style={{ marginTop: 10, fontWeight: 700 }}>Blocked query</p>
                <pre className="font-mono" style={{ fontSize: 11, background: 'var(--input-bg)', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{blockDetail.blocked_query || '—'}</pre>
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
```

(JSX text content is auto-escaped by React — no XSS risk from stored queries.)

6f. Waits panel history — in `renderSection`, case `'resource_waits'` (~line 552), compute history rows and substitute when not Live:

```jsx
      case 'resource_waits': {
        const histWaits = histRange && histData ? aggregateWaits(histData.waits) : null
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="waits"
            title={histRange ? 'Resource Waits — history range' : 'Resource Waits'}
            badge={<SectionBadge count={histWaits ? histWaits.length : (m?.currentWaits?.length ? m.currentWaits.reduce((s,r)=>s+r.session_count,0) : (m?.resourceWaits?.length || 0))} alertWhen={!histRange && m?.currentWaits?.length > 0} />}>
            {!histRange && <CurrentWaitsPanel rows={m?.currentWaits} />}
            <VirtualTable rows={histWaits ?? sortedWaits} columns={TABLE_COLS.waits} height={240}
              sortCol={conn.sortState.waits.col} sortDir={conn.sortState.waits.dir} onSort={col => handleSort('waits', col)} />
          </CollapsibleSection>
        )
      }
```

(Aggregated rows lack `max_wait_time_ms` — the column renders blank via the table's null handling, which is acceptable for deltas.)

- [ ] **Step 7: Run frontend tests + manual browser check**

Run: `npx vitest run src/`
Expected: PASS, no new failures.

Manual (requires dev SQL instance): in history mode with a range containing a blocking event (create one on the dev instance: `BEGIN TRAN; UPDATE <table> ...` in one SSMS session against `medcare_db_dev`, a competing `UPDATE` in a second session, wait >5s, rollback both), confirm: ⛔ marker on CPU chart, event in the list, clicking opens the detail dialog, Resource Waits shows range aggregates.

- [ ] **Step 8: Commit**

```bash
git add src/lib/historySeries.js src/components/ChartCard.jsx src/components/Dashboard.jsx src/__tests__/lib/historySeries.test.js
git commit -m "feat(persistence): blocking markers + event detail dialog and waits history in range view"
```

---

### Task 11: Full verification + E2E

**Files:** none created — verification only.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all metrics/persistence/history tests PASS; only the 4 pre-existing WhoIsActive failures remain (known, unrelated). If any other test fails, fix before proceeding.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: vite build succeeds with no errors.

- [ ] **Step 3: End-to-end manual checklist (dev SQL instance only — per devInstruction.md, never point AI-assisted testing at production)**

1. `npm run dev`, connect to the dev instance.
2. `curl "http://localhost:3001/api/persistence/status"` (dev PORT is 3001) → `enabled: true`, `samples_raw` growing, `rawInsertRatePerSec ≈ 0.5`.
3. Restart `server.js` mid-session → reconnect → `/api/persistence/status` still shows the earlier rows (history survives restarts); `servers` has ONE entry for the instance (identity via `@@SERVERNAME`, not connection string).
4. History mode: `1h` renders fetched data; tooltips show wall-clock times; `Back to Live` resumes appends.
5. Wait ≥1 poll past the next HH:05 → status shows `last_rollup_at`/`last_prune_at` set and `samples_1m` count > 0.
6. `data/metrics.db` exists on disk; `git status` shows it untracked-and-ignored (`data/` is in .gitignore).

- [ ] **Step 4: Review AI-generated SQL**

Per CLAUDE.md policy, manually review the one new SQL Server query introduced by this feature — `SELECT @@SERVERNAME AS name` in `/api/connect` — plus confirm no other T-SQL was added or changed. (All other new SQL is SQLite, local file, no server exposure.)

- [ ] **Step 5: Final commit (only if steps 1–4 surfaced fixes)**

```bash
git add <specific files changed during verification>
git commit -m "fix(persistence): address E2E verification findings"
```

---

## Self-Review Notes

- **Spec coverage:** storage engine + PRAGMAs (T2), persisted set — KPIs/waits-as-deltas/blocking (T3–T4), instance-key identity (T3, T8), epoch-ms timestamps (all), rollup ladder + watermarks + NULL rules + weighted averages (T5), retention + conditional VACUUM + checkpoint (T6), rolled-tail gap fill + auto resolution (T7), four endpoints + validation + health payload (T8), UI range picker/live-pause/banner/custom (T9), blocking markers + detail + waits range + empty states (T10), setup.js prerequisite (T1), error isolation / disabled mode (T3). Out-of-scope items untouched.
- **Deviation noted inline:** blocking "marker click" is implemented as a clickable event list (markers are visual annotations; ApexCharts point annotations have no click callback). Spec intent — reaching the who-blocked-whom detail from the chart area — is preserved.
- **Type consistency check:** `insertSnapshot(instanceKey, displayName, metrics, now)` and getter signatures identical across Tasks 3–8; chart keys `cpu/wait/io/batch/netMb/compilations` identical across Tasks 9–10 and `buildCharts`; `KPI_COLUMNS` is the single source for every generated column list.





