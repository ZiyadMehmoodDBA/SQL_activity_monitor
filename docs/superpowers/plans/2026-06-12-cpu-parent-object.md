# CPU Intensive Queries — Parent Object Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Copy action in the CPU Intensive Queries grid with Parent Object / Object Type columns plus a full-query-text modal, so users can see where high-CPU queries originate.

**Architecture:** Extend the existing `Q.cpuExpensive` DMV query in `server.js` to resolve the containing module (`sys.dm_exec_sql_text.objectid` → `OBJECT_NAME` + module-stats DMVs for type). Frontend stays on the generic `VirtualTable` + `VTABLE_SECTION_CFG` pattern — no dedicated `CpuIntensiveQueriesTable` component (deviation from spec; existing pattern wins). A new small `QueryTextModal` shows the full statement; `VirtualTable` gains an optional per-column `titleFn` for row-aware tooltips.

**Tech Stack:** Node/Express + mssql (backend poll loop), React 18 + @tanstack/react-virtual + Radix Dialog, Vitest + @testing-library/react.

---

## Spec deviations (agreed limitations)

1. **Object types implemented:** `Stored Procedure`, `Trigger`, `Function`, `Ad Hoc Query`, `Unknown`. The spec's `View`, `SQL Agent Job`, `Dynamic SQL`, `External Process` types are **not resolvable** from `sys.dm_exec_query_stats`: `sql_text.objectid` is only populated for executable modules (procs/triggers/functions). Views compile into the referencing statement; job/host attribution needs session-level data not present in query stats.
2. **Full query text capped at 4000 chars** — payload travels over Socket.io every 2s × up to 50 rows.
3. **No dedicated `CpuIntensiveQueriesTable` component** — grid stays generic `VirtualTable` driven by `VTABLE_SECTION_CFG`, consistent with every other section.
4. **AI-generated SQL review policy (CLAUDE.md):** the Task 1 SQL must be manually reviewed by the developer before `npm start` against any instance. It is read-only DMV access, no `USE` statement.

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `server.js` (Q.cpuExpensive, ~line 288) | Modify | Resolve parent object name/schema/type in SQL |
| `src/components/VirtualTable.jsx` | Modify | Optional `titleFn(row)` per column for tooltips |
| `src/components/QueryTextModal.jsx` | Create | Modal showing full query text, formatting preserved |
| `src/lib/tableCols.js` | Modify | New `cpu` column set |
| `src/components/Dashboard.jsx` | Modify | Replace Copy with View button + modal state |
| `src/__tests__/components/VirtualTable.test.jsx` | Create | titleFn behavior |
| `src/__tests__/components/QueryTextModal.test.jsx` | Create | Modal render/close |
| `src/__tests__/lib/tableCols.test.js` | Create | cpu column contract |

---

### Task 1: Backend — extend `Q.cpuExpensive`

**Files:**
- Modify: `server.js:288-302` (the `cpuExpensive` key inside the `Q` object)

No automated test — `Q` is not exported and the query needs a live SQL Server. Verification is manual review (project policy) + browser check in Task 6.

- [ ] **Step 1: Replace the `cpuExpensive` query**

