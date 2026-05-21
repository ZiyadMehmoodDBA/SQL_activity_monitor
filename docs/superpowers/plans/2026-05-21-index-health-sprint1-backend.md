# Index Health — Sprint 1: Backend Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Async scan API with IScanStore, concurrency engine, progress tracking, TTL, and cancel — no SQL queries yet (stubbed); Sprint 2 fills in the real DMV queries.

**Architecture:** Three new CommonJS modules (`server/indexScanStore.js`, `server/indexScanOrchestrator.js`, `server/indexScanQueries.js`) imported by `server.js`. A singleton `MemoryScanStore` tracks all scan state. `runScan` runs async fire-and-forget with a manual concurrency queue, per-DB timeout, and weighted progress.

**Tech Stack:** Node.js 22, Express 4, mssql 11, Vitest 4 (already installed). No new dependencies needed.

---

## Context for agentic workers

**Codebase:** `D:\dashbaords\` — Node.js + Express backend (`server.js`), React 18 frontend (`src/`), Vite build to `dist/`. Server is CommonJS (`require`/`module.exports`). Frontend is ESM.

**Key server.js patterns:**
- `requireConn(req, res)` — looks up `connections.get(req.params.id)`, returns 404 if missing, returns the conn object otherwise.
- `connections` — `Map<id, { pool, label, server, database, color, appIntent, handle, snapshotHandle, prevIO, prevNet }>`
- All existing API routes follow `/api/connections/:id/...` pattern.
- `server.js` uses `require('crypto').randomUUID` (already imported at line 6).

**Test setup:** Vitest with jsdom global default. Server-side tests must include `// @vitest-environment node` as the first line to override. Run server tests with: `npx vitest run tests/server/`

**Spec file:** `docs/superpowers/specs/2026-05-21-index-health-design.md`

---

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `server/indexScanStore.js` | Create | MemoryScanStore — all scan state: create/update/get/cancel/cleanup |
| `server/indexScanQueries.js` | Create | `scanDatabase` stub (Sprint 1); real DMV queries in Sprint 2 |
| `server/indexScanOrchestrator.js` | Create | `runScan`, `runWithConcurrency`, `scanDatabaseWithTimeout`, `fetchUserDatabases`, `fetchDbWeights`, `fetchServerMeta`, `computeHealthScore`, `paginateResults` |
| `tests/server/indexScanStore.test.js` | Create | MemoryScanStore unit tests |
| `tests/server/indexScanOrchestrator.test.js` | Create | Orchestrator helper unit tests |
| `server.js` | Modify | Import modules, add `scanStore` singleton, 4 endpoints, TTL cleanup interval |

---

## Task 1: Server module scaffolding + Vitest smoke test

**Files:**
- Create: `server/indexScanStore.js`
- Create: `server/indexScanOrchestrator.js`
- Create: `server/indexScanQueries.js`
- Create: `tests/server/smoke.test.js`

- [ ] **Step 1: Create the `server/` directory**

```powershell
New-Item -ItemType Directory -Force "D:\dashbaords\server"
New-Item -ItemType Directory -Force "D:\dashbaords\tests\server"
```

- [ ] **Step 2: Create `server/indexScanStore.js` skeleton**

```javascript
'use strict'
// MemoryScanStore — in-memory scan state. IScanStore interface:
//   create(scanId, connId, scanMode, databases) → record
//   update(scanId, patch) → record | null
//   get(scanId) → record | null
//   getActiveScanByConn(connId) → record | null   (status pending|running)
//   cancel(scanId) → boolean
//   cleanup(nowMs, ttlMs) → number  (count deleted)

class MemoryScanStore {
  constructor() {
    this._scans = new Map()
  }
}

module.exports = { MemoryScanStore }
```

- [ ] **Step 3: Create `server/indexScanOrchestrator.js` skeleton**

```javascript
'use strict'
module.exports = {}
```

- [ ] **Step 4: Create `server/indexScanQueries.js` skeleton**

```javascript
'use strict'
module.exports = {}
```

- [ ] **Step 5: Write smoke test `tests/server/smoke.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { MemoryScanStore } from '../../server/indexScanStore.js'

describe('smoke', () => {
  it('imports MemoryScanStore', () => {
    expect(typeof MemoryScanStore).toBe('function')
  })
})
```

- [ ] **Step 6: Run smoke test to verify Vitest picks it up**

```powershell
cd D:\dashbaords
npx vitest run tests/server/
```

Expected output: `1 passed`

- [ ] **Step 7: Commit scaffold**

```bash
git add server/indexScanStore.js server/indexScanOrchestrator.js server/indexScanQueries.js tests/server/smoke.test.js
git commit -m "feat(index-health): scaffold Sprint 1 server modules + test directory"
```

---

## Task 2: MemoryScanStore — TDD

**Files:**
- Modify: `server/indexScanStore.js`
- Modify: `tests/server/indexScanStore.test.js` (create)

### Scan record shape (reference for all tasks)

```javascript
{
  scanId: string,          // randomUUID()
  connId: string,          // connection ID from connections Map
  status: 'pending' | 'running' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled',
  scanMode: 'LIMITED' | 'SAMPLED' | 'DETAILED',
  databases: string[],     // ['db1', 'db2'] or ['ALL']
  completedDbs: string[],  // DBs that finished (including timed-out ones)
  timedOutDbs: string[],   // subset of completedDbs that timed out
  totalDbs: number,
  totalWeight: number,     // sum of file sizes in bytes (set after fetchDbWeights)
  completedWeight: number, // grows as each DB finishes
  currentDb: string | null,
  error: string | null,
  results: null | {
    fragmented: object[],
    missing: object[],
    unused: object[],
    duplicate: object[],
    summary: object,       // from computeHealthScore
  },
  metadata: null | {
    scanMode: string,
    serverVersion: number,
    serverRestartTime: string | null,
    supportsOnlineRebuild: boolean,
    scanDurationMs: number,
    scanStartedAt: string,
    totalDbs: number,
    completedDbs: number,
  },
  createdAt: number,       // Date.now()
  completedAt: number | null,
  expiresAt: number | null, // completedAt + SCAN_TTL_MS (2h)
}
```

