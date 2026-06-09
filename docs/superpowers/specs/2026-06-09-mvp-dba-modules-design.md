# MVP DBA Modules — Design Spec
_2026-06-09_

## Context

Extends the existing SQL Server Activity Monitor with six DBA-focused diagnostic modules answering the questions: which queries are slow, which indexes are missing, what is consuming CPU, why is SQL Server waiting, who is blocking whom, and who is consuming TempDB.

**Approach: Option C — Hybrid.** Reuse existing Socket.io polling infrastructure and widget/section framework. Add two new polled metrics, one on-demand endpoint, and one new frontend component. Align existing sections to the MVP column spec.

---

## Architecture

### Data Delivery

| Module | Delivery | Notes |
|---|---|---|
| Slowest Queries | Socket.io 2s poll | Enhance existing `recentExpensive` |
| CPU Intensive Queries | Socket.io 2s poll | New `cpuExpensive` metric |
| Wait Statistics | Socket.io 2s poll | Existing `resourceWaits` + frontend `wait_pct` |
| Blocking Sessions | Socket.io 2s poll | Existing `blocking` — no change needed |
| TempDB Usage | Socket.io 2s poll | New `tempdbUsage` metric |
| Missing Indexes | On-demand REST | Advisory data; 10-min cache per connection |

Missing Indexes is advisory (query optimizer writes these infrequently). Keeping it off the poll avoids 2s DMV joins and aligns with DBA mental model — you analyse it when you suspect a problem, not watch it tick.

---

## Backend (`server.js`)

### Metric Registry Pattern

Refactor `collectMetrics` from one large `Promise.all` to a named collector map, making Phase 2 additions safe:

```js
const collectors = {
  recentExpensive: pool => pool.request().query(Q.recentExpensive),
  cpuExpensive:    pool => pool.request().query(Q.cpuExpensive),
  resourceWaits:   pool => pool.request().query(Q.resourceWaits),
  blocking:        pool => pool.request().query(Q.blocking),
  tempdbUsage:     pool => pool.request().query(Q.tempdbUsage),
  // ... existing collectors
}
const results = await Promise.all(
  Object.entries(collectors).map(([k, fn]) =>
    fn(pool).catch(() => ({ recordset: [] })).then(r => [k, r.recordset])
  )
)
const metrics = Object.fromEntries(results)
```

Each collector wrapped in `.catch(() => ({ recordset: [] }))` — one failing query never blocks the rest.

---

### Q.recentExpensive — Enhanced

Add three columns to the existing query:

```sql
DB_NAME(qt.dbid)                                          AS database_name,
qs.total_elapsed_time / 1000.0                            AS total_elapsed_ms,
qs.total_worker_time  / 1000.0                            AS total_worker_time
```

Ensure these are already present: `qs.execution_count`, `qs.total_logical_reads`, `qs.last_execution_time`. Add if missing (avoids a second backend change later).

---

### Q.cpuExpensive — New

Same base query as `recentExpensive` (same DMV joins), different `ORDER BY`:

```sql
ORDER BY qs.total_worker_time DESC
```

Expose `avg_cpu_ms` computed column:

```sql
(qs.total_worker_time / NULLIF(qs.execution_count, 0)) / 1000.0 AS avg_cpu_ms
```

Top 50 rows. Added to `collectors` map.

---

### Q.tempdbUsage — New

`sys.dm_db_session_space_usage` does not expose `database_id`, so no database name column.

```sql
SELECT TOP 50
  s.session_id,
  s.login_name,
  s.host_name,
  su.user_objects_alloc_page_count                                          AS user_objects,
  su.internal_objects_alloc_page_count                                      AS internal_objects,
  su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count   AS total_pages,
  (su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count) * 8 AS memory_kb
FROM sys.dm_db_session_space_usage su
JOIN sys.dm_exec_sessions s ON s.session_id = su.session_id
WHERE su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count > 0
ORDER BY total_pages DESC
```

Added to `collectors` map. Broadcast via existing `metrics` Socket.io event as `tempdbUsage`.

---

### GET `/api/connections/:id/missing-indexes` — New Endpoint

**Cache:** in-process `Map<connectionId, { rows, ts }>`. TTL configurable via `MISSING_INDEX_CACHE_MIN` env var, default `10`. Force-refresh: `?force=1`.

**Response shape:**
```json
{
  "rows": [],
  "count": 50,
  "ts": "2026-06-09T10:00:00.000Z",
  "cached": true,
  "ttlMinutes": 10
}
```

**Query:**
```sql
SELECT TOP 50
  DB_NAME(d.database_id)                        AS database_name,
  OBJECT_NAME(d.object_id, d.database_id)       AS table_name,
  d.equality_columns,
  d.inequality_columns,
  d.included_columns,
  gs.user_seeks,
  gs.user_scans,
  CAST(
    gs.avg_total_user_cost * gs.avg_user_impact *
    (gs.user_seeks + gs.user_scans)
  AS DECIMAL(18,2))                             AS estimated_improvement,
  'CREATE INDEX [IX_' +
    OBJECT_NAME(d.object_id, d.database_id) + '_' +
    CAST(d.index_handle AS VARCHAR) + '] ON ' +
    d.statement + ' (' +
    ISNULL(d.equality_columns, '') +
    CASE
      WHEN d.inequality_columns IS NOT NULL AND d.equality_columns IS NOT NULL
      THEN ','
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
ORDER BY estimated_improvement DESC
```