Replace the entire `cpuExpensive: \`...\`` entry with:

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
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),150) AS query_text,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),4000) AS query_text_full,
      CASE
        WHEN st.objectid IS NULL THEN 'Unknown'
        ELSE ISNULL(OBJECT_NAME(st.objectid, st.dbid), 'Unknown')
      END                                                                      AS parent_object,
      ISNULL(OBJECT_SCHEMA_NAME(st.objectid, st.dbid),'')                      AS schema_name,
      st.objectid                                                              AS object_id,
      CASE
        WHEN st.objectid IS NULL OR OBJECT_NAME(st.objectid, st.dbid) IS NULL THEN 'Ad Hoc Query'
        WHEN ot.type_desc LIKE '%STORED_PROCEDURE' THEN 'Stored Procedure'
        WHEN ot.type_desc LIKE '%TRIGGER'          THEN 'Trigger'
        WHEN ot.type_desc LIKE '%FUNCTION'         THEN 'Function'
        ELSE 'Unknown'
      END                                                                      AS object_type
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    OUTER APPLY (
      SELECT TOP 1 t.type_desc FROM (
        SELECT type_desc FROM sys.dm_exec_procedure_stats WHERE object_id = st.objectid AND database_id = st.dbid
        UNION ALL
        SELECT type_desc FROM sys.dm_exec_trigger_stats   WHERE object_id = st.objectid AND database_id = st.dbid
        UNION ALL
        SELECT type_desc FROM sys.dm_exec_function_stats  WHERE object_id = st.objectid AND database_id = st.dbid
      ) t
    ) ot
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count > 0
    ORDER BY qs.total_worker_time DESC`,
```

Notes for the implementer:
- `query_text` shrinks from 300 → 150 chars (spec: "first 100 to 150 characters"); `query_text_full` carries up to 4000 chars of the *statement* (not the whole batch).
- `OBJECT_NAME(id, dbid)` / `OBJECT_SCHEMA_NAME(id, dbid)` are cross-database safe. They return NULL if the module was dropped or the login lacks metadata visibility — that NULL routes to the `'Unknown'` / `'Ad Hoc Query'` fallback (AC6).
- The `OUTER APPLY` over `dm_exec_procedure_stats` / `dm_exec_trigger_stats` / `dm_exec_function_stats` (all keyed by `database_id, object_id`) avoids join fan-out from multiple cached plans per module. If a module's stats entry was evicted, type falls back to `'Unknown'` while the name still resolves.
- Read-only DMV access; needs only `VIEW SERVER STATE` (already required). No `USE` statement.

- [ ] **Step 2: Manual SQL review checkpoint**

Per CLAUDE.md policy, present the SQL diff to the developer for review BEFORE running `npm start`. Do not start the server against any instance until reviewed.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): resolve parent object and type for CPU intensive queries"
```

---

### Task 2: `VirtualTable` — per-column `titleFn` tooltips

**Files:**
- Modify: `src/components/VirtualTable.jsx`
- Test: `src/__tests__/components/VirtualTable.test.jsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/components/VirtualTable.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import VirtualTable from '../../components/VirtualTable'

// jsdom has no layout, so the virtualizer would return zero items. Mock it
// to emit one virtual row per data row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, key: i, start: i * 32, size: 32 })),
  }),
}))

const rows = [
  { parent_object: 'usp_ImportClaims', schema_name: 'dbo', object_id: 245575913, database_name: 'Medcare_DB', query_text: 'INSERT INTO #T SELECT 1', query_text_full: 'INSERT INTO #T\nSELECT 1' },
]

