# Query Optimization Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Query Optimization" section above SQL Agent Jobs with three stacked full-width summary widgets: Longest Blocked Queries, Top CPU Queries, Top I/O Queries.

**Architecture:** server.js gains one new DMV query (`Q.ioExpensive`) and one new column (`parent_object`) on `Q.blocking`; both flow through the existing 2s poll → Socket.io `metrics` broadcast. A new `QueryOptimizationSection.jsx` component renders three plain (non-virtualized, max 10 rows) tables styled like JobsPanel cards. Widget header click scrolls to the corresponding existing collapsible section via a new `id` anchor on `CollapsibleSection`. Toggle via a new `query_optimization` panel entry in widgetRegistry.

**Tech Stack:** Node/Express + mssql (backend), React 18 + Tailwind classes + CSS vars (frontend), Vitest + @testing-library/react (jsdom) for tests.

**User decisions (locked):**
- Click navigation = smooth-scroll to existing section (Widget 1 → Blocking Chains, Widget 2 → CPU Intensive Queries, Widget 3 → Recent Expensive Queries). No new pages.
- Layout = three full-width cards stacked vertically, placed immediately above the SQL Agent Jobs row.

**Constraints (from CLAUDE.md / user global rules):**
- All AI-generated SQL must be manually reviewed by the user before `npm start`. Flag this at handoff.
- Never `git add .` / `git add -A` — stage files by name.
- No `USE [medcare_db]` statements anywhere (queries here are DMV-only, no USE needed).
- Pre-existing test failures NOT to touch: `WhoIsActive.test.jsx` (4 tests) and `tests/server/*` suites reporting "0 test". Baseline: 165 passed / 4 failed.

---

### Task 1: Backend — `Q.ioExpensive` query, `parent_object` on `Q.blocking`, wire into poll loop

**Files:**
- Modify: `server.js` (Q.blocking at ~line 401; insert Q.ioExpensive after Q.cpuExpensive which ends ~line 328; collectMetrics destructure ~line 588, Promise.all list, payload ~line 722)

There is no working server-side test harness (`tests/server/*` suites are broken pre-existing, report "0 test"). Verification = `node --check server.js` + build still passes.

- [ ] **Step 1: Add `parent_object` column to `Q.blocking`**

In `server.js`, the `blocking` query (~line 401) currently selects `blocked_query` as its last column via `OUTER APPLY sys.dm_exec_sql_text(bc.sql_handle) t`. The alias `t` exposes `objectid`/`dbid` for the BLOCKED statement. Edit the SELECT list: after the `blocked_query` column expression (ends with `,''),300) AS blocked_query`), add a comma and:

```sql
      CASE
        WHEN t.objectid IS NULL THEN 'Unknown'
        ELSE ISNULL(OBJECT_NAME(t.objectid, t.dbid), 'Unknown')
      END                                                                  AS parent_object
```

(i.e. the old last column `blocked_query` gets a trailing comma, `parent_object` becomes the new last column before `FROM sys.dm_exec_requests bc`.)

- [ ] **Step 2: Add `Q.ioExpensive` query**

In `server.js`, immediately after the `cpuExpensive` query (ends `ORDER BY qs.total_worker_time DESC` + backtick + comma, ~line 328), insert:

```js
  ioExpensive: `
    SELECT TOP 50
      ISNULL(DB_NAME(st.dbid),'')                                              AS database_name,
      qs.execution_count,
      qs.total_logical_reads,
      qs.total_physical_reads,
      CAST(qs.total_logical_reads / NULLIF(qs.execution_count,0) AS FLOAT)     AS avg_logical_reads,
      CONVERT(VARCHAR(23),qs.last_execution_time,121)                          AS last_executed,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),150) AS query_text,
      CASE
        WHEN st.objectid IS NULL THEN 'Unknown'
        ELSE ISNULL(OBJECT_NAME(st.objectid, st.dbid), 'Unknown')
      END                                                                      AS parent_object
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count > 0
    ORDER BY qs.total_logical_reads DESC`,
```

Note: matches `cpuExpensive` patterns exactly (statement-offset substring, cross-db-safe `OBJECT_NAME(id, dbid)`, 1-hour window). No `USE` statement — DMVs are server-scoped.

- [ ] **Step 3: Wire into `collectMetrics`**

Three edits in `server.js` `collectMetrics` (~line 586):

1. Destructure (line 588) — append `, ioExpensiveR` after `tempdbR`:
```js
  const [cpuR, ovR, ioR, procR, waitR, curWaitR, fileR, recentR, activeR, dbSizesR, blockingR, deadlocksR, perfR, jobsR, diskR, backupHealthR, cpuExpensiveR, tempdbR, ioExpensiveR] = await Promise.all([
```

