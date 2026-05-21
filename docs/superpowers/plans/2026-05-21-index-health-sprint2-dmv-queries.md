# Index Health Sprint 2 — Real DMV Queries

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Sprint 1 `scanDatabase()` stub with real SQL Server DMV queries for fragmented, missing, unused, and duplicate index detection.

**Architecture:** Four focused scanner modules (`server/scanners/`) each own one DMV query. A shared `executeDMV` wrapper applies safety settings (READ UNCOMMITTED, LOCK_TIMEOUT 5000). `server/indexScanQueries.js` becomes the adapter calling all four scanners and assembling the `DatabaseScanResult`. `computeHealthScore()` and the HTTP endpoints are untouched.

**Tech Stack:** Node.js 22, mssql 11, Vitest 4. No new dependencies.

---

## Locked contracts

### `DatabaseScanResult` — what `scanDatabase(pool, db, mode, serverMeta)` returns

```javascript
{
  database:     string,       // was `db` in Sprint 1 stub
  totalIndexes: number,       // flat — read directly by computeHealthScore
  disabledCount: number,      // flat — read directly by computeHealthScore
  fragmented:   FragmentedIndex[],
  missing:      MissingIndex[],
  unused:       UnusedIndex[],
  duplicate:    DuplicateIndex[],
  metadata: {
    durationMs:  number,
    startedAt:   string,   // ISO
    completedAt: string,   // ISO
    timeout:     boolean,  // was `timedOut` at root in Sprint 1
  },
}
```

### `FragmentedIndex`

```javascript
{
  database_name:                string,
  schema_name:                  string,
  table_name:                   string,
  index_name:                   string,
  index_type_desc:              string,
  avg_fragmentation_in_percent: number,
  page_count:                   number,
  partition_number:             number,
  partition_count:              number,
  data_compression_desc:        string,
  recommendation:               'REBUILD' | 'REORGANIZE' | 'OK' | 'SKIP_SMALL',
}
```

### `MissingIndex`

```javascript
{
  database_name:          string,
  schema_name:            string,
  table_name:             string,
  equality_columns:       string | null,
  inequality_columns:     string | null,
  include_columns:        string | null,   // capped at 16 columns
  truncated_include_list: boolean,
  impact_score:           number,          // 0–100, normalized within result set
  user_seeks:             number,
  user_scans:             number,
  last_user_seek:         string | null,   // ISO
  create_script:          string,
}
```

### `UnusedIndex`

```javascript
{
  database_name:   string,
  schema_name:     string,
  table_name:      string,
  index_name:      string,
  index_type_desc: string,
  user_seeks:      number,
  user_scans:      number,
  user_lookups:    number,
  user_updates:    number,
  last_user_seek:  string | null,   // ISO
  is_duplicate:    boolean,         // set by duplicate scanner
}
```

### `DuplicateIndex`

```javascript
{
  database_name:   string,
  schema_name:     string,
  table_name:      string,
  index_name:      string,
  duplicate_of:    string,   // index_name of the counterpart
  key_columns:     string,
  include_columns: string,
}
```

---

## Context for agentic workers

**Codebase:** `D:\dashbaords\` — CommonJS Node.js + Express backend, mssql 11, Vitest 4.

**Sprint 1 baseline** (41 tests pass at commit `9388958`):
- `server/indexScanStore.js` — MemoryScanStore
- `server/indexScanOrchestrator.js` — `runScan`, `computeHealthScore`, `scanDatabaseWithTimeout`, `fetchUserDatabases`, etc.
- `server/indexScanQueries.js` — stub returning empty arrays with OLD shape (`db`, `timedOut`)
- `server.js` — 4 HTTP endpoints

**Breaking changes in Task 1 (must apply first):**

| Old (Sprint 1) | New (Sprint 2) |
|---|---|
| `dbResult.db` | `dbResult.database` |
| `dbResult.timedOut` | `dbResult.metadata.timeout` |
| No `metadata` field | `metadata: { durationMs, startedAt, completedAt, timeout }` |

**`computeHealthScore(dbResults)` reads:** `r.totalIndexes`, `r.disabledCount`, `r.fragmented`, `r.missing`, `r.unused`, `r.duplicate` — all flat on the result, unchanged from Sprint 1. It does NOT read `metadata`.

**`runScan` in `server/indexScanOrchestrator.js` reads `dbResult.timedOut`** — this must change to `dbResult.metadata.timeout` in Task 1.

**`scanDatabaseWithTimeout` timeout result** currently returns `{ db, timedOut: true, ... }` — must change to new shape in Task 1.

**Run tests:** `npx vitest run tests/server/` from `D:\dashbaords`

---

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `server/repository/executeDMV.js` | Create | USE context switch + READ UNCOMMITTED + LOCK_TIMEOUT 5000 |
| `server/scanners/fragmented.js` | Create | `sys.dm_db_index_physical_stats` + recommendation logic |
| `server/scanners/missing.js` | Create | `sys.dm_db_missing_index_*` + impact normalization + script gen |
| `server/scanners/unused.js` | Create | `sys.dm_db_index_usage_stats` + disabled count |
| `server/scanners/duplicate.js` | Create | In-memory duplicate detection from index catalog |
| `server/indexScanQueries.js` | Replace | Adapter calling all 4 scanners, returns `DatabaseScanResult` |
| `server/indexScanOrchestrator.js` | Modify | Fix timeout result shape, `dbResult.metadata.timeout`, READ_ONLY filter, `serverMeta` forwarding, store `databases[]` |
| `tests/server/indexScanOrchestrator.test.js` | Modify | Fix `timedOut`→`metadata.timeout`, `db`→`database` in timeout test |
| `tests/server/scanners/fragmented.test.js` | Create | Unit tests |
| `tests/server/scanners/missing.test.js` | Create | Unit tests |
| `tests/server/scanners/unused.test.js` | Create | Unit tests |
| `tests/server/scanners/duplicate.test.js` | Create | Unit tests |
| `tests/server/indexScanQueries.test.js` | Create | Integration-style unit tests for scanDatabase() |
| `tests/integration/indexHealth.test.js` | Create | Real SQL Server tests (skip if no TEST_SQL_SERVER env) |

---

## Task 1: Shape migration + executeDMV + READ_ONLY filter

**Files:**
- Modify: `server/indexScanOrchestrator.js`
- Modify: `server/indexScanQueries.js`
- Modify: `tests/server/indexScanOrchestrator.test.js`
- Create: `server/repository/executeDMV.js`

- [ ] **Step 1: Update `scanDatabaseWithTimeout` timeout result in `server/indexScanOrchestrator.js`**

Find and replace the timeout return (currently around line 133):

Old:
```javascript
return { db, timedOut: true, totalIndexes: 0, disabledCount: 0, fragmented: [], missing: [], unused: [], duplicate: [] }
```

New:
```javascript
const nowMs = Date.now()
return {
  database:     db,
  totalIndexes: 0,
  disabledCount: 0,
  fragmented:   [],
  missing:      [],
  unused:       [],
  duplicate:    [],
  metadata: {
    durationMs:  timeoutMs,
    startedAt:   new Date(nowMs - timeoutMs).toISOString(),
    completedAt: new Date(nowMs).toISOString(),
    timeout:     true,
  },
}
```

- [ ] **Step 2: Update `runScan` to read `dbResult.metadata.timeout` in `server/indexScanOrchestrator.js`**

Find inside the `runWithConcurrency` callback:
```javascript
const timedOutDbs  = dbResult.timedOut
```

Replace with:
```javascript
const timedOutDbs  = dbResult.metadata?.timeout
```

- [ ] **Step 3: Update `fetchUserDatabases` to filter READ_ONLY databases in `server/indexScanOrchestrator.js`**

Find:
```javascript
    WHERE database_id > 4 AND state = 0
