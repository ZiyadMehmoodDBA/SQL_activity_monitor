# Index Health Expandable Config Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an expand/collapse configuration panel to the Index Health card that lets DBAs select target databases, set a minimum fragmentation threshold, and control scan concurrency — with settings persisted to sessionStorage for the tab lifetime.

**Architecture:** `IndexHealth.jsx` owns all new config state and fetches the DB list lazily on first expand. A new pure-presentational `ScanConfigPanel.jsx` renders the expanded panel. `ScanControls.jsx` gains an expand toggle icon and inline summary text. The backend gains one new endpoint (`GET /databases`) and one modified endpoint (POST scan now forwards `maxConcurrent`).

**Tech Stack:** React 18, Vitest + @testing-library/react (jsdom), vanilla fetch API, Express, mssql (Tedious).

## Global Constraints

- Never commit `.env`, credentials, or secret files.
- All AI-generated SQL must be manually reviewed before `npm start` — per `devInstruction.md`.
- Test runner: `npx vitest run` (runs all tests). Individual file: `npx vitest run src/__tests__/path/file.test.jsx`.
- Inline styles only — no new Tailwind classes in indexHealth components (existing components use inline style objects).
- `sessionStorage` for persistence, not `localStorage`.
- `selectedDbs` is `null` (means "all user DBs — let backend decide") or a `Set<string>` (explicit selection).
- `maxConcurrent` server clamp: min 1, max 8.
- `minFrag` is a **display filter only** — no server param, no reduction in data fetched.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server.js` | Modify | Add `GET /api/connections/:id/databases`; forward `maxConcurrent` in POST scan handler |
| `src/hooks/useIndexHealthApi.js` | Modify | Add `fetchDatabases()`; update `startScan` body to include `maxConcurrent` |
| `src/components/indexHealth/ScanConfigPanel.jsx` | Create | Pure UI: DB checklist, search, bulk selectors, minFrag/maxParallel inputs, action buttons |
| `src/components/indexHealth/ScanControls.jsx` | Modify | Add expand chevron icon + inline `configSummary` display |
| `src/components/IndexHealth.jsx` | Modify | Own config state, DB fetch, session persistence, panel wiring |
| `src/__tests__/hooks/useIndexHealthApi.test.js` | Modify | Tests for `fetchDatabases` + `startScan` with `maxConcurrent` |
| `src/__tests__/components/indexHealth/ScanConfigPanel.test.jsx` | Create | Tests for all ScanConfigPanel behaviours |
| `src/__tests__/components/indexHealth/ScanControls.test.jsx` | Modify | Tests for expand toggle + configSummary |
| `src/__tests__/components/IndexHealth.test.jsx` | Modify | Tests for expand flow, DB fetch, config persistence, minFrag filter |

---

### Task 1: Backend endpoint + hook additions

**Files:**
- Modify: `server.js:1154–1168` (POST scan), after line 1255 (add GET /databases)
- Modify: `src/hooks/useIndexHealthApi.js` (add `fetchDatabases`, update `startScan`)
- Modify: `src/__tests__/hooks/useIndexHealthApi.test.js`

**Interfaces:**
- Produces: `GET /api/connections/:id/databases` → `{ databases: Array<{ name: string, is_system: boolean, state_desc: string, is_read_only: boolean }> }`
- Produces: `useIndexHealthApi` now returns `{ startScan, pollProgress, fetchResults, cancelScan, fetchDatabases }`
- Produces: `startScan({ mode, databases, maxConcurrent? })` — `maxConcurrent` is optional number

- [ ] **Step 1: Write failing tests for `fetchDatabases` and updated `startScan`**

Add these `describe` blocks to `src/__tests__/hooks/useIndexHealthApi.test.js`, after the existing `cancelScan` block:

```js
describe('fetchDatabases', () => {
  it('GETs the databases URL and returns payload', async () => {
    const payload = { databases: [
      { name: 'master', is_system: true,  state_desc: 'ONLINE', is_read_only: false },
      { name: 'Clinical', is_system: false, state_desc: 'ONLINE', is_read_only: false },
    ] }
    mockFetch(200, payload)
    const { result } = renderHook(() => useIndexHealthApi(CONN))
    const res = await result.current.fetchDatabases()
    expect(global.fetch).toHaveBeenCalledWith(`/api/connections/${CONN}/databases`)
    expect(res.databases).toHaveLength(2)
    expect(res.databases[0].name).toBe('master')
  })

  it('throws on non-ok status', async () => {
    mockFetch(500, { error: 'query failed' })
    const { result } = renderHook(() => useIndexHealthApi(CONN))
    await expect(result.current.fetchDatabases()).rejects.toThrow('Failed to load databases: 500')
  })
})

