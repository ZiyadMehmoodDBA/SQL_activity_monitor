# MVP DBA Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six DBA diagnostic panels (Slowest Queries, CPU Intensive, Wait Stats, Blocking, TempDB Usage, Missing Indexes) to the existing SQL Server Activity Monitor.

**Architecture:** Extend existing Socket.io 2-second poll with two new metrics (`cpuExpensive`, `tempdbUsage`) and enhance the existing `recentExpensive` query. Missing Indexes uses an on-demand REST endpoint with a 10-minute in-process cache. All new panels integrate into the existing collapsible-section widget framework.

**Tech Stack:** Node.js + Express + mssql (server), React + Vite + Vitest + @testing-library/react (frontend), Socket.io (data delivery), Tailwind CSS, `navigator.clipboard` API.

---

## File Map

| File | Change |
|---|---|
| `server.js` | Add `Q.cpuExpensive`, `Q.tempdbUsage`; enhance `Q.recentExpensive`; extend `Promise.all`; add `/missing-indexes` endpoint + in-process cache |
| `src/lib/tableCols.js` | Update `recent` column order; add `cpu`, `tempdb`, `missing_indexes` tables; add 3 `DEFAULT_SORT` entries |
| `src/lib/widgetRegistry.js` | Add 3 new section entries with capability flags |
| `src/context/AppContext.jsx` | Add sort state keys + collapsed sections for new tables |
| `src/components/Dashboard.jsx` | Add `sortedCpu`/`sortedTempdb` memos; `waitsWithPct`; `applyMvpFilter`; TopN/DB filter bar; extend `VTABLE_SECTION_CFG`; Copy SQL; `missing_indexes` case |
| `src/components/MissingIndexes.jsx` | **New** — on-demand component with cache badge, loading state, Copy INDEX |
| `src/__tests__/lib/widgetRegistry.test.js` | Update count assertion 24 → 27 |
| `src/__tests__/components/MissingIndexes.test.jsx` | **New** — component tests |

---

## Task 1: Backend — new queries, enhanced recentExpensive, missing-indexes endpoint

**Files:**
- Modify: `server.js` (lines 265–279 for `recentExpensive`; line 487 for `Promise.all`; line 588 for return object; after line 624 for new endpoint)

### Step 1.1: Add `Q.cpuExpensive` to the Q object

In `server.js`, inside the `const Q = { ... }` object, after the `recentExpensive` key (around line 279), add:

```js
  cpuExpensive: `
    SELECT TOP 50
      ISNULL(DB_NAME(st.dbid),'')                                              AS database_name,
      qs.execution_count,
      CAST(qs.total_worker_time / 1000.0 AS FLOAT)                            AS total_worker_time,
      CAST(qs.total_worker_time / NULLIF(qs.execution_count,0) / 1000.0 AS FLOAT) AS avg_cpu_ms,
      CONVERT(VARCHAR(23),qs.last_execution_time,121)                         AS last_executed,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),300) AS query_text
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count > 0
    ORDER BY qs.total_worker_time DESC`,
```

- [ ] Add `Q.cpuExpensive` query to `server.js`

### Step 1.2: Add `Q.tempdbUsage` to the Q object

In `server.js`, inside `const Q = { ... }`, after `Q.cpuExpensive`, add:

```js
  tempdbUsage: `
    SELECT TOP 50
      s.session_id,
      ISNULL(s.login_name,'')                                                   AS login_name,
      ISNULL(s.host_name,'')                                                    AS host_name,
      su.user_objects_alloc_page_count                                          AS user_objects,
      su.internal_objects_alloc_page_count                                      AS internal_objects,
      (su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count) AS total_pages,
      (su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count) * 8 AS memory_kb
    FROM sys.dm_db_session_space_usage su
    JOIN sys.dm_exec_sessions s ON s.session_id = su.session_id
    WHERE su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count > 0
    ORDER BY total_pages DESC`,
```

- [ ] Add `Q.tempdbUsage` query to `server.js`

### Step 1.3: Enhance `Q.recentExpensive`

Replace the existing `recentExpensive` value (lines 265–279) with the version that adds `database_name`, `total_elapsed_ms`, and `total_worker_time`:

```js
  recentExpensive: `
    SELECT TOP 25
      ISNULL(DB_NAME(st.dbid),'')                                              AS database_name,
      qs.execution_count,
      CAST(qs.total_elapsed_time/NULLIF(qs.execution_count,0)/1000.0 AS FLOAT) AS avg_elapsed_ms,
      CAST(qs.total_elapsed_time / 1000.0 AS FLOAT)                           AS total_elapsed_ms,
      CAST(qs.total_worker_time /NULLIF(qs.execution_count,0)/1000.0  AS FLOAT) AS avg_cpu_ms,
      CAST(qs.total_worker_time / 1000.0 AS FLOAT)                            AS total_worker_time,
      CAST(qs.total_logical_reads/NULLIF(qs.execution_count,0) AS FLOAT)      AS avg_logical_reads,
      CONVERT(VARCHAR(23),qs.last_execution_time,121)                         AS last_executed,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),300) AS query_text
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count > 0
    ORDER BY qs.total_elapsed_time/qs.execution_count DESC`,
```

- [ ] Replace `Q.recentExpensive` with enhanced version

### Step 1.4: Add new queries to `collectMetrics` Promise.all

In `collectMetrics` (line 487), add `cpuExpensiveR` and `tempdbR` to the destructure and Promise.all:

Replace this line:
```js
const [cpuR, ovR, ioR, procR, waitR, curWaitR, fileR, recentR, activeR, dbSizesR, blockingR, deadlocksR, perfR, jobsR, diskR, backupHealthR] = await Promise.all([
  req().query(Q.cpu),
  req().query(Q.overview),
  req().query(Q.ioSnapshot),
  req().query(Q.processes),
  req().query(Q.resourceWaits),
  req().query(Q.currentWaits).catch(() => ({ recordset: [] })),
  req().query(Q.dataFileIO),
  req().query(Q.recentExpensive),
  req().query(Q.activeExpensive),
  req().query(Q.dbSizes),
  req().query(Q.blocking),
  req().query(Q.deadlocks).catch(() => ({ recordset: [] })),
  req().query(Q.serverPerf).catch(err => { console.error('[serverPerf]', err.message); return { recordset: [] }; }),
  req().query(Q.jobs).catch(err => { console.error('[jobs]', err.message); return { recordset: [] }; }),
  req().query(Q.diskDrives).catch(err => { console.error('[diskDrives]', err.message); return { recordset: [] }; }),
  req().query(Q.backupHealth).catch(err => { console.error('[backupHealth]', err.message); return { recordset: [] }; }),
]);
```

With:
```js
const [cpuR, ovR, ioR, procR, waitR, curWaitR, fileR, recentR, activeR, dbSizesR, blockingR, deadlocksR, perfR, jobsR, diskR, backupHealthR, cpuExpensiveR, tempdbR] = await Promise.all([
  req().query(Q.cpu),
  req().query(Q.overview),
  req().query(Q.ioSnapshot),
  req().query(Q.processes),
  req().query(Q.resourceWaits),
  req().query(Q.currentWaits).catch(() => ({ recordset: [] })),
  req().query(Q.dataFileIO),
  req().query(Q.recentExpensive),
  req().query(Q.activeExpensive),
  req().query(Q.dbSizes),
  req().query(Q.blocking),
  req().query(Q.deadlocks).catch(() => ({ recordset: [] })),
  req().query(Q.serverPerf).catch(err => { console.error('[serverPerf]', err.message); return { recordset: [] }; }),
  req().query(Q.jobs).catch(err => { console.error('[jobs]', err.message); return { recordset: [] }; }),
  req().query(Q.diskDrives).catch(err => { console.error('[diskDrives]', err.message); return { recordset: [] }; }),
  req().query(Q.backupHealth).catch(err => { console.error('[backupHealth]', err.message); return { recordset: [] }; }),
  req().query(Q.cpuExpensive).catch(err => { console.error('[cpuExpensive]', err.message); return { recordset: [] }; }),
  req().query(Q.tempdbUsage).catch(err => { console.error('[tempdbUsage]', err.message); return { recordset: [] }; }),
]);
```

- [ ] Extend `Promise.all` with 2 new queries

### Step 1.5: Add new metrics to collectMetrics return value

In the `return { ... }` block (around line 588), add two new fields after `backupHealth`:

```js
    backupHealth:    backupHealthR.recordset,
    cpuExpensive:    cpuExpensiveR.recordset,
    tempdbUsage:     tempdbR.recordset,
```

- [ ] Add `cpuExpensive` and `tempdbUsage` to the metrics return object

### Step 1.6: Add in-process cache and missing-indexes endpoint

Add the cache Map and the endpoint **after** the `const connections = new Map()` declaration (around line 91) and before or after the `scanStore` declaration. Add the endpoint after the existing `/api/connections/:id/error-log` route.

Add the cache map near the top (after line 93):
```js
// ─── Missing index cache (per connection, advisory data) ──────────────────────
const missingIndexCache = new Map() // Map<connId, { rows, ts, expiresAt }>
const MISSING_INDEX_CACHE_MS = parseInt(process.env.MISSING_INDEX_CACHE_MIN || '10') * 60 * 1000
```

Add the SQL query string as `Q.missingIndexes` in the `Q` object:
```js
  missingIndexes: `
    SELECT TOP 50
      DB_NAME(d.database_id)                        AS database_name,
      OBJECT_NAME(d.object_id, d.database_id)       AS table_name,
      d.equality_columns,
      d.inequality_columns,
      d.included_columns,
      gs.user_seeks,
      gs.user_scans,
      CAST(
        gs.avg_total_user_cost * gs.avg_user_impact * (gs.user_seeks + gs.user_scans)
      AS DECIMAL(18,2))                             AS estimated_improvement,
      'CREATE INDEX [' +
        LEFT(
          'IX_' + ISNULL(OBJECT_NAME(d.object_id, d.database_id),'obj') + '_' + CAST(d.index_handle AS VARCHAR(10)),
          128
        ) +
        '] ON ' + d.statement + ' (' +
        ISNULL(d.equality_columns, '') +
        CASE
          WHEN d.inequality_columns IS NOT NULL AND d.equality_columns IS NOT NULL THEN ','
          ELSE ''
        END +
        ISNULL(d.inequality_columns, '') + ')' +
        CASE
          WHEN d.included_columns IS NOT NULL
          THEN ' INCLUDE (' + d.included_columns + ')'
          ELSE ''
        END                                         AS create_index_sql
    FROM sys.dm_db_missing_index_details d
    JOIN sys.dm_db_missing_index_groups g
      ON g.index_handle = d.index_handle
    JOIN sys.dm_db_missing_index_group_stats gs
      ON gs.group_handle = g.index_group_handle
    WHERE d.database_id > 4
      AND OBJECTPROPERTY(d.object_id,'IsMsShipped') = 0
    ORDER BY estimated_improvement DESC`,
```