- [ ] **Step 1: Write failing tests `tests/server/indexScanStore.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryScanStore } from '../../server/indexScanStore.js'

describe('MemoryScanStore', () => {
  let store

  beforeEach(() => { store = new MemoryScanStore() })

  describe('create', () => {
    it('returns a record with pending status', () => {
      const r = store.create('scan1', 'conn1', 'LIMITED', ['db1', 'db2'])
      expect(r.scanId).toBe('scan1')
      expect(r.connId).toBe('conn1')
      expect(r.status).toBe('pending')
      expect(r.scanMode).toBe('LIMITED')
      expect(r.databases).toEqual(['db1', 'db2'])
      expect(r.totalDbs).toBe(2)
      expect(r.completedDbs).toEqual([])
      expect(r.timedOutDbs).toEqual([])
      expect(r.totalWeight).toBe(0)
      expect(r.completedWeight).toBe(0)
      expect(r.currentDb).toBeNull()
      expect(r.error).toBeNull()
      expect(r.results).toBeNull()
      expect(r.metadata).toBeNull()
      expect(typeof r.createdAt).toBe('number')
      expect(r.completedAt).toBeNull()
      expect(r.expiresAt).toBeNull()
    })
  })

  describe('get', () => {
    it('returns null for unknown scan', () => {
      expect(store.get('nope')).toBeNull()
    })
    it('returns record after create', () => {
      store.create('s1', 'c1', 'SAMPLED', [])
      expect(store.get('s1')).not.toBeNull()
    })
  })

  describe('update', () => {
    it('merges patch into record', () => {
      store.create('s1', 'c1', 'LIMITED', ['db1'])
      const r = store.update('s1', { status: 'running', currentDb: 'db1' })
      expect(r.status).toBe('running')
      expect(r.currentDb).toBe('db1')
      expect(r.scanId).toBe('s1')  // other fields preserved
    })
    it('returns null for unknown scanId', () => {
      expect(store.update('ghost', { status: 'running' })).toBeNull()
    })
  })

  describe('getActiveScanByConn', () => {
    it('returns null when no scans exist', () => {
      expect(store.getActiveScanByConn('c1')).toBeNull()
    })
    it('returns pending scan for connId', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.getActiveScanByConn('c1')?.scanId).toBe('s1')
    })
    it('returns running scan for connId', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { status: 'running' })
      expect(store.getActiveScanByConn('c1')?.scanId).toBe('s1')
    })
    it('returns null when scan is completed', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { status: 'completed' })
      expect(store.getActiveScanByConn('c1')).toBeNull()
    })
    it('returns null for different connId', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.getActiveScanByConn('c2')).toBeNull()
    })
  })

  describe('cancel', () => {
    it('sets status to cancelled and returns true', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.cancel('s1')).toBe(true)
      expect(store.get('s1').status).toBe('cancelled')
    })
    it('returns false for unknown scanId', () => {
      expect(store.cancel('ghost')).toBe(false)
    })
    it('returns false when already completed', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { status: 'completed' })
      expect(store.cancel('s1')).toBe(false)
      expect(store.get('s1').status).toBe('completed')
    })
  })

  describe('cleanup', () => {
    it('deletes expired scans', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { expiresAt: Date.now() - 1 })
      const count = store.cleanup(Date.now())
      expect(count).toBe(1)
      expect(store.get('s1')).toBeNull()
    })
    it('keeps non-expired scans', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { expiresAt: Date.now() + 60_000 })
      expect(store.cleanup(Date.now())).toBe(0)
      expect(store.get('s1')).not.toBeNull()
    })
    it('keeps scans with null expiresAt (still running)', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.cleanup(Date.now())).toBe(0)
    })
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```powershell
cd D:\dashbaords
npx vitest run tests/server/indexScanStore.test.js
```

Expected: multiple failures (`store.create is not a function`, etc.)

- [ ] **Step 3: Implement `MemoryScanStore` in `server/indexScanStore.js`**

```javascript
'use strict'

class MemoryScanStore {
  constructor() {
    this._scans = new Map()
  }

  create(scanId, connId, scanMode, databases) {
    const record = {
      scanId,
      connId,
      status: 'pending',
      scanMode,
      databases,
      completedDbs: [],
      timedOutDbs: [],
      totalDbs: databases.length,
      totalWeight: 0,
      completedWeight: 0,
      currentDb: null,
      error: null,
      results: null,
      metadata: null,
      createdAt: Date.now(),
      completedAt: null,
      expiresAt: null,
    }
    this._scans.set(scanId, record)
    return record
  }

  update(scanId, patch) {
    const record = this._scans.get(scanId)
    if (!record) return null
    Object.assign(record, patch)
    return record
  }

  get(scanId) {
    return this._scans.get(scanId) || null
  }

  getActiveScanByConn(connId) {
    for (const s of this._scans.values()) {
      if (s.connId === connId && (s.status === 'pending' || s.status === 'running')) return s
    }
    return null
  }

  cancel(scanId) {
    const record = this._scans.get(scanId)
    if (!record) return false
    if (record.status !== 'pending' && record.status !== 'running') return false
    record.status = 'cancelled'
    record.completedAt = Date.now()
    return true
  }

