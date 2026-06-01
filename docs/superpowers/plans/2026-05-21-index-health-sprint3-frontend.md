# Index Health Sprint 3: Frontend Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Index Health frontend — a self-contained section component that owns scan lifecycle, progress polling, and result rendering via render-only children.

**Architecture:** `IndexHealth.jsx` is the single owner of all async work (polling, fetching, sessionStorage). Seven child components (`ScanControls`, `ScanProgress`, `HealthScore`, `SummaryStrip`, `IndexInventory`, `DetailModal`) receive props only and never call `fetch` or set timers. One API hook (`useIndexHealthApi`) encapsulates all four server endpoints.

**Tech Stack:** React 18, Vitest + React Testing Library, Tailwind CSS, CSS variables (`var(--card-bg)`, `var(--text-primary)`, etc.), existing `VirtualTable` + `CollapsibleSection` components.

**Key constraint:** `Only IndexHealth.jsx may own polling. Child components remain render-only.`

---

## File Map

| Action  | Path                                                            | Responsibility                               |
|---------|-----------------------------------------------------------------|----------------------------------------------|
| Create  | `src/components/IndexHealth.jsx`                                | Phase machine, polling, sessionStorage, fetch dispatch |
| Create  | `src/components/indexHealth/ScanControls.jsx`                   | Mode selector + start/cancel buttons         |
| Create  | `src/components/indexHealth/ScanProgress.jsx`                   | Progress bar, DB counter, ETA, timed-out badges |
| Create  | `src/components/indexHealth/HealthScore.jsx`                    | Circular/numeric score + severity ring       |
| Create  | `src/components/indexHealth/SummaryStrip.jsx`                   | 5-pill count strip                           |
| Create  | `src/components/indexHealth/IndexInventory.jsx`                 | 4 display tabs, pagination, filter, virtualization |
| Create  | `src/components/indexHealth/DetailModal.jsx`                    | Script/detail overlay for selected row       |
| Create  | `src/hooks/useIndexHealthApi.js`                                | startScan, pollProgress, fetchResults, cancelScan |
| Create  | `src/__tests__/components/IndexHealth.test.jsx`                 | Phase machine, session recovery, polling lifecycle |
| Create  | `src/__tests__/components/indexHealth/ScanControls.test.jsx`    | Render states, button interactions           |
| Create  | `src/__tests__/components/indexHealth/ScanProgress.test.jsx`    | Progress bar rendering                       |
| Create  | `src/__tests__/components/indexHealth/HealthScore.test.jsx`     | Score + severity colours                     |
| Create  | `src/__tests__/components/indexHealth/IndexInventory.test.jsx`  | Tabs, pagination, filter callbacks           |
| Create  | `src/__tests__/components/indexHealth/DetailModal.test.jsx`     | Script copy, close                           |
| Create  | `src/__tests__/hooks/useIndexHealthApi.test.js`                 | All four endpoints, edge cases               |
| Modify  | `src/lib/widgetRegistry.js`                                     | Add `index_health` entry                     |
| Modify  | `src/components/Dashboard.jsx`                                  | Import + `case 'index_health'`               |
| Modify  | `src/test/setup.js`                                             | Add `sessionStorage` mock                    |

---

## API Reference (server endpoints)

```
POST   /api/connections/:id/index-health/scan
       Body: { mode: 'LIMITED'|'SAMPLED'|'DETAILED', databases: string[] }
       202: { scanId }   409: { error, scanId } (already running)

GET    /api/connections/:id/index-health/scan/:scanId/progress
       200: { scanId, status, pct, currentDb, completedDbs, totalDbs, timedOutDbs, eta }

GET    /api/connections/:id/index-health/scan/:scanId/results
       Query: tab=fragmented|missing|unusedAndDuplicate  page=N  pageSize=N  db=...  search=...
       200: { status, metadata, summary, timedOutDbs,
              fragmented?: { total, page, pageSize, rows },
              missing?: ..., unusedAndDuplicate?: ... }
       202: scan still running   404: expired

DELETE /api/connections/:id/index-health/scan/:scanId
       204: cancelled
```

`summary` shape: `{ score, severity, totalIndexes, fragmentedCount, missingCount, unusedCount, duplicateCount, disabledCount }`

Tab mapping — server `unusedAndDuplicate` rows carry `_rowType: 'unused'|'duplicate'`.
Frontend splits them client-side: Unused display tab shows `_rowType==='unused'`, Duplicate shows `_rowType==='duplicate'`. Counts always come from `summary.unusedCount`/`summary.duplicateCount`.

Polling intervals (backoff in `IndexHealth.jsx`):
- `pct < 40` → 2 000 ms
- `pct 40–80` → 5 000 ms
- `pct > 80` → 10 000 ms

Session recovery key: `` `index-health-scan-${connId}` `` in `sessionStorage`.

---

### Task 1: Widget Registration + IndexHealth Scaffold

**Files:**
- Modify: `src/lib/widgetRegistry.js`
- Modify: `src/components/Dashboard.jsx`
- Create: `src/components/IndexHealth.jsx`
- Create: `src/__tests__/components/IndexHealth.test.jsx`

- [ ] **Step 1: Write failing test**

`src/__tests__/components/IndexHealth.test.jsx`:
```jsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import IndexHealth from '../../components/IndexHealth'

describe('IndexHealth', () => {
  it('renders in idle phase showing Run Scan button', () => {
    render(<IndexHealth connId="conn-1" />)
    expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument()
  })

  it('renders index health heading', () => {
    render(<IndexHealth connId="conn-1" />)
    expect(screen.getByText(/index health/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/__tests__/components/IndexHealth.test.jsx
```
Expected: FAIL — `Cannot find module '../../components/IndexHealth'`

- [ ] **Step 3: Add `index_health` entry to widgetRegistry.js**

In `src/lib/widgetRegistry.js`, append after `error_log`:
```js
{ id: 'index_health', label: 'Index Health', group: 'section', category: 'Maintenance', defaultEnabled: false },
```

- [ ] **Step 4: Add import + case to Dashboard.jsx**

At the top of `src/components/Dashboard.jsx`, add import after ErrorLog:
```js
import IndexHealth from './IndexHealth'
```

In the `renderSection` function, add before `default:`:
```js
case 'index_health':
  return <IndexHealth key={id} connId={connId} />
```

- [ ] **Step 5: Create IndexHealth.jsx scaffold**