Add the route (after the existing `/error-log` route, search for it):
```js
app.get('/api/connections/:id/missing-indexes', async (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return
  const force = req.query.force === '1'
  const ttlMinutes = Math.round(MISSING_INDEX_CACHE_MS / 60000)
  const cached = missingIndexCache.get(req.params.id)
  if (!force && cached && Date.now() < cached.expiresAt) {
    return res.json({ rows: cached.rows, count: cached.rows.length, ts: cached.ts, cached: true, ttlMinutes })
  }
  try {
    const result = await conn.pool.request().query(Q.missingIndexes)
    const rows = result.recordset
    const ts = new Date().toISOString()
    missingIndexCache.set(req.params.id, { rows, ts, expiresAt: Date.now() + MISSING_INDEX_CACHE_MS })
    res.json({ rows, count: rows.length, ts, cached: false, ttlMinutes })
  } catch (err) {
    console.error('[missing-indexes]', err.message)
    res.status(500).json({ error: err.message })
  }
})
```

Also clear the cache when a connection is removed. Find the disconnect endpoint (search for `DELETE /api/disconnect`) and add:
```js
missingIndexCache.delete(id)
```

- [ ] Add `missingIndexCache` Map and `MISSING_INDEX_CACHE_MS` constant
- [ ] Add `Q.missingIndexes` to the Q object
- [ ] Add `GET /api/connections/:id/missing-indexes` route
- [ ] Clear `missingIndexCache` on disconnect

### Step 1.7: Commit backend changes

```bash
git add server.js
git commit -m "feat(server): add cpuExpensive, tempdbUsage metrics and missing-indexes endpoint"
```

- [ ] Run `npm start` briefly to verify no startup errors, then stop
- [ ] Commit

---

## Task 2: Table columns, widget registry, sort defaults, AppContext

**Files:**
- Modify: `src/lib/tableCols.js`
- Modify: `src/lib/widgetRegistry.js`
- Modify: `src/__tests__/lib/widgetRegistry.test.js`
- Modify: `src/context/AppContext.jsx`

### Step 2.1: Update `TABLE_COLS.recent`

In `src/lib/tableCols.js`, replace the `recent` array with the expanded version:

```js
  recent: [
    { key: 'database_name',    label: 'Database',            type: 'str'                                        },
    { key: 'execution_count',  label: 'Executions',          type: 'num'                                        },
    { key: 'avg_elapsed_ms',   label: 'Avg Elapsed (ms)',    type: 'dec'                                        },
    { key: 'total_elapsed_ms', label: 'Total Elapsed (ms)',  type: 'dec'                                        },
    { key: 'avg_cpu_ms',       label: 'Avg CPU (ms)',        type: 'dec'                                        },
    { key: 'total_worker_time',label: 'Total CPU (ms)',      type: 'dec'                                        },
    { key: 'avg_logical_reads',label: 'Avg Reads',           type: 'num'                                        },
    { key: 'last_executed',    label: 'Last Executed',       type: 'str'                                        },
    { key: 'query_text',       label: 'Query',               type: 'query', maxWidth: 500, truncate: true, tooltip: true },
  ],
```

- [ ] Update `TABLE_COLS.recent`

### Step 2.2: Add `TABLE_COLS.cpu`

After the `recent` array, add:

```js
  cpu: [
    { key: 'database_name',    label: 'Database',        type: 'str'                                        },
    { key: 'execution_count',  label: 'Executions',      type: 'num'                                        },
    { key: 'total_worker_time',label: 'Total CPU (ms)',  type: 'dec'                                        },
    { key: 'avg_cpu_ms',       label: 'Avg CPU (ms)',    type: 'dec'                                        },
    { key: 'last_executed',    label: 'Last Executed',   type: 'str'                                        },
    { key: 'query_text',       label: 'Query',           type: 'query', maxWidth: 500, truncate: true, tooltip: true },
  ],
```

- [ ] Add `TABLE_COLS.cpu`

### Step 2.3: Add `TABLE_COLS.tempdb`

```js
  tempdb: [
    { key: 'session_id',       label: 'Session',      type: 'num' },
    { key: 'login_name',       label: 'Login',        type: 'str' },
    { key: 'host_name',        label: 'Host',         type: 'str' },
    { key: 'user_objects',     label: 'User Obj',     type: 'num' },
    { key: 'internal_objects', label: 'Internal Obj', type: 'num' },
    { key: 'total_pages',      label: 'Pages',        type: 'num' },
    { key: 'memory_kb',        label: 'TempDB KB',    type: 'num' },
  ],
```

- [ ] Add `TABLE_COLS.tempdb`

### Step 2.4: Add `TABLE_COLS.missing_indexes`

```js
  missing_indexes: [
    { key: 'database_name',         label: 'Database',         type: 'str'   },
    { key: 'table_name',            label: 'Table',            type: 'str'   },
    { key: 'equality_columns',      label: 'Equality Cols',    type: 'trunc' },
    { key: 'inequality_columns',    label: 'Inequality Cols',  type: 'trunc' },
    { key: 'included_columns',      label: 'Included Cols',    type: 'trunc' },
    { key: 'user_seeks',            label: 'Seeks',            type: 'num'   },
    { key: 'estimated_improvement', label: 'Est. Improvement', type: 'dec'   },
  ],
```

Note: `create_index_sql` is not a display column — only used by the Copy INDEX button.

- [ ] Add `TABLE_COLS.missing_indexes`

### Step 2.5: Add three new `DEFAULT_SORT` entries

In `src/lib/tableCols.js`, in the `DEFAULT_SORT` export, add:

```js
  cpu:            { col: 'total_worker_time',     dir: 'desc' },
  tempdb:         { col: 'total_pages',           dir: 'desc' },
  missing_indexes:{ col: 'estimated_improvement', dir: 'desc' },
```

- [ ] Add `DEFAULT_SORT` entries for `cpu`, `tempdb`, `missing_indexes`

### Step 2.6: Add three new widget registry entries

In `src/lib/widgetRegistry.js`, after the `index_health` entry, add:

```js
  { id: 'cpu_intensive',   label: 'CPU Intensive Queries', group: 'section', category: 'Queries',     defaultEnabled: true  },
  { id: 'missing_indexes', label: 'Missing Indexes',        group: 'section', category: 'Maintenance', defaultEnabled: true  },
  { id: 'tempdb_usage',    label: 'TempDB Usage',           group: 'section', category: 'Database',    defaultEnabled: true  },
```

- [ ] Add 3 entries to `WIDGET_REGISTRY`

### Step 2.7: Fix the registry count in the test

In `src/__tests__/lib/widgetRegistry.test.js`, line 11, update the count:

```js
  it('has 27 widgets', () => expect(WIDGET_REGISTRY).toHaveLength(27))
```

- [ ] Change `toHaveLength(24)` → `toHaveLength(27)` in `widgetRegistry.test.js`

### Step 2.8: Run registry tests

```bash
npx vitest run src/__tests__/lib/widgetRegistry.test.js
```

Expected: all 5 tests pass.

- [ ] Run tests and verify they pass

### Step 2.9: Update `AppContext.jsx` — sort state and collapsed sections

In `src/context/AppContext.jsx`, in the `ALL_SECTIONS_COLLAPSED` Set (line 13), add the two new section IDs:

```js
const ALL_SECTIONS_COLLAPSED = new Set([
  'proc', 'waits', 'fileio', 'recent', 'active',
  'blocking', 'deadlocks', 'dbsizes', 'dbsizetrend',
  'cpu', 'tempdb',
])
```

In `makeConn`, in the `sortState` object (line 43), add three new entries:

```js
      sortState: {
        proc:           { col: 'cpu_time',              dir: 'desc' },
        waits:          { col: 'wait_time_ms',          dir: 'desc' },
        fileio:         { col: 'io_stall',              dir: 'desc' },
        recent:         { col: 'avg_elapsed_ms',        dir: 'desc' },
        active:         { col: 'elapsed_sec',           dir: 'desc' },
        blocking:       { col: 'wait_time',             dir: 'desc' },
        deadlocks:      { col: 'deadlock_time',         dir: 'desc' },
        cpu:            { col: 'total_worker_time',     dir: 'desc' },
        tempdb:         { col: 'total_pages',           dir: 'desc' },
        missing_indexes:{ col: 'estimated_improvement', dir: 'desc' },
      },
```

- [ ] Add `'cpu', 'tempdb'` to `ALL_SECTIONS_COLLAPSED`
- [ ] Add `cpu`, `tempdb`, `missing_indexes` sort state entries in `makeConn`

### Step 2.10: Commit

```bash
git add src/lib/tableCols.js src/lib/widgetRegistry.js src/__tests__/lib/widgetRegistry.test.js src/context/AppContext.jsx
git commit -m "feat(frontend): add cpu/tempdb/missing-indexes table cols, registry entries, sort state"
```

- [ ] Commit

---

## Task 3: Dashboard plumbing — sort memos, wait_pct, filter bar, Copy SQL, new cases

**Files:**
- Modify: `src/components/Dashboard.jsx`

### Step 3.1: Add `sortedCpu` and `sortedTempdb` useMemos

In `Dashboard.jsx`, after the existing `sortedDeadlocks` useMemo (around line 360), add:

```js
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedCpu    = useMemo(() => sortRows(m?.cpuExpensive, conn.sortState.cpu),   [m?.cpuExpensive, conn.sortState.cpu])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedTempdb = useMemo(() => sortRows(m?.tempdbUsage,  conn.sortState.tempdb),[m?.tempdbUsage,  conn.sortState.tempdb])
```

- [ ] Add `sortedCpu` and `sortedTempdb` useMemos

### Step 3.2: Replace `sortedWaits` with `waitsWithPct` → `sortedWaits`

Find the existing `sortedWaits` useMemo (around line 350):
```js
  const sortedWaits = useMemo(() => sortRows(m?.resourceWaits, conn.sortState.waits), [m?.resourceWaits, conn.sortState.waits])
```

Replace it with:
```js
  const waitsWithPct = useMemo(() => {
    const rows  = m?.resourceWaits || []
    const total = rows.reduce((s, r) => s + (r.wait_time_ms || 0), 0)
    return rows.map(r => ({
      ...r,
      wait_pct: total > 0 ? +((r.wait_time_ms / total) * 100).toFixed(1) : 0,
    }))
  }, [m?.resourceWaits])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedWaits = useMemo(() => sortRows(waitsWithPct, conn.sortState.waits), [waitsWithPct, conn.sortState.waits])
```

- [ ] Replace `sortedWaits` with the two-step `waitsWithPct` → `sortedWaits`

### Step 3.3: Update `sortedByKey` map

Find `const sortedByKey = { ... }` (around line 362) and add the two new keys:

```js
  const sortedByKey = { fileio: sortedFileio, recent: sortedRecent, active: sortedActive, blocking: sortedBlocking, deadlocks: sortedDeadlocks, cpu: sortedCpu, tempdb: sortedTempdb }
```

- [ ] Add `cpu` and `tempdb` to `sortedByKey`

### Step 3.4: Add `applyMvpFilter` helper and TopN/DB filter state

Near the top of the `Dashboard` component body (after the `on` and `orderedSections` memos), add:

```js
  // ── TopN / DB filter (MVP sections) ──────────────────────────────────────
  const [topN,     setTopN]     = useState(10)
  const [dbFilter, setDbFilter] = useState('')

  const dbNames = useMemo(() => {
    const names = new Set()
    ;[m?.recentExpensive, m?.cpuExpensive, m?.blocking].forEach(arr => {
      ;(arr || []).forEach(r => { if (r.database_name) names.add(r.database_name) })
    })
    return [...names].sort()
  }, [m?.recentExpensive, m?.cpuExpensive, m?.blocking])
```