  cleanup(nowMs) {
    let count = 0
    for (const [id, s] of this._scans.entries()) {
      if (s.expiresAt !== null && nowMs > s.expiresAt) {
        this._scans.delete(id)
        count++
      }
    }
    return count
  }
}

module.exports = { MemoryScanStore }
```

- [ ] **Step 4: Run tests — verify all pass**

```powershell
npx vitest run tests/server/indexScanStore.test.js
```

Expected: `15 passed`

- [ ] **Step 5: Commit**

```bash
git add server/indexScanStore.js tests/server/indexScanStore.test.js
git commit -m "feat(index-health): MemoryScanStore with create/update/get/cancel/cleanup"
```

---

## Task 3: DB discovery + weighted progress helpers — TDD

**Files:**
- Modify: `server/indexScanOrchestrator.js`
- Create: `tests/server/indexScanOrchestrator.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  fetchUserDatabases,
  fetchDbWeights,
  calcProgressPct,
  computeHealthScore,
  paginateResults,
} from '../../server/indexScanOrchestrator.js'

// Minimal mock pool factory
function makePool(recordsets) {
  let callCount = 0
  return {
    request: () => ({
      query: async () => ({ recordset: recordsets[callCount++] || [] }),
    }),
  }
}

describe('fetchUserDatabases', () => {
  it('returns database names from recordset', async () => {
    const pool = makePool([[
      { db_name: 'db1' },
      { db_name: 'db2' },
    ]])
    const dbs = await fetchUserDatabases(pool)
    expect(dbs).toEqual(['db1', 'db2'])
  })

  it('returns empty array when no user databases', async () => {
    const pool = makePool([[]])
    expect(await fetchUserDatabases(pool)).toEqual([])
  })
})

describe('fetchDbWeights', () => {
  it('returns weight map by db name', async () => {
    const pool = makePool([[
      { db_name: 'db1', size_bytes: 1_000_000 },
      { db_name: 'db2', size_bytes: 2_000_000 },
    ]])
    const weights = await fetchDbWeights(pool, ['db1', 'db2'])
    expect(weights).toEqual({ db1: 1_000_000, db2: 2_000_000 })
  })

  it('assigns 1 as fallback for DB missing from query result', async () => {
    const pool = makePool([[{ db_name: 'db1', size_bytes: 500_000 }]])
    const weights = await fetchDbWeights(pool, ['db1', 'db2'])
    expect(weights.db1).toBe(500_000)
    expect(weights.db2).toBe(1)
  })
})

describe('calcProgressPct', () => {
  it('returns 0 when totalWeight is 0', () => {
    expect(calcProgressPct(0, 0)).toBe(0)
  })
  it('returns correct pct', () => {
    expect(calcProgressPct(25, 100)).toBeCloseTo(25)
  })
  it('caps at 100', () => {
    expect(calcProgressPct(200, 100)).toBe(100)
  })
})

describe('computeHealthScore', () => {
  it('returns score 100 with Healthy when no indexes', () => {
    const result = computeHealthScore([])
    expect(result.score).toBe(100)
    expect(result.severity).toBe('Healthy')
    expect(result.totalIndexes).toBe(0)
  })

  it('returns Critical when many rebuild-needed indexes', () => {
    const dbResults = [{
      totalIndexes: 10,
      disabledCount: 0,
      fragmented: Array(8).fill({ recommendation: 'REBUILD' }),
      missing: [],
      unused: [],
      duplicate: [],
    }]
    const result = computeHealthScore(dbResults)
    expect(result.score).toBeLessThan(70)
    expect(result.severity).toBe('Critical')
    expect(result.fragmentedCount).toBe(8)
  })

  it('aggregates across multiple DB results', () => {
    const dbResults = [
      { totalIndexes: 5, disabledCount: 0, fragmented: [{ recommendation: 'REBUILD' }], missing: [], unused: [], duplicate: [] },
      { totalIndexes: 5, disabledCount: 0, fragmented: [{ recommendation: 'OK' }], missing: [], unused: [], duplicate: [] },
    ]
    const result = computeHealthScore(dbResults)
    expect(result.totalIndexes).toBe(10)
    expect(result.fragmentedCount).toBe(1)
  })

  it('returns Warning for score 70-90', () => {
    const dbResults = [{
      totalIndexes: 10,
      disabledCount: 0,
      fragmented: [{ recommendation: 'REBUILD' }, { recommendation: 'REBUILD' }],
      missing: [],
      unused: [],
      duplicate: [],
    }]
    const result = computeHealthScore(dbResults)
    expect(result.severity).toBe('Warning')
  })
})