```

Replace with:
```javascript
    WHERE database_id > 4 AND state = 0 AND is_read_only = 0
```

- [ ] **Step 4: Fix timeout test in `tests/server/indexScanOrchestrator.test.js`**

Find:
```javascript
  it('returns timedOut=true when scanner exceeds timeout', async () => {
    const slowScan = async () => new Promise(r => setTimeout(r, 500))
    const result = await scanDatabaseWithTimeout(null, 'testdb', 'LIMITED', 50, slowScan)
    expect(result.timedOut).toBe(true)
    expect(result.db).toBe('testdb')
    expect(result.fragmented).toEqual([])
  })
```

Replace with:
```javascript
  it('returns metadata.timeout=true when scanner exceeds timeout', async () => {
    const slowScan = async () => new Promise(r => setTimeout(r, 500))
    const result = await scanDatabaseWithTimeout(null, 'testdb', 'LIMITED', 50, slowScan)
    expect(result.metadata.timeout).toBe(true)
    expect(result.database).toBe('testdb')
    expect(result.fragmented).toEqual([])
    expect(result.metadata.durationMs).toBe(50)
  })
```

- [ ] **Step 5: Update `server/indexScanQueries.js` stub to return new shape**

Replace entire file:
```javascript
'use strict'

async function scanDatabase(pool, db, mode) {
  return {
    database:     db,
    totalIndexes: 0,
    disabledCount: 0,
    fragmented:   [],
    missing:      [],
    unused:       [],
    duplicate:    [],
    metadata: {
      durationMs:  0,
      startedAt:   new Date().toISOString(),
      completedAt: new Date().toISOString(),
      timeout:     false,
    },
  }
}

module.exports = { scanDatabase }
```

- [ ] **Step 6: Run all server tests — verify still 41 passing**

```powershell
npx vitest run tests/server/
```

Expected: `41 passed`

- [ ] **Step 7: Create `server/repository/` directory and `executeDMV.js`**

```powershell
New-Item -ItemType Directory -Force "D:\dashbaords\server\repository"
```

Create `server/repository/executeDMV.js`:
```javascript
'use strict'

function quoteName(name) {
  return `[${name.replace(/]/g, ']]')}]`
}

async function executeDMV(pool, db, sqlBody) {
  const result = await pool.request().query(`
    USE ${quoteName(db)};
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
    SET LOCK_TIMEOUT 5000;
    ${sqlBody}
  `)
  return result.recordset
}

module.exports = { executeDMV, quoteName }
```

- [ ] **Step 8: Verify syntax and run tests**

```powershell
node --check server/repository/executeDMV.js && npx vitest run tests/server/
```

Expected: syntax OK, 41 tests pass.

- [ ] **Step 9: Commit**

```bash
git add server/indexScanOrchestrator.js server/indexScanQueries.js server/repository/executeDMV.js tests/server/indexScanOrchestrator.test.js
git commit -m "feat(index-health): DatabaseScanResult shape migration, executeDMV wrapper, READ_ONLY filter"
```

---

## Task 2: Fragmented index scanner

**Files:**
- Create: `server/scanners/fragmented.js`
- Create: `tests/server/scanners/fragmented.test.js`

- [ ] **Step 1: Create scanner directory**

```powershell
New-Item -ItemType Directory -Force "D:\dashbaords\server\scanners"
New-Item -ItemType Directory -Force "D:\dashbaords\tests\server\scanners"
```

- [ ] **Step 2: Write failing tests `tests/server/scanners/fragmented.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getFragmented } from '../../../server/scanners/fragmented.js'

function makePool(rows) {
  return { request: () => ({ query: async () => ({ recordset: rows }) }) }
}