Uses existing `requireConn` helper. Returns 404 if connection not found.

---

## Frontend

### `src/lib/tableCols.js`

#### Update `recent` — add 3 columns

Final column order for `recent`:
```js
{ key: 'database_name',    label: 'Database',            type: 'str'   },
{ key: 'execution_count',  label: 'Executions',          type: 'num'   },
{ key: 'avg_elapsed_ms',   label: 'Avg Elapsed (ms)',    type: 'dec'   },
{ key: 'total_elapsed_ms', label: 'Total Elapsed (ms)',  type: 'dec'   },
{ key: 'avg_cpu_ms',       label: 'Avg CPU (ms)',        type: 'dec'   },
{ key: 'total_worker_time',label: 'Total CPU (ms)',       type: 'dec'   },
{ key: 'avg_logical_reads',label: 'Avg Reads',           type: 'num'   },
{ key: 'last_executed',    label: 'Last Executed',       type: 'str'   },
{ key: 'query_text',       label: 'Query',               type: 'query', maxWidth: 500, truncate: true, tooltip: true },
]
```

#### New `cpu` table

```js
cpu: [
  { key: 'database_name',    label: 'Database',          type: 'str',   },
  { key: 'execution_count',  label: 'Executions',        type: 'num'   },
  { key: 'total_worker_time',label: 'Total CPU (ms)',     type: 'dec'   },
  { key: 'avg_cpu_ms',       label: 'Avg CPU (ms)',       type: 'dec'   },
  { key: 'last_executed',    label: 'Last Executed',      type: 'str'   },
  { key: 'query_text',       label: 'Query',              type: 'query', maxWidth: 500, truncate: true, tooltip: true },
]
```

#### Update `waits` — add percentage column

```js
{ key: 'wait_pct', label: '% of Total', type: 'dec' },
```

`wait_pct` is not returned by the server. It is computed in Dashboard before sort (see §Dashboard).

#### Rename in `tempdb`

`memory_kb` label: `TempDB KB` (not `Mem (KB)`).

#### New `tempdb` table

```js
tempdb: [
  { key: 'session_id',       label: 'Session',      type: 'num' },
  { key: 'login_name',       label: 'Login',        type: 'str' },
  { key: 'host_name',        label: 'Host',         type: 'str' },
  { key: 'user_objects',     label: 'User Obj',     type: 'num' },
  { key: 'internal_objects', label: 'Internal Obj', type: 'num' },
  { key: 'total_pages',      label: 'Pages',        type: 'num' },
  { key: 'memory_kb',        label: 'TempDB KB',    type: 'num' },
]
```

#### New `missing_indexes` table

Used by `MissingIndexes.jsx` directly (not VirtualTable). Defined here for consistency:

```js
missing_indexes: [
  { key: 'database_name',         label: 'Database',        type: 'str'  },
  { key: 'table_name',            label: 'Table',           type: 'str'  },
  { key: 'equality_columns',      label: 'Equality Cols',   type: 'trunc'},
  { key: 'inequality_columns',    label: 'Inequality Cols', type: 'trunc'},
  { key: 'included_columns',      label: 'Included Cols',   type: 'trunc'},
  { key: 'user_seeks',            label: 'Seeks',           type: 'num'  },
  { key: 'estimated_improvement', label: 'Est. Improvement',type: 'dec'  },
]
```

`create_index_sql` is not a display column — used only by the Copy INDEX button.

#### New default sorts

```js
cpu:            { col: 'total_worker_time',     dir: 'desc' },
tempdb:         { col: 'total_pages',           dir: 'desc' },
missing_indexes:{ col: 'estimated_improvement', dir: 'desc' },
```

---

### `src/lib/widgetRegistry.js`

Three new entries, all `defaultEnabled: true`, inserted after existing Queries entries:

```js
{ id: 'cpu_intensive',   label: 'CPU Intensive Queries', group: 'section', category: 'Queries',     defaultEnabled: true },
{ id: 'missing_indexes', label: 'Missing Indexes',        group: 'section', category: 'Maintenance', defaultEnabled: true },
{ id: 'tempdb_usage',    label: 'TempDB Usage',           group: 'section', category: 'Database',    defaultEnabled: true },
```

---

### `src/components/Dashboard.jsx`

#### VTABLE_SECTION_CFG — extension

Add capability flags (metadata-driven behavior, prevents giant switch growth):