describe('startScan with maxConcurrent', () => {
  it('includes maxConcurrent in POST body when provided', async () => {
    mockFetch(202, { scanId: SCAN_ID })
    const { result } = renderHook(() => useIndexHealthApi(CONN))
    await result.current.startScan({ mode: 'LIMITED', databases: ['Clinical'], maxConcurrent: 5 })
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.maxConcurrent).toBe(5)
    expect(body.databases).toEqual(['Clinical'])
  })

  it('omits maxConcurrent from POST body when not provided', async () => {
    mockFetch(202, { scanId: SCAN_ID })
    const { result } = renderHook(() => useIndexHealthApi(CONN))
    await result.current.startScan({ mode: 'LIMITED', databases: [] })
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.maxConcurrent).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```
npx vitest run src/__tests__/hooks/useIndexHealthApi.test.js
```

Expected: FAIL — `result.current.fetchDatabases is not a function` and `body.maxConcurrent` assertions fail.

- [ ] **Step 3: Update `useIndexHealthApi.js`**

Replace the entire file content:

```js
import { useCallback } from 'react'

export function useIndexHealthApi(connId) {
  const startScan = useCallback(async ({ mode, databases, maxConcurrent }) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        databases,
        ...(maxConcurrent != null ? { maxConcurrent } : {}),
      }),
    })
    if (res.status === 409) {
      const data = await res.json()
      return { conflict: true, scanId: data.scanId }
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Start scan failed: ${res.status}`)
    }
    return await res.json()
  }, [connId])

  const pollProgress = useCallback(async (scanId) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}/progress`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      const err = new Error(data.error || `Progress poll failed: ${res.status}`)
      err.status = res.status
      throw err
    }
    return await res.json()
  }, [connId])

  const fetchResults = useCallback(async (scanId, tab, opts = {}) => {
    const params = new URLSearchParams({ tab, page: opts.page ?? 1, pageSize: opts.pageSize || 50 })
    if (opts.db && opts.db !== 'all') params.set('db', opts.db)
    if (opts.search) params.set('search', opts.search)
    if (opts.rowType) params.set('rowType', opts.rowType)
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}/results?${params}`)
    if (res.status === 404) return { expired: true }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Results fetch failed: ${res.status}`)
    }
    return await res.json()
  }, [connId])

  const cancelScan = useCallback(async (scanId) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Cancel failed: ${res.status}`)
  }, [connId])

  const fetchDatabases = useCallback(async () => {
    const res = await fetch(`/api/connections/${connId}/databases`)
    if (!res.ok) throw new Error(`Failed to load databases: ${res.status}`)
    return res.json()
  }, [connId])

  return { startScan, pollProgress, fetchResults, cancelScan, fetchDatabases }
}
```

- [ ] **Step 4: Run hook tests — verify they pass**

```
npx vitest run src/__tests__/hooks/useIndexHealthApi.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Add `GET /api/connections/:id/databases` to `server.js`**

Find the line `// ─── SPA fallback ───` (line ~1258) and insert **before** it:

```js
// ─── Databases list ───────────────────────────────────────────────────────────
app.get('/api/connections/:id/databases', async (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return
  try {
    const r = await conn.pool.request().query(`
      SELECT
        name,
        CAST(CASE WHEN database_id <= 4 THEN 1 ELSE 0 END AS BIT) AS is_system,
        state_desc,
        is_read_only
      FROM sys.databases
      WHERE state != 6
      ORDER BY CASE WHEN database_id <= 4 THEN 0 ELSE 1 END, name
    `)
    res.json({ databases: r.recordset })
  } catch (err) {
    console.error('[databases]', err.message)
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 6: Forward `maxConcurrent` in the POST scan handler**

In `server.js`, replace lines 1154 and 1168 (the destructure and the `runScan` call):

```js
// replace:
const { mode = 'LIMITED', databases = [] } = req.body
// with:
const { mode = 'LIMITED', databases = [], maxConcurrent } = req.body
```

```js
// replace:
runScan(conn.pool, scanId, scanStore)
  .catch(err => console.error(`[index-health] runScan error ${scanId.slice(0, 8)}:`, err.message))
// with:
const scanOpts = maxConcurrent != null
  ? { maxConcurrent: Math.min(Math.max(1, parseInt(maxConcurrent, 10) || 3), 8) }
  : {}
runScan(conn.pool, scanId, scanStore, scanOpts)
  .catch(err => console.error(`[index-health] runScan error ${scanId.slice(0, 8)}:`, err.message))
```

- [ ] **Step 7: Commit**

```
git add src/hooks/useIndexHealthApi.js src/__tests__/hooks/useIndexHealthApi.test.js server.js
git commit -m "feat: add /databases endpoint and wire maxConcurrent through scan API"
```

---

### Task 2: `ScanConfigPanel.jsx` — pure UI component

**Files:**
- Create: `src/components/indexHealth/ScanConfigPanel.jsx`
- Create: `src/__tests__/components/indexHealth/ScanConfigPanel.test.jsx`

**Interfaces:**
- Consumes props:
  ```
  dbList:              Array<{ name: string, is_system: boolean, state_desc: string, is_read_only: boolean }>
  dbListLoading:       boolean
  dbListError:         string | null
  selectedDbs:         Set<string> | null   (null = no explicit selection yet)
  onSelectedDbsChange: (newSet: Set<string>) => void
  minFrag:             number
  onMinFragChange:     (n: number) => void
  maxParallel:         number
  onMaxParallelChange: (n: number) => void
  onRetryDbFetch:      () => void
  onRunScan:           () => void
  onCancel:            () => void
  onReset:             () => void
  phase:               string
  ```
- Produces: no exports beyond default component

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/components/indexHealth/ScanConfigPanel.test.jsx`:

```jsx
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import ScanConfigPanel from '../../../components/indexHealth/ScanConfigPanel'

const DB_LIST = [
  { name: 'master',   is_system: true,  state_desc: 'ONLINE', is_read_only: false },
  { name: 'tempdb',   is_system: true,  state_desc: 'ONLINE', is_read_only: false },
  { name: 'Clinical', is_system: false, state_desc: 'ONLINE', is_read_only: false },
  { name: 'Billing',  is_system: false, state_desc: 'ONLINE', is_read_only: false },
]

const noop = () => {}

function makeProps(overrides = {}) {
  return {
    dbList: DB_LIST,
    dbListLoading: false,
    dbListError: null,
    selectedDbs: new Set(['Clinical', 'Billing']),
    onSelectedDbsChange: noop,
    minFrag: 10,
    onMinFragChange: noop,
    maxParallel: 3,
    onMaxParallelChange: noop,
    onRetryDbFetch: noop,
    onRunScan: noop,
    onCancel: noop,
    onReset: noop,
    phase: 'idle',
    ...overrides,
  }
}

describe('ScanConfigPanel', () => {
  describe('loading state', () => {
    it('shows loading text when dbListLoading is true', () => {
      render(<ScanConfigPanel {...makeProps({ dbList: [], dbListLoading: true })} />)
      expect(screen.getByText(/loading databases/i)).toBeInTheDocument()
    })
  })

  describe('error state', () => {
    it('shows error message and Retry button', () => {
      render(<ScanConfigPanel {...makeProps({ dbList: [], dbListError: 'Connection refused' })} />)
      expect(screen.getByText(/could not load databases/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    })

    it('calls onRetryDbFetch when Retry clicked', () => {
      const retry = vi.fn()
      render(<ScanConfigPanel {...makeProps({ dbList: [], dbListError: 'err', onRetryDbFetch: retry })} />)
      fireEvent.click(screen.getByRole('button', { name: /retry/i }))
      expect(retry).toHaveBeenCalledTimes(1)
    })
  })

  describe('empty DB list', () => {
    it('shows no-databases message', () => {
      render(<ScanConfigPanel {...makeProps({ dbList: [], selectedDbs: null })} />)
      expect(screen.getByText(/no accessible databases/i)).toBeInTheDocument()
    })
  })

  describe('database list', () => {
    it('renders a checkbox per database', () => {
      render(<ScanConfigPanel {...makeProps()} />)
      expect(screen.getByLabelText('master')).toBeInTheDocument()
      expect(screen.getByLabelText('Clinical')).toBeInTheDocument()
    })

    it('checks boxes for selectedDbs entries', () => {
      render(<ScanConfigPanel {...makeProps()} />)
      expect(screen.getByLabelText('Clinical')).toBeChecked()
      expect(screen.getByLabelText('Billing')).toBeChecked()
      expect(screen.getByLabelText('master')).not.toBeChecked()
    })

    it('shows selected count', () => {
      render(<ScanConfigPanel {...makeProps()} />)
      expect(screen.getByText(/2\s*\/\s*4/)).toBeInTheDocument()
    })

    it('calls onSelectedDbsChange with updated Set when checkbox toggled on', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onSelectedDbsChange: onChange })} />)
      fireEvent.click(screen.getByLabelText('master'))
      const arg = onChange.mock.calls[0][0]
      expect(arg).toBeInstanceOf(Set)
      expect(arg.has('master')).toBe(true)
      expect(arg.has('Clinical')).toBe(true)
    })

    it('calls onSelectedDbsChange with updated Set when checkbox toggled off', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onSelectedDbsChange: onChange })} />)
      fireEvent.click(screen.getByLabelText('Clinical'))
      const arg = onChange.mock.calls[0][0]
      expect(arg.has('Clinical')).toBe(false)
      expect(arg.has('Billing')).toBe(true)
    })
  })

  describe('search', () => {
    it('filters DB list by search input', () => {
      render(<ScanConfigPanel {...makeProps()} />)
      fireEvent.change(screen.getByPlaceholderText(/search databases/i), { target: { value: 'cli' } })
      expect(screen.queryByLabelText('Clinical')).toBeInTheDocument()
      expect(screen.queryByLabelText('master')).not.toBeInTheDocument()
    })

    it('is case-insensitive', () => {
      render(<ScanConfigPanel {...makeProps()} />)
      fireEvent.change(screen.getByPlaceholderText(/search databases/i), { target: { value: 'BILLING' } })
      expect(screen.getByLabelText('Billing')).toBeInTheDocument()
    })
  })

  describe('bulk selectors', () => {
    it('Select All calls onSelectedDbsChange with all DB names', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onSelectedDbsChange: onChange })} />)
      fireEvent.click(screen.getByRole('button', { name: /select all/i }))
      const arg = onChange.mock.calls[0][0]
      expect(arg.size).toBe(4)
    })

    it('Deselect All calls onSelectedDbsChange with empty Set', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onSelectedDbsChange: onChange })} />)
      fireEvent.click(screen.getByRole('button', { name: /deselect all/i }))
      const arg = onChange.mock.calls[0][0]
      expect(arg.size).toBe(0)
    })

    it('System DBs selects only is_system databases', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onSelectedDbsChange: onChange })} />)
      fireEvent.click(screen.getByRole('button', { name: /system dbs/i }))
      const arg = onChange.mock.calls[0][0]
      expect(arg.has('master')).toBe(true)
      expect(arg.has('tempdb')).toBe(true)
      expect(arg.has('Clinical')).toBe(false)
    })

    it('User DBs selects only non-system databases', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onSelectedDbsChange: onChange })} />)
      fireEvent.click(screen.getByRole('button', { name: /user dbs/i }))
      const arg = onChange.mock.calls[0][0]
      expect(arg.has('Clinical')).toBe(true)
      expect(arg.has('master')).toBe(false)
    })
  })

  describe('scan config inputs', () => {
    it('renders minFrag input with current value', () => {
      render(<ScanConfigPanel {...makeProps({ minFrag: 15 })} />)
      expect(screen.getByLabelText(/min fragmentation/i)).toHaveValue(15)
    })

    it('calls onMinFragChange when minFrag input changes', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onMinFragChange: onChange })} />)
      fireEvent.change(screen.getByLabelText(/min fragmentation/i), { target: { value: '20' } })
      expect(onChange).toHaveBeenCalledWith(20)
    })

    it('renders maxParallel input with current value', () => {
      render(<ScanConfigPanel {...makeProps({ maxParallel: 5 })} />)
      expect(screen.getByLabelText(/max parallel/i)).toHaveValue(5)
    })

    it('calls onMaxParallelChange when maxParallel input changes', () => {
      const onChange = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onMaxParallelChange: onChange })} />)
      fireEvent.change(screen.getByLabelText(/max parallel/i), { target: { value: '6' } })
      expect(onChange).toHaveBeenCalledWith(6)
    })
  })

  describe('action buttons', () => {
    it('Run Scan button calls onRunScan', () => {
      const onRun = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onRunScan: onRun })} />)
      fireEvent.click(screen.getByRole('button', { name: /^run scan$/i }))
      expect(onRun).toHaveBeenCalledTimes(1)
    })

    it('Reset Filters button calls onReset', () => {
      const onReset = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onReset })} />)
      fireEvent.click(screen.getByRole('button', { name: /reset filters/i }))
      expect(onReset).toHaveBeenCalledTimes(1)
    })

    it('Cancel button calls onCancel', () => {
      const onCancel = vi.fn()
      render(<ScanConfigPanel {...makeProps({ onCancel })} />)
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
      expect(onCancel).toHaveBeenCalledTimes(1)
    })
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```
npx vitest run src/__tests__/components/indexHealth/ScanConfigPanel.test.jsx
```

Expected: FAIL — `ScanConfigPanel` module not found.

- [ ] **Step 3: Create `src/components/indexHealth/ScanConfigPanel.jsx`**

```jsx
import React, { useState } from 'react'

