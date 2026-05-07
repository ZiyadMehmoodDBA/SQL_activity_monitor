# Architecture Reference

Live SQL Server Activity Monitor — clones SSMS Activity Monitor with real-time charts, data tables, and multi-connection support. Targets SQL Server via `mssql` (Tedious driver).

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express + Socket.io |
| DB driver | `mssql` (Tedious, supports Windows + SQL auth) |
| Frontend | React 18 + Vite |
| Charts | ApexCharts (`react-apexcharts`) |
| UI primitives | Radix UI (Dialog), Lucide icons, Tailwind CSS |
| State | React `useReducer` via `AppContext` |
| Persistence | `localStorage` (layout, palette) + `data/db-size-history.json` (disk) |

---

## Data Flow

```
SQL Server DMVs
    │
    ▼ every 2s per connection
server.js  pollMetrics(pool)
    │  Promise.all — all queries run in parallel
    │
    ├─ Socket.io  emit('metrics', { connId, ...data })
    │                │
    │                ▼
    │           useSocket.js  (hook, one per active connection)
    │                │
    │                ▼
    │           AppContext  UPDATE_METRICS reducer
    │                │  pushes ring-buffer history (max 60 points)
    │                ▼
    │           Dashboard.jsx  reads state, passes props down
    │                │
    │                ▼
    │           Components render (ChartCard, KPIBar, tables…)
    │
    └─ REST  GET /api/connections/:id/whoIsActive  (on-demand)
            POST /api/connections/:id/jobs/start|stop
            GET  /api/connections/:id/db-size-history
```

---

## server.js — Key Sections

| Lines | Purpose |
|-------|---------|
| 1–25 | Express + Socket.io setup, static file serving (`dist/` else `public/`) |
| 26–100 | DB size history: file-based daily snapshots (`data/db-size-history.json`), 10-day prune |
| 100–560 | `pollMetrics(pool)` — parallel DMV queries (see table below) |
| 560–640 | Connection registry (`connections` Map), Socket.io `connect`/`disconnect` handlers |
| 567–760 | REST API routes |
| 761+ | SPA fallback `GET *` |

### DMV Queries (run in parallel each 2s tick)

| Metric | Source |
|--------|--------|
| CPU % | `sys.dm_os_ring_buffers` — XML parse, `ProcessUtilization` field |
| Waiting tasks | `sys.dm_exec_requests` suspended/waiting count |
| DB I/O MB/s | `sys.dm_io_virtual_file_stats` delta between ticks |
| Batch requests/s | `sys.dm_os_performance_counters` |
| Server perf (net, compilations) | `sys.dm_os_performance_counters` |
| Memory health | `sys.dm_os_sys_memory` + `sys.dm_os_buffer_pool_extension_configuration` |
| Active sessions | `sys.dm_exec_sessions` + `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |
| Resource waits | `sys.dm_os_wait_stats` delta, benign waits filtered |
| Data file I/O | `sys.dm_io_virtual_file_stats` + `sys.master_files` |
| Recent expensive queries | `sys.dm_exec_query_stats` (last 1h) |
| Active expensive queries | `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |
| Blocking chains | `sys.dm_exec_requests` self-join on `blocking_session_id` |
| Deadlocks | `sys.fn_xe_file_target_read_file` (system health XE session) |
| DB sizes | `sys.databases` + `sys.master_files` |
| Drive space | `sys.dm_os_volume_stats` CROSS APPLY, GROUP BY `volume_mount_point` — MAX(total), MIN(available) to collapse multi-file same-volume rows |
| SQL Agent jobs | `msdb.dbo.sysjobs` + `sysjobservers` + `sysjobactivity` |
| sp_WhoIsActive | REST endpoint, on-demand only |

---

## Frontend Structure

```
src/
├── main.jsx            — React root, mounts <App>
├── App.jsx             — AppProvider wrapper, applyPalette on state.palette change
├── index.css           — CSS variables (all palettes override via JS), component styles
│
├── context/
│   └── AppContext.jsx  — Single global reducer store
│                          State shape per connection: metrics, history (ring buffers),
│                          diskHistory, collapsedSections, sortState, jobsFilter/Search/Sort,
│                          expandedSessionGroups, widgetLayout
│
├── hooks/
│   └── useSocket.js    — Socket.io client per connId, dispatches UPDATE_METRICS
│
├── lib/
│   ├── palettes.js     — PALETTES map + applyPalette() — sets CSS vars on :root
│   ├── widgetRegistry.js — WIDGET_REGISTRY, loadLayout/saveLayout (localStorage)
│   ├── tableCols.js    — Column definitions for sortable tables
│   ├── thresholds.js   — Color thresholds for KPI values
│   ├── fmt.js          — Number formatters
│   └── cn.js           — Tailwind class merger
│
└── components/
    ├── Dashboard.jsx   — Main layout: chart grid + ordered section list from widgetLayout
    ├── Header.jsx      — App bar: connection tabs, palette picker, widget sidebar toggle
    ├── TabBar.jsx      — Per-connection tab strip
    ├── ConnectModal.jsx — Connection dialog (Login + Connection String tabs)
    ├── WidgetSidebar.jsx — Toggle/reorder widgets panel
    ├── CollapsibleSection.jsx — section-body 1fr→0fr CSS grid collapse animation
    ├── KPIBar.jsx      — Top KPI cards row
    ├── ChartCard.jsx   — ApexCharts area chart card (fixed 224px height, overflow:hidden)
    ├── MemoryHealth.jsx — Memory pressure gauges
    ├── DriveMonitor.jsx — Drive space grouped by type (OS/TempDB/Data/Log)
    ├── DbSizes.jsx     — Database size bar chart
    ├── DbSizeTrend.jsx — Historical DB size line chart
    ├── JobsPanel.jsx   — SQL Agent jobs list
    ├── SessionsPanel.jsx — Connected sessions grouped view
    ├── WhoIsActive.jsx — sp_WhoIsActive table (on-demand refresh)
    ├── VirtualTable.jsx — Virtualized sortable table (@tanstack/react-virtual)
    └── ui/
        └── Dialog.jsx  — Radix Dialog wrapper with project styling
```