Add `applyMvpFilter` as a **module-level** pure function (above the `Dashboard` component, near the other module-level helpers like `sortRows`):

```js
function applyMvpFilter(rows, topN, dbFilter) {
  let r = rows || []
  if (dbFilter) r = r.filter(row => (row.database_name || '') === dbFilter)
  return topN > 0 ? r.slice(0, topN) : r
}
```

- [ ] Add `applyMvpFilter` at module level
- [ ] Add `topN`, `dbFilter` state and `dbNames` memo inside Dashboard

### Step 3.5: Extend `VTABLE_SECTION_CFG` with new entries and capability flags

Replace the existing `VTABLE_SECTION_CFG` constant with the extended version. **Preserve all existing entries unchanged** and add the new ones plus capability flags where relevant:

```js
const VTABLE_SECTION_CFG = {
  file_io:          { sectionId: 'fileio',    title: 'Data File I/O',            sortKey: 'fileio',    height: 280, metricKey: 'dataFileIO',      supportsTopN: false, supportsDbFilter: false, supportsClipboard: false, supportsRefresh: false },
  recent_expensive: { sectionId: 'recent',    title: 'Recent Expensive Queries', sortKey: 'recent',    height: 280, metricKey: 'recentExpensive',  supportsTopN: true,  supportsDbFilter: true,  supportsClipboard: true,  supportsRefresh: false },
  active_expensive: { sectionId: 'active',    title: 'Active Expensive Queries', sortKey: 'active',    height: 280, metricKey: 'activeExpensive',  supportsTopN: true,  supportsDbFilter: true,  supportsClipboard: true,  supportsRefresh: false },
  blocking:         { sectionId: 'blocking',  title: 'Blocking Chains',          sortKey: 'blocking',  height: 240, metricKey: 'blocking',         rowStyle: BLOCKING_ROW_STYLE, alertWhen: true, supportsTopN: true, supportsDbFilter: true, supportsClipboard: false, supportsRefresh: false },
  deadlocks:        { sectionId: 'deadlocks', title: 'Deadlock History',         sortKey: 'deadlocks', height: 240, metricKey: 'deadlocks',        rowStyle: DEADLOCK_ROW_STYLE, alertWhen: true, supportsTopN: false, supportsDbFilter: false, supportsClipboard: false, supportsRefresh: false },
  cpu_intensive:    { sectionId: 'cpu',       title: 'CPU Intensive Queries',    sortKey: 'cpu',       height: 280, metricKey: 'cpuExpensive',     supportsTopN: true,  supportsDbFilter: true,  supportsClipboard: true,  supportsRefresh: false },
  tempdb_usage:     { sectionId: 'tempdb',    title: 'TempDB Usage',             sortKey: 'tempdb',    height: 280, metricKey: 'tempdbUsage',      supportsTopN: true,  supportsDbFilter: false, supportsClipboard: false, supportsRefresh: false },
}
```

- [ ] Replace `VTABLE_SECTION_CFG` with extended version

### Step 3.6: Add `copyQueryCell` callback

After the `handleSort` callback, add:

```js
  const copyQueryCell = useCallback(row => (
    <button
      className="copy-btn"
      title="Copy SQL"
      onClick={async e => {
        e.stopPropagation()
        try { await navigator.clipboard.writeText(row.query_text || '') } catch { /* clipboard blocked */ }
      }}
    >
      Copy
    </button>
  ), [])
```

- [ ] Add `copyQueryCell` callback

### Step 3.7: Update the `VTABLE_SECTION_CFG` render path to use capability flags

Find the `if (cfg)` block in `renderSection` and update it to use the new flags:

```js
    if (cfg) {
      const cfgRows = cfg.supportsTopN
        ? applyMvpFilter(sortedByKey[cfg.sortKey], topN, cfg.supportsDbFilter ? dbFilter : '')
        : sortedByKey[cfg.sortKey]
      return (
        <CollapsibleSection key={id} connId={connId} sectionId={cfg.sectionId} title={cfg.title}
          badge={<SectionBadge count={m?.[cfg.metricKey]?.length || 0} alertWhen={cfg.alertWhen} />}>
          <VirtualTable rows={cfgRows} columns={TABLE_COLS[cfg.sortKey]}
            height={cfg.height}
            sortCol={conn.sortState[cfg.sortKey].col} sortDir={conn.sortState[cfg.sortKey].dir}
            onSort={col => handleSort(cfg.sortKey, col)}
            rowStyle={cfg.rowStyle}
            extraCol={cfg.supportsClipboard || false}
            renderExtraCell={cfg.supportsClipboard ? copyQueryCell : undefined}
          />
        </CollapsibleSection>
      )
    }
```

- [ ] Update the `if (cfg)` render block to use capability flags

### Step 3.8: Add `missing_indexes` renderSection case

In the `switch (id)` inside `renderSection`, before the `default` case, add:

```js
      case 'missing_indexes':
        return <MissingIndexes key={id} connId={connId} topN={topN} dbFilter={dbFilter} />
```

Also add the import at the top of the file (with the other component imports):

```js
import MissingIndexes from './MissingIndexes'
```

- [ ] Add `import MissingIndexes` at top of Dashboard.jsx
- [ ] Add `case 'missing_indexes'` to `renderSection`

### Step 3.9: Add TopN / DB filter bar JSX

In the `return ( ... )` of Dashboard, find the line just before `{orderedSections.length > 0 && ...}` and insert the filter bar:

```jsx
      {/* TopN / DB filter strip — applies to MVP sections */}
      {orderedSections.length > 0 && (
        <div className="flex items-center gap-3 mb-3 px-0.5" style={{ flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            Filter
          </span>
          <div className="flex items-center gap-1">
            {[10, 25, 50].map(n => (
              <button
                key={n}
                onClick={() => setTopN(n)}
                className="px-2.5 py-1 rounded-md text-xs font-semibold transition-colors"
                style={{
                  background: topN === n ? 'var(--sort-active)' : 'var(--divider)',
                  color:      topN === n ? '#fff'               : 'var(--text-secondary)',
                  border:     '1px solid var(--input-border)',
                }}
              >
                Top {n}
              </button>
            ))}
          </div>
          <select
            value={dbFilter}
            onChange={e => setDbFilter(e.target.value)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--input-border)',
              background: 'var(--input-bg)', color: 'var(--text-primary)', cursor: 'pointer',
            }}
          >
            <option value=''>All Databases</option>
            {dbNames.map(db => <option key={db} value={db}>{db}</option>)}
          </select>
          {dbFilter && (
            <button
              onClick={() => setDbFilter('')}
              style={{ fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              ✕ Clear
            </button>
          )}
        </div>
      )}
```

The existing `{orderedSections.length > 0 && ( <div className="space-y-6"> ... )}` block stays immediately after.

- [ ] Add TopN/DB filter bar JSX

### Step 3.10: Commit

```bash
git add src/components/Dashboard.jsx
git commit -m "feat(dashboard): TopN/DB filter, wait_pct, CPU/TempDB sections, Copy SQL"
```

- [ ] Commit

---

## Task 4: MissingIndexes component + tests

**Files:**
- Create: `src/components/MissingIndexes.jsx`
- Create: `src/__tests__/components/MissingIndexes.test.jsx`

### Step 4.1: Write failing tests

Create `src/__tests__/components/MissingIndexes.test.jsx`:

```jsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, render } from '@testing-library/react'
import MissingIndexes from '../../components/MissingIndexes'

function mockFetch(payload, ok = true) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok,
      json: () => Promise.resolve(payload),
    })
  )
}

function makeRow(overrides = {}) {
  return {
    database_name:         'MyDb',
    table_name:            'Orders',
    equality_columns:      '[CustomerId]',
    inequality_columns:    null,
    included_columns:      '[OrderDate]',
    user_seeks:            1200,
    estimated_improvement: 9800.50,
    create_index_sql:      "CREATE INDEX [IX_Orders_1] ON [dbo].[Orders] ([CustomerId]) INCLUDE ([OrderDate])",
    ...overrides,
  }
}

describe('MissingIndexes — initial state', () => {
  it('renders section heading', () => {
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    expect(screen.getByText(/missing indexes/i)).toBeInTheDocument()
  })

  it('renders Analyse button', () => {
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    expect(screen.getByRole('button', { name: /analyse/i })).toBeInTheDocument()
  })

  it('shows idle prompt before first fetch', () => {
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    expect(screen.getByText(/run analysis/i)).toBeInTheDocument()
  })
})

describe('MissingIndexes — fetch', () => {
  it('calls correct API endpoint', async () => {
    mockFetch({ rows: [], count: 0, ts: new Date().toISOString(), cached: false, ttlMinutes: 10 })
    render(<MissingIndexes connId='conn42' topN={10} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/connections/conn42/missing-indexes')
    })
  })

  it('shows rows after successful fetch', async () => {
    mockFetch({ rows: [makeRow()], count: 1, ts: new Date().toISOString(), cached: false, ttlMinutes: 10 })
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => {
      expect(screen.getByText('Orders')).toBeInTheDocument()
    })
  })

  it('shows empty state when no rows returned', async () => {
    mockFetch({ rows: [], count: 0, ts: new Date().toISOString(), cached: false, ttlMinutes: 10 })
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => {
      expect(screen.getByText(/no missing indexes/i)).toBeInTheDocument()
    })
  })

  it('shows error state on fetch failure', async () => {
    mockFetch({ error: 'Query timeout' }, false)
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => {
      expect(screen.getByText(/query timeout/i)).toBeInTheDocument()
    })
  })

  it('disables button while loading', async () => {
    let resolve
    global.fetch = vi.fn(() => new Promise(r => { resolve = r }))
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    expect(screen.getByRole('button', { name: /analysing/i })).toBeDisabled()
    resolve({ ok: true, json: () => Promise.resolve({ rows: [], count: 0, ts: '', cached: false, ttlMinutes: 10 }) })
  })
})

describe('MissingIndexes — cache badge', () => {
  it('shows cached badge when response is cached', async () => {
    mockFetch({ rows: [makeRow()], count: 1, ts: new Date().toISOString(), cached: true, ttlMinutes: 10 })
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => {
      expect(screen.getByText(/cached/i)).toBeInTheDocument()
    })
  })
})

describe('MissingIndexes — force refresh', () => {
  it('appends ?force=1 when Force Refresh is clicked', async () => {
    mockFetch({ rows: [makeRow()], count: 1, ts: new Date().toISOString(), cached: true, ttlMinutes: 10 })
    render(<MissingIndexes connId='c1' topN={10} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => screen.getByText(/force refresh/i))
    fireEvent.click(screen.getByText(/force refresh/i))
    await waitFor(() => {
      expect(global.fetch).toHaveBeenLastCalledWith('/api/connections/c1/missing-indexes?force=1')
    })
  })
})

describe('MissingIndexes — topN and dbFilter props', () => {
  it('limits displayed rows to topN', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ table_name: `Table${i}` }))
    mockFetch({ rows, count: 5, ts: new Date().toISOString(), cached: false, ttlMinutes: 10 })
    render(<MissingIndexes connId='c1' topN={3} dbFilter='' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => screen.getByText('Table0'))
    expect(screen.queryByText('Table3')).not.toBeInTheDocument()
  })

  it('filters rows by dbFilter', async () => {
    const rows = [makeRow({ database_name: 'A' }), makeRow({ table_name: 'OtherTable', database_name: 'B' })]
    mockFetch({ rows, count: 2, ts: new Date().toISOString(), cached: false, ttlMinutes: 10 })
    render(<MissingIndexes connId='c1' topN={10} dbFilter='A' />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => screen.getByText('Orders'))
    expect(screen.queryByText('OtherTable')).not.toBeInTheDocument()
  })
})
```