const BTN = {
  padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
  background: 'var(--badge-bg)', color: 'var(--text-primary)',
  border: '1px solid var(--input-border)', cursor: 'pointer',
}

const INPUT = {
  padding: '4px 8px', borderRadius: 6, fontSize: 12, width: 70,
  background: 'var(--card-bg)', color: 'var(--text-primary)',
  border: '1px solid var(--input-border)',
}

const SECTION_LABEL = {
  fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
}

export default function ScanConfigPanel({
  dbList, dbListLoading, dbListError,
  selectedDbs, onSelectedDbsChange,
  minFrag, onMinFragChange,
  maxParallel, onMaxParallelChange,
  onRetryDbFetch, onRunScan, onCancel, onReset, phase,
}) {
  const [search, setSearch] = useState('')
  const isActive = phase === 'pending' || phase === 'running'

  const filtered = search
    ? dbList.filter(d => d.name.toLowerCase().includes(search.toLowerCase()))
    : dbList

  const effectiveSelected = selectedDbs ?? new Set()
  const selectedCount = effectiveSelected.size
  const totalCount = dbList.length

  function toggle(name) {
    const next = new Set(effectiveSelected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onSelectedDbsChange(next)
  }

  function selectAll()    { onSelectedDbsChange(new Set(dbList.map(d => d.name))) }
  function deselectAll()  { onSelectedDbsChange(new Set()) }
  function selectSystem() { onSelectedDbsChange(new Set(dbList.filter(d => d.is_system).map(d => d.name))) }
  function selectUser()   { onSelectedDbsChange(new Set(dbList.filter(d => !d.is_system).map(d => d.name))) }

  return (
    <div style={{ borderTop: '1px solid var(--divider)', padding: '14px 18px' }}>

      {/* DATABASE SELECTION */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={SECTION_LABEL}>Database Selection</span>
          {totalCount > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
              Selected ({selectedCount}/{totalCount})
            </span>
          )}
        </div>

        {dbListLoading && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Loading databases…</p>
        )}

        {dbListError && !dbListLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#ef4444' }}>Could not load databases.</span>
            <button style={{ ...BTN, color: '#ef4444', border: '1px solid rgba(239,68,68,.3)', background: 'rgba(239,68,68,.08)' }}
              onClick={onRetryDbFetch}>Retry</button>
          </div>
        )}

        {!dbListLoading && !dbListError && totalCount === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No accessible databases found.</p>
        )}

        {!dbListLoading && !dbListError && totalCount > 0 && (
          <>
            <input
              type="text"
              placeholder="Search databases…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...INPUT, width: '100%', marginBottom: 8, boxSizing: 'border-box' }}
            />

            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              <button style={BTN} onClick={selectAll}>Select All</button>
              <button style={BTN} onClick={deselectAll}>Deselect All</button>
              <button style={BTN} onClick={selectSystem}>System DBs</button>
              <button style={BTN} onClick={selectUser}>User DBs</button>
            </div>

            <div style={{
              maxHeight: 240, overflowY: 'auto',
              border: '1px solid var(--divider)', borderRadius: 8,
              padding: '6px 10px',
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '4px 12px',
            }}>
              {filtered.map(db => (
                <label key={db.name} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)', padding: '2px 0' }}>
                  <input
                    type="checkbox"
                    checked={effectiveSelected.has(db.name)}
                    onChange={() => toggle(db.name)}
                  />
                  {db.name}
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {/* SCAN CONFIGURATION */}
      <div style={{ marginBottom: 14 }}>
        <div style={SECTION_LABEL}>Scan Configuration</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)' }}>
            Min Fragmentation %
            <input
              type="number"
              min={0}
              max={100}
              value={minFrag}
              onChange={e => onMinFragChange(parseInt(e.target.value, 10) || 0)}
              style={INPUT}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)' }}>
            Max Parallel DBs
            <input
              type="number"
              min={1}
              max={8}
              value={maxParallel}
              onChange={e => onMaxParallelChange(parseInt(e.target.value, 10) || 1)}
              style={INPUT}
            />
          </label>
        </div>
      </div>

      {/* ACTION BUTTONS */}
      <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--divider)', paddingTop: 12 }}>
        <button
          onClick={onRunScan}
          disabled={isActive}
          style={{ ...BTN, padding: '5px 16px', background: 'var(--accent, #3b82f6)', color: '#fff', border: 'none', opacity: isActive ? 0.5 : 1, cursor: isActive ? 'not-allowed' : 'pointer' }}
        >
          Run Scan
        </button>
        <button
          onClick={onCancel}
          style={BTN}
        >
          Cancel
        </button>
        <button
          onClick={onReset}
          disabled={isActive}
          style={{ ...BTN, opacity: isActive ? 0.5 : 1, cursor: isActive ? 'not-allowed' : 'pointer' }}
        >
          Reset Filters
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

```
npx vitest run src/__tests__/components/indexHealth/ScanConfigPanel.test.jsx
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```
git add src/components/indexHealth/ScanConfigPanel.jsx src/__tests__/components/indexHealth/ScanConfigPanel.test.jsx
git commit -m "feat: add ScanConfigPanel pure UI component with DB selection and scan config"
```

---

### Task 3: Update `ScanControls.jsx` — expand toggle + inline summary

**Files:**
- Modify: `src/components/indexHealth/ScanControls.jsx`
- Modify: `src/__tests__/components/indexHealth/ScanControls.test.jsx`

**Interfaces:**
- Consumes new props: `isExpanded: boolean`, `onToggleExpand: () => void`, `configSummary: string`
- All existing props remain unchanged

- [ ] **Step 1: Add failing tests for new props**

Append to `src/__tests__/components/indexHealth/ScanControls.test.jsx` (after the last `it` block):

```js
describe('expand toggle', () => {
  it('renders expand toggle button', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle"
      onStartScan={noop} onCancelScan={noop}
      isExpanded={false} onToggleExpand={noop} configSummary="" />)
    expect(screen.getByRole('button', { name: /expand scan config/i })).toBeInTheDocument()
  })

  it('toggle button label changes when expanded', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle"
      onStartScan={noop} onCancelScan={noop}
      isExpanded={true} onToggleExpand={noop} configSummary="" />)
    expect(screen.getByRole('button', { name: /collapse scan config/i })).toBeInTheDocument()
  })

  it('calls onToggleExpand when toggle clicked', () => {
    const onToggle = vi.fn()
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle"
      onStartScan={noop} onCancelScan={noop}
      isExpanded={false} onToggleExpand={onToggle} configSummary="" />)
    fireEvent.click(screen.getByRole('button', { name: /expand scan config/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('toggle button is disabled when phase is running', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="running"
      onStartScan={noop} onCancelScan={noop}
      isExpanded={false} onToggleExpand={noop} configSummary="" />)
    expect(screen.getByRole('button', { name: /expand scan config/i })).toBeDisabled()
  })

  it('renders configSummary text when non-empty', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle"
      onStartScan={noop} onCancelScan={noop}
      isExpanded={false} onToggleExpand={noop} configSummary="8 DBs · Standard" />)
    expect(screen.getByText('8 DBs · Standard')).toBeInTheDocument()
  })

  it('does not render summary text when configSummary is empty', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle"
      onStartScan={noop} onCancelScan={noop}
      isExpanded={false} onToggleExpand={noop} configSummary="" />)
    expect(screen.queryByText(/DBs/)).not.toBeInTheDocument()
  })
})
```

Also update all existing tests to pass the new required props by adding them to each `render` call. The simplest approach: add `isExpanded={false} onToggleExpand={noop} configSummary=""` to every existing `render(<ScanControls .../>)` call in the file.

- [ ] **Step 2: Run tests — verify new tests fail, existing pass**

```
npx vitest run src/__tests__/components/indexHealth/ScanControls.test.jsx
```

Expected: New `expand toggle` tests FAIL. Existing tests may pass or fail depending on whether new props are required.

- [ ] **Step 3: Replace `ScanControls.jsx`**

```jsx
import React from 'react'