---

## AppContext State Shape

```javascript
{
  connections: {
    [connId]: {
      id, label, server, color, appIntent,
      metrics: { cpu_percent, waiting_tasks, db_io_mb, batch_requests,
                 diskDrives[], sessions[], resourceWaits[], fileIo[],
                 recentExpensive[], activeExpensive[], blocking[], deadlocks[],
                 dbSizes[], serverPerf{}, memoryHealth{} },
      history: {
        cpu: number[],        // ring buffer, max 60 items
        wait: number[],
        io: number[],
        batch: number[],
        netMb: number[],
        compilations: number[],
      },
      diskHistory: { 'C:\\': number[] },  // free_pct per volume
      collapsedSections: Set<sectionId>,   // always starts fully collapsed
      sortState: { proc, waits, fileio, recent, active, blocking, deadlocks },
      jobsFilter, jobsSearch, jobsSort,
      expandedSessionGroups: Set,
    }
  },
  activeConnId: string | null,
  palette: string,             // persisted in localStorage
  widgetLayout: { id, enabled }[],  // panels + sections, persisted in localStorage
}
```

---

## Widget System

- **Registry** (`widgetRegistry.js`) — two groups: `panel` (fixed position) and `section` (orderable).
- **Layout** stored in `localStorage('sqlmon-widget-layout')` as `{ id, enabled }[]`.
- **Dashboard.jsx** renders panels first (in registry order, skipping disabled), then sections in stored order.
- **WidgetSidebar** — drag-to-reorder sections, toggle any widget. Dispatches `REORDER_WIDGETS` / `TOGGLE_WIDGET`.

---

## Theming / Palette System

- 8 palettes defined in `src/lib/palettes.js`: Enterprise (default), Mossy Hollow, Golden Taupe, Wisteria Bloom, Burnt Sienna, Desert Dusk, Wildflowers, Dark.
- `applyPalette(name)` sets CSS custom properties on `:root` via `document.documentElement.style.setProperty`.
- Dark palette also sets `data-theme="dark"` attribute, enabling dark-mode CSS overrides in `index.css`.
- Palette choice persisted in `localStorage('palette')`.
- **ConnectModal** uses hardcoded light-mode colors (not CSS vars) to stay readable regardless of active palette.

---

## CSS Architecture

- `src/index.css` — Tailwind base + all component styles.
- CSS variables defined on `:root`, overridden per-palette at runtime.
- Key stability rules to prevent ApexCharts ResizeObserver growth loop:
  - `.section-body { will-change: grid-template-rows }` — composite layer isolation
  - `.section-body-inner { contain: layout style }` — stops internal layout changes propagating
  - `.chart-wrap { contain: layout; height: 224px }` — fixed chart container
  - `overflow: hidden` on all `.mc` cards and chart wrappers
- Collapse animation: `grid-template-rows: 1fr → 0fr` (CSS transition, no JS height calc).

---

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/config` | Default server/auth from `.env` |
| GET | `/api/connections` | List active connections |
| POST | `/api/connect` | Open new connection, start polling |
| DELETE | `/api/disconnect/:id` | Close connection, stop polling |
| POST | `/api/connections/:id/kill` | Kill specific SPID |
| POST | `/api/connections/:id/kill-sleeping` | Kill all sleeping sessions |
| GET | `/api/connections/:id/whoIsActive` | Run sp_WhoIsActive, return rows |
| POST | `/api/connections/:id/jobs/start` | Start SQL Agent job |
| POST | `/api/connections/:id/jobs/stop` | Stop SQL Agent job |
| GET | `/api/connections/:id/db-size-history` | DB size trend data |

---

## Auth Configuration (`.env`)

```
AUTH_TYPE=windows          # windows = trusted connection; sql = SQL auth
DB_USER=sa                 # SQL auth only
DB_PASS=secret             # SQL auth only
DB_SERVER=SERVER\INSTANCE
DB_NAME=master
PORT=3000
POLL_INTERVAL_MS=2000
```

Required SQL Server permission: `VIEW SERVER STATE`

---

## Known Design Decisions

- **Drive dedup**: `sys.dm_os_volume_stats` CROSS APPLY can return different `available_bytes` per file on same volume within one query. Server GROUPs BY `volume_mount_point` only, using `MAX(total_bytes)` and `MIN(available_bytes)`. Client-side dedup in `DriveMonitor.jsx` as safety net.
- **Collapse-always**: All sections/groups start collapsed on every page load — `collapsedSections` initialized from `ALL_SECTIONS_COLLAPSED` Set, never restored from localStorage.
- **Chart height lock**: ApexCharts with dynamic data triggers ResizeObserver loops unless height is fixed and all parent containers have `overflow: hidden`. `dynamicAnimation: false` and `redrawOnParentResize: false` also required.
- **Socket.io per connection**: Each `connId` gets its own Socket.io room. Clients join on connect, leave on disconnect.