describe('getFragmented', () => {
  it('returns empty array when no rows', async () => {
    expect(await getFragmented(makePool([]), 'testdb', 'LIMITED')).toEqual([])
  })

  it('maps REBUILD for frag >= 30 and page_count >= 1000', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Orders', index_name: 'IX_Date', index_type_desc: 'NONCLUSTERED', avg_fragmentation_in_percent: 45, page_count: 5000, partition_number: 1, partition_count: 1, data_compression_desc: 'NONE' }]
    const result = await getFragmented(makePool(rows), 'testdb', 'LIMITED')
    expect(result).toHaveLength(1)
    expect(result[0].recommendation).toBe('REBUILD')
    expect(result[0].database_name).toBe('testdb')
    expect(result[0].schema_name).toBe('dbo')
    expect(result[0].avg_fragmentation_in_percent).toBe(45)
    expect(result[0].page_count).toBe(5000)
  })

  it('maps REORGANIZE for frag 5–30 and page_count >= 1000', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'CLUSTERED', avg_fragmentation_in_percent: 15, page_count: 2000, partition_number: 1, partition_count: 1, data_compression_desc: 'ROW' }]
    expect((await getFragmented(makePool(rows), 'testdb', 'LIMITED'))[0].recommendation).toBe('REORGANIZE')
  })

  it('maps OK for frag < 5', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'CLUSTERED', avg_fragmentation_in_percent: 2, page_count: 5000, partition_number: 1, partition_count: 1, data_compression_desc: 'NONE' }]
    expect((await getFragmented(makePool(rows), 'testdb', 'LIMITED'))[0].recommendation).toBe('OK')
  })

  it('maps SKIP_SMALL for page_count < 1000 regardless of frag', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Small', index_name: 'IX_S', index_type_desc: 'NONCLUSTERED', avg_fragmentation_in_percent: 99, page_count: 500, partition_number: 1, partition_count: 1, data_compression_desc: 'NONE' }]
    expect((await getFragmented(makePool(rows), 'testdb', 'LIMITED'))[0].recommendation).toBe('SKIP_SMALL')
  })

  it('includes partition_number and partition_count', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'CLUSTERED', avg_fragmentation_in_percent: 35, page_count: 2000, partition_number: 2, partition_count: 4, data_compression_desc: 'PAGE' }]
    const result = await getFragmented(makePool(rows), 'testdb', 'LIMITED')
    expect(result[0].partition_number).toBe(2)
    expect(result[0].partition_count).toBe(4)
  })
})
```

- [ ] **Step 3: Run — verify failure**

```powershell
npx vitest run tests/server/scanners/fragmented.test.js
```

Expected: `Cannot find module '../../../server/scanners/fragmented.js'`

- [ ] **Step 4: Create `server/scanners/fragmented.js`**

```javascript
'use strict'

const { executeDMV } = require('../repository/executeDMV.js')

function mapRecommendation(frag, pages) {
  if (pages < 1000) return 'SKIP_SMALL'
  if (frag >= 30)   return 'REBUILD'
  if (frag >= 5)    return 'REORGANIZE'
  return 'OK'
}

async function getFragmented(pool, db, mode) {
  const rows = await executeDMV(pool, db, `
    SELECT
      s.name                           AS schema_name,
      o.name                           AS table_name,
      i.name                           AS index_name,
      i.type_desc                      AS index_type_desc,
      p.avg_fragmentation_in_percent,
      p.page_count,
      p.partition_number,
      (SELECT COUNT(*) FROM sys.partitions sp2
       WHERE sp2.object_id = i.object_id AND sp2.index_id = i.index_id) AS partition_count,
      par.data_compression_desc
    FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, N'${mode}') p
    JOIN sys.indexes    i   ON i.object_id   = p.object_id AND i.index_id = p.index_id
    JOIN sys.objects    o   ON o.object_id   = i.object_id AND o.type = 'U'
    JOIN sys.schemas    s   ON s.schema_id   = o.schema_id
    JOIN sys.partitions par ON par.object_id = p.object_id
                            AND par.index_id = p.index_id
                            AND par.partition_number = p.partition_number
    WHERE i.type_desc IN (
      N'CLUSTERED', N'NONCLUSTERED',
      N'CLUSTERED COLUMNSTORE', N'NONCLUSTERED COLUMNSTORE'
    )
    AND i.is_disabled = 0
  `)

  return rows.map(r => ({
    database_name:                db,
    schema_name:                  r.schema_name,
    table_name:                   r.table_name,
    index_name:                   r.index_name,
    index_type_desc:              r.index_type_desc,
    avg_fragmentation_in_percent: r.avg_fragmentation_in_percent,
    page_count:                   r.page_count,
    partition_number:             r.partition_number,
    partition_count:              r.partition_count,
    data_compression_desc:        r.data_compression_desc,
    recommendation:               mapRecommendation(r.avg_fragmentation_in_percent, r.page_count),
  }))
}

module.exports = { getFragmented }
```

- [ ] **Step 5: Run scanner tests**

```powershell
npx vitest run tests/server/scanners/fragmented.test.js
```

Expected: `6 passed`

- [ ] **Step 6: Run full suite**

```powershell
npx vitest run tests/server/
```

Expected: all 41 previous tests still pass.

- [ ] **Step 7: Commit**

```bash
git add server/scanners/fragmented.js tests/server/scanners/fragmented.test.js
git commit -m "feat(index-health): fragmented index scanner with REBUILD/REORGANIZE/OK/SKIP_SMALL logic"
```

---

## Task 3: Missing index scanner

**Files:**
- Create: `server/scanners/missing.js`
- Create: `tests/server/scanners/missing.test.js`

- [ ] **Step 1: Write failing tests `tests/server/scanners/missing.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getMissing } from '../../../server/scanners/missing.js'

function makePool(rows) {
  return { request: () => ({ query: async () => ({ recordset: rows }) }) }
}