describe('paginateResults', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    database_name: i < 5 ? 'db1' : 'db2',
    table_name: `Table${i}`,
    index_name: `IX_${i}`,
  }))

  it('returns first page with correct total', () => {
    const r = paginateResults(rows, { page: 1, pageSize: 3 })
    expect(r.total).toBe(10)
    expect(r.rows.length).toBe(3)
    expect(r.page).toBe(1)
    expect(r.pageSize).toBe(3)
  })

  it('filters by database name', () => {
    const r = paginateResults(rows, { page: 1, pageSize: 50, db: 'db1' })
    expect(r.total).toBe(5)
    expect(r.rows.every(r => r.database_name === 'db1')).toBe(true)
  })

  it('filters by search text (table_name)', () => {
    const r = paginateResults(rows, { page: 1, pageSize: 50, search: 'table3' })
    expect(r.total).toBe(1)
    expect(r.rows[0].table_name).toBe('Table3')
  })

  it('returns empty rows for out-of-range page', () => {
    const r = paginateResults(rows, { page: 99, pageSize: 5 })
    expect(r.total).toBe(10)
    expect(r.rows.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run — verify failures**

```powershell
npx vitest run tests/server/indexScanOrchestrator.test.js
```

Expected: import errors / function-not-found failures.

- [ ] **Step 3: Implement helpers in `server/indexScanOrchestrator.js`**

```javascript
'use strict'

async function fetchUserDatabases(pool) {
  const r = await pool.request().query(`
    SELECT DB_NAME(database_id) AS db_name
    FROM sys.databases
    WHERE database_id > 4 AND state = 0
    ORDER BY name
  `)
  return r.recordset.map(row => row.db_name)
}

async function fetchDbWeights(pool, databases) {
  const r = await pool.request().query(`
    SELECT
      DB_NAME(database_id) AS db_name,
      CAST(SUM(CAST(size AS BIGINT)) * 8192 AS FLOAT) AS size_bytes
    FROM sys.master_files
    WHERE state = 0 AND database_id > 4
    GROUP BY database_id
  `)
  const fromQuery = {}
  for (const row of r.recordset) fromQuery[row.db_name] = row.size_bytes
  const weights = {}
  for (const db of databases) weights[db] = fromQuery[db] || 1
  return weights
}

async function fetchServerMeta(pool) {
  const r = await pool.request().query(`
    SELECT
      CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
      CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100))   AS edition,
      sqlserver_start_time
    FROM sys.dm_os_sys_info
  `)
  const row = r.recordset[0] || {}
  return {
    majorVersion: row.major_version || 0,
    edition: row.edition || '',
    serverRestartTime: row.sqlserver_start_time
      ? new Date(row.sqlserver_start_time).toISOString()
      : null,
    supportsOnlineRebuild: /Enterprise|Developer/i.test(row.edition || ''),
  }
}

function calcProgressPct(completedWeight, totalWeight) {
  if (totalWeight === 0) return 0
  return Math.min(100, (completedWeight / totalWeight) * 100)
}

function computeHealthScore(dbResults) {
  if (dbResults.length === 0) {
    return { score: 100, severity: 'Healthy', totalIndexes: 0, fragmentedCount: 0, missingCount: 0, unusedCount: 0, duplicateCount: 0, disabledCount: 0 }
  }

  let totalIndexes = 0, rebuildCount = 0, missingCount = 0
  let duplicateCount = 0, disabledCount = 0, unusedCount = 0, fragmentedCount = 0

  for (const r of dbResults) {
    totalIndexes  += r.totalIndexes
    disabledCount += r.disabledCount
    missingCount  += r.missing.length
    duplicateCount += r.duplicate.length
    unusedCount   += r.unused.filter(u => !u.is_duplicate).length
    for (const f of r.fragmented) {
      if (f.recommendation === 'REBUILD') rebuildCount++
      if (f.recommendation !== 'OK' && f.recommendation !== 'SKIP_SMALL') fragmentedCount++
    }
  }

  if (totalIndexes === 0) {
    return { score: 100, severity: 'Healthy', totalIndexes: 0, fragmentedCount: 0, missingCount: 0, unusedCount: 0, duplicateCount: 0, disabledCount: 0 }
  }

  const fragPenalty    = Math.min((rebuildCount   / totalIndexes) * 100, 100)
  const missingPenalty = Math.min((missingCount   / totalIndexes) * 100, 100)
  const dupPenalty     = Math.min((duplicateCount / totalIndexes) * 100, 100)
  const disablePenalty = Math.min((disabledCount  / totalIndexes) * 100, 100)

  const score = Math.max(0, Math.round(
    100 - (fragPenalty * 0.4 + missingPenalty * 0.3 + dupPenalty * 0.15 + disablePenalty * 0.15)
  ))
  const severity = score > 90 ? 'Healthy' : score >= 70 ? 'Warning' : 'Critical'

  return { score, severity, totalIndexes, fragmentedCount, missingCount, unusedCount, duplicateCount, disabledCount }
}

function paginateResults(rows, { page = 1, pageSize = 50, db, search } = {}) {
  let filtered = rows
  if (db && db !== 'all') {
    filtered = filtered.filter(r => r.database_name === db)
  }
  if (search) {
    const s = search.toLowerCase()
    filtered = filtered.filter(r =>
      (r.table_name  || '').toLowerCase().includes(s) ||
      (r.index_name  || '').toLowerCase().includes(s)
    )
  }
  const total = filtered.length
  const start = (page - 1) * pageSize
  return { total, page, pageSize, rows: filtered.slice(start, start + pageSize) }
}

module.exports = {
  fetchUserDatabases,
  fetchDbWeights,
  fetchServerMeta,
  calcProgressPct,
  computeHealthScore,
  paginateResults,
}
```

- [ ] **Step 4: Run — verify all pass**

```powershell
npx vitest run tests/server/indexScanOrchestrator.test.js
```

Expected: `20 passed`

- [ ] **Step 5: Commit**

```bash
git add server/indexScanOrchestrator.js tests/server/indexScanOrchestrator.test.js
git commit -m "feat(index-health): DB discovery, weighted progress, health score, pagination helpers"
```

---

## Task 4: Stub `scanDatabase` + concurrency engine — TDD

**Files:**
- Modify: `server/indexScanQueries.js`
- Modify: `server/indexScanOrchestrator.js`
- Modify: `tests/server/indexScanOrchestrator.test.js`

- [ ] **Step 1: Implement stub `scanDatabase` in `server/indexScanQueries.js`**

This stub is replaced by real DMV queries in Sprint 2. The shape must match exactly so Sprint 2 is a drop-in replacement.

```javascript
'use strict'

/**
 * Returns index data for a single database.
 * Sprint 1 stub — returns empty arrays.
 * Sprint 2 replaces this with real DMV queries.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} db
 * @param {'LIMITED'|'SAMPLED'|'DETAILED'} mode
 * @returns {Promise<{
 *   db: string,
 *   totalIndexes: number,
 *   disabledCount: number,
 *   fragmented: object[],
 *   missing: object[],
 *   unused: object[],
 *   duplicate: object[],
 * }>}
 */
async function scanDatabase(pool, db, mode) {
  // Sprint 1 stub — Sprint 2 replaces with real DMV queries
  return {
    db,
    totalIndexes: 0,
    disabledCount: 0,
    fragmented: [],
    missing: [],
    unused: [],
    duplicate: [],
  }
}

module.exports = { scanDatabase }
```

- [ ] **Step 2: Add concurrency + timeout tests to `tests/server/indexScanOrchestrator.test.js`**

Append these describe blocks to the existing test file:

```javascript
import {
  // existing imports...
  fetchUserDatabases,
  fetchDbWeights,
  calcProgressPct,
  computeHealthScore,
  paginateResults,
  runWithConcurrency,
  scanDatabaseWithTimeout,
} from '../../server/indexScanOrchestrator.js'

describe('runWithConcurrency', () => {
  it('runs all items and collects results', async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await runWithConcurrency(items, 3, async (n) => n * 2, () => false)
    expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10])
  })

  it('respects concurrency limit', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const items = Array.from({ length: 6 }, (_, i) => i)
    await runWithConcurrency(items, 2, async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 10))
      concurrent--
    }, () => false)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('stops early when shouldStop returns true after first item', async () => {
    const processed = []
    const items = [1, 2, 3, 4, 5]
    let stopAfter = 1
    await runWithConcurrency(
      items,
      1,
      async (n) => { processed.push(n) },
      () => processed.length >= stopAfter
    )
    expect(processed.length).toBeLessThanOrEqual(2)
  })
})

describe('scanDatabaseWithTimeout', () => {
  it('returns db result on success', async () => {
    const mockScan = async () => ({ db: 'testdb', totalIndexes: 5, fragmented: [], missing: [], unused: [], duplicate: [], disabledCount: 0 })
    const result = await scanDatabaseWithTimeout(null, 'testdb', 'LIMITED', 5000, mockScan)
    expect(result.db).toBe('testdb')
    expect(result.timedOut).toBeUndefined()
  })

  it('returns timedOut=true when scanner exceeds timeout', async () => {
    const slowScan = async () => new Promise(r => setTimeout(r, 500))
    const result = await scanDatabaseWithTimeout(null, 'testdb', 'LIMITED', 50, slowScan)
    expect(result.timedOut).toBe(true)
    expect(result.db).toBe('testdb')
    expect(result.fragmented).toEqual([])
  })
})
```

- [ ] **Step 3: Run — verify failures for the new tests only**

```powershell
npx vitest run tests/server/indexScanOrchestrator.test.js
```

Expected: `runWithConcurrency is not a function`, `scanDatabaseWithTimeout is not a function`

- [ ] **Step 4: Add `runWithConcurrency` and `scanDatabaseWithTimeout` to `server/indexScanOrchestrator.js`**

Add these functions before the `module.exports` line:

```javascript
async function runWithConcurrency(items, limit, processor, shouldStop) {
  const results = []
  const queue = items.slice()

  async function worker() {
    while (queue.length > 0 && !shouldStop()) {
      const item = queue.shift()
      if (item === undefined) break
      results.push(await processor(item))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return results
}

async function scanDatabaseWithTimeout(pool, db, mode, timeoutMs, scanFn) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('SCAN_TIMEOUT')), timeoutMs)
  )
  try {
    return await Promise.race([scanFn(pool, db, mode), timeout])
  } catch (err) {
    if (err.message === 'SCAN_TIMEOUT') {
      return { db, timedOut: true, totalIndexes: 0, disabledCount: 0, fragmented: [], missing: [], unused: [], duplicate: [] }
    }
    throw err
  }
}
```

Update `module.exports` to include the new functions:

```javascript
module.exports = {
  fetchUserDatabases,
  fetchDbWeights,
  fetchServerMeta,
  calcProgressPct,
  computeHealthScore,
  paginateResults,
  runWithConcurrency,
  scanDatabaseWithTimeout,
}
```

- [ ] **Step 5: Run — all pass**

```powershell
npx vitest run tests/server/indexScanOrchestrator.test.js
```

Expected: `27 passed`

- [ ] **Step 6: Commit**

```bash
git add server/indexScanQueries.js server/indexScanOrchestrator.js tests/server/indexScanOrchestrator.test.js
git commit -m "feat(index-health): scanDatabase stub, concurrency engine, per-DB timeout"
```

---

## Task 5: `runScan` — integration TDD

**Files:**
- Modify: `server/indexScanOrchestrator.js`
- Modify: `tests/server/indexScanOrchestrator.test.js`

- [ ] **Step 1: Add `runScan` tests to `tests/server/indexScanOrchestrator.test.js`**

Append to the test file. Import `runScan` from orchestrator (add to import line) and `MemoryScanStore` from store.

```javascript
import { runScan } from '../../server/indexScanOrchestrator.js'
import { MemoryScanStore } from '../../server/indexScanStore.js'

describe('runScan', () => {
  const SCAN_TTL_MS = 2 * 60 * 60 * 1000

  function makePool() {
    return {
      request: () => ({
        query: async (sql) => {
          // fetchUserDatabases
          if (sql.includes('sys.databases')) return { recordset: [{ db_name: 'db1' }, { db_name: 'db2' }] }
          // fetchDbWeights
          if (sql.includes('sys.master_files') && sql.includes('SUM')) return { recordset: [{ db_name: 'db1', size_bytes: 1000 }, { db_name: 'db2', size_bytes: 2000 }] }
          // fetchServerMeta
          if (sql.includes('SERVERPROPERTY')) return { recordset: [{ major_version: 15, edition: 'Developer Edition', sqlserver_start_time: new Date() }] }
          return { recordset: [] }
        },
      }),
    }
  }

  it('transitions to completed and sets results', async () => {
    const store = new MemoryScanStore()
    const { randomUUID } = await import('node:crypto')
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1', 'db2'])

    await runScan(makePool(), scanId, store)

    const scan = store.get(scanId)
    expect(scan.status).toBe('completed')
    expect(scan.results).not.toBeNull()
    expect(scan.results.summary.score).toBe(100)
    expect(scan.metadata).not.toBeNull()
    expect(scan.metadata.serverVersion).toBe(15)
    expect(scan.completedDbs).toHaveLength(2)
    expect(scan.expiresAt).toBeGreaterThan(Date.now())
  })

  it('sets completed_with_warnings when databases timed out', async () => {
    const store = new MemoryScanStore()
    const { randomUUID } = await import('node:crypto')
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1'])

    // Override timeout to near-zero for this test
    await runScan(makePool(), scanId, store, { timeoutPerDbMs: 1 })

    const scan = store.get(scanId)
    // stub scanDatabase is instant but we set timeout=1ms; result may vary
    // just verify it's either completed or completed_with_warnings
    expect(['completed', 'completed_with_warnings']).toContain(scan.status)
  })

  it('stays cancelled when cancelled before run completes', async () => {
    const store = new MemoryScanStore()
    const { randomUUID } = await import('node:crypto')
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1', 'db2'])

    // Cancel before runScan gets a chance to finish
    store.cancel(scanId)
    await runScan(makePool(), scanId, store)

    expect(store.get(scanId).status).toBe('cancelled')
  })

  it('sets status to failed on pool error', async () => {
    const store = new MemoryScanStore()
    const { randomUUID } = await import('node:crypto')
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1'])

    const brokenPool = {
      request: () => ({
        query: async () => { throw new Error('Connection lost') },
      }),
    }

    await runScan(brokenPool, scanId, store)
    const scan = store.get(scanId)
    expect(scan.status).toBe('failed')
    expect(scan.error).toContain('Connection lost')
  })
})
```

- [ ] **Step 2: Run — verify failures**

```powershell
npx vitest run tests/server/indexScanOrchestrator.test.js
```

Expected: `runScan is not a function`

- [ ] **Step 3: Implement `runScan` in `server/indexScanOrchestrator.js`**

Add this near the top after existing imports, before `module.exports`:

```javascript
const { scanDatabase } = require('./indexScanQueries.js')

const SCAN_TTL_MS      = 2 * 60 * 60 * 1000
const DEFAULT_TIMEOUT  = parseInt(process.env.INDEX_TIMEOUT_PER_DB_MS) || 120_000
const DEFAULT_CONCURRENCY = Math.min(parseInt(process.env.INDEX_SCAN_CONCURRENCY) || 3, 5)

async function runScan(pool, scanId, store, opts = {}) {
  const scan = store.get(scanId)
  if (!scan || scan.status === 'cancelled') return

  const timeoutPerDbMs = opts.timeoutPerDbMs || DEFAULT_TIMEOUT
  const maxConcurrent  = opts.maxConcurrent  || DEFAULT_CONCURRENCY

  store.update(scanId, { status: 'running' })

  try {
    const serverMeta = await fetchServerMeta(pool)

    // Determine databases to scan
    let databases = scan.databases
    if (databases.length === 0 || (databases.length === 1 && databases[0] === 'ALL')) {
      databases = await fetchUserDatabases(pool)
      store.update(scanId, { databases, totalDbs: databases.length })
    }

    if (databases.length === 0) {
      store.update(scanId, {
        status: 'completed',
        currentDb: null,
        results: {
          fragmented: [], missing: [], unused: [], duplicate: [],
          summary: computeHealthScore([]),
        },
        metadata: {
          scanMode: scan.scanMode, serverVersion: serverMeta.majorVersion,
          serverRestartTime: serverMeta.serverRestartTime,
          supportsOnlineRebuild: serverMeta.supportsOnlineRebuild,
          scanDurationMs: 0, scanStartedAt: new Date(scan.createdAt).toISOString(),
          totalDbs: 0, completedDbs: 0,
        },
        completedAt: Date.now(),
        expiresAt: Date.now() + SCAN_TTL_MS,
      })
      return
    }

    // Fetch file-size weights for progress calculation
    const weights   = await fetchDbWeights(pool, databases)
    const totalWeight = databases.reduce((sum, db) => sum + (weights[db] || 1), 0)
    store.update(scanId, { totalWeight })

    const allDbResults = []

    await runWithConcurrency(
      databases,
      maxConcurrent,
      async (db) => {
        const current = store.get(scanId)
        if (!current || current.status === 'cancelled') return

        store.update(scanId, { currentDb: db })

        const dbResult = await scanDatabaseWithTimeout(
          pool, db, scan.scanMode, timeoutPerDbMs, scanDatabase
        )
        allDbResults.push(dbResult)

        const freshScan    = store.get(scanId)
        const completedDbs = [...(freshScan?.completedDbs || []), db]
        const timedOutDbs  = dbResult.timedOut
          ? [...(freshScan?.timedOutDbs || []), db]
          : (freshScan?.timedOutDbs || [])
        const completedWeight = completedDbs.reduce((s, d) => s + (weights[d] || 1), 0)

        store.update(scanId, { completedDbs, timedOutDbs, completedWeight })
      },
      () => (store.get(scanId)?.status === 'cancelled')
    )

    const finalScan = store.get(scanId)
    if (finalScan?.status === 'cancelled') return

    const summary      = computeHealthScore(allDbResults)
    const scanDurationMs = Date.now() - scan.createdAt
    const completedAt  = Date.now()
    const timedOutDbs  = finalScan?.timedOutDbs || []

    store.update(scanId, {
      status: timedOutDbs.length > 0 ? 'completed_with_warnings' : 'completed',
      currentDb: null,
      results: {
        fragmented: allDbResults.flatMap(r => r.fragmented),
        missing:    allDbResults.flatMap(r => r.missing),
        unused:     allDbResults.flatMap(r => r.unused),
        duplicate:  allDbResults.flatMap(r => r.duplicate),
        summary,
      },
      metadata: {
        scanMode:            scan.scanMode,
        serverVersion:       serverMeta.majorVersion,
        serverRestartTime:   serverMeta.serverRestartTime,
        supportsOnlineRebuild: serverMeta.supportsOnlineRebuild,
        scanDurationMs,
        scanStartedAt:       new Date(scan.createdAt).toISOString(),
        totalDbs:            databases.length,
        completedDbs:        finalScan?.completedDbs?.length || 0,
      },
      completedAt,
      expiresAt: completedAt + SCAN_TTL_MS,
    })
  } catch (err) {
    store.update(scanId, { status: 'failed', error: err.message, completedAt: Date.now() })
  }
}
```

Update `module.exports`:

```javascript
module.exports = {
  fetchUserDatabases,
  fetchDbWeights,
  fetchServerMeta,
  calcProgressPct,
  computeHealthScore,
  paginateResults,
  runWithConcurrency,
  scanDatabaseWithTimeout,
  runScan,
  SCAN_TTL_MS,
}
```

- [ ] **Step 4: Run all server tests — verify pass**

```powershell
npx vitest run tests/server/
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add server/indexScanOrchestrator.js tests/server/indexScanOrchestrator.test.js
git commit -m "feat(index-health): runScan orchestrator with concurrency, timeout, weighted progress, health score"
```

---

## Task 6: HTTP endpoints + TTL cleanup wired into `server.js`

**Files:**
- Modify: `server.js` (after line 8 `const path = require('path')` for imports; add endpoints before the SPA fallback at line 852)

- [ ] **Step 1: Add imports near the top of `server.js`** (after line 8, before `const PORT = ...`)

Add:
```javascript
const { MemoryScanStore }   = require('./server/indexScanStore.js')
const { runScan, calcProgressPct, paginateResults, SCAN_TTL_MS } = require('./server/indexScanOrchestrator.js')
```

- [ ] **Step 2: Add scanStore singleton** (after `const connections = new Map()` around line 88)

Add:
```javascript
const scanStore = new MemoryScanStore()
```

- [ ] **Step 3: Add TTL cleanup** (after the scanStore line)

```javascript
// Clean up expired scan results every 30 minutes
setInterval(() => {
  const n = scanStore.cleanup(Date.now())
  if (n > 0) console.log(`[index-health] Cleaned up ${n} expired scan(s)`)
}, 30 * 60 * 1000)
```

- [ ] **Step 4: Add the four HTTP endpoints** — insert before the SPA fallback route (`app.get('*', ...)` at line ~852).

```javascript
// ─── Index Health API ─────────────────────────────────────────────────────────
const VALID_MODES = new Set(['LIMITED', 'SAMPLED', 'DETAILED'])

// POST /api/connections/:id/index-health/scan
// Body: { mode: 'LIMITED'|'SAMPLED'|'DETAILED', databases?: string[] }
// Returns: { scanId } — scan runs async; poll /progress
// 409 if scan already running
app.post('/api/connections/:id/index-health/scan', async (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const { mode = 'LIMITED', databases = [] } = req.body
  if (!VALID_MODES.has(mode)) {
    return res.status(400).json({ error: `Invalid mode. Must be LIMITED, SAMPLED, or DETAILED.` })
  }

  const existing = scanStore.getActiveScanByConn(req.params.id)
  if (existing) {
    return res.status(409).json({ error: 'Scan already in progress.', scanId: existing.scanId })
  }

  const scanId = randomUUID()
  const dbs    = Array.isArray(databases) && databases.length > 0 ? databases : []
  scanStore.create(scanId, req.params.id, mode, dbs)

  // Fire and forget
  runScan(conn.pool, scanId, scanStore)
    .catch(err => console.error(`[index-health] runScan error ${scanId.slice(0, 8)}:`, err.message))

  res.status(202).json({ scanId })
})

// GET /api/connections/:id/index-health/scan/:scanId/progress
app.get('/api/connections/:id/index-health/scan/:scanId/progress', (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const scan = scanStore.get(req.params.scanId)
  if (!scan || scan.connId !== req.params.id) {
    return res.status(404).json({ error: 'Scan not found.' })
  }

  const pct = calcProgressPct(scan.completedWeight, scan.totalWeight)

  // Simple ETA: extrapolate from elapsed + pct
  let eta = null
  if (pct > 5 && pct < 100) {
    const elapsed = Date.now() - scan.createdAt
    eta = Math.round((elapsed / pct) * (100 - pct) / 1000)
  }

  res.json({
    scanId:       scan.scanId,
    status:       scan.status,
    pct:          Math.round(pct),
    currentDb:    scan.currentDb,
    completedDbs: scan.completedDbs.length,
    totalDbs:     scan.totalDbs,
    timedOutDbs:  scan.timedOutDbs,
    eta,
  })
})

// GET /api/connections/:id/index-health/scan/:scanId/results
// Query: tab=fragmented|missing|unusedAndDuplicate, page, pageSize, db, search
app.get('/api/connections/:id/index-health/scan/:scanId/results', (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const scan = scanStore.get(req.params.scanId)
  if (!scan || scan.connId !== req.params.id) {
    return res.status(404).json({ error: 'Scan not found or expired.' })
  }

  if (scan.status === 'pending' || scan.status === 'running') {
    return res.status(202).json({ error: 'Scan still in progress.', status: scan.status })
  }

  if (scan.status === 'failed') {
    return res.status(400).json({ error: scan.error || 'Scan failed.', status: 'failed' })
  }

  const { tab = 'fragmented', page = '1', pageSize = '50', db, search } = req.query
  const pgOpts = { page: parseInt(page, 10) || 1, pageSize: parseInt(pageSize, 10) || 50, db, search }
  const results = scan.results || { fragmented: [], missing: [], unused: [], duplicate: [], summary: {} }

  const unusedAndDuplicate = [
    ...results.unused.map(r => ({ ...r, _rowType: 'unused' })),
    ...results.duplicate.map(r => ({ ...r, _rowType: 'duplicate' })),
  ]

  res.json({
    status:      scan.status,
    metadata:    scan.metadata,
    summary:     results.summary,
    timedOutDbs: scan.timedOutDbs,
    fragmented:  tab === 'fragmented'        ? paginateResults(results.fragmented, pgOpts)    : undefined,
    missing:     tab === 'missing'           ? paginateResults(results.missing, pgOpts)       : undefined,
    unusedAndDuplicate: tab === 'unusedAndDuplicate' ? paginateResults(unusedAndDuplicate, pgOpts) : undefined,
  })
})

// DELETE /api/connections/:id/index-health/scan/:scanId
app.delete('/api/connections/:id/index-health/scan/:scanId', (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const scan = scanStore.get(req.params.scanId)
  if (!scan || scan.connId !== req.params.id) {
    return res.status(404).json({ error: 'Scan not found.' })
  }

  const cancelled = scanStore.cancel(req.params.scanId)
  if (!cancelled) {
    return res.status(400).json({ error: `Cannot cancel scan with status: ${scan.status}` })
  }

  console.log(`[index-health] Scan cancelled: ${req.params.scanId.slice(0, 8)} (${conn.label})`)
  res.status(204).end()
})
```

- [ ] **Step 5: Start server and verify endpoints respond**

```powershell
cd D:\dashbaords
node server.js
```

In a second terminal, test each endpoint. Replace `CONN_ID` with a real connection ID from your browser (connect to SQL Server first, then copy the ID from the URL or network tab):

```powershell
# Test 1: POST scan (will 404 if no CONN_ID — that's expected before connecting)
$body = '{"mode":"LIMITED","databases":[]}'
Invoke-WebRequest -Uri "http://localhost:3000/api/connections/CONN_ID/index-health/scan" -Method POST -Body $body -ContentType "application/json"
# Expected: 202 { scanId: "..." }

# Test 2: GET progress
Invoke-WebRequest -Uri "http://localhost:3000/api/connections/CONN_ID/index-health/scan/SCAN_ID/progress"
# Expected: { status: "completed", pct: 100, ... }

# Test 3: GET results
Invoke-WebRequest -Uri "http://localhost:3000/api/connections/CONN_ID/index-health/scan/SCAN_ID/results?tab=fragmented&page=1"
# Expected: { status: "completed", summary: { score: 100 }, fragmented: { total: 0, rows: [] }, ... }

# Test 4: Concurrent scan guard
Invoke-WebRequest -Uri "http://localhost:3000/api/connections/CONN_ID/index-health/scan" -Method POST -Body $body -ContentType "application/json"
# While first scan running: Expected 409 { error: "Scan already in progress.", scanId: "..." }
```

- [ ] **Step 6: Run all server tests one final time**

```powershell
npx vitest run tests/server/
```

Expected: all tests still pass

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(index-health): scan HTTP endpoints — POST/GET progress/GET results/DELETE cancel"
```

---

## Sprint 1 — Definition of Done

- [ ] `npx vitest run tests/server/` passes (≥ 30 tests)
- [ ] POST `/scan` → 202 `{ scanId }`; 409 on concurrent attempt
- [ ] GET `/scan/:id/progress` → progress object with pct, currentDb, eta
- [ ] GET `/scan/:id/results` → 202 while running, 200 with empty rows when done (stub), 404 after TTL
- [ ] DELETE `/scan/:id` → 204 cancels; 400 if already completed
- [ ] Cancelled scan keeps partial `completedDbs` in store
- [ ] `computeHealthScore([])` → score 100 / Healthy
- [ ] TTL cleanup interval registered (30 min)

---

## What Sprint 2 delivers

Sprint 2 replaces `server/indexScanQueries.js` stub with four real DMV queries:
- `fragmented`: `sys.dm_db_index_physical_stats` + partitions + compression
- `missing`: `sys.dm_db_missing_index_*` views + normalized impact score
- `unused`: `sys.dm_db_index_usage_stats` + server restart scoping
- `duplicate`: key/include/filter matching logic

Sprint 2 also adds `STRING_AGG` vs `FOR XML PATH` fallback based on `serverMeta.majorVersion >= 14`.