2. Promise.all array — after the `Q.tempdbUsage` line (~606), add:
```js
    req().query(Q.ioExpensive).catch(err => { console.error('[ioExpensive]', err.message); return { recordset: [] }; }),
```

3. Return payload — after `tempdbUsage:     tempdbR.recordset,` (~line 723), add:
```js
    ioExpensive:     ioExpensiveR.recordset,
```

- [ ] **Step 4: Verify syntax**

Run: `node --check server.js`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(server): add ioExpensive query, parent_object on blocking"
```

---

### Task 2: `QueryOptimizationSection` component (TDD)

**Files:**
- Create: `src/components/QueryOptimizationSection.jsx`
- Test: `src/__tests__/components/QueryOptimizationSection.test.jsx`

Design mirrors JobsPanel card pattern: `mc` card class, header row with uppercase 12px semibold title + count badge (red alert style for blocked count), compact rows. Only 10 rows max so plain `<table>` — no virtualizer, no jsdom mocking needed.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/components/QueryOptimizationSection.test.jsx`:

```jsx
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import QueryOptimizationSection from '../../components/QueryOptimizationSection'

afterEach(cleanup)

const blockingRows = Array.from({ length: 12 }, (_, i) => ({
  blocked_session_id: 100 + i,
  blocking_session_id: 55,
  wait_time: (12 - i) * 1000,
  database_name: 'medcare_db_dev',
  blocked_query: `SELECT ${i} FROM dbo.Orders`,
  parent_object: i % 2 ? 'usp_GetOrders' : 'Unknown',
}))

const cpuRows = Array.from({ length: 12 }, (_, i) => ({
  execution_count: 10 + i,
  total_worker_time: (12 - i) * 500,
  avg_cpu_ms: 42.5,
  query_text: `EXEC dbo.CpuProc${i}`,
  query_text_full: `EXEC dbo.CpuProc${i} -- full`,
  parent_object: `CpuProc${i}`,
  database_name: 'medcare_db_dev',
}))

const ioRows = Array.from({ length: 12 }, (_, i) => ({
  total_logical_reads: (12 - i) * 1000,
  total_physical_reads: (12 - i) * 10,
  query_text: `SELECT io ${i}`,
  parent_object: 'Unknown',
  database_name: 'medcare_db_dev',
}))

function renderSection(props = {}) {
  return render(
    <QueryOptimizationSection
      blocking={blockingRows}
      cpuRows={cpuRows}
      ioRows={ioRows}
      {...props}
    />
  )
}

describe('QueryOptimizationSection', () => {
  it('renders the three widget titles and section heading', () => {
    renderSection()
    expect(screen.getByText('Query Optimization')).toBeTruthy()
    expect(screen.getByText('Queries Longest Time Being Blocked')).toBeTruthy()
    expect(screen.getByText('Queries Using the Most CPU')).toBeTruthy()
    expect(screen.getByText('Queries Using the Most I/O')).toBeTruthy()
  })

  it('shows blocked count badge with full row count (not the top-10 slice)', () => {
    renderSection()
    expect(screen.getByTestId('badge-blocked').textContent).toBe('12')
  })

  it('caps each widget at 10 rows', () => {
    renderSection()
    const table = screen.getByTestId('widget-table-blocked')
    expect(table.querySelectorAll('tbody tr').length).toBe(10)
  })

  it('renders empty state when a widget has no rows', () => {
    renderSection({ blocking: [] })
    expect(screen.getByText('No blocked queries')).toBeTruthy()
    expect(screen.getByTestId('badge-blocked').textContent).toBe('0')
  })

  it('converts wait_time ms to seconds in the blocked widget', () => {
    renderSection({ blocking: [{ ...blockingRows[0], wait_time: 12500 }] })
    expect(screen.getByText('12.5')).toBeTruthy()
  })

  it('header click scrolls to the matching section anchor', () => {
    const anchor = document.createElement('div')
    anchor.id = 'section-anchor-blocking'
    anchor.scrollIntoView = vi.fn()
    document.body.appendChild(anchor)
    renderSection()
    fireEvent.click(screen.getByText('Queries Longest Time Being Blocked'))
    expect(anchor.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    anchor.remove()
  })

  it('header click on missing anchor does not throw', () => {
    renderSection()
    expect(() => fireEvent.click(screen.getByText('Queries Using the Most CPU'))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/components/QueryOptimizationSection.test.jsx`
Expected: FAIL — cannot resolve `../../components/QueryOptimizationSection`.

- [ ] **Step 3: Write the component**

Create `src/components/QueryOptimizationSection.jsx`:

```jsx
import React from 'react'

const TH = {
  padding: '5px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '.04em', color: 'var(--text-muted)', textAlign: 'left',
  whiteSpace: 'nowrap', borderBottom: '1px solid var(--divider)',
}
const TD = {
  padding: '5px 12px', fontSize: 11.5, color: 'var(--text-primary)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  borderBottom: '1px solid var(--divider)',
}

const fmtInt = v => (v == null ? '' : Number(v).toLocaleString())

const BLOCKED_COLS = [
  { key: 'blocked_query',       label: 'Query Information', width: '40%',
    render: r => r.blocked_query || '', title: r => r.blocked_query || '' },
  { key: 'wait_time',           label: 'Blocked (sec)', num: true,
    render: r => ((r.wait_time || 0) / 1000).toFixed(1) },
  { key: 'blocking_session_id', label: 'Blocker SPID', num: true,
    render: r => r.blocking_session_id },
  { key: 'database_name',       label: 'Database',
    render: r => r.database_name || '' },
  { key: 'parent_object',       label: 'Parent Object',
    render: r => r.parent_object || '' },
]

const CPU_COLS = [
  { key: 'query_text',        label: 'Query Information', width: '40%',
    render: r => r.query_text || '', title: r => r.query_text_full || r.query_text || '' },
  { key: 'execution_count',   label: 'Executions', num: true,
    render: r => fmtInt(r.execution_count) },
  { key: 'total_worker_time', label: 'Total CPU (ms)', num: true,
    render: r => fmtInt(Math.round(r.total_worker_time || 0)) },
  { key: 'avg_cpu_ms',        label: 'Avg CPU (ms)', num: true,
    render: r => (r.avg_cpu_ms == null ? '' : Number(r.avg_cpu_ms).toFixed(1)) },
  { key: 'parent_object',     label: 'Parent Object',
    render: r => r.parent_object || '' },
]

const IO_COLS = [
  { key: 'query_text',           label: 'Query Information', width: '40%',
    render: r => r.query_text || '', title: r => r.query_text || '' },
  { key: 'total_logical_reads',  label: 'Logical Reads', num: true,
    render: r => fmtInt(r.total_logical_reads) },
  { key: 'total_physical_reads', label: 'Physical Reads', num: true,
    render: r => fmtInt(r.total_physical_reads) },
  { key: 'parent_object',        label: 'Parent Object',
    render: r => r.parent_object || '' },
]

function OptimizationWidget({ title, testId, badgeCount, badgeAlert, columns, rows, targetSectionId, emptyText }) {
  const top = rows.slice(0, 10)
  const navigate = () => {
    document.getElementById(`section-anchor-${targetSectionId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const alert = badgeAlert && badgeCount > 0
  return (
    <div className="mc overflow-hidden">
      <button type="button" onClick={navigate} title="Go to detailed section"
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
        style={{ borderBottom: '1px solid var(--divider)', background: 'transparent', cursor: 'pointer' }}>
        <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
          {title}
        </span>
        <span data-testid={`badge-${testId}`}
          className="text-xs px-2 py-0.5 rounded font-semibold tabular-nums ml-1"
          style={alert
            ? { background: 'rgba(239,68,68,.15)', color: '#ef4444' }
            : { background: 'var(--badge-bg)', color: 'var(--badge-text)' }}>
          {badgeCount}
        </span>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)' }}>view details →</span>
      </button>
      {top.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table data-testid={`widget-table-${testId}`}
            style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c.key} style={{ ...TH, width: c.width, textAlign: c.num ? 'right' : 'left' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {top.map((row, i) => (
                <tr key={i}>
                  {columns.map(c => (
                    <td key={c.key}
                      style={{ ...TD, textAlign: c.num ? 'right' : 'left', ...(c.num ? { fontVariantNumeric: 'tabular-nums' } : {}) }}
                      title={c.title ? c.title(row) : undefined}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function LongestBlockedQueriesWidget({ rows }) {
  const sorted = [...rows].sort((a, b) => (b.wait_time || 0) - (a.wait_time || 0))
  return (
    <OptimizationWidget title="Queries Longest Time Being Blocked" testId="blocked"
      badgeCount={rows.length} badgeAlert
      columns={BLOCKED_COLS} rows={sorted}
      targetSectionId="blocking" emptyText="No blocked queries" />
  )
}

export function CpuIntensiveQueriesWidget({ rows }) {
  return (
    <OptimizationWidget title="Queries Using the Most CPU" testId="cpu"
      badgeCount={rows.length}
      columns={CPU_COLS} rows={rows}
      targetSectionId="cpu" emptyText="No query data" />
  )
}

export function IoIntensiveQueriesWidget({ rows }) {
  return (
    <OptimizationWidget title="Queries Using the Most I/O" testId="io"
      badgeCount={rows.length}
      columns={IO_COLS} rows={rows}
      targetSectionId="recent" emptyText="No query data" />
  )
}

export default function QueryOptimizationSection({ blocking, cpuRows, ioRows }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 px-0.5 mb-3">
        <span className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Query Optimization
        </span>
      </div>
      <div className="space-y-6">
        <LongestBlockedQueriesWidget rows={blocking} />
        <CpuIntensiveQueriesWidget rows={cpuRows} />
        <IoIntensiveQueriesWidget rows={ioRows} />
      </div>
    </div>
  )
}
```

Notes for the implementer:
- `cpuRows` arrive pre-sorted by `total_worker_time DESC` from the server; `ioRows` pre-sorted by `total_logical_reads DESC`. Only the blocking rows are re-sorted client-side (the blocking metric is sorted by wait_time server-side too, but the defensive sort is what the badge/top-10 test exercises and is cheap on ≤50 rows).
- Widget 3 targets `section-anchor-recent` (Recent Expensive Queries) because no dedicated I/O section exists.
- Auto-refresh is free: props come from the live `metrics` socket payload re-rendered every 2s.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/components/QueryOptimizationSection.test.jsx`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/QueryOptimizationSection.jsx src/__tests__/components/QueryOptimizationSection.test.jsx
git commit -m "feat(query-optimization): blocked/cpu/io summary widgets with tests"
```

---

### Task 3: Integration — anchor id, registry entry, Dashboard mount

**Files:**
- Modify: `src/components/CollapsibleSection.jsx:14`
- Modify: `src/lib/widgetRegistry.js:17` (insert before `jobs_panel`)
- Modify: `src/components/Dashboard.jsx` (import ~line 12, `showJobs` block ~line 347, render ~line 726)

- [ ] **Step 1: Add scroll anchor id to CollapsibleSection**

In `src/components/CollapsibleSection.jsx`, change line 14:

```jsx
    <div className="mc overflow-hidden">
```

to:

```jsx
    <div className="mc overflow-hidden" id={`section-anchor-${sectionId}`}>
```

- [ ] **Step 2: Register the widget**

In `src/lib/widgetRegistry.js`, insert before the `jobs_panel` line (line 17), so menu order matches page order:

```js
  { id: 'query_optimization', label: 'Query Optimization',       group: 'panel',   category: 'Performance', defaultEnabled: true },
```

`loadLayout()` already appends new registry IDs for users with stored layouts — no migration needed.

- [ ] **Step 3: Mount in Dashboard**

In `src/components/Dashboard.jsx`:

1. After `import JobsPanel from './JobsPanel'` (line 12), add:
```jsx
import QueryOptimizationSection from './QueryOptimizationSection'
```

2. After `const showJobs     = on('jobs_panel')` (line 347), add:
```jsx
  const showQueryOpt = on('query_optimization')
```

3. Immediately before the `{/* Row 3: Jobs + Sessions */}` comment (line 726), add:
```jsx
      {/* Query Optimization widgets */}
      {showQueryOpt && (
        <QueryOptimizationSection
          blocking={m?.blocking || []}
          cpuRows={m?.cpuExpensive || []}
          ioRows={m?.ioExpensive || []}
        />
      )}
```

- [ ] **Step 4: Build**

Run: `npx vite build`
Expected: success (bundle ~1030 kB, same warnings as baseline).

- [ ] **Step 5: Full test suite — no regressions**

Run: `npx vitest run`
Expected: 172 passed / 4 failed (baseline 165 + 7 new; the 4 pre-existing WhoIsActive failures and "0 test" server suites are NOT regressions — do not fix them).

- [ ] **Step 6: Commit**

```bash
git add src/components/CollapsibleSection.jsx src/lib/widgetRegistry.js src/components/Dashboard.jsx
git commit -m "feat(dashboard): mount Query Optimization section above SQL Agent Jobs"
```

---

## Manual verification (user, after implementation)

1. **Review the new SQL** in server.js (`Q.ioExpensive` + the `parent_object` addition to `Q.blocking`) before `npm start` — per repo AI-SQL review policy.
2. `npm start`, connect, verify:
   - Query Optimization section appears above SQL Agent Jobs, three stacked cards.
   - Blocked widget badge red when blocking exists, shows total blocked count; rows capped at 10; durations in seconds.
   - CPU widget tooltip on Query Information shows full text.
   - Clicking each widget header smooth-scrolls to Blocking Chains / CPU Intensive Queries / Recent Expensive Queries.
   - Toggle "Query Optimization" off in the widget menu hides the section.
   - Data refreshes with the 2s poll.