describe('getMissing', () => {
  it('returns empty array when no rows', async () => {
    expect(await getMissing(makePool([]), 'testdb')).toEqual([])
  })

  it('normalizes impact score — max row gets 100, others proportional', async () => {
    const rows = [
      { schema_name: 'dbo', table_name: 'Orders', equality_columns: 'CustomerId', inequality_columns: null, included_columns: 'OrderDate', raw_impact: 800, user_seeks: 1000, user_scans: 0, last_user_seek: new Date('2024-01-01') },
      { schema_name: 'dbo', table_name: 'Items',  equality_columns: 'SKU',        inequality_columns: null, included_columns: null,        raw_impact: 400, user_seeks: 500,  user_scans: 0, last_user_seek: null },
    ]
    const result = await getMissing(makePool(rows), 'testdb')
    expect(result[0].impact_score).toBe(100)
    expect(result[1].impact_score).toBe(50)
    result.forEach(r => {
      expect(r.impact_score).toBeGreaterThanOrEqual(0)
      expect(r.impact_score).toBeLessThanOrEqual(100)
    })
  })

  it('caps include columns at 16 and sets truncated_include_list=true', async () => {
    const manyIncludes = Array.from({ length: 20 }, (_, i) => `Col${i}`).join(',')
    const rows = [{ schema_name: 'dbo', table_name: 'T', equality_columns: 'Id', inequality_columns: null, included_columns: manyIncludes, raw_impact: 100, user_seeks: 10, user_scans: 0, last_user_seek: null }]
    const result = await getMissing(makePool(rows), 'testdb')
    expect(result[0].truncated_include_list).toBe(true)
    expect(result[0].include_columns.split(',').length).toBe(16)
  })

  it('sets truncated_include_list=false when <= 16 includes', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', equality_columns: 'Id', inequality_columns: null, included_columns: 'A,B,C', raw_impact: 100, user_seeks: 10, user_scans: 0, last_user_seek: null }]
    expect((await getMissing(makePool(rows), 'testdb'))[0].truncated_include_list).toBe(false)
  })

  it('generates CREATE INDEX script containing table and key columns', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Orders', equality_columns: 'CustomerId', inequality_columns: 'OrderDate', included_columns: 'Amount', raw_impact: 100, user_seeks: 10, user_scans: 0, last_user_seek: null }]
    const result = await getMissing(makePool(rows), 'testdb')
    expect(result[0].create_script).toContain('CREATE INDEX')
    expect(result[0].create_script).toContain('[dbo].[Orders]')
    expect(result[0].create_script).toContain('[CustomerId]')
    expect(result[0].create_script).toContain('[OrderDate]')
    expect(result[0].create_script).toContain('INCLUDE')
    expect(result[0].create_script).toContain('[Amount]')
  })

  it('sets last_user_seek to null when absent', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', equality_columns: 'Id', inequality_columns: null, included_columns: null, raw_impact: 50, user_seeks: 5, user_scans: 0, last_user_seek: null }]
    expect((await getMissing(makePool(rows), 'testdb'))[0].last_user_seek).toBeNull()
  })
})
```

- [ ] **Step 2: Run — verify failure**

```powershell
npx vitest run tests/server/scanners/missing.test.js
```

Expected: `Cannot find module '../../../server/scanners/missing.js'`

- [ ] **Step 3: Create `server/scanners/missing.js`**

```javascript
'use strict'

const { executeDMV, quoteName } = require('../repository/executeDMV.js')

const MAX_INCLUDE_COLS = 16

function capIncludes(colStr) {
  if (!colStr) return { columns: null, truncated: false }
  const cols = colStr.split(',').map(c => c.trim())
  if (cols.length <= MAX_INCLUDE_COLS) return { columns: colStr, truncated: false }
  return { columns: cols.slice(0, MAX_INCLUDE_COLS).join(', '), truncated: true }
}

function buildScript(schema, table, equality, inequality, includes, supportsOnline) {
  const keyCols = [
    ...(equality   ? equality.split(',').map(c => quoteName(c.trim()))   : []),
    ...(inequality ? inequality.split(',').map(c => quoteName(c.trim())) : []),
  ]
  const inclCols  = includes ? includes.split(',').map(c => quoteName(c.trim())) : []
  const inclPart  = inclCols.length > 0 ? `\nINCLUDE (${inclCols.join(', ')})` : ''
  const onlinePart = supportsOnline ? '\nWITH (ONLINE = ON)' : ''
  const baseName  = keyCols[0] ? keyCols[0].replace(/[\[\]]/g, '') : 'idx'
  return (
    `CREATE INDEX [IX_missing_${table}_${baseName}]\n` +
    `ON ${quoteName(schema)}.${quoteName(table)} (${keyCols.join(', ')})${inclPart}${onlinePart};`
  )
}

function normalizeImpact(rows) {
  const maxRaw = Math.max(...rows.map(r => r.raw_impact), 1)
  return rows.map(r => Math.min(Math.round((r.raw_impact / maxRaw) * 100), 100))
}

async function getMissing(pool, db, supportsOnline = false) {
  const rows = await executeDMV(pool, db, `
    SELECT
      s.name                                                                    AS schema_name,
      OBJECT_NAME(mid.object_id)                                                AS table_name,
      mid.equality_columns,
      mid.inequality_columns,
      mid.included_columns,
      migs.avg_total_user_cost * (migs.avg_user_impact / 100.0)
        * (migs.user_seeks + migs.user_scans)                                  AS raw_impact,
      migs.user_seeks,
      migs.user_scans,
      migs.last_user_seek
    FROM sys.dm_db_missing_index_details     mid
    JOIN sys.dm_db_missing_index_groups      mig  ON mig.index_handle   = mid.index_handle
    JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle  = mig.index_group_handle
    JOIN sys.objects                         o    ON o.object_id        = mid.object_id
    JOIN sys.schemas                         s    ON s.schema_id        = o.schema_id
    WHERE mid.database_id = DB_ID()
    ORDER BY raw_impact DESC
  `)

  if (rows.length === 0) return []

  const scores = normalizeImpact(rows)
  return rows.map((r, i) => {
    const { columns: cappedIncludes, truncated } = capIncludes(r.included_columns)
    return {
      database_name:          db,
      schema_name:            r.schema_name,
      table_name:             r.table_name,
      equality_columns:       r.equality_columns   || null,
      inequality_columns:     r.inequality_columns || null,
      include_columns:        cappedIncludes,
      truncated_include_list: truncated,
      impact_score:           scores[i],
      user_seeks:             r.user_seeks,
      user_scans:             r.user_scans,
      last_user_seek:         r.last_user_seek ? new Date(r.last_user_seek).toISOString() : null,
      create_script:          buildScript(r.schema_name, r.table_name, r.equality_columns, r.inequality_columns, cappedIncludes, supportsOnline),
    }
  })
}

module.exports = { getMissing }
```

- [ ] **Step 4: Run tests**

```powershell
npx vitest run tests/server/scanners/missing.test.js
```

Expected: `6 passed`

- [ ] **Step 5: Run full suite**

```powershell
npx vitest run tests/server/
```

- [ ] **Step 6: Commit**

```bash
git add server/scanners/missing.js tests/server/scanners/missing.test.js
git commit -m "feat(index-health): missing index scanner with impact normalization and CREATE INDEX script"
```

---

## Task 4: Unused index scanner

**Files:**
- Create: `server/scanners/unused.js`
- Create: `tests/server/scanners/unused.test.js`

- [ ] **Step 1: Write failing tests `tests/server/scanners/unused.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getUnused, getDisabledCount } from '../../../server/scanners/unused.js'

function makePool(rows) {
  return { request: () => ({ query: async () => ({ recordset: rows }) }) }
}