```js
// Existing entries gain: supportsTopN, supportsDbFilter, supportsClipboard
cpu_intensive: {
  sectionId: 'cpu',    title: 'CPU Intensive Queries',
  sortKey:   'cpu',    height: 280, metricKey: 'cpuExpensive',
  supportsTopN: true, supportsDbFilter: true, supportsClipboard: true,
},
tempdb_usage: {
  sectionId: 'tempdb', title: 'TempDB Usage',
  sortKey:   'tempdb', height: 280, metricKey: 'tempdbUsage',
  supportsTopN: true,
},
```

#### `wait_pct` injection

Before the `sortedWaits` useMemo, compute percentage client-side:

```js
const waitsWithPct = useMemo(() => {
  const rows = m?.resourceWaits || []
  const total = rows.reduce((s, r) => s + (r.wait_time_ms || 0), 0)
  return rows.map(r => ({
    ...r,
    wait_pct: total > 0 ? +((r.wait_time_ms / total) * 100).toFixed(1) : 0,
  }))
}, [m?.resourceWaits])
// then sort waitsWithPct instead of m?.resourceWaits
```

#### TopN / DB filter bar

State added to Dashboard (not persisted — resets on connection change):

```js
const [topN,     setTopN]     = useState(10)
const [dbFilter, setDbFilter] = useState('')
```

DB name list computed from `recentExpensive + cpuExpensive + blocking` rows present in current metrics (always available via poll). When `MissingIndexes` has loaded results, those rows are also included. TempDB is excluded — session rows don't represent a specific user database. Rendered as a compact strip above `orderedSections`:

```
[Top: 10 ▾]   [Database: All ▾]
```

Helper `applyMvpFilter(rows, topN, dbFilter)` slices and filters. Applied to:
- `sortedRecent`, `sortedCpu`, `sortedBlocking` — via `database_name` key
- MissingIndexes component receives `topN` + `dbFilter` as props

#### Copy SQL — `renderExtraCell`

For `recent_expensive` and `cpu_intensive` cfg entries, set `supportsClipboard: true`. In the cfg-driven render path, when `cfg.supportsClipboard` is set, pass:

```jsx
extraCol
renderExtraCell={row => (
  <button className="copy-btn" onClick={() => navigator.clipboard.writeText(row.query_text || '')}>
    Copy
  </button>
)}
```

#### New renderSection case

```js
case 'missing_indexes':
  return <MissingIndexes key={id} connId={connId} topN={topN} dbFilter={dbFilter} />
```

---

### `src/components/MissingIndexes.jsx` — New

Pattern mirrors `ErrorLog.jsx`.

**States:** `rows`, `loading`, `error`, `meta` (`{ ts, cached, count, ttlMinutes }`)

**UI structure:**
```
[CollapsibleSection title="Missing Indexes" badge=<count>]
  [if !rows] → "Run analysis to identify missing indexes." + [Analyse] button
  [if loading] → spinner + "Analysing…"
  [if error]   → error message + [Retry] button
  [if rows]
    → cache badge: "Cached · Updated HH:MM:SS · TTL Nmin · [Force Refresh]"
    → table (database_name, table_name, equality_columns, inequality_columns,
              included_columns, user_seeks, estimated_improvement, [Copy INDEX])
```

**Analyse button:**
```jsx
<button disabled={loading}>
  {loading ? 'Analysing…' : 'Analyse'}
</button>
```

**Force Refresh:** calls same fetch with `?force=1`, re-runs load flow.

**Copy INDEX button:** `navigator.clipboard.writeText(row.create_index_sql)` per row.

**DB filter / TopN:** applied client-side on `rows` using `topN` and `dbFilter` props.

**Widget registry entry:** `{ id: 'missing_indexes', ... }` (see above).

---

## `src/context/AppContext.jsx`

Add sort state keys for new tables in the connection initializer (wherever `DEFAULT_SORT` is spread):

```js
cpu:            DEFAULT_SORT.cpu,
tempdb:         DEFAULT_SORT.tempdb,
missing_indexes: DEFAULT_SORT.missing_indexes,
```

---

## Files Changed

| File | Change |
|---|---|
| `server.js` | Refactor to collector map; enhance `recentExpensive`; add `cpuExpensive`, `tempdbUsage`; add `/missing-indexes` endpoint with in-process cache |
| `src/lib/tableCols.js` | Update `recent`; add `cpu`, `tempdb`, `missing_indexes` tables; add 3 default sorts |
| `src/lib/widgetRegistry.js` | Add 3 new section entries |
| `src/components/Dashboard.jsx` | Extend `VTABLE_SECTION_CFG`; add `waitsWithPct`; add TopN/DB filter bar + `applyMvpFilter`; add Copy SQL via cfg flags; add `missing_indexes` case |
| `src/context/AppContext.jsx` | Add sort state keys for `cpu`, `tempdb`, `missing_indexes` |
| `src/components/MissingIndexes.jsx` | **New** — on-demand component with cache badge, loading state, Copy INDEX |

---

## Out of Scope (Phase 1)

- Execution plan viewer (Phase 2)
- Historical trend data
- Email / alerting
- Fragmentation analysis
- Agent job monitoring changes
- Index rebuild / reorganize actions