- [ ] Create `src/__tests__/components/MissingIndexes.test.jsx` with the above content

### Step 4.2: Run tests to verify they fail

```bash
npx vitest run src/__tests__/components/MissingIndexes.test.jsx
```

Expected: **FAIL** — `Cannot find module '../../components/MissingIndexes'`

- [ ] Run tests and confirm they fail with "Cannot find module"

### Step 4.3: Implement `MissingIndexes.jsx`

Create `src/components/MissingIndexes.jsx`:

```jsx
import React, { useState, useCallback, useMemo } from 'react'
import { RefreshCw, Search, ChevronDown } from 'lucide-react'

function fmtTs(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function CopyIndexBtn({ sql }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async e => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(sql || '')
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard blocked */ }
      }}
      title="Copy CREATE INDEX statement"
      style={{
        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--input-border)',
        background: copied ? 'rgba(34,197,94,.1)' : 'var(--divider)', color: copied ? '#16a34a' : 'var(--text-secondary)',
        cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      {copied ? 'Copied!' : 'Copy INDEX'}
    </button>
  )
}

function IndexRow({ row }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderBottom: '1px solid var(--divider)', transition: 'background .1s' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div className="flex gap-3 px-5 py-3 items-start">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{row.database_name}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>·</span>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{row.table_name}</span>
            <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 99, background: 'rgba(59,130,246,.1)', color: '#3b82f6', fontWeight: 700 }}>
              {Number(row.estimated_improvement || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} pts
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {Number(row.user_seeks || 0).toLocaleString()} seeks
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {row.equality_columns && <span><strong style={{ color: 'var(--text-muted)' }}>EQ:</strong> {row.equality_columns} </span>}
            {row.inequality_columns && <span><strong style={{ color: 'var(--text-muted)' }}>IQ:</strong> {row.inequality_columns} </span>}
            {row.included_columns && <span><strong style={{ color: 'var(--text-muted)' }}>INC:</strong> {row.included_columns}</span>}
          </div>
          {open && (
            <div style={{ marginTop: 8, fontSize: 10, fontFamily: 'Cascadia Code,Consolas,monospace', background: 'var(--section-hover)',
              borderRadius: 6, padding: '8px 12px', wordBreak: 'break-all', color: 'var(--text-primary)', lineHeight: 1.6 }}>
              {row.create_index_sql}
            </div>
          )}
          <button
            onClick={() => setOpen(o => !o)}
            style={{ fontSize: 10, color: 'var(--sort-active)', marginTop: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
          >
            <ChevronDown size={10} style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .15s' }} />
            {open ? 'Hide SQL' : 'Show SQL'}
          </button>
        </div>
        <CopyIndexBtn sql={row.create_index_sql} />
      </div>
    </div>
  )
}

export default function MissingIndexes({ connId, topN = 10, dbFilter = '' }) {
  const [collapsed, setCollapsed] = useState(true)
  const [rows,      setRows]      = useState(null)   // null = never fetched
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [meta,      setMeta]      = useState(null)   // { ts, cached, ttlMinutes }

  const doFetch = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/connections/${connId}/missing-indexes${force ? '?force=1' : ''}`
      const r   = await fetch(url)
      const d   = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setRows(d.rows || [])
      setMeta({ ts: d.ts, cached: d.cached, ttlMinutes: d.ttlMinutes })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [connId])

  const handleAnalyse = useCallback(() => {
    if (collapsed) setCollapsed(false)
    doFetch(false)
  }, [collapsed, doFetch])

  const filteredRows = useMemo(() => {
    let r = rows || []
    if (dbFilter) r = r.filter(row => (row.database_name || '') === dbFilter)
    return topN > 0 ? r.slice(0, topN) : r
  }, [rows, topN, dbFilter])

  const tsStr = fmtTs(meta?.ts)

  return (
    <div className="mc overflow-hidden">
      {/* ── Header ── */}
      <div className="section-toggle flex items-center justify-between px-5 py-3 gap-4 flex-wrap">
        <button
          className="flex items-center gap-3 text-left min-w-0"
          onClick={() => setCollapsed(c => !c)}
        >
          <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-bold leading-none" style={{ color: 'var(--text-primary)', letterSpacing: '-.01em' }}>
              Missing Indexes
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Advisory · DMV recommendations
            </span>
          </div>
          {rows !== null && rows.length > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(245,158,11,.12)', color: '#d97706', border: '1px solid rgba(245,158,11,.2)', flexShrink: 0 }}>
              {filteredRows.length} recommendation{filteredRows.length !== 1 ? 's' : ''}
            </span>
          )}
        </button>

        <div className="flex items-center gap-3 flex-shrink-0">
          {meta?.cached && tsStr && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Cached · {tsStr}
            </span>
          )}
          {!meta?.cached && tsStr && (
            <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
              Updated {tsStr}
            </span>
          )}
          {meta?.cached && (
            <button
              onClick={() => doFetch(true)}
              disabled={loading}
              style={{ fontSize: 10, color: 'var(--sort-active)', cursor: loading ? 'default' : 'pointer', opacity: loading ? .5 : 1 }}
            >
              Force Refresh
            </button>
          )}
          <button
            onClick={handleAnalyse}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: 'var(--divider)', color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Analysing…' : 'Analyse'}
          </button>
          <button
            onClick={() => setCollapsed(c => !c)}
            className="p-1 rounded-md transition-colors"
            style={{ lineHeight: 0, color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronDown size={14} className={`chevron ${collapsed ? '' : 'open'}`} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className={`section-body ${collapsed ? 'collapsed' : ''}`}>
        <div className="section-body-inner">

          {/* Error */}
          {error && (
            <div className="mx-5 mt-4 flex items-start gap-3 px-4 py-3 rounded-xl text-xs"
              style={{ background: 'rgba(239,68,68,.06)', color: '#dc2626', border: '1px solid rgba(239,68,68,.2)' }}>
              <span style={{ lineHeight: 1.5 }}>{error}</span>
              <button onClick={() => doFetch(false)} style={{ marginLeft: 'auto', fontWeight: 700, cursor: 'pointer', color: '#dc2626' }}>Retry</button>
            </div>
          )}

          {/* Idle — never fetched */}
          {!loading && !error && rows === null && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--section-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Search size={20} style={{ color: 'var(--text-muted)', opacity: .5 }} />
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Run analysis to identify missing indexes</span>
                <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 260, lineHeight: 1.6 }}>
                  Scans SQL Server DMV recommendations. Results are cached for {meta?.ttlMinutes ?? 10} minutes.
                </span>
              </div>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center gap-2.5 py-12">
              <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Analysing…</span>
            </div>
          )}

          {/* Empty — fetched but no results */}
          {!loading && !error && rows !== null && filteredRows.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 20 }}>✓</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-sm font-semibold" style={{ color: '#22c55e' }}>No missing indexes detected</span>
                <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 260, lineHeight: 1.6 }}>
                  {dbFilter ? `No recommendations for database "${dbFilter}".` : 'SQL Server has no active index recommendations.'}
                </span>
              </div>
            </div>
          )}

          {/* Results */}
          {!loading && filteredRows.length > 0 && (
            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
              {filteredRows.map((row, i) => (
                <IndexRow key={`${row.database_name}-${row.table_name}-${i}`} row={row} />
              ))}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
```

- [ ] Create `src/components/MissingIndexes.jsx` with the above content

### Step 4.4: Run tests to verify they pass

```bash
npx vitest run src/__tests__/components/MissingIndexes.test.jsx
```

Expected: **all tests PASS**.

- [ ] Run tests and verify all pass

### Step 4.5: Run the full test suite

```bash
npx vitest run
```

Expected: all existing tests plus new tests pass. Zero failures.

- [ ] Run full suite and verify no regressions

### Step 4.6: Commit

```bash
git add src/components/MissingIndexes.jsx src/__tests__/components/MissingIndexes.test.jsx
git commit -m "feat(frontend): add MissingIndexes component with cache badge, Copy INDEX, topN/dbFilter"
```

- [ ] Commit

---

## Self-Review Checklist

### Spec coverage

| Spec requirement | Task |
|---|---|
| `Q.cpuExpensive` — new metric | Task 1.1 |
| `Q.tempdbUsage` — new metric | Task 1.2 |
| `Q.recentExpensive` — add db_name, total_elapsed_ms, total_worker_time | Task 1.3 |
| `cpuExpensive`/`tempdbUsage` in Promise.all + return | Task 1.4/1.5 |
| `/missing-indexes` endpoint with cache + force | Task 1.6 |
| Clear cache on disconnect | Task 1.6 |
| `TABLE_COLS.recent` updated | Task 2.1 |
| `TABLE_COLS.cpu`, `tempdb`, `missing_indexes` added | Task 2.2/2.3/2.4 |
| `DEFAULT_SORT` 3 new entries | Task 2.5 |
| Widget registry 3 new entries | Task 2.6 |
| AppContext sort state + collapsed sections | Task 2.9 |
| `sortedCpu`, `sortedTempdb` memos | Task 3.1 |
| `waitsWithPct` → `wait_pct` column | Task 3.2 |
| `sortedByKey` extended | Task 3.3 |
| `applyMvpFilter` helper | Task 3.4 |
| `VTABLE_SECTION_CFG` extended with new entries + flags | Task 3.5 |
| `copyQueryCell` — Copy SQL for recent/cpu/active | Task 3.6 |
| Cfg render path uses flags (extraCol, topN, db filter) | Task 3.7 |
| `missing_indexes` renderSection case + import | Task 3.8 |
| TopN / DB filter bar JSX | Task 3.9 |
| `MissingIndexes.jsx` — all states + force refresh + topN/dbFilter | Task 4.3 |
| `MissingIndexes.test.jsx` — full test coverage | Task 4.1 |

All spec requirements have a corresponding task. ✓

### Type / name consistency

- `sortedByKey.cpu` → uses `conn.sortState.cpu` → defined in AppContext Task 2.9 ✓
- `sortedByKey.tempdb` → uses `conn.sortState.tempdb` → defined in AppContext Task 2.9 ✓
- `VTABLE_SECTION_CFG.cpu_intensive.sortKey = 'cpu'` → `TABLE_COLS.cpu` defined Task 2.2 ✓
- `VTABLE_SECTION_CFG.tempdb_usage.sortKey = 'tempdb'` → `TABLE_COLS.tempdb` defined Task 2.3 ✓
- `m?.cpuExpensive` → returned by server as `cpuExpensive` Task 1.5 ✓
- `m?.tempdbUsage` → returned by server as `tempdbUsage` Task 1.5 ✓
- `MissingIndexes` props: `connId`, `topN`, `dbFilter` → passed from Dashboard Task 3.8, used in component Task 4.3 ✓