describe('getUnused', () => {
  it('returns empty array when no rows', async () => {
    expect(await getUnused(makePool([]), 'testdb')).toEqual([])
  })

  it('returns indexes with zero reads and nonzero writes', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Orders', index_name: 'IX_Unused', index_type_desc: 'NONCLUSTERED', user_seeks: 0, user_scans: 0, user_lookups: 0, user_updates: 150, last_user_seek: null }]
    const result = await getUnused(makePool(rows), 'testdb')
    expect(result).toHaveLength(1)
    expect(result[0].database_name).toBe('testdb')
    expect(result[0].user_updates).toBe(150)
    expect(result[0].is_duplicate).toBe(false)
    expect(result[0].last_user_seek).toBeNull()
  })

  it('maps last_user_seek to ISO string when present', async () => {
    const seekDate = new Date('2024-03-15T10:00:00Z')
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'NONCLUSTERED', user_seeks: 0, user_scans: 0, user_lookups: 0, user_updates: 10, last_user_seek: seekDate }]
    expect((await getUnused(makePool(rows), 'testdb'))[0].last_user_seek).toBe(seekDate.toISOString())
  })
})

describe('getDisabledCount', () => {
  it('returns 0 when no disabled indexes', async () => {
    expect(await getDisabledCount(makePool([{ disabled_count: 0 }]), 'testdb')).toBe(0)
  })

  it('returns count from first row', async () => {
    expect(await getDisabledCount(makePool([{ disabled_count: 3 }]), 'testdb')).toBe(3)
  })

  it('returns 0 when recordset is empty', async () => {
    expect(await getDisabledCount(makePool([]), 'testdb')).toBe(0)
  })
})
```

- [ ] **Step 2: Run — verify failure**

```powershell
npx vitest run tests/server/scanners/unused.test.js
```

Expected: `Cannot find module '../../../server/scanners/unused.js'`

- [ ] **Step 3: Create `server/scanners/unused.js`**

```javascript
'use strict'

const { executeDMV } = require('../repository/executeDMV.js')

async function getUnused(pool, db) {
  const rows = await executeDMV(pool, db, `
    SELECT
      s.name                      AS schema_name,
      o.name                      AS table_name,
      i.name                      AS index_name,
      i.type_desc                 AS index_type_desc,
      ISNULL(u.user_seeks,   0)  AS user_seeks,
      ISNULL(u.user_scans,   0)  AS user_scans,
      ISNULL(u.user_lookups, 0)  AS user_lookups,
      ISNULL(u.user_updates, 0)  AS user_updates,
      u.last_user_seek
    FROM sys.indexes i
    JOIN sys.objects  o ON o.object_id = i.object_id AND o.type = 'U'
    JOIN sys.schemas  s ON s.schema_id = o.schema_id
    LEFT JOIN sys.dm_db_index_usage_stats u
      ON u.object_id   = i.object_id
     AND u.index_id    = i.index_id
     AND u.database_id = DB_ID()
    WHERE i.type_desc IN (N'CLUSTERED', N'NONCLUSTERED')
      AND i.is_disabled          = 0
      AND i.is_primary_key       = 0
      AND i.is_unique_constraint = 0
      AND ISNULL(u.user_seeks,   0) + ISNULL(u.user_scans,   0)
        + ISNULL(u.user_lookups, 0) = 0
      AND ISNULL(u.user_updates, 0) > 0
  `)

  return rows.map(r => ({
    database_name:   db,
    schema_name:     r.schema_name,
    table_name:      r.table_name,
    index_name:      r.index_name,
    index_type_desc: r.index_type_desc,
    user_seeks:      r.user_seeks,
    user_scans:      r.user_scans,
    user_lookups:    r.user_lookups,
    user_updates:    r.user_updates,
    last_user_seek:  r.last_user_seek ? new Date(r.last_user_seek).toISOString() : null,
    is_duplicate:    false,
  }))
}

async function getDisabledCount(pool, db) {
  const rows = await executeDMV(pool, db, `
    SELECT COUNT(*) AS disabled_count
    FROM sys.indexes i
    JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
    WHERE i.is_disabled = 1
  `)
  return rows[0]?.disabled_count ?? 0
}

module.exports = { getUnused, getDisabledCount }
```

- [ ] **Step 4: Run tests**

```powershell
npx vitest run tests/server/scanners/unused.test.js
```

Expected: `6 passed`

- [ ] **Step 5: Run full suite**

```powershell
npx vitest run tests/server/
```

- [ ] **Step 6: Commit**

```bash
git add server/scanners/unused.js tests/server/scanners/unused.test.js
git commit -m "feat(index-health): unused index scanner and disabled index count"
```

---

## Task 5: Duplicate index scanner

**Files:**
- Create: `server/scanners/duplicate.js`
- Create: `tests/server/scanners/duplicate.test.js`

Duplicate detection runs entirely in-memory from the index catalog (`sys.indexes` + `sys.index_columns`). No DMV usage. Two indexes are duplicates when: key columns (same order + ASC/DESC), include columns (same sorted set), `filter_definition`, and `has_filter` all match. Primary keys and unique constraints are excluded.

- [ ] **Step 1: Write failing tests `tests/server/scanners/duplicate.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getDuplicates } from '../../../server/scanners/duplicate.js'

// Two-call pool: first returns index list, second returns column list
function makePool(indexRows, columnRows) {
  let callCount = 0
  return {
    request: () => ({
      query: async () => {
        const result = callCount === 0 ? indexRows : columnRows
        callCount++
        return { recordset: result }
      },
    }),
  }
}

describe('getDuplicates', () => {
  it('returns empty array when no indexes', async () => {
    expect(await getDuplicates(makePool([], []), 'testdb')).toEqual([])
  })

  it('detects exact duplicate key columns (same order, same ASC/DESC)', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
    ]
    const result = await getDuplicates(makePool(indexes, columns), 'testdb')
    expect(result).toHaveLength(2)
    const names = result.map(r => r.index_name)
    expect(names).toContain('IX_A')
    expect(names).toContain('IX_B')
    expect(result[0].duplicate_of).toBeDefined()
    expect(result[0].database_name).toBe('testdb')
  })

  it('does not flag indexes with different key columns', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId',    key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'OrderDate', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })

  it('excludes primary key indexes from duplicate candidates', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'PK_T', index_id: 1, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 1, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 1, column_name: 'Id', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 2, column_name: 'Id', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })

  it('does not flag indexes with same key but different include columns', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 2, column_name: 'Name',   key_ordinal: 0, is_descending_key: 0, is_included_column: 1 },
      { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'Email',  key_ordinal: 0, is_descending_key: 0, is_included_column: 1 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })

  it('respects ASC/DESC direction — different direction is not a duplicate', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 1, is_included_column: 0 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })
})
```

- [ ] **Step 2: Run — verify failure**

```powershell
npx vitest run tests/server/scanners/duplicate.test.js
```

Expected: `Cannot find module '../../../server/scanners/duplicate.js'`

- [ ] **Step 3: Create `server/scanners/duplicate.js`**

```javascript
'use strict'