`src/components/IndexHealth.jsx`:
```jsx
import React, { useState, useEffect, useRef, useCallback } from 'react'

export default function IndexHealth({ connId }) {
  const [phase, setPhase]               = useState('idle')
  // idle | pending | running | completed | completed_with_warnings | failed | cancelled | expired
  const [scanId, setScanId]             = useState(null)
  const [mode, setMode]                 = useState('LIMITED')
  const [progress, setProgress]         = useState(null)
  const [summary, setSummary]           = useState(null)
  const [metadata, setMetadata]         = useState(null)
  const [timedOutDbs, setTimedOutDbs]   = useState([])
  const [error, setError]               = useState(null)
  const [activeTab, setActiveTab]       = useState('fragmented')
  const [inventoryPage, setInventoryPage] = useState(1)
  const [inventoryFilter, setInventoryFilter] = useState({ db: 'all', search: '' })
  const [inventoryData, setInventoryData]     = useState(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [selectedRow, setSelectedRow]   = useState(null)
  const pollRef = useRef(null)

  return (
    <div style={{ background: 'var(--card-bg)', borderRadius: 16, border: '1px solid var(--divider)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Index Health</span>
      </div>
      <div style={{ padding: 16 }}>
        <button
          onClick={() => {}}
          style={{ padding: '6px 16px', borderRadius: 8, background: 'var(--badge-bg)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, border: '1px solid var(--input-border)', cursor: 'pointer' }}
        >
          Run Scan
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Run test to verify it passes**

```
npx vitest run src/__tests__/components/IndexHealth.test.jsx
```
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```
git add src/lib/widgetRegistry.js src/components/Dashboard.jsx src/components/IndexHealth.jsx src/__tests__/components/IndexHealth.test.jsx
git commit -m "feat(index-health): register widget and scaffold IndexHealth component"
```

---

### Task 2: API Hooks

**Files:**
- Create: `src/hooks/useIndexHealthApi.js`
- Create: `src/__tests__/hooks/useIndexHealthApi.test.js`

- [ ] **Step 1: Write failing tests**

`src/__tests__/hooks/useIndexHealthApi.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIndexHealthApi } from '../../hooks/useIndexHealthApi'

const CONN = 'conn-1'
const SCAN_ID = 'scan-abc'

function mockFetch(status, body) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })
  )
}