const MODES = [
  { value: 'LIMITED',  label: 'LIMITED — fastest, page count only' },
  { value: 'SAMPLED',  label: 'SAMPLED — sample fragmentation' },
  { value: 'DETAILED', label: 'DETAILED — full scan, slowest' },
]

const ACTIVE_PHASES = new Set(['pending', 'running'])
const TERMINAL_DONE = new Set(['completed', 'completed_with_warnings'])

export default function ScanControls({
  mode, onModeChange, phase, onStartScan, onCancelScan,
  isExpanded = false, onToggleExpand = () => {}, configSummary = '',
}) {
  const isActive = ACTIVE_PHASES.has(phase)
  const isDone   = TERMINAL_DONE.has(phase)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {configSummary && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
          {configSummary}
        </span>
      )}

      <select
        value={mode}
        disabled={isActive}
        onChange={e => onModeChange(e.target.value)}
        style={{
          padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 500,
          background: 'var(--card-bg)', color: 'var(--text-primary)',
          border: '1px solid var(--input-border)', cursor: isActive ? 'not-allowed' : 'pointer',
          opacity: isActive ? 0.5 : 1,
        }}
      >
        {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>

      {isActive ? (
        <button
          aria-label="Cancel scan"
          onClick={onCancelScan}
          style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            background: 'rgba(239,68,68,.12)', color: '#ef4444',
            border: '1px solid rgba(239,68,68,.3)', cursor: 'pointer' }}
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={onStartScan}
          style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            background: 'var(--badge-bg)', color: 'var(--text-primary)',
            border: '1px solid var(--input-border)', cursor: 'pointer' }}
        >
          {isDone ? 'Run New Scan' : 'Run Scan'}
        </button>
      )}

      <button
        aria-label={isExpanded ? 'Collapse scan config' : 'Expand scan config'}
        disabled={isActive}
        onClick={onToggleExpand}
        style={{
          padding: '5px 8px', borderRadius: 8, fontSize: 12, fontWeight: 600,
          background: 'var(--badge-bg)', color: 'var(--text-muted)',
          border: '1px solid var(--input-border)',
          cursor: isActive ? 'not-allowed' : 'pointer',
          opacity: isActive ? 0.5 : 1,
          display: 'flex', alignItems: 'center',
        }}
      >
        <svg
          width={14} height={14}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
          style={{ transition: 'transform 250ms ease-in-out', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — verify all pass**

```
npx vitest run src/__tests__/components/indexHealth/ScanControls.test.jsx
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```
git add src/components/indexHealth/ScanControls.jsx src/__tests__/components/indexHealth/ScanControls.test.jsx
git commit -m "feat: add expand toggle and config summary to ScanControls"
```

---

### Task 4: Wire `IndexHealth.jsx` — config state, DB fetch, session persistence, panel rendering

**Files:**
- Modify: `src/components/IndexHealth.jsx`
- Modify: `src/__tests__/components/IndexHealth.test.jsx`

**Interfaces:**
- Consumes: `fetchDatabases` from `useIndexHealthApi` (Task 1)
- Consumes: `ScanConfigPanel` (Task 2)
- Consumes: `ScanControls` new props `isExpanded`, `onToggleExpand`, `configSummary` (Task 3)

- [ ] **Step 1: Add failing tests for new IndexHealth behaviours**

Append to `src/__tests__/components/IndexHealth.test.jsx`:

```jsx
describe('IndexHealth expand/config', () => {
  function mockFetchIdle() {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ databases: [] }) })
    )
  }

  it('renders expand toggle button in idle phase', () => {
    render(<IndexHealth connId="conn-1" />)
    expect(screen.getByRole('button', { name: /expand scan config/i })).toBeInTheDocument()
  })

  it('shows ScanConfigPanel after expand toggle clicked', async () => {
    const dbPayload = { databases: [
      { name: 'Clinical', is_system: false, state_desc: 'ONLINE', is_read_only: false },
    ] }
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(dbPayload) })
    )
    render(<IndexHealth connId="conn-1" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /expand scan config/i }))
    })
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search databases/i)).toBeInTheDocument()
    })
  })

  it('fetches DB list from /databases endpoint on first expand', async () => {
    const dbPayload = { databases: [
      { name: 'db1', is_system: false, state_desc: 'ONLINE', is_read_only: false },
    ] }
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(dbPayload) })
    )
    render(<IndexHealth connId="conn-1" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /expand scan config/i }))
    })
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/connections/conn-1/databases')
    })
  })

  it('does not re-fetch DB list on second expand', async () => {
    const dbPayload = { databases: [
      { name: 'db1', is_system: false, state_desc: 'ONLINE', is_read_only: false },
    ] }
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(dbPayload) })
    )
    render(<IndexHealth connId="conn-1" />)

    // expand
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /expand scan config/i })) })
    await waitFor(() => expect(screen.getByPlaceholderText(/search databases/i)).toBeInTheDocument())

    // collapse
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /collapse scan config/i })) })

    const callCountAfterFirstExpand = global.fetch.mock.calls.filter(c => c[0].includes('/databases')).length

    // expand again
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /expand scan config/i })) })

    const callCountAfterSecondExpand = global.fetch.mock.calls.filter(c => c[0].includes('/databases')).length
    expect(callCountAfterSecondExpand).toBe(callCountAfterFirstExpand)
  })

  it('restores config from sessionStorage on mount', () => {
    sessionStorage.setItem('index-health-config-conn-cfg', JSON.stringify({
      selectedDbs: ['ClinicalDB'],
      minFrag: 20,
      maxParallel: 5,
    }))
    render(<IndexHealth connId="conn-cfg" />)
    // configSummary should include "1 DBs" since selectedDbs is restored as Set with 1 entry
    expect(screen.getByText(/1 dbs/i)).toBeInTheDocument()
  })

  it('includes databases and maxConcurrent in startScan call', async () => {
    sessionStorage.setItem('index-health-config-conn-2', JSON.stringify({
      selectedDbs: ['db1', 'db2'],
      minFrag: 10,
      maxParallel: 4,
    }))
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ scanId: 'scan-x' }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ status: 'running', pct: 0, currentDb: null, completedDbs: 0, totalDbs: 0, timedOutDbs: [], eta: null }) })

    render(<IndexHealth connId="conn-2" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
    })

    const postCall = global.fetch.mock.calls.find(c => c[0].includes('/index-health/scan') && c[1]?.method === 'POST')
    expect(postCall).toBeTruthy()
    const body = JSON.parse(postCall[1].body)
    expect(body.databases).toEqual(expect.arrayContaining(['db1', 'db2']))
    expect(body.maxConcurrent).toBe(4)
  })
})
```

- [ ] **Step 2: Run tests — verify new tests fail, existing pass**

```
npx vitest run src/__tests__/components/IndexHealth.test.jsx
```

Expected: New `IndexHealth expand/config` tests FAIL. Existing tests PASS.

- [ ] **Step 3: Replace `IndexHealth.jsx`**

```jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useIndexHealthApi } from '../hooks/useIndexHealthApi'
import ScanControls from './indexHealth/ScanControls'
import ScanConfigPanel from './indexHealth/ScanConfigPanel'
import ScanProgress from './indexHealth/ScanProgress'
import HealthScore from './indexHealth/HealthScore'
import SummaryStrip from './indexHealth/SummaryStrip'
import IndexInventory from './indexHealth/IndexInventory'
import DetailModal from './indexHealth/DetailModal'