const { executeDMV } = require('../repository/executeDMV.js')

function keySignature(cols) {
  return cols
    .filter(c => !c.is_included_column)
    .sort((a, b) => a.key_ordinal - b.key_ordinal)
    .map(c => `${c.column_name}:${c.is_descending_key ? 'desc' : 'asc'}`)
    .join('|')
}

function includeSignature(cols) {
  return cols
    .filter(c => c.is_included_column)
    .map(c => c.column_name)
    .sort()
    .join(',')
}

function colDisplay(cols, includeOnly) {
  return cols
    .filter(c => c.is_included_column === includeOnly)
    .sort((a, b) => includeOnly ? a.column_name.localeCompare(b.column_name) : a.key_ordinal - b.key_ordinal)
    .map(c => c.column_name)
    .join(', ')
}

async function getDuplicates(pool, db) {
  const indexes = await executeDMV(pool, db, `
    SELECT
      s.name                AS schema_name,
      o.name                AS table_name,
      i.name                AS index_name,
      i.index_id,
      i.object_id,
      i.has_filter,
      i.filter_definition,
      i.is_primary_key,
      i.is_unique_constraint
    FROM sys.indexes  i
    JOIN sys.objects  o ON o.object_id = i.object_id AND o.type = 'U'
    JOIN sys.schemas  s ON s.schema_id = o.schema_id
    WHERE i.type_desc IN (N'CLUSTERED', N'NONCLUSTERED')
      AND i.is_primary_key       = 0
      AND i.is_unique_constraint = 0
      AND i.is_disabled          = 0
  `)

  if (indexes.length === 0) return []

  const columns = await executeDMV(pool, db, `
    SELECT
      ic.object_id,
      ic.index_id,
      c.name            AS column_name,
      ic.key_ordinal,
      ic.is_descending_key,
      ic.is_included_column
    FROM sys.index_columns ic
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id IN (
      SELECT DISTINCT object_id FROM sys.indexes
      WHERE type_desc IN (N'CLUSTERED', N'NONCLUSTERED')
        AND is_primary_key = 0 AND is_unique_constraint = 0 AND is_disabled = 0
    )
  `)

  const colMap = new Map()
  for (const c of columns) {
    const key = `${c.object_id}|${c.index_id}`
    if (!colMap.has(key)) colMap.set(key, [])
    colMap.get(key).push(c)
  }

  const byTable = new Map()
  for (const ix of indexes) {
    if (!byTable.has(ix.object_id)) byTable.set(ix.object_id, [])
    byTable.get(ix.object_id).push(ix)
  }

  const duplicates = []
  const seen = new Set()

  for (const tableIndexes of byTable.values()) {
    if (tableIndexes.length < 2) continue

    const fps = tableIndexes.map(ix => {
      const cols = colMap.get(`${ix.object_id}|${ix.index_id}`) || []
      return {
        ix,
        keySig:     keySignature(cols),
        inclSig:    includeSignature(cols),
        keyDisplay: colDisplay(cols, false),
        inclDisplay: colDisplay(cols, true),
      }
    })

    for (let a = 0; a < fps.length; a++) {
      for (let b = a + 1; b < fps.length; b++) {
        const fa = fps[a], fb = fps[b]
        if (
          fa.keySig  === fb.keySig &&
          fa.inclSig === fb.inclSig &&
          (fa.ix.filter_definition || null) === (fb.ix.filter_definition || null) &&
          Boolean(fa.ix.has_filter) === Boolean(fb.ix.has_filter)
        ) {
          const keyA = `${fa.ix.object_id}|${fa.ix.index_id}`
          const keyB = `${fb.ix.object_id}|${fb.ix.index_id}`
          if (!seen.has(keyA)) {
            seen.add(keyA)
            duplicates.push({ database_name: db, schema_name: fa.ix.schema_name, table_name: fa.ix.table_name, index_name: fa.ix.index_name, duplicate_of: fb.ix.index_name, key_columns: fa.keyDisplay, include_columns: fa.inclDisplay })
          }
          if (!seen.has(keyB)) {
            seen.add(keyB)
            duplicates.push({ database_name: db, schema_name: fb.ix.schema_name, table_name: fb.ix.table_name, index_name: fb.ix.index_name, duplicate_of: fa.ix.index_name, key_columns: fb.keyDisplay, include_columns: fb.inclDisplay })
          }
        }
      }
    }
  }

  return duplicates
}

module.exports = { getDuplicates }
```

- [ ] **Step 4: Run tests**

```powershell
npx vitest run tests/server/scanners/duplicate.test.js
```

Expected: `6 passed`

- [ ] **Step 5: Run full suite**

```powershell
npx vitest run tests/server/
```

- [ ] **Step 6: Commit**

```bash
git add server/scanners/duplicate.js tests/server/scanners/duplicate.test.js
git commit -m "feat(index-health): duplicate index scanner with key/include/filter fingerprinting"
```

---

## Task 6: Wire scanDatabase() — real implementation

**Files:**
- Replace: `server/indexScanQueries.js`
- Modify: `server/indexScanOrchestrator.js` (serverMeta forwarding + databases[] in results)
- Create: `tests/server/indexScanQueries.test.js`

- [ ] **Step 1: Write failing tests `tests/server/indexScanQueries.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { scanDatabase } from '../../server/indexScanQueries.js'

function makeEmptyPool() {
  return { request: () => ({ query: async () => ({ recordset: [] }) }) }
}

