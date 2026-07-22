# Index Health — Expandable Config Panel Design

**Date:** 2026-07-22  
**Status:** Approved

## Overview

Enhance the Index Health card with an expand/collapse configuration panel that lets DBAs select target databases and tune scan parameters without cluttering the default dashboard view.

---

## Scope

**In scope:**
- Expand/collapse panel inside the Index Health card (inner toggle, not the outer CollapsibleSection)
- Lazy-fetched database list (on first expand per connection)
- Database multi-select with search + bulk-select shortcuts
- Min Fragmentation % display filter (frontend-only)
- Max Parallel DBs concurrency control (wired to backend)
- Collapsed summary inline in header row
- Session persistence via `sessionStorage`

**Out of scope (deferred):**
- Include Disabled Indexes toggle
- Include Hypothetical Indexes toggle
- Availability Group / read-only / offline DB filters
- Database tags / environment labels

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/components/indexHealth/ScanConfigPanel.jsx` | Pure UI panel — receives all config as props, emits callbacks |

### Modified files

| File | Change |
|------|--------|
| `src/components/IndexHealth.jsx` | Add `isExpanded`, `dbList`, `selectedDbs`, `minFrag`, `maxParallel` state; DB fetch on expand; pass config to `startScan` |
| `src/components/indexHealth/ScanControls.jsx` | Add expand toggle icon + inline `configSummary` display |
| `src/hooks/useIndexHealthApi.js` | Add `fetchDatabases()`; update `startScan` to accept `maxConcurrent` |
| `server.js` | Add `GET /api/connections/:id/databases`; forward `maxConcurrent` from POST body |

### Unchanged

`ScanProgress`, `HealthScore`, `SummaryStrip`, `IndexInventory`, `DetailModal`, `Dashboard.jsx`

---

## State (IndexHealth.jsx additions)

```js
const [isExpanded,     setIsExpanded]     = useState(false)
const [dbList,         setDbList]         = useState([])      // { name, is_system, state_desc, is_read_only }
const [dbListLoading,  setDbListLoading]  = useState(false)
const [dbListError,    setDbListError]    = useState(null)
const [selectedDbs,    setSelectedDbs]    = useState(null)    // null = "all" (backend default)
const [minFrag,        setMinFrag]        = useState(10)
const [maxParallel,    setMaxParallel]    = useState(3)
```

`selectedDbs = null` means no explicit selection — backend scans all user DBs. Once user interacts with the panel, it becomes a `Set<string>`.

### Session key

```
index-health-config-${connId}  →  JSON { selectedDbs: string[]|null, minFrag: number, maxParallel: number }
```

Restored on mount (alongside existing `index-health-scan-${connId}`). Cleared on Reset.

---

## Data Flow

### DB fetch

1. User clicks expand icon → `isExpanded = true`
2. If `dbList.length === 0` → call `GET /api/connections/:id/databases`
3. On first load with no saved config: pre-select all online non-system DBs (`is_system = false`)
4. On subsequent expands: restore `selectedDbs` from sessionStorage
5. DB list cached in component state for the session — not re-fetched on collapse/expand

### Scan start

```js
await startScan({
  mode,
  databases: selectedDbs ? [...selectedDbs] : [],
  maxConcurrent: maxParallel,
})
```

- Empty array → backend `runScan` falls back to all user DBs (existing behavior, unchanged)
- `minFrag` passed as `inventoryFilter.minFrag` to `IndexInventory` — client-side row filter only

### Connection switch

`useEffect([connId])` resets: `isExpanded = false`, `dbList = []`. Config (`selectedDbs`, `minFrag`, `maxParallel`) restored from new connId's sessionStorage key or defaulted.

---

## UI Layout

### Collapsed (default)

```
┌──────────────────────────────────────────────────────────────────┐
│ Index Health   [8 DBs · Standard · ≥10%]  [LIMITED ▾] [Run Scan] [▼] │
└──────────────────────────────────────────────────────────────────┘
```

- Summary text hidden when config is all-defaults (no explicit DB selection, minFrag=10, maxParallel=3)
- Expand icon disabled while scan is active (`pending` / `running` phase)

### Expanded

```
┌──────────────────────────────────────────────────────────────────┐
│ Index Health                              [LIMITED ▾] [Run Scan] [▲] │
├──────────────────────────────────────────────────────────────────┤
│ DATABASE SELECTION                    Selected (8/124)           │
│ [🔍 Search databases…                                ]           │
│ [Select All] [Deselect All] [System DBs] [User DBs]             │
│ ┌────────────────────────────────────────────────────┐           │
│ │ ☐ master        ☐ model     ☐ msdb    ☐ tempdb    │  scroll   │
│ │ ☑ Clinical      ☑ Billing   ☑ Reporting            │  max-h    │
│ │ ☑ Analytics     ☑ Inventory                        │  240px    │
│ └────────────────────────────────────────────────────┘           │
├──────────────────────────────────────────────────────────────────┤
│ SCAN CONFIGURATION                                               │
│ Min Fragmentation %  [10    ]     Max Parallel DBs  [3     ]    │
├──────────────────────────────────────────────────────────────────┤
│                [Run Scan]   [Cancel]   [Reset Filters]           │
└──────────────────────────────────────────────────────────────────┘
```

### Animation

CSS `max-height` transition on the panel wrapper: `0 → 600px`, `250ms ease-in-out`. No JS animation library.

### DB list

- 2-column checkbox grid (responsive to 1-column on narrow)
- `max-height: 240px`, `overflow-y: auto`
- Search filters list in real-time (case-insensitive substring match on `name`)
- System DBs shown but visually grouped first (sorted `is_system DESC, name ASC` from API)

---

## Backend Changes

### New endpoint

```js
// server.js
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
    res.status(500).json({ error: err.message })
  }
})
```

- No caching — lightweight query, called at most once per panel open
- Excludes `state = 6` (offline) only; read-only DBs included
- `database_id <= 4` = system DBs (master, tempdb, model, msdb)

### Modified scan POST

```js
// server.js ~line 1154
const { mode = 'LIMITED', databases = [], maxConcurrent } = req.body
// ...
runScan(conn.pool, scanId, scanStore, {
  ...(maxConcurrent ? { maxConcurrent: Math.min(Math.max(1, parseInt(maxConcurrent, 10)), 8) } : {}),
})
```

- `maxConcurrent` clamped 1–8 server-side
- Orchestrator's `opts.maxConcurrent` path already exists (no orchestrator changes needed)

### Hook additions (`useIndexHealthApi.js`)

```js
const fetchDatabases = useCallback(async () => {
  const res = await fetch(`/api/connections/${connId}/databases`)
  if (!res.ok) throw new Error(`Failed to load databases: ${res.status}`)
  return res.json()
}, [connId])
```

`startScan` body gains `maxConcurrent` — one-line change to the `JSON.stringify` call.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| DB fetch fails | Inline error in panel: "Could not load databases. [Retry]". Scan can still run (all DBs). |
| DB list empty | Show "No accessible databases found". No checkboxes. |
| Scan active | Expand icon disabled. Panel cannot be opened mid-scan. |
| `maxParallel` invalid input | Non-numeric / out-of-range → clamp to default (3) on submit. |
| Connection switch | Reset `isExpanded`, `dbList`. Restore config from new connId's sessionStorage. |

---

## Inline Config Summary (collapsed)

Shown only when config deviates from defaults OR user has explicitly made a selection:

```
8 DBs · Standard · ≥10%
```

- `N DBs` — shown when `selectedDbs !== null` (explicit selection made)
- `· Standard` — shown when mode is SAMPLED or DETAILED (not LIMITED)  
- `· ≥10%` — always shown when minFrag !== 10

When no deviations: summary string is empty, no text rendered.

---

## Session Persistence

Config saved to `sessionStorage` key `index-health-config-${connId}` on every change to `selectedDbs`, `minFrag`, or `maxParallel`. Loaded on mount. Cleared on Reset Filters.

Existing `index-health-scan-${connId}` key unchanged.