describe('VirtualTable titleFn', () => {
  it('uses titleFn result as tooltip on a default (str) cell', () => {
    const columns = [
      { key: 'parent_object', label: 'Parent Object', type: 'str',
        titleFn: r => `Schema: ${r.schema_name}\nObject Id: ${r.object_id}\nDatabase: ${r.database_name}` },
    ]
    render(<VirtualTable rows={rows} columns={columns} />)
    expect(screen.getByText('usp_ImportClaims'))
      .toHaveAttribute('title', 'Schema: dbo\nObject Id: 245575913\nDatabase: Medcare_DB')
  })

  it('overrides the built-in title on a query cell with titleFn result', () => {
    const columns = [
      { key: 'query_text', label: 'Query Information', type: 'query', titleFn: r => r.query_text_full },
    ]
    render(<VirtualTable rows={rows} columns={columns} />)
    expect(screen.getByText('INSERT INTO #T SELECT 1'))
      .toHaveAttribute('title', 'INSERT INTO #T\nSELECT 1')
  })

  it('keeps default behavior when titleFn absent', () => {
    const columns = [{ key: 'parent_object', label: 'Parent Object', type: 'str' }]
    render(<VirtualTable rows={rows} columns={columns} />)
    const el = screen.getByText('usp_ImportClaims')
    expect(el).not.toHaveAttribute('title')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/components/VirtualTable.test.jsx`
Expected: FAIL — first two tests fail (no `title` attribute / wrong title); third may pass.

- [ ] **Step 3: Implement `titleFn` in `VirtualTable.jsx`**

Change `fmtCell` signature and the three title-bearing cases (`query`, `trunc`, `default`), and thread the override from the cell render. Diff against current file:

```jsx
function fmtCell(val, type, titleOverride) {
```

In `case 'query'` change the span's `title`:

```jsx
          title={titleOverride ?? text}
```

In `case 'trunc'` change the span's `title`:

```jsx
          title={titleOverride ?? s}
```

Replace the `default` case:

```jsx
    default: {
      const s = String(val) || <span style={{ color: 'var(--text-muted)', opacity: .4 }}>—</span>
      return titleOverride ? <span title={titleOverride}>{s}</span> : s
    }
```

In the row render (currently `fmtCell(row[c.key], c.type)` at ~line 171), pass the override:

```jsx
                      {columns.map(c => (
                        <td key={c.key} className="vt-td" style={{ width: c.width }}>
                          {fmtCell(row[c.key], c.type, c.titleFn ? (c.titleFn(row) || undefined) : undefined)}
                        </td>
                      ))}
```

(`|| undefined` so an empty-string tooltip doesn't render an empty title attribute.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/components/VirtualTable.test.jsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/VirtualTable.jsx src/__tests__/components/VirtualTable.test.jsx
git commit -m "feat(virtual-table): per-column titleFn for row-aware tooltips"
```

---

### Task 3: `QueryTextModal` component

**Files:**
- Create: `src/components/QueryTextModal.jsx`
- Test: `src/__tests__/components/QueryTextModal.test.jsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/components/QueryTextModal.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QueryTextModal from '../../components/QueryTextModal'

const row = {
  parent_object: 'usp_ImportClaims',
  object_type: 'Stored Procedure',
  query_text: 'INSERT INTO #TempHoldClaimsNo SELECT *',
  query_text_full: 'INSERT INTO #TempHoldClaimsNo\nSELECT *\nFROM Max_Claims\nWHERE 1 = 1',
}

describe('QueryTextModal', () => {
  it('renders nothing when row is null', () => {
    render(<QueryTextModal row={null} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows full query text with formatting preserved', () => {
    render(<QueryTextModal row={row} onClose={() => {}} />)
    const pre = screen.getByTestId('query-full-text')
    expect(pre.textContent).toBe(row.query_text_full)
    expect(pre.tagName).toBe('PRE')
  })

  it('shows parent object and type in the title', () => {
    render(<QueryTextModal row={row} onClose={() => {}} />)
    expect(screen.getByText(/usp_ImportClaims/)).toBeInTheDocument()
    expect(screen.getByText(/Stored Procedure/)).toBeInTheDocument()
  })

  it('falls back to query_text when query_text_full missing', () => {
    render(<QueryTextModal row={{ ...row, query_text_full: undefined }} onClose={() => {}} />)
    expect(screen.getByTestId('query-full-text').textContent).toBe(row.query_text)
  })

  it('calls onClose when dialog dismissed', () => {
    const onClose = vi.fn()
    render(<QueryTextModal row={row} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/components/QueryTextModal.test.jsx`
Expected: FAIL with "Failed to resolve import ... QueryTextModal"

- [ ] **Step 3: Implement `src/components/QueryTextModal.jsx`**

```jsx
import React from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogClose } from './ui/Dialog'

export default function QueryTextModal({ row, onClose }) {
  return (
    <Dialog open={!!row} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl" style={{ maxWidth: 720 }}>
        <DialogHeader>
          <DialogTitle>
            {row?.parent_object && row.parent_object !== 'Unknown' ? row.parent_object : 'Query Text'}
            {row?.object_type && (
              <span className="ml-2 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {row.object_type}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <pre
            data-testid="query-full-text"
            className="text-xs rounded-lg p-3"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              maxHeight: 420,
              overflow: 'auto',
              background: 'var(--divider)',
              color: 'var(--text-secondary)',
            }}
          >
            {row?.query_text_full || row?.query_text || ''}
          </pre>
          <div className="flex justify-end mt-4">
            <DialogClose asChild>
              <button
                className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--divider)', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}
              >
                Close
              </button>
            </DialogClose>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/components/QueryTextModal.test.jsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/QueryTextModal.jsx src/__tests__/components/QueryTextModal.test.jsx
git commit -m "feat(dashboard): query text modal with formatting preserved"
```

---

### Task 4: `tableCols.js` — new `cpu` column set

**Files:**
- Modify: `src/lib/tableCols.js:58-65` (the `cpu` array)
- Test: `src/__tests__/lib/tableCols.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/lib/tableCols.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { TABLE_COLS, DEFAULT_SORT } from '../../lib/tableCols'

describe('TABLE_COLS.cpu', () => {
  it('matches the spec grid layout order', () => {
    expect(TABLE_COLS.cpu.map(c => c.key)).toEqual([
      'database_name', 'execution_count', 'total_worker_time', 'avg_cpu_ms',
      'last_executed', 'query_text', 'parent_object', 'object_type',
    ])
  })

  it('query_text tooltip shows the full statement', () => {
    const col = TABLE_COLS.cpu.find(c => c.key === 'query_text')
    expect(col.titleFn({ query_text: 'short', query_text_full: 'SELECT 1\nFROM t' })).toBe('SELECT 1\nFROM t')
    expect(col.titleFn({ query_text: 'short' })).toBe('short')
  })

  it('parent_object tooltip shows schema, object id, database when resolved', () => {
    const col = TABLE_COLS.cpu.find(c => c.key === 'parent_object')
    expect(col.titleFn({ schema_name: 'dbo', object_id: 245575913, database_name: 'Medcare_DB' }))
      .toBe('Schema: dbo\nObject Id: 245575913\nDatabase: Medcare_DB')
    expect(col.titleFn({ object_id: null })).toBe('')
  })

  it('cpu default sort unchanged', () => {
    expect(DEFAULT_SORT.cpu).toEqual({ col: 'total_worker_time', dir: 'desc' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/lib/tableCols.test.js`
Expected: FAIL — column list mismatch, `titleFn` undefined.

- [ ] **Step 3: Replace the `cpu` array in `src/lib/tableCols.js`**

```js
  cpu: [
    { key: 'database_name',    label: 'Database',          type: 'str' },
    { key: 'execution_count',  label: 'Executions',        type: 'num' },
    { key: 'total_worker_time',label: 'Total CPU (ms)',    type: 'dec' },
    { key: 'avg_cpu_ms',       label: 'Avg CPU (ms)',      type: 'dec' },
    { key: 'last_executed',    label: 'Last Executed',     type: 'str' },
    { key: 'query_text',       label: 'Query Information', type: 'query', maxWidth: 500, truncate: true, tooltip: true,
      titleFn: row => row.query_text_full || row.query_text || '' },
    { key: 'parent_object',    label: 'Parent Object',     type: 'trunc',
      titleFn: row => row.object_id
        ? `Schema: ${row.schema_name || ''}\nObject Id: ${row.object_id}\nDatabase: ${row.database_name || ''}`
        : '' },
    { key: 'object_type',      label: 'Object Type',       type: 'str' },
  ],
```

Note: `parent_object` uses `type: 'trunc'` so long names ellipsize; `titleFn` overrides trunc's default self-title. No JSX in this file — `titleFn` returns plain strings only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/lib/tableCols.test.js`
Expected: PASS (4 tests)

Note: when `titleFn` returns `''` (unresolved object), the VirtualTable call site converts it to `undefined`, so the trunc cell falls back to its own self-title. Intended.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tableCols.js src/__tests__/lib/tableCols.test.js
git commit -m "feat(dashboard): cpu grid columns for parent object and type"
```

---

### Task 5: Dashboard wiring — View button replaces Copy

**Files:**
- Modify: `src/components/Dashboard.jsx`

Changes (no new automated test — Dashboard has no test harness; covered by component tests above + manual verification in Task 6):

- [ ] **Step 1: Import + state**

Add import near the other component imports at the top of `Dashboard.jsx`:

```jsx
import QueryTextModal from './QueryTextModal'
```

Add state next to the other `useState` calls (~line 299):

```jsx
  const [queryView, setQueryView] = useState(null)   // null | row object
```

- [ ] **Step 2: Update `VTABLE_SECTION_CFG.cpu_intensive` (~line 276)**

Remove `supportsClipboard: true`, add `supportsQueryView: true`:

```js
  cpu_intensive:    { sectionId: 'cpu',       title: 'CPU Intensive Queries',    sortKey: 'cpu',       height: 280, metricKey: 'cpuExpensive',  supportsTopN: true, supportsDbFilter: true, supportsQueryView: true },
```

(`recent_expensive` keeps its Copy button — only the CPU grid changes.)

- [ ] **Step 3: Add the View button branch in `renderSection`**

In the cfg branch's `<VirtualTable ...>` props, after the existing `supportsClipboard` spread, add:

```jsx
            {...(cfg.supportsQueryView ? {
              extraCol: true,
              renderExtraCell: row => (
                <button className="copy-btn" onClick={() => setQueryView(row)}>View</button>
              ),
            } : {})}
```

- [ ] **Step 4: Mount the modal**

In the returned JSX, next to the existing kill dialogs (top of the `return` block):

```jsx
      <QueryTextModal row={queryView} onClose={() => setQueryView(null)} />
```

- [ ] **Step 5: Build check**

Run: `npx vite build`
Expected: `✓ built` with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dashboard.jsx
git commit -m "feat(dashboard): replace cpu grid copy with parent-object view modal"
```

---

### Task 6: Verification

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all NEW tests pass. Known pre-existing failures (do not fix in this plan): `WhoIsActive.test.jsx` (4 tests) and `tests/server/*` suites reporting 0 tests.

- [ ] **Step 2: Manual browser verification (requires live SQL Server + reviewed SQL)**

After the developer approves the Task 1 SQL: `npm start`, open dashboard, connect, expand CPU Intensive Queries. Verify:
- AC1: no Copy button in CPU grid (Recent Expensive still has Copy)
- AC2: Query Information column shows truncated statement
- AC3/AC4: Parent Object + Object Type populated for proc-sourced queries; ad hoc rows show `Unknown` / `Ad Hoc Query` (AC6)
- AC5: hover on Query Information shows full statement; View opens modal with line breaks preserved
- Parent Object hover shows `Schema / Object Id / Database`
- Sorting on new columns works; Top/Database filters still apply

- [ ] **Step 3: Final commit if any fixups**

```bash
git add <touched files>
git commit -m "fix(dashboard): cpu parent object verification fixups"
```

---

## Acceptance criteria → task map

| AC | Covered by |
|----|-----------|
| AC1 Copy removed | Task 5 step 2-3 |
| AC2 query info shown | Task 1 (query_text 150), Task 4 (column) |
| AC3 parent object attempt | Task 1 (OBJECT_NAME resolution) |
| AC4 object type shown | Task 1 (CASE mapping), Task 4 |
| AC5 full text tooltip + modal | Task 2 (titleFn), Task 3 (modal), Task 4 (titleFn wiring) |
| AC6 Unknown / Ad Hoc fallback | Task 1 (CASE fallbacks) |
| AC7 origin visible at a glance | Sum of above; manual check Task 6 |