function sessionKey(connId)  { return `index-health-scan-${connId}` }
function configKey(connId)   { return `index-health-config-${connId}` }

function pollInterval(pct) {
  if (pct < 40) return 2000
  if (pct < 80) return 5000
  return 10000
}

function Banner({ color, children }) {
  return (
    <div style={{ marginBottom: 10, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500,
      background: `${color}14`, border: `1px solid ${color}44`, color }}>
      {children}
    </div>
  )
}

const TERMINAL = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled', 'expired'])

export default function IndexHealth({ connId }) {
  const [phase, setPhase]                     = useState('idle')
  const [scanId, setScanId]                   = useState(null)
  const [mode, setMode]                       = useState('LIMITED')
  const [progress, setProgress]               = useState(null)
  const [summary, setSummary]                 = useState(null)
  const [metadata, setMetadata]               = useState(null)
  const [timedOutDbs, setTimedOutDbs]         = useState([])
  const [error, setError]                     = useState(null)
  const [activeTab, setActiveTab]             = useState('fragmented')
  const [inventoryPage, setInventoryPage]     = useState(1)
  const [inventoryFilter, setInventoryFilter] = useState({ db: 'all', search: '' })
  const [inventoryData, setInventoryData]     = useState(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [selectedRow, setSelectedRow]         = useState(null)

  // Config state
  const [isExpanded,    setIsExpanded]    = useState(false)
  const [dbList,        setDbList]        = useState([])
  const [dbListLoading, setDbListLoading] = useState(false)
  const [dbListError,   setDbListError]   = useState(null)
  const [selectedDbs,   setSelectedDbs]   = useState(null)
  const [minFrag,       setMinFrag]       = useState(10)
  const [maxParallel,   setMaxParallel]   = useState(3)

  const pollRef = useRef(null)

  const { startScan, pollProgress, fetchResults, cancelScan, fetchDatabases } = useIndexHealthApi(connId)

  const loadInventory = useCallback(async (sid, tab, pg, filter) => {
    setInventoryLoading(true)
    try {
      const serverTab = (tab === 'unused' || tab === 'duplicate') ? 'unusedAndDuplicate' : tab
      const rowType = tab === 'unused' ? 'unused' : tab === 'duplicate' ? 'duplicate' : undefined
      const res = await fetchResults(sid, serverTab, { page: pg, pageSize: 50, rowType, ...filter })
      if (res.expired) {
        setPhase('expired')
        sessionStorage.removeItem(sessionKey(connId))
        return
      }
      if (res.timedOutDbs) setTimedOutDbs(res.timedOutDbs)
      if (res.summary)     setSummary(res.summary)
      if (res.metadata)    setMetadata(res.metadata)
      const rawData = res.fragmented || res.missing || res.unusedAndDuplicate
      const rows = rawData?.rows ?? []
      setInventoryData({ rows, total: rawData?.total ?? 0, page: rawData?.page ?? 1, pageSize: rawData?.pageSize ?? 50 })
    } catch {
      // non-fatal — keep existing data
    } finally {
      setInventoryLoading(false)
    }
  }, [connId, fetchResults])

  // Reset state on connection switch, then restore config + check for scan recovery
  useEffect(() => {
    setPhase('idle')
    setScanId(null)
    setProgress(null)
    setSummary(null)
    setMetadata(null)
    setTimedOutDbs([])
    setError(null)
    setInventoryData(null)
    setSelectedRow(null)
    setActiveTab('fragmented')
    setInventoryPage(1)
    setInventoryFilter({ db: 'all', search: '' })
    setIsExpanded(false)
    setDbList([])
    setDbListLoading(false)
    setDbListError(null)

    // Restore config from sessionStorage
    const savedConfig = sessionStorage.getItem(configKey(connId))
    if (savedConfig) {
      try {
        const { selectedDbs: dbs, minFrag: mf, maxParallel: mp } = JSON.parse(savedConfig)
        setSelectedDbs(dbs ? new Set(dbs) : null)
        if (mf != null) setMinFrag(mf)
        if (mp != null) setMaxParallel(mp)
      } catch {
        setSelectedDbs(null)
        setMinFrag(10)
        setMaxParallel(3)
      }
    } else {
      setSelectedDbs(null)
      setMinFrag(10)
      setMaxParallel(3)
    }

    const saved = sessionStorage.getItem(sessionKey(connId))
    if (!saved) return
    setScanId(saved)
    setPhase('running')
  }, [connId])

  // Persist config changes
  useEffect(() => {
    sessionStorage.setItem(configKey(connId), JSON.stringify({
      selectedDbs: selectedDbs ? [...selectedDbs] : null,
      minFrag,
      maxParallel,
    }))
  }, [selectedDbs, minFrag, maxParallel, connId])

  // Polling loop
  useEffect(() => {
    if (!scanId) return
    if (!['pending', 'running'].includes(phase)) return

    let alive = true

    async function tick() {
      if (!alive) return
      try {
        const prog = await pollProgress(scanId)
        if (!alive) return
        setProgress(prog)
        if (TERMINAL.has(prog.status)) {
          setPhase(prog.status)
          return
        }
        pollRef.current = setTimeout(tick, pollInterval(prog.pct ?? 0))
      } catch (err) {
        if (!alive) return
        if (err?.status === 404 || err?.message?.includes('404')) {
          setPhase('expired')
          sessionStorage.removeItem(sessionKey(connId))
          return
        }
        pollRef.current = setTimeout(tick, 10000)
      }
    }

    tick()
    return () => {
      alive = false
      clearTimeout(pollRef.current)
    }
  }, [scanId, phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load initial results when scan completes
  useEffect(() => {
    if (!scanId) return
    if (phase !== 'completed' && phase !== 'completed_with_warnings') return
    loadInventory(scanId, 'fragmented', 1, { db: 'all', search: '' })
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear sessionStorage for terminal non-result states
  useEffect(() => {
    if (phase === 'failed' || phase === 'cancelled' || phase === 'expired') {
      sessionStorage.removeItem(sessionKey(connId))
    }
  }, [phase, connId])

  const fetchDbList = useCallback(async () => {
    setDbListLoading(true)
    setDbListError(null)
    try {
      const data = await fetchDatabases()
      setDbList(data.databases)
      if (selectedDbs === null) {
        setSelectedDbs(new Set(data.databases.filter(d => !d.is_system).map(d => d.name)))
      }
    } catch (err) {
      setDbListError(err.message)
    } finally {
      setDbListLoading(false)
    }
  }, [fetchDatabases, selectedDbs])

  function handleToggleExpand() {
    const next = !isExpanded
    setIsExpanded(next)
    if (next && dbList.length === 0 && !dbListLoading) {
      fetchDbList()
    }
  }

  async function handleStartScan() {
    setError(null)
    setSummary(null)
    setMetadata(null)
    setInventoryData(null)
    setProgress(null)
    setTimedOutDbs([])
    setActiveTab('fragmented')
    setInventoryPage(1)
    setInventoryFilter({ db: 'all', search: '' })
    setPhase('pending')
    setIsExpanded(false)
    try {
      const res = await startScan({
        mode,
        databases: selectedDbs ? [...selectedDbs] : [],
        maxConcurrent: maxParallel,
      })
      if (res.conflict) {
        setScanId(res.scanId)
        setPhase('running')
        sessionStorage.setItem(sessionKey(connId), res.scanId)
        return
      }
      setScanId(res.scanId)
      sessionStorage.setItem(sessionKey(connId), res.scanId)
    } catch (err) {
      setError(err.message)
      setPhase('failed')
    }
  }

  async function handleCancelScan() {
    if (!scanId) return
    try {
      await cancelScan(scanId)
    } catch {}
    setPhase('cancelled')
    sessionStorage.removeItem(sessionKey(connId))
  }

  function handleReset() {
    const userDbs = dbList.filter(d => !d.is_system).map(d => d.name)
    setSelectedDbs(userDbs.length > 0 ? new Set(userDbs) : null)
    setMinFrag(10)
    setMaxParallel(3)
    sessionStorage.removeItem(configKey(connId))
  }

  function handleTabChange(tab) {
    setActiveTab(tab)
    setInventoryPage(1)
    if (scanId && (phase === 'completed' || phase === 'completed_with_warnings')) {
      loadInventory(scanId, tab, 1, inventoryFilter)
    }
  }

  function handlePageChange(pg) {
    setInventoryPage(pg)
    if (scanId && (phase === 'completed' || phase === 'completed_with_warnings')) {
      loadInventory(scanId, activeTab, pg, inventoryFilter)
    }
  }

  function handleFilterChange(filter) {
    setInventoryFilter(filter)
    setInventoryPage(1)
    if (scanId && (phase === 'completed' || phase === 'completed_with_warnings')) {
      loadInventory(scanId, activeTab, 1, filter)
    }
  }

  // Apply minFrag display filter reactively — no re-fetch needed
  const displayInventoryData = useMemo(() => {
    if (!inventoryData || activeTab !== 'fragmented' || minFrag <= 0) return inventoryData
    return {
      ...inventoryData,
      rows: inventoryData.rows.filter(r => (r.avg_fragmentation_in_percent ?? 0) >= minFrag),
    }
  }, [inventoryData, activeTab, minFrag])

  const configSummary = useMemo(() => {
    const parts = []
    if (selectedDbs !== null) parts.push(`${selectedDbs.size} DBs`)
    if (mode === 'SAMPLED')   parts.push('Standard')
    if (mode === 'DETAILED')  parts.push('Detailed')
    if (minFrag !== 10)       parts.push(`≥${minFrag}%`)
    return parts.join(' · ')
  }, [selectedDbs, mode, minFrag])

  const hasResults = phase === 'completed' || phase === 'completed_with_warnings'
  const isActive   = phase === 'pending' || phase === 'running'

  return (
    <div style={{ background: 'var(--card-bg)', borderRadius: 12, border: '1px solid var(--divider)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: isExpanded ? '1px solid var(--divider)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Index Health</span>
        <ScanControls
          mode={mode}
          onModeChange={setMode}
          phase={phase}
          onStartScan={handleStartScan}
          onCancelScan={handleCancelScan}
          isExpanded={isExpanded}
          onToggleExpand={handleToggleExpand}
          configSummary={configSummary}
        />
      </div>

      {/* Expand panel */}
      <div style={{
        maxHeight: isExpanded ? '700px' : '0',
        overflow: 'hidden',
        transition: 'max-height 250ms ease-in-out',
      }}>
        <ScanConfigPanel
          dbList={dbList}
          dbListLoading={dbListLoading}
          dbListError={dbListError}
          selectedDbs={selectedDbs}
          onSelectedDbsChange={setSelectedDbs}
          minFrag={minFrag}
          onMinFragChange={setMinFrag}
          maxParallel={maxParallel}
          onMaxParallelChange={setMaxParallel}
          onRetryDbFetch={fetchDbList}
          onRunScan={handleStartScan}
          onCancel={() => setIsExpanded(false)}
          onReset={handleReset}
          phase={phase}
        />
      </div>

      {/* Body */}
      <div style={{ padding: '14px 18px' }}>
        {phase === 'expired' && (
          <Banner color="#6b7280">Scan results have expired. Run a new scan to refresh.</Banner>
        )}
        {phase === 'failed' && error && (
          <Banner color="#ef4444">Scan failed: {error}</Banner>
        )}
        {timedOutDbs.length > 0 && hasResults && (
          <Banner color="#f59e0b">
            {timedOutDbs.length} database{timedOutDbs.length > 1 ? 's' : ''} timed out during scan: {timedOutDbs.join(', ')}
          </Banner>
        )}

        {isActive && <ScanProgress phase={phase} progress={progress} />}

        {hasResults && summary && (
          <>
            <HealthScore summary={summary} />
            <SummaryStrip summary={summary} timedOutDbs={timedOutDbs} />
            <IndexInventory
              activeTab={activeTab}
              onTabChange={handleTabChange}
              data={displayInventoryData}
              loading={inventoryLoading}
              filter={inventoryFilter}
              onFilterChange={handleFilterChange}
              page={inventoryPage}
              onPageChange={handlePageChange}
              summary={summary}
              onRowClick={row => setSelectedRow({ ...row, _tab: activeTab })}
            />
          </>
        )}
      </div>

      {selectedRow && <DetailModal row={selectedRow} onClose={() => setSelectedRow(null)} />}
    </div>
  )
}
```

- [ ] **Step 4: Run all IndexHealth tests — verify they pass**

```
npx vitest run src/__tests__/components/IndexHealth.test.jsx
```

Expected: All tests PASS.

- [ ] **Step 5: Run full test suite — verify no regressions**

```
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```
git add src/components/IndexHealth.jsx src/__tests__/components/IndexHealth.test.jsx
git commit -m "feat: wire expandable config panel into IndexHealth with DB fetch and session persistence"
```

---

## Post-Implementation Verification

After all tasks complete:

1. Start dev server: `npm run dev` (or `npm start`)
2. Open the dashboard in a browser
3. Verify collapsed state: Index Health card shows mode dropdown + Run Scan + expand chevron
4. Click chevron: panel animates open, loading spinner appears, then DB list populates
5. Select a subset of databases, change Max Parallel DBs to 5, click Run Scan
6. Verify panel collapses and scan starts; progress bar appears
7. Reload page: config summary should show in header (restored from sessionStorage)
8. Expand again: DB selection should match what was set before reload
9. Click Reset Filters: summary clears, user DBs re-selected