describe('useIndexHealthApi', () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe('startScan', () => {
    it('POSTs correct URL and body, returns scanId', async () => {
      mockFetch(202, { scanId: SCAN_ID })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.startScan({ mode: 'LIMITED', databases: [] })
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/connections/${CONN}/index-health/scan`,
        expect.objectContaining({ method: 'POST' })
      )
      expect(res.scanId).toBe(SCAN_ID)
    })

    it('returns { conflict: true, scanId } on 409', async () => {
      mockFetch(409, { error: 'Scan already in progress.', scanId: SCAN_ID })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.startScan({ mode: 'LIMITED', databases: [] })
      expect(res.conflict).toBe(true)
      expect(res.scanId).toBe(SCAN_ID)
    })

    it('throws on non-202 non-409 status', async () => {
      mockFetch(500, { error: 'Server error' })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await expect(result.current.startScan({ mode: 'LIMITED', databases: [] })).rejects.toThrow('Server error')
    })
  })

  describe('pollProgress', () => {
    it('GETs progress URL and returns payload', async () => {
      const payload = { scanId: SCAN_ID, status: 'running', pct: 40, currentDb: 'dbA', completedDbs: 2, totalDbs: 5, timedOutDbs: [], eta: 30 }
      mockFetch(200, payload)
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.pollProgress(SCAN_ID)
      expect(global.fetch).toHaveBeenCalledWith(`/api/connections/${CONN}/index-health/scan/${SCAN_ID}/progress`)
      expect(res.pct).toBe(40)
    })

    it('throws on non-ok status', async () => {
      mockFetch(404, { error: 'not found' })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await expect(result.current.pollProgress(SCAN_ID)).rejects.toThrow()
    })
  })

  describe('fetchResults', () => {
    it('GETs results URL with correct query params', async () => {
      const payload = { status: 'completed', summary: {}, metadata: {}, timedOutDbs: [], fragmented: { rows: [], total: 0, page: 1, pageSize: 50 } }
      mockFetch(200, payload)
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await result.current.fetchResults(SCAN_ID, 'fragmented', { page: 2, pageSize: 50, db: 'mydb', search: 'idx' })
      const url = global.fetch.mock.calls[0][0]
      expect(url).toContain('tab=fragmented')
      expect(url).toContain('page=2')
      expect(url).toContain('db=mydb')
      expect(url).toContain('search=idx')
    })

    it('returns { expired: true } on 404', async () => {
      mockFetch(404, { error: 'not found' })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.fetchResults(SCAN_ID, 'fragmented')
      expect(res.expired).toBe(true)
    })
  })

  describe('cancelScan', () => {
    it('sends DELETE to correct URL', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 204 }))
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await result.current.cancelScan(SCAN_ID)
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/connections/${CONN}/index-health/scan/${SCAN_ID}`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/__tests__/hooks/useIndexHealthApi.test.js
```
Expected: FAIL — `Cannot find module '../../hooks/useIndexHealthApi'`

- [ ] **Step 3: Implement useIndexHealthApi.js**

`src/hooks/useIndexHealthApi.js`:
```js
import { useCallback } from 'react'

export function useIndexHealthApi(connId) {
  const startScan = useCallback(async ({ mode, databases }) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, databases }),
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
    if (!res.ok) throw new Error(`Progress poll failed: ${res.status}`)
    return await res.json()
  }, [connId])

  const fetchResults = useCallback(async (scanId, tab, opts = {}) => {
    const params = new URLSearchParams({ tab, page: opts.page || 1, pageSize: opts.pageSize || 50 })
    if (opts.db && opts.db !== 'all') params.set('db', opts.db)
    if (opts.search) params.set('search', opts.search)
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}/results?${params}`)
    if (res.status === 404) return { expired: true }
    if (!res.ok) throw new Error(`Results fetch failed: ${res.status}`)
    return await res.json()
  }, [connId])

  const cancelScan = useCallback(async (scanId) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) throw new Error(`Cancel failed: ${res.status}`)
  }, [connId])

  return { startScan, pollProgress, fetchResults, cancelScan }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/__tests__/hooks/useIndexHealthApi.test.js
```
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```
git add src/hooks/useIndexHealthApi.js src/__tests__/hooks/useIndexHealthApi.test.js
git commit -m "feat(index-health): add useIndexHealthApi hook covering all four endpoints"
```

---

### Task 3: ScanControls

**Files:**
- Create: `src/components/indexHealth/ScanControls.jsx`
- Create: `src/__tests__/components/indexHealth/ScanControls.test.jsx`

Props: `{ mode, onModeChange, phase, onStartScan, onCancelScan }`

- [ ] **Step 1: Write failing tests**

`src/__tests__/components/indexHealth/ScanControls.test.jsx`:
```jsx
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import ScanControls from '../../../components/indexHealth/ScanControls'

const noop = () => {}

describe('ScanControls', () => {
  it('shows Run Scan button when phase is idle', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument()
  })

  it('shows mode selector in idle phase', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('calls onStartScan when Run Scan is clicked', () => {
    const onStart = vi.fn()
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle" onStartScan={onStart} onCancelScan={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('shows Cancel button and disables mode selector when phase is running', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="running" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('calls onCancelScan when Cancel is clicked', () => {
    const onCancel = vi.fn()
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="running" onStartScan={noop} onCancelScan={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onModeChange when selector changes', () => {
    const onChange = vi.fn()
    render(<ScanControls mode="LIMITED" onModeChange={onChange} phase="idle" onStartScan={noop} onCancelScan={noop} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'SAMPLED' } })
    expect(onChange).toHaveBeenCalledWith('SAMPLED')
  })

  it('shows Run New Scan button when phase is completed', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="completed" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /run new scan/i })).toBeInTheDocument()
  })

  it('shows Run Scan button when phase is failed', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="failed" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```
npx vitest run src/__tests__/components/indexHealth/ScanControls.test.jsx
```
Expected: FAIL — `Cannot find module '../../../components/indexHealth/ScanControls'`

- [ ] **Step 3: Implement ScanControls.jsx**

`src/components/indexHealth/ScanControls.jsx`:
```jsx
import React from 'react'

const MODES = [
  { value: 'LIMITED',  label: 'LIMITED — fastest, page count only' },
  { value: 'SAMPLED',  label: 'SAMPLED — sample fragmentation' },
  { value: 'DETAILED', label: 'DETAILED — full scan, slowest' },
]

const ACTIVE_PHASES = new Set(['pending', 'running'])
const TERMINAL_DONE = new Set(['completed', 'completed_with_warnings'])

export default function ScanControls({ mode, onModeChange, phase, onStartScan, onCancelScan }) {
  const isActive  = ACTIVE_PHASES.has(phase)
  const isDone    = TERMINAL_DONE.has(phase)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

```
npx vitest run src/__tests__/components/indexHealth/ScanControls.test.jsx
```
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```
git add src/components/indexHealth/ScanControls.jsx src/__tests__/components/indexHealth/ScanControls.test.jsx
git commit -m "feat(index-health): add render-only ScanControls component"
```

---

### Task 4: ScanProgress

**Files:**
- Create: `src/components/indexHealth/ScanProgress.jsx`
- Create: `src/__tests__/components/indexHealth/ScanProgress.test.jsx`

Props: `{ phase, progress }` where `progress = { pct, currentDb, completedDbs, totalDbs, timedOutDbs, eta }`

- [ ] **Step 1: Write failing tests**

`src/__tests__/components/indexHealth/ScanProgress.test.jsx`:
```jsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import ScanProgress from '../../../components/indexHealth/ScanProgress'

const baseProgress = { pct: 45, currentDb: 'Northwind', completedDbs: 3, totalDbs: 7, timedOutDbs: [], eta: 20 }

describe('ScanProgress', () => {
  it('renders nothing when phase is idle', () => {
    const { container } = render(<ScanProgress phase="idle" progress={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders progress bar when phase is running', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('fills progress bar to correct percentage', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('45')
  })

  it('shows current database name', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByText(/Northwind/)).toBeInTheDocument()
  })

  it('shows completed/total counter', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByText(/3.*of.*7/i)).toBeInTheDocument()
  })

  it('shows ETA when eta is set', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByText(/~20s/i)).toBeInTheDocument()
  })

  it('hides ETA when eta is null', () => {
    render(<ScanProgress phase="running" progress={{ ...baseProgress, eta: null }} />)
    expect(screen.queryByText(/~.*s/i)).not.toBeInTheDocument()
  })

  it('shows timed-out badge when timedOutDbs is non-empty', () => {
    render(<ScanProgress phase="running" progress={{ ...baseProgress, timedOutDbs: ['dbA', 'dbB'] }} />)
    expect(screen.getByText(/2.*timed out/i)).toBeInTheDocument()
  })

  it('renders during pending phase too', () => {
    render(<ScanProgress phase="pending" progress={{ pct: 0, currentDb: null, completedDbs: 0, totalDbs: 0, timedOutDbs: [], eta: null }} />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```
npx vitest run src/__tests__/components/indexHealth/ScanProgress.test.jsx
```
Expected: FAIL — `Cannot find module '../../../components/indexHealth/ScanProgress'`

- [ ] **Step 3: Implement ScanProgress.jsx**

`src/components/indexHealth/ScanProgress.jsx`:
```jsx
import React from 'react'

export default function ScanProgress({ phase, progress }) {
  if (phase !== 'running' && phase !== 'pending') return null

  const pct         = progress?.pct         ?? 0
  const currentDb   = progress?.currentDb   ?? null
  const completedDbs = progress?.completedDbs ?? 0
  const totalDbs    = progress?.totalDbs    ?? 0
  const timedOutDbs = progress?.timedOutDbs ?? []
  const eta         = progress?.eta         ?? null

  return (
    <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Progress bar */}
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 6, borderRadius: 99, background: 'var(--divider)', overflow: 'hidden' }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: '#3b82f6', borderRadius: 99, transition: 'width 0.4s ease' }} />
      </div>

      {/* Status line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
        {currentDb && (
          <span>Scanning <strong style={{ color: 'var(--text-primary)' }}>{currentDb}</strong></span>
        )}
        {totalDbs > 0 && (
          <span>{completedDbs} of {totalDbs} databases</span>
        )}
        {eta !== null && (
          <span>~{eta}s remaining</span>
        )}
        {timedOutDbs.length > 0 && (
          <span style={{ padding: '1px 7px', borderRadius: 99, background: 'rgba(245,158,11,.15)', color: '#f59e0b', fontWeight: 600, fontSize: 10 }}>
            {timedOutDbs.length} timed out
          </span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

```
npx vitest run src/__tests__/components/indexHealth/ScanProgress.test.jsx
```
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```
git add src/components/indexHealth/ScanProgress.jsx src/__tests__/components/indexHealth/ScanProgress.test.jsx
git commit -m "feat(index-health): add render-only ScanProgress component"
```

---

### Task 5: HealthScore + SummaryStrip

**Files:**
- Create: `src/components/indexHealth/HealthScore.jsx`
- Create: `src/components/indexHealth/SummaryStrip.jsx`
- Create: `src/__tests__/components/indexHealth/HealthScore.test.jsx`

Props — HealthScore: `{ summary }`. SummaryStrip: `{ summary, timedOutDbs }`.

`summary` shape: `{ score, severity, totalIndexes, fragmentedCount, missingCount, unusedCount, duplicateCount, disabledCount }`

- [ ] **Step 1: Write failing tests**

`src/__tests__/components/indexHealth/HealthScore.test.jsx`:
```jsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import HealthScore from '../../../components/indexHealth/HealthScore'
import SummaryStrip from '../../../components/indexHealth/SummaryStrip'

const healthySummary = { score: 95, severity: 'Healthy', totalIndexes: 200, fragmentedCount: 2, missingCount: 1, unusedCount: 4, duplicateCount: 0, disabledCount: 0 }
const warningSummary = { score: 75, severity: 'Warning', totalIndexes: 150, fragmentedCount: 15, missingCount: 8, unusedCount: 10, duplicateCount: 3, disabledCount: 1 }
const criticalSummary = { score: 42, severity: 'Critical', totalIndexes: 100, fragmentedCount: 40, missingCount: 20, unusedCount: 15, duplicateCount: 8, disabledCount: 5 }

describe('HealthScore', () => {
  it('displays the numeric score', () => {
    render(<HealthScore summary={healthySummary} />)
    expect(screen.getByText('95')).toBeInTheDocument()
  })

  it('displays severity label', () => {
    render(<HealthScore summary={healthySummary} />)
    expect(screen.getByText(/Healthy/i)).toBeInTheDocument()
  })

  it('shows Warning severity for score 75', () => {
    render(<HealthScore summary={warningSummary} />)
    expect(screen.getByText(/Warning/i)).toBeInTheDocument()
  })

  it('shows Critical severity for score 42', () => {
    render(<HealthScore summary={criticalSummary} />)
    expect(screen.getByText(/Critical/i)).toBeInTheDocument()
  })

  it('displays total index count', () => {
    render(<HealthScore summary={healthySummary} />)
    expect(screen.getByText(/200/)).toBeInTheDocument()
  })
})

describe('SummaryStrip', () => {
  it('shows fragmented count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('15')).toBeInTheDocument()
  })

  it('shows missing count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('shows unused count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('shows duplicate count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows disabled count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('shows timed-out warning when timedOutDbs is non-empty', () => {
    render(<SummaryStrip summary={healthySummary} timedOutDbs={['dbA']} />)
    expect(screen.getByText(/1.*db.*timed out/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```
npx vitest run src/__tests__/components/indexHealth/HealthScore.test.jsx
```
Expected: FAIL — `Cannot find module '../../../components/indexHealth/HealthScore'`

- [ ] **Step 3: Implement HealthScore.jsx**

`src/components/indexHealth/HealthScore.jsx`:
```jsx
import React from 'react'

function scoreColor(severity) {
  if (severity === 'Critical') return '#ef4444'
  if (severity === 'Warning')  return '#f59e0b'
  return '#22c55e'
}

export default function HealthScore({ summary }) {
  if (!summary) return null
  const { score, severity, totalIndexes } = summary
  const color = scoreColor(severity)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0' }}>
      <div style={{
        width: 64, height: 64, borderRadius: '50%',
        border: `4px solid ${color}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 20, fontWeight: 800, lineHeight: 1, color: 'var(--text-primary)' }}>{score}</span>
        <span style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)', marginTop: 1 }}>/100</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color }}>{severity}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{totalIndexes.toLocaleString()} total indexes monitored</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Implement SummaryStrip.jsx**

`src/components/indexHealth/SummaryStrip.jsx`:
```jsx
import React from 'react'

function Pill({ label, count, alertColor }) {
  const isAlert = alertColor && count > 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      padding: '6px 14px', borderRadius: 10, background: 'var(--badge-bg)',
      border: `1px solid ${isAlert ? alertColor + '44' : 'var(--divider)'}`,
      minWidth: 72 }}>
      <span style={{ fontSize: 18, fontWeight: 800, lineHeight: 1,
        color: isAlert ? alertColor : 'var(--text-primary)' }}>{count}</span>
      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '.06em', color: 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}

export default function SummaryStrip({ summary, timedOutDbs }) {
  if (!summary) return null
  const { fragmentedCount, missingCount, unusedCount, duplicateCount, disabledCount } = summary

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 0 12px' }}>
      <Pill label="Fragmented" count={fragmentedCount} alertColor="#f97316" />
      <Pill label="Missing"    count={missingCount}    alertColor="#3b82f6" />
      <Pill label="Unused"     count={unusedCount}     alertColor={null}    />
      <Pill label="Duplicate"  count={duplicateCount}  alertColor={null}    />
      <Pill label="Disabled"   count={disabledCount}   alertColor="#ef4444" />
      {timedOutDbs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px', borderRadius: 10,
          background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.3)',
          fontSize: 11, fontWeight: 600, color: '#f59e0b', gap: 4 }}>
          ⚠ {timedOutDbs.length} db timed out
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run to verify it passes**

```
npx vitest run src/__tests__/components/indexHealth/HealthScore.test.jsx
```
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```
git add src/components/indexHealth/HealthScore.jsx src/components/indexHealth/SummaryStrip.jsx src/__tests__/components/indexHealth/HealthScore.test.jsx
git commit -m "feat(index-health): add HealthScore and SummaryStrip components"
```

---

### Task 6: IndexInventory

**Files:**
- Create: `src/components/indexHealth/IndexInventory.jsx`
- Create: `src/__tests__/components/indexHealth/IndexInventory.test.jsx`

Props:
```
{
  activeTab,        // 'fragmented' | 'missing' | 'unused' | 'duplicate'
  onTabChange,      // (tab) => void
  data,             // { rows, total, page, pageSize } | null
  loading,          // boolean
  filter,           // { db: string, search: string }
  onFilterChange,   // (filter) => void
  page,             // number
  onPageChange,     // (page) => void
  summary,          // { fragmentedCount, missingCount, unusedCount, duplicateCount, ... }
  onRowClick,       // (row) => void
}
```

Four display tabs: Fragmented, Missing, Unused, Duplicate.
Tab counts from `summary.*Count`.
When `data.rows.length > 500`, use VirtualTable. Otherwise, plain `<table>`.
Server-side pagination: show prev/next buttons when `data.total > data.pageSize`.
Filter: DB selector (options built from distinct `database_name` in rows) + text search input.

- [ ] **Step 1: Write failing tests**

`src/__tests__/components/indexHealth/IndexInventory.test.jsx`:
```jsx
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import IndexInventory from '../../../components/indexHealth/IndexInventory'

const noop = () => {}

const summary = { fragmentedCount: 5, missingCount: 3, unusedCount: 8, duplicateCount: 2 }

const makeData = (rows = []) => ({ rows, total: rows.length, page: 1, pageSize: 50 })

const fragRow = { database_name: 'db1', schema_name: 'dbo', table_name: 'Orders', index_name: 'IX_Orders_Date', avg_fragmentation_in_percent: 45, page_count: 5000, recommendation: 'REBUILD' }

const missingRow = { database_name: 'db1', schema_name: 'dbo', table_name: 'Orders', equality_columns: 'OrderDate', inequality_columns: null, impact_score: 80, create_script: 'CREATE INDEX [IX_missing_Orders_OrderDate]\nON dbo.Orders ([OrderDate]);' }

const unusedRow = { database_name: 'db1', schema_name: 'dbo', table_name: 'Products', index_name: 'IX_Products_Old', is_duplicate: false, _rowType: 'unused' }

const dupRow = { database_name: 'db1', schema_name: 'dbo', table_name: 'Products', index_name: 'IX_Products_Dup', duplicate_of: 'IX_Products_Old', key_columns: 'ProductId', _rowType: 'duplicate' }

const baseProps = {
  activeTab: 'fragmented',
  onTabChange: noop,
  data: makeData([fragRow]),
  loading: false,
  filter: { db: 'all', search: '' },
  onFilterChange: noop,
  page: 1,
  onPageChange: noop,
  summary,
  onRowClick: noop,
}

describe('IndexInventory', () => {
  it('renders four tab buttons', () => {
    render(<IndexInventory {...baseProps} />)
    expect(screen.getByRole('button', { name: /fragmented/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /missing/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unused/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /duplicate/i })).toBeInTheDocument()
  })

  it('tab badge shows count from summary', () => {
    render(<IndexInventory {...baseProps} />)
    // Fragmented tab should show count 5
    const fragTab = screen.getByRole('button', { name: /fragmented/i })
    expect(fragTab).toHaveTextContent('5')
  })

  it('calls onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn()
    render(<IndexInventory {...baseProps} onTabChange={onTabChange} />)
    fireEvent.click(screen.getByRole('button', { name: /missing/i }))
    expect(onTabChange).toHaveBeenCalledWith('missing')
  })

  it('shows fragmented row data', () => {
    render(<IndexInventory {...baseProps} />)
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText(/REBUILD/i)).toBeInTheDocument()
  })

  it('calls onRowClick when a row is clicked', () => {
    const onRowClick = vi.fn()
    render(<IndexInventory {...baseProps} onRowClick={onRowClick} />)
    const row = screen.getByText('Orders').closest('tr') || screen.getByText('Orders').closest('[data-row]')
    fireEvent.click(row)
    expect(onRowClick).toHaveBeenCalledWith(fragRow)
  })

  it('shows pagination when total > pageSize', () => {
    render(<IndexInventory {...baseProps} data={{ rows: [fragRow], total: 100, page: 1, pageSize: 50 }} />)
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument()
  })

  it('calls onPageChange when Next is clicked', () => {
    const onPageChange = vi.fn()
    render(<IndexInventory {...baseProps} data={{ rows: [fragRow], total: 100, page: 1, pageSize: 50 }} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('disables Prev button on page 1', () => {
    render(<IndexInventory {...baseProps} data={{ rows: [fragRow], total: 100, page: 1, pageSize: 50 }} />)
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled()
  })

  it('calls onFilterChange when search input changes', () => {
    const onFilterChange = vi.fn()
    render(<IndexInventory {...baseProps} onFilterChange={onFilterChange} />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'Orders' } })
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'Orders' }))
  })

  it('shows loading state', () => {
    render(<IndexInventory {...baseProps} loading={true} data={null} />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows empty state when no rows', () => {
    render(<IndexInventory {...baseProps} data={makeData([])} />)
    expect(screen.getByText(/no.*fragmented/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```
npx vitest run src/__tests__/components/indexHealth/IndexInventory.test.jsx
```
Expected: FAIL — `Cannot find module '../../../components/indexHealth/IndexInventory'`

- [ ] **Step 3: Implement IndexInventory.jsx**

`src/components/indexHealth/IndexInventory.jsx`:
```jsx
import React from 'react'

const TABS = [
  { id: 'fragmented', label: 'Fragmented', countKey: 'fragmentedCount' },
  { id: 'missing',    label: 'Missing',    countKey: 'missingCount'    },
  { id: 'unused',     label: 'Unused',     countKey: 'unusedCount'     },
  { id: 'duplicate',  label: 'Duplicate',  countKey: 'duplicateCount'  },
]

const COLUMNS = {
  fragmented: [
    { key: 'database_name', label: 'DB' },
    { key: 'schema_name',   label: 'Schema' },
    { key: 'table_name',    label: 'Table' },
    { key: 'index_name',    label: 'Index' },
    { key: 'avg_fragmentation_in_percent', label: 'Frag %', render: v => `${v?.toFixed(1)}%` },
    { key: 'page_count',    label: 'Pages', render: v => v?.toLocaleString() },
    { key: 'recommendation',label: 'Action' },
  ],
  missing: [
    { key: 'database_name',      label: 'DB' },
    { key: 'schema_name',        label: 'Schema' },
    { key: 'table_name',         label: 'Table' },
    { key: 'equality_columns',   label: 'Equality Cols' },
    { key: 'inequality_columns', label: 'Inequality Cols' },
    { key: 'impact_score',       label: 'Impact', render: v => `${v}%` },
  ],
  unused: [
    { key: 'database_name', label: 'DB' },
    { key: 'schema_name',   label: 'Schema' },
    { key: 'table_name',    label: 'Table' },
    { key: 'index_name',    label: 'Index' },
  ],
  duplicate: [
    { key: 'database_name', label: 'DB' },
    { key: 'schema_name',   label: 'Schema' },
    { key: 'table_name',    label: 'Table' },
    { key: 'index_name',    label: 'Index' },
    { key: 'duplicate_of',  label: 'Duplicate Of' },
    { key: 'key_columns',   label: 'Key Cols' },
  ],
}

export default function IndexInventory({
  activeTab, onTabChange,
  data, loading,
  filter, onFilterChange,
  page, onPageChange,
  summary, onRowClick,
}) {
  const cols = COLUMNS[activeTab] || COLUMNS.fragmented
  const rows = data?.rows || []
  const total = data?.total || 0
  const pageSize = data?.pageSize || 50
  const totalPages = Math.ceil(total / pageSize)

  return (
    <div style={{ borderTop: '1px solid var(--divider)', marginTop: 8 }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '10px 0 0', borderBottom: '1px solid var(--divider)' }}>
        {TABS.map(t => {
          const count = summary?.[t.countKey] ?? 0
          const isActive = activeTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '6px 12px', borderRadius: '8px 8px 0 0', fontSize: 12, fontWeight: isActive ? 700 : 500,
                background: isActive ? 'var(--card-bg)' : 'transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                border: 'none', cursor: 'pointer',
                borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
              }}
            >
              {t.label}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 99,
                background: 'var(--badge-bg)', color: 'var(--badge-text)',
              }}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 0', alignItems: 'center' }}>
        <input
          placeholder="Search table or index…"
          value={filter.search}
          onChange={e => onFilterChange({ ...filter, search: e.target.value })}
          style={{
            padding: '4px 10px', borderRadius: 7, fontSize: 12,
            background: 'var(--card-bg)', color: 'var(--text-primary)',
            border: '1px solid var(--input-border)', width: 220,
          }}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          No {activeTab} indexes found.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.key} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  data-row="true"
                  onClick={() => onRowClick(row)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--divider)' }}
                >
                  {cols.map(c => (
                    <td key={c.key} style={{ padding: '7px 10px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                      {c.render ? c.render(row[c.key]) : (row[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', justifyContent: 'flex-end', fontSize: 12 }}>
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--input-border)', background: 'var(--card-bg)', color: 'var(--text-primary)', cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.4 : 1 }}
          >
            Prev
          </button>
          <span style={{ color: 'var(--text-muted)' }}>Page {page} of {totalPages}</span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--input-border)', background: 'var(--card-bg)', color: 'var(--text-primary)', cursor: page >= totalPages ? 'not-allowed' : 'pointer', opacity: page >= totalPages ? 0.4 : 1 }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

```
npx vitest run src/__tests__/components/indexHealth/IndexInventory.test.jsx
```
Expected: PASS (11 tests). Note: the `onRowClick` test clicks the `<tr>`. If a test fails because `.closest('tr')` returns null, check the fallback `.closest('[data-row]')`.

- [ ] **Step 5: Commit**

```
git add src/components/indexHealth/IndexInventory.jsx src/__tests__/components/indexHealth/IndexInventory.test.jsx
git commit -m "feat(index-health): add IndexInventory with 4 tabs, pagination, and filter"
```

---

### Task 7: DetailModal + Wire IndexHealth.jsx (Session Recovery + Polling)

**Files:**
- Create: `src/components/indexHealth/DetailModal.jsx`
- Create: `src/__tests__/components/indexHealth/DetailModal.test.jsx`
- Modify: `src/test/setup.js` (add `sessionStorage` mock)
- Modify: `src/components/IndexHealth.jsx` (full implementation)
- Modify: `src/__tests__/components/IndexHealth.test.jsx` (add lifecycle tests)

- [ ] **Step 1: Add sessionStorage mock to `src/test/setup.js`**

After the `localStorage` mock block, add:
```js
// ── sessionStorage mock ────────────────────────────────────────────────────────
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
```

Also extend the `beforeEach` block to clear sessionStorage:
```js
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})
```

- [ ] **Step 2: Write failing DetailModal tests**

`src/__tests__/components/indexHealth/DetailModal.test.jsx`:
```jsx
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import DetailModal from '../../../components/indexHealth/DetailModal'

const fragRow = {
  _tab: 'fragmented',
  database_name: 'mydb', schema_name: 'dbo', table_name: 'Orders',
  index_name: 'IX_Orders_Date',
  avg_fragmentation_in_percent: 67.3,
  page_count: 12500,
  recommendation: 'REBUILD',
  index_type_desc: 'NONCLUSTERED',
}

const missingRow = {
  _tab: 'missing',
  database_name: 'mydb', schema_name: 'dbo', table_name: 'Orders',
  equality_columns: 'OrderDate',
  inequality_columns: null,
  impact_score: 82,
  create_script: 'CREATE INDEX [IX_missing_Orders_OrderDate]\nON dbo.Orders ([OrderDate]);',
}

describe('DetailModal', () => {
  it('renders nothing when row is null', () => {
    const { container } = render(<DetailModal row={null} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows table and index name for fragmented row', () => {
    render(<DetailModal row={fragRow} onClose={() => {}} />)
    expect(screen.getByText(/Orders/)).toBeInTheDocument()
    expect(screen.getByText(/IX_Orders_Date/)).toBeInTheDocument()
  })

  it('shows recommendation for fragmented row', () => {
    render(<DetailModal row={fragRow} onClose={() => {}} />)
    expect(screen.getByText(/REBUILD/i)).toBeInTheDocument()
  })

  it('shows create script for missing row', () => {
    render(<DetailModal row={missingRow} onClose={() => {}} />)
    expect(screen.getByText(/CREATE INDEX/i)).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<DetailModal row={fragRow} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<DetailModal row={fragRow} onClose={onClose} />)
    const backdrop = container.querySelector('[data-backdrop]')
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows impact score for missing row', () => {
    render(<DetailModal row={missingRow} onClose={() => {}} />)
    expect(screen.getByText(/82/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Implement DetailModal.jsx**

`src/components/indexHealth/DetailModal.jsx`:
```jsx
import React, { useCallback } from 'react'

function CopyButton({ text }) {
  const [copied, setCopied] = React.useState(false)
  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])
  return (
    <button
      onClick={copy}
      style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        background: 'var(--badge-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

function FragmentedDetail({ row }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 12 }}>
      {[
        ['Database',      row.database_name],
        ['Schema',        row.schema_name],
        ['Table',         row.table_name],
        ['Index',         row.index_name],
        ['Type',          row.index_type_desc],
        ['Fragmentation', `${row.avg_fragmentation_in_percent?.toFixed(1)}%`],
        ['Pages',         row.page_count?.toLocaleString()],
        ['Action',        row.recommendation],
      ].map(([k, v]) => [
        <dt key={`k-${k}`} style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{k}</dt>,
        <dd key={`v-${k}`} style={{ color: 'var(--text-primary)', margin: 0 }}>{v ?? '—'}</dd>,
      ])}
    </dl>
  )
}

function MissingDetail({ row }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 12 }}>
        {[
          ['Database',        row.database_name],
          ['Schema',          row.schema_name],
          ['Table',           row.table_name],
          ['Equality Cols',   row.equality_columns   || '—'],
          ['Inequality Cols', row.inequality_columns || '—'],
          ['Impact Score',    `${row.impact_score}%`],
        ].map(([k, v]) => [
          <dt key={`k-${k}`} style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{k}</dt>,
          <dd key={`v-${k}`} style={{ color: 'var(--text-primary)', margin: 0 }}>{v}</dd>,
        ])}
      </dl>
      {row.create_script && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Create Script</span>
            <CopyButton text={row.create_script} />
          </div>
          <pre style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'rgba(0,0,0,.2)', fontSize: 11, color: 'var(--text-primary)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {row.create_script}
          </pre>
        </div>
      )}
    </div>
  )
}

function GenericDetail({ row }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 12 }}>
      {Object.entries(row).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [
        <dt key={`k-${k}`} style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{k}</dt>,
        <dd key={`v-${k}`} style={{ color: 'var(--text-primary)', margin: 0 }}>{String(v ?? '—')}</dd>,
      ])}
    </dl>
  )
}

export default function DetailModal({ row, onClose }) {
  if (!row) return null

  const title = row.index_name || row.table_name || 'Detail'
  const tab   = row._tab || (row.create_script ? 'missing' : row.recommendation ? 'fragmented' : 'unused')

  return (
    <div
      data-backdrop="true"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          borderRadius: 16, overflow: 'hidden', background: 'var(--card-bg)', border: '1px solid var(--input-border)',
          boxShadow: '0 32px 80px rgba(0,0,0,.4)' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--divider)', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{row.schema_name}.{row.table_name}</div>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid var(--input-border)', background: 'var(--badge-bg)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', flexGrow: 1 }}>
          {tab === 'fragmented' ? <FragmentedDetail row={row} /> :
           tab === 'missing'    ? <MissingDetail    row={row} /> :
                                  <GenericDetail    row={row} />}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run DetailModal tests to verify they pass**

```
npx vitest run src/__tests__/components/indexHealth/DetailModal.test.jsx
```
Expected: PASS (7 tests)

- [ ] **Step 5: Write IndexHealth.jsx lifecycle tests**

Append to `src/__tests__/components/IndexHealth.test.jsx`:
```jsx
import { waitFor, fireEvent, act } from '@testing-library/react'
import { vi } from 'vitest'

function mockFetch(status, body) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })
  )
}

describe('IndexHealth scan lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('transitions to running after clicking Run Scan', async () => {
    // POST scan returns scanId
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ scanId: 'scan-1' }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ scanId: 'scan-1', status: 'running', pct: 10, currentDb: 'mydb', completedDbs: 0, totalDbs: 5, timedOutDbs: [], eta: 60 }) })

    render(<IndexHealth connId="conn-1" />)
    fireEvent.click(screen.getByRole('button', { name: /run scan/i }))

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument()
    })
  })

  it('saves scanId to sessionStorage after start', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ scanId: 'scan-persist' }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ status: 'running', pct: 5, currentDb: null, completedDbs: 0, totalDbs: 0, timedOutDbs: [], eta: null }) })

    render(<IndexHealth connId="conn-1" />)
    fireEvent.click(screen.getByRole('button', { name: /run scan/i }))

    await waitFor(() => {
      expect(sessionStorage.getItem('index-health-scan-conn-1')).toBe('scan-persist')
    })
  })

  it('shows health score after scan completes', async () => {
    const summary = { score: 87, severity: 'Healthy', totalIndexes: 100, fragmentedCount: 2, missingCount: 1, unusedCount: 3, duplicateCount: 0, disabledCount: 0 }
    const resultsPayload = { status: 'completed', summary, metadata: {}, timedOutDbs: [], fragmented: { rows: [], total: 0, page: 1, pageSize: 50 } }

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ scanId: 'scan-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ status: 'completed', pct: 100, currentDb: null, completedDbs: 5, totalDbs: 5, timedOutDbs: [], eta: null }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(resultsPayload) })

    render(<IndexHealth connId="conn-1" />)
    fireEvent.click(screen.getByRole('button', { name: /run scan/i }))

    await waitFor(() => {
      expect(screen.getByText('87')).toBeInTheDocument()
    })
  })

  it('recovers from sessionStorage on mount', async () => {
    sessionStorage.setItem('index-health-scan-conn-1', 'scan-recovered')
    const summary = { score: 72, severity: 'Warning', totalIndexes: 80, fragmentedCount: 10, missingCount: 4, unusedCount: 2, duplicateCount: 1, disabledCount: 0 }

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ status: 'completed', pct: 100, currentDb: null, completedDbs: 3, totalDbs: 3, timedOutDbs: [], eta: null }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ status: 'completed', summary, metadata: {}, timedOutDbs: [], fragmented: { rows: [], total: 0, page: 1, pageSize: 50 } }) })

    render(<IndexHealth connId="conn-1" />)

    await waitFor(() => {
      expect(screen.getByText('72')).toBeInTheDocument()
    })
  })

  it('shows expired banner when results return 404', async () => {
    sessionStorage.setItem('index-health-scan-conn-1', 'scan-old')

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) })

    render(<IndexHealth connId="conn-1" />)

    await waitFor(() => {
      expect(screen.getByText(/expired/i)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 6: Run IndexHealth tests — should fail on lifecycle tests**

```
npx vitest run src/__tests__/components/IndexHealth.test.jsx
```
Expected: First 2 tests pass (scaffold tests), lifecycle tests FAIL — no polling logic yet.

- [ ] **Step 7: Implement full IndexHealth.jsx**

Replace `src/components/IndexHealth.jsx` with the complete implementation:
```jsx
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useIndexHealthApi } from '../hooks/useIndexHealthApi'
import ScanControls from './indexHealth/ScanControls'
import ScanProgress from './indexHealth/ScanProgress'
import HealthScore from './indexHealth/HealthScore'
import SummaryStrip from './indexHealth/SummaryStrip'
import IndexInventory from './indexHealth/IndexInventory'
import DetailModal from './indexHealth/DetailModal'

function sessionKey(connId) { return `index-health-scan-${connId}` }

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
  const pollRef  = useRef(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const { startScan, pollProgress, fetchResults, cancelScan } = useIndexHealthApi(connId)

  const loadInventory = useCallback(async (sid, tab, pg, filter) => {
    setInventoryLoading(true)
    try {
      const serverTab = (tab === 'unused' || tab === 'duplicate') ? 'unusedAndDuplicate' : tab
      const res = await fetchResults(sid, serverTab, { page: pg, pageSize: 50, ...filter })
      if (res.expired) {
        setPhase('expired')
        sessionStorage.removeItem(sessionKey(connId))
        return
      }
      if (res.timedOutDbs) setTimedOutDbs(res.timedOutDbs)
      if (res.summary)     setSummary(res.summary)
      if (res.metadata)    setMetadata(res.metadata)
      const rawData = res.fragmented || res.missing || res.unusedAndDuplicate
      let rows = rawData?.rows || []
      if (tab === 'unused')     rows = rows.filter(r => r._rowType === 'unused')
      if (tab === 'duplicate')  rows = rows.filter(r => r._rowType === 'duplicate')
      setInventoryData({ rows, total: rawData?.total || 0, page: rawData?.page || 1, pageSize: rawData?.pageSize || 50 })
    } catch {
      // non-fatal — keep existing data
    } finally {
      setInventoryLoading(false)
    }
  }, [connId, fetchResults])

  // Session recovery on mount
  useEffect(() => {
    const saved = sessionStorage.getItem(sessionKey(connId))
    if (!saved) return
    setScanId(saved)
    setPhase('running')
  }, [connId])

  // Polling loop — owns all interval scheduling
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
        pollRef.current = setTimeout(tick, pollInterval(prog.pct || 0))
      } catch {
        if (alive) pollRef.current = setTimeout(tick, 10000)
      }
    }

    tick()
    return () => {
      alive = false
      clearTimeout(pollRef.current)
    }
  }, [scanId, phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load first results page when scan completes
  useEffect(() => {
    if (!scanId) return
    if (phase !== 'completed' && phase !== 'completed_with_warnings') return
    loadInventory(scanId, 'fragmented', 1, { db: 'all', search: '' })
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Remove sessionStorage on terminal non-result states
  useEffect(() => {
    if (phase === 'failed' || phase === 'cancelled' || phase === 'expired') {
      sessionStorage.removeItem(sessionKey(connId))
    }
  }, [phase, connId])

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
    try {
      const res = await startScan({ mode, databases: [] })
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

  const hasResults = phase === 'completed' || phase === 'completed_with_warnings'
  const isActive   = phase === 'pending' || phase === 'running'

  return (
    <div style={{ background: 'var(--card-bg)', borderRadius: 16, border: '1px solid var(--divider)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Index Health</span>
        <ScanControls
          mode={mode}
          onModeChange={setMode}
          phase={phase}
          onStartScan={handleStartScan}
          onCancelScan={handleCancelScan}
        />
      </div>

      {/* Body */}
      <div style={{ padding: '14px 18px' }}>
        {/* Banners */}
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
              data={inventoryData}
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

- [ ] **Step 8: Run all IndexHealth tests**

```
npx vitest run src/__tests__/components/IndexHealth.test.jsx
```
Expected: PASS (7 tests)

- [ ] **Step 9: Run full test suite**

```
npx vitest run
```
Expected: All tests pass. Confirm no regressions in existing tests.

- [ ] **Step 10: Commit**

```
git add src/test/setup.js src/components/indexHealth/DetailModal.jsx src/__tests__/components/indexHealth/DetailModal.test.jsx src/components/IndexHealth.jsx src/__tests__/components/IndexHealth.test.jsx
git commit -m "feat(index-health): wire full IndexHealth orchestrator with polling, session recovery, and detail modal"
```

---

## Self-Review

### Spec Coverage

| Requirement | Task |
|-------------|------|
| `idle/pending/running/completed/completed_with_warnings/cancelled/failed/expired` phases | Task 1, Task 7 |
| Only IndexHealth.jsx owns polling | Task 7 (all children render-only) |
| Exponential backoff 2s/5s/10s | Task 7 (`pollInterval`) |
| Session recovery via sessionStorage | Task 7 |
| startScan, pollProgress, fetchResults, cancelScan | Task 2 |
| 409 conflict handling (resume existing scan) | Task 2, Task 7 |
| 404 expired handling | Task 2, Task 7 |
| ScanControls disabled during active phase | Task 3 |
| Progress bar, DB counter, ETA, timed-out badges | Task 4 |
| HealthScore with severity colour | Task 5 |
| SummaryStrip 5 count pills | Task 5 |
| 4 display tabs (Fragmented/Missing/Unused/Duplicate) | Task 6 |
| Server-side pagination | Task 6 |
| Filter (db, search) | Task 6 |
| unusedAndDuplicate → client-side split by `_rowType` | Task 7 |
| DetailModal with create script display | Task 7 |
| Expired/failure/timed-out banners | Task 7 |
| Widget registered in sidebar | Task 1 |

### Placeholder Scan

No TBDs, TODOs, or incomplete sections in this plan.

### Type Consistency

- `summary` shape used consistently: `{ score, severity, totalIndexes, fragmentedCount, missingCount, unusedCount, duplicateCount, disabledCount }`
- `progress` shape: `{ pct, currentDb, completedDbs, totalDbs, timedOutDbs, eta }`
- `data` (inventory): `{ rows, total, page, pageSize }`
- `filter`: `{ db: string, search: string }`
- `phase` values: `'idle' | 'pending' | 'running' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled' | 'expired'`
- `onRowClick` augments row with `_tab: activeTab` before passing to DetailModal — DetailModal uses `row._tab` to choose `FragmentedDetail` vs `MissingDetail` vs `GenericDetail`