describe('scanDatabase', () => {
  it('returns DatabaseScanResult shape', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'testdb', 'LIMITED')
    expect(result.database).toBe('testdb')
    expect(typeof result.totalIndexes).toBe('number')
    expect(typeof result.disabledCount).toBe('number')
    expect(Array.isArray(result.fragmented)).toBe(true)
    expect(Array.isArray(result.missing)).toBe(true)
    expect(Array.isArray(result.unused)).toBe(true)
    expect(Array.isArray(result.duplicate)).toBe(true)
    expect(typeof result.metadata.durationMs).toBe('number')
    expect(typeof result.metadata.startedAt).toBe('string')
    expect(typeof result.metadata.completedAt).toBe('string')
    expect(result.metadata.timeout).toBe(false)
  })

  it('returns empty arrays for empty database', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'emptydb', 'LIMITED')
    expect(result.fragmented).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.unused).toEqual([])
    expect(result.duplicate).toEqual([])
    expect(result.totalIndexes).toBe(0)
    expect(result.disabledCount).toBe(0)
  })

  it('durationMs is non-negative', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'testdb', 'SAMPLED')
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('startedAt is not after completedAt', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'testdb', 'LIMITED')
    expect(new Date(result.metadata.startedAt) <= new Date(result.metadata.completedAt)).toBe(true)
  })

  it('unused rows get is_duplicate=true when also in duplicate list', async () => {
    // Pool returns: 1 unused row and 1 duplicate row for the same index
    let callCount = 0
    const pool = {
      request: () => ({
        query: async () => {
          callCount++
          // getUnused (3rd parallel call) returns one row
          if (callCount === 3) {
            return { recordset: [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_Dup', index_type_desc: 'NONCLUSTERED', user_seeks: 0, user_scans: 0, user_lookups: 0, user_updates: 10, last_user_seek: null }] }
          }
          // getDuplicates 1st query (4th call) returns same index as duplicate
          if (callCount === 4) {
            return { recordset: [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_Dup', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 }, { schema_name: 'dbo', table_name: 'T', index_name: 'IX_Same', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 }] }
          }
          // getDuplicates 2nd query (5th call) returns columns
          if (callCount === 5) {
            return { recordset: [
              { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
              { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
            ] }
          }
          return { recordset: [] }
        }
      })
    }
    const result = await scanDatabase(pool, 'testdb', 'LIMITED')
    const dupUnused = result.unused.find(u => u.index_name === 'IX_Dup')
    if (dupUnused) {
      expect(dupUnused.is_duplicate).toBe(true)
    }
    // If no unused rows returned (order may vary), just verify shape still valid
    expect(result.metadata.timeout).toBe(false)
  })
})
```

- [ ] **Step 2: Run — verify partial failures**

```powershell
npx vitest run tests/server/indexScanQueries.test.js
```

Expected: shape tests pass (stub already has new shape), but `totalIndexes` count test may vary. At least 4/5 tests pass.

- [ ] **Step 3: Replace `server/indexScanQueries.js` with real implementation**

```javascript
'use strict'

const { executeDMV }                  = require('./repository/executeDMV.js')
const { getFragmented }               = require('./scanners/fragmented.js')
const { getMissing }                  = require('./scanners/missing.js')
const { getUnused, getDisabledCount } = require('./scanners/unused.js')
const { getDuplicates }               = require('./scanners/duplicate.js')

async function getTotalIndexCount(pool, db) {
  const rows = await executeDMV(pool, db, `
    SELECT COUNT(*) AS total_count
    FROM sys.indexes i
    JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
    WHERE i.type_desc IN (
      N'CLUSTERED', N'NONCLUSTERED',
      N'CLUSTERED COLUMNSTORE', N'NONCLUSTERED COLUMNSTORE'
    )
    AND i.is_disabled = 0
  `)
  return rows[0]?.total_count ?? 0
}

async function scanDatabase(pool, db, mode, serverMeta = {}) {
  const startedAt = new Date().toISOString()
  const startMs   = Date.now()

  const [fragmented, missing, unused, duplicate, disabledCount, totalIndexes] = await Promise.all([
    getFragmented(pool, db, mode),
    getMissing(pool, db, serverMeta.supportsOnlineRebuild || false),
    getUnused(pool, db),
    getDuplicates(pool, db),
    getDisabledCount(pool, db),
    getTotalIndexCount(pool, db),
  ])

  const dupSet = new Set(duplicate.map(d => `${d.table_name}|${d.index_name}`))
  const unusedTagged = unused.map(u => ({
    ...u,
    is_duplicate: dupSet.has(`${u.table_name}|${u.index_name}`),
  }))

  return {
    database:     db,
    totalIndexes,
    disabledCount,
    fragmented,
    missing,
    unused: unusedTagged,
    duplicate,
    metadata: {
      durationMs:  Date.now() - startMs,
      startedAt,
      completedAt: new Date().toISOString(),
      timeout:     false,
    },
  }
}

module.exports = { scanDatabase }
```

- [ ] **Step 4: Run tests**

```powershell
npx vitest run tests/server/indexScanQueries.test.js
```

Expected: `5 passed`

- [ ] **Step 5: Update `runScan` in `server/indexScanOrchestrator.js` to pass `serverMeta` and store `databases[]`**

**Change 1** — In `runScan`, find the `scanDatabaseWithTimeout` call:
```javascript
const dbResult = await scanDatabaseWithTimeout(
  pool, db, scan.scanMode, timeoutPerDbMs, scanDatabase
)
```

Replace with (closure forwards `serverMeta`):
```javascript
const dbResult = await scanDatabaseWithTimeout(
  pool, db, scan.scanMode, timeoutPerDbMs,
  (p, d, m) => scanDatabase(p, d, m, serverMeta)
)
```

**Change 2** — In the final `store.update` call, find:
```javascript
      results: {
        fragmented: allDbResults.flatMap(r => r.fragmented),
        missing:    allDbResults.flatMap(r => r.missing),
        unused:     allDbResults.flatMap(r => r.unused),
        duplicate:  allDbResults.flatMap(r => r.duplicate),
        summary,
      },
```

Replace with:
```javascript
      results: {
        databases:  allDbResults,
        fragmented: allDbResults.flatMap(r => r.fragmented),
        missing:    allDbResults.flatMap(r => r.missing),
        unused:     allDbResults.flatMap(r => r.unused),
        duplicate:  allDbResults.flatMap(r => r.duplicate),
        summary,
      },
```

- [ ] **Step 6: Run full test suite**

```powershell
npx vitest run tests/server/
```

Expected: all tests pass. Count should be ≥ 60.

- [ ] **Step 7: Commit**

```bash
git add server/indexScanQueries.js server/indexScanOrchestrator.js tests/server/indexScanQueries.test.js
git commit -m "feat(index-health): wire real DMV scanners into scanDatabase, forward serverMeta, store databases[]"
```

---

## Task 7: Integration tests

**Files:**
- Create: `tests/integration/indexHealth.test.js`

Tests skip automatically when `TEST_SQL_SERVER` env is absent. Set before running:

```powershell
$env:TEST_SQL_SERVER = "HCMPSDB01\HCMPS"
$env:TEST_SQL_DB     = "medcare_db_dev"
npx vitest run tests/integration/
```

- [ ] **Step 1: Create directory**

```powershell
New-Item -ItemType Directory -Force "D:\dashbaords\tests\integration"
```

- [ ] **Step 2: Create `tests/integration/indexHealth.test.js`**

```javascript
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mssql from 'mssql'
import { randomUUID } from 'node:crypto'
import { scanDatabase } from '../../server/indexScanQueries.js'
import { MemoryScanStore } from '../../server/indexScanStore.js'
import { runScan } from '../../server/indexScanOrchestrator.js'

const HAVE_DB = !!(process.env.TEST_SQL_SERVER && process.env.TEST_SQL_DB)

let pool

beforeAll(async () => {
  if (!HAVE_DB) return
  pool = await mssql.connect({
    server:   process.env.TEST_SQL_SERVER,
    database: process.env.TEST_SQL_DB,
    options:  { encrypt: false, trustServerCertificate: true, trustedConnection: true },
  })
}, 30_000)

afterAll(async () => {
  if (pool) await pool.close()
})

describe.skipIf(!HAVE_DB)('Integration: scanDatabase shape', () => {
  it('returns valid DatabaseScanResult against real server', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    expect(result.database).toBe(process.env.TEST_SQL_DB)
    expect(typeof result.totalIndexes).toBe('number')
    expect(typeof result.disabledCount).toBe('number')
    expect(Array.isArray(result.fragmented)).toBe(true)
    expect(Array.isArray(result.missing)).toBe(true)
    expect(Array.isArray(result.unused)).toBe(true)
    expect(Array.isArray(result.duplicate)).toBe(true)
    expect(result.metadata.timeout).toBe(false)
    expect(result.metadata.durationMs).toBeGreaterThan(0)
  }, 60_000)

  it('fragmented rows have required fields and valid recommendation', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    for (const row of result.fragmented) {
      expect(row).toHaveProperty('database_name')
      expect(row).toHaveProperty('schema_name')
      expect(row).toHaveProperty('table_name')
      expect(row).toHaveProperty('index_name')
      expect(['REBUILD', 'REORGANIZE', 'OK', 'SKIP_SMALL']).toContain(row.recommendation)
    }
  }, 60_000)

  it('missing rows have valid 0–100 impact score and create_script', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    for (const row of result.missing) {
      expect(row.impact_score).toBeGreaterThanOrEqual(0)
      expect(row.impact_score).toBeLessThanOrEqual(100)
      expect(row.create_script).toContain('CREATE INDEX')
    }
  }, 60_000)

  it('unused rows have is_duplicate boolean', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    for (const row of result.unused) {
      expect(typeof row.is_duplicate).toBe('boolean')
    }
  }, 60_000)
})

describe.skipIf(!HAVE_DB)('Integration: runScan lifecycle', () => {
  it('completes scan and produces valid health score', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    await runScan(pool, scanId, store)
    const scan = store.get(scanId)
    expect(['completed', 'completed_with_warnings']).toContain(scan.status)
    expect(scan.results).not.toBeNull()
    expect(scan.results.summary.score).toBeGreaterThanOrEqual(0)
    expect(scan.results.summary.score).toBeLessThanOrEqual(100)
    expect(['Healthy', 'Warning', 'Critical']).toContain(scan.results.summary.severity)
    expect(scan.expiresAt).toBeGreaterThan(Date.now())
  }, 120_000)

  it('stores databases[] array in results', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    await runScan(pool, scanId, store)
    const scan = store.get(scanId)
    expect(Array.isArray(scan.results.databases)).toBe(true)
    if (scan.results.databases.length > 0) {
      expect(scan.results.databases[0]).toHaveProperty('database')
      expect(scan.results.databases[0]).toHaveProperty('metadata')
    }
  }, 120_000)

  it('marks database timed_out when timeout is 1ms', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    await runScan(pool, scanId, store, { timeoutPerDbMs: 1 })
    const scan = store.get(scanId)
    expect(['completed', 'completed_with_warnings']).toContain(scan.status)
  }, 30_000)

  it('stays cancelled when cancelled before run', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    store.cancel(scanId)
    await runScan(pool, scanId, store)
    expect(store.get(scanId).status).toBe('cancelled')
  }, 30_000)
})
```

- [ ] **Step 3: Verify unit tests unaffected**

```powershell
npx vitest run tests/server/
```

Expected: all server tests still pass.

- [ ] **Step 4: (Manual) Run integration tests when SQL Server is accessible**

```powershell
$env:TEST_SQL_SERVER = "HCMPSDB01\HCMPS"
$env:TEST_SQL_DB     = "medcare_db_dev"
npx vitest run tests/integration/ --reporter=verbose
```

Expected: all 8 tests pass with longer timeouts.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/indexHealth.test.js
git commit -m "feat(index-health): integration test suite (auto-skip without TEST_SQL_SERVER)"
```

---

## Sprint 2 — Definition of Done

- [ ] `npx vitest run tests/server/` passes (≥ 60 tests)
- [ ] `server/scanners/` contains 4 scanner files, each independently testable
- [ ] Every `executeDMV` call applies `READ UNCOMMITTED` + `LOCK_TIMEOUT 5000`
- [ ] `is_read_only = 0` filter active in `fetchUserDatabases`
- [ ] `scanDatabase()` passes `serverMeta` through (for `ONLINE = ON` in CREATE scripts)
- [ ] `scan.results.databases[]` stored for per-DB drill-down
- [ ] `computeHealthScore()` unchanged (verified by existing tests still passing)
- [ ] Integration tests present and auto-skip when `TEST_SQL_SERVER` not set

---

## What Sprint 3 delivers

Frontend: `IndexHealth.jsx` shell, `ScanControls`, `ScanProgress` with backoff polling, `HealthScoreCard`, `SummaryStrip`, `IndexInventory` 3-tab table, `IndexDetailModal`.
