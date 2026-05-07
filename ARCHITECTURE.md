# Software Architecture

**SQL Server Activity Monitor** — live observability dashboard for Microsoft SQL Server.  
Equivalent to SSMS Activity Monitor with animated charts, real-time tables, multi-connection tabs, and configurable widget layout.

---

## Architectural Style

**Event-driven real-time web application** — server pushes metrics via WebSocket on a fixed 2-second poll cycle. Clients receive and render without polling.

Single-page application (React) backed by a stateless Node.js + Express server. No database tier; all persistent state is SQL Server (read-only DMV queries) or localStorage (user preferences).

---

## Core Principles

- **Push, don't pull.** Server emits on every poll cycle; clients never request metrics.
- **Read-only.** All SQL queries target DMVs (`sys.dm_*`, `sys.master_files`). No schema changes, no writes. Requires only `VIEW SERVER STATE`.
- **Multi-connection.** Multiple SQL Server instances tracked simultaneously via connection-scoped state; only the active tab renders a Dashboard.
- **Minimal backend state.** Connections held in memory on the Node process. The only server-side persistence is `data/db-size-history.json` for daily DB size snapshots. Reconnect restores connection list from `/api/connections`.
- **Theme-first.** All colors flow through CSS custom properties. No hardcoded color values in component code.
- **Render isolation.** Only the active dashboard renders. Inactive connections accumulate no chart ResizeObservers or animation timers.

---

## Recommended Stack

### Frontend
| Layer | Choice |
|---|---|
| Framework | React 18 (functional components, hooks) |
| Build | Vite 5 |
| Styling | Tailwind CSS + CSS custom properties (design tokens) |
| Charts | ApexCharts (`react-apexcharts`) |
| Virtualization | `@tanstack/react-virtual` |
| Real-time | `socket.io-client` |
| State | `useReducer` + React Context |
| Testing | Vitest + @testing-library/react + jsdom |

### Backend
| Layer | Choice |
|---|---|
| Runtime | Node.js 20 LTS |
| HTTP | Express 4 |
| WebSocket | Socket.io 4 |
| SQL driver | `mssql` (Tedious) |
| Auth | Windows Integrated or SQL Auth via `.env` |

### Database
SQL Server 2012+. Queries target only public DMVs accessible via `VIEW SERVER STATE`. No schema, no stored procs, no temp tables.

---

## UI/UX Architecture

### Design Goals
- **Enterprise observability aesthetic** — Grafana/Datadog/Azure Monitor register. Dense information, minimal decoration.
- **Status-only color** — KPI values are neutral by default. Color (warning amber, critical red) appears only when a threshold is breached. No decorative coloration.
- **Compact notation** — large numbers formatted as `82.9M`, `4.3k` throughout. Full value on hover.
- **Dark and light mode** — all components adapt via `data-theme="dark"` on `<html>` and CSS custom property overrides. No component-level theme logic.

### Design System

All color, spacing, and semantic tokens defined in `src/index.css` `:root`:

```
--body-bg, --body-text, --header-bg
--card-bg, --card-shadow, --card-radius
--badge-bg, --badge-text
--divider, --row-hover, --section-hover
--text-primary, --text-secondary, --text-muted
--c-ok, --c-warn, --c-crit, --c-info
--sort-active
--val-cpu, --val-wait, --val-io, --val-batch
--dot-live, --dot-dead, --dot-warn, --dot-idle
--status-run-*, --status-susp-*, --status-sleep-*, --status-bgnd-*
```

Shared CSS utility classes for cross-cutting concerns:
- `.mc` / `.mc-click` — metric card base + hover lift
- `.vt-th` / `.vt-td` — virtualized table header/cell
- `.wia-th` / `.wia-td` / `.wia-row-*` — sp_WhoIsActive table
- `.form-label`, `.form-input`, `.form-select`, `.form-textarea` — modal form tokens
- `.form-segmented`, `.form-segmented-btn`, `.form-error` — modal controls
- `.chart-wrap` — fixed 224px chart container, no flex growth
- `.op-scroll` — thin custom scrollbar

Severity colors accessed via `src/lib/thresholds.js` → `metricStatusColor(key, value)` → `var(--c-crit)` / `var(--c-warn)` / `null`.

Palettes (`src/lib/palettes.js`): named color schemes (Enterprise, Dark, Midnight, etc.) applied by writing CSS variable overrides to `:root`. Stored in `localStorage`.

### Layout Strategy

```
┌─────────────────────────────────────────────────────┐
│ Header (fixed, z-50)                                 │
│  server name · last-update · status dot · controls   │
├─────────────────────────────────────────────────────┤
│ TabBar (one tab per connection)                      │
├─────────────────────────────────────────────────────┤
│ main (p-6, max-w-1920, auto margins)                 │
│  ┌──────────────────────────────────────────────┐   │
│  │ KPI Bar (6-col CSS Grid)                     │   │
│  │  CPU · Wait · Sessions · DB I/O · Mem · PLE  │   │
│  ├──────────────────────────────────────────────┤   │
│  │ Chart Grid (CSS Grid, auto-fill minmax 280px) │   │
│  │  up to 7 ApexCharts area charts              │   │
│  ├──────────────────────────────────────────────┤   │
│  │ Memory Health panel                          │   │
│  ├──────────────────────────────────────────────┤   │
│  │ Jobs Panel · Sessions Panel (fixed height)   │   │
│  ├──────────────────────────────────────────────┤   │
│  │ CollapsibleSection × N (widget order driven) │   │
│  │  DB Sizes · DB Size Trends · Processes       │   │
│  │  Resource Waits · File I/O · Recent/Active   │   │
│  │  sp_WhoIsActive · Blocking · Deadlocks       │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

Disabled widgets are fully unmounted (not `display:none`). Widget order for sections is user-configurable via drag-and-drop in the sidebar and persisted to `localStorage`.

### Dashboard Behavior

- **One active Dashboard at a time.** Switching tabs unmounts the previous Dashboard, destroying all chart instances and timers. No background re-rendering.
- **Fixed chart height** — `.chart-wrap` enforces `height/min-height/max-height: 224px; flex-shrink:0; overflow:hidden` and ApexCharts renders at `height={224}` (pixel). Prevents flex-grow feedback loops.
- **Chart resize prevention** — `redrawOnWindowResize: false`, `redrawOnParentResize: false` on all ApexCharts instances.
- **Sections collapse state** persisted per connection via `localStorage` key `sqlmon-collapsed-{connId}`.
- **Sort state** persisted in `AppContext` per connection per table (never resets on re-render).

### Accessibility

- Semantic HTML (`<table>`, `<thead>`, `<th>`, `<button>`, `<input>`).
- Status badges use both color and text label (CRITICAL / WARNING), not color alone.
- SVG sparklines marked `aria-hidden`.
- Tooltips via CSS positioning, not `title` attributes.

---

## Frontend Architecture

### Structure

```
src/
├── main.jsx                  # React root, AppProvider wrapper
├── App.jsx                   # Route shell: header, tabbar, single active Dashboard
├── index.css                 # Design tokens, utility classes, dark mode overrides
├── context/
│   └── AppContext.jsx         # Global useReducer store, localStorage persistence
├── hooks/
│   └── useSocket.js           # Socket.io lifecycle, dispatches UPDATE_METRICS
├── lib/
│   ├── widgetRegistry.js      # Widget manifest, layout load/save/default
│   ├── thresholds.js          # Warn/crit thresholds, metricStatusColor()
│   ├── palettes.js            # Named color palettes, applyPalette()
│   ├── fmt.js                 # fmtNum, fmtBytes, fmtMs, fmtJobDuration
│   ├── tableCols.js           # Column definitions for all VirtualTable instances
│   └── cn.js                  # clsx-compatible className helper
├── components/
│   ├── Dashboard.jsx          # Orchestrator: reads state, renders widget tree
│   ├── KPIBar.jsx             # 6-card KPI strip with sparklines and tooltips
│   ├── ChartCard.jsx          # Single ApexCharts area card
│   ├── MemoryHealth.jsx       # Memory health gauges and detail table
│   ├── JobsPanel.jsx          # SQL Agent jobs (fixed height, virtualized)
│   ├── SessionsPanel.jsx      # Connected sessions grouped by database
│   ├── WhoIsActive.jsx        # sp_WhoIsActive results with expand-row
│   ├── DbSizes.jsx            # Database size cards with fill bars
│   ├── DbSizeTrend.jsx        # 10-day DB size trend chart + growth table
│   ├── VirtualTable.jsx       # Generic virtualized sortable table
│   ├── CollapsibleSection.jsx # Expandable/collapsible section wrapper
│   ├── TabBar.jsx             # Connection tabs
│   ├── Header.jsx             # App header
│   ├── ConnectModal.jsx       # New connection form
│   ├── WidgetSidebar.jsx      # Widget show/hide and section reorder
│   └── ui/                   # Primitive components: Button, Badge, Dialog
└── test/ + __tests__/        # Vitest test files (79 tests)
```

### State Management

Single `useReducer` store in `AppContext`. No external state library.

**State shape:**
```
{
  connections: {
    [id]: {
      id, label, server, color, appIntent,
      metrics: null | <latest poll payload>,
      history: { cpu[], wait[], io[], batch[], netMb[], compilations[] },  // ring buffer, max 60
      diskHistory: { [volume_mount_point]: number[] },  // free_pct ring buffer, max 60
      lastUpdate: timestamp | null,
      jobsFilter, jobsSearch, jobsSort,
      sortState: { proc, waits, fileio, recent, active, blocking, deadlocks },
      expandedSessionGroups: Set,
      collapsedSections: Set,
    }
  },
  activeConnId: string | null,
  palette: string,
  widgetLayout: { id, enabled }[],
}
```

**Actions:**
- `ADD_CONN` / `REMOVE_CONN` / `SET_ACTIVE`
- `UPDATE_METRICS` — merges new poll data, pushes all 6 history series
- `SET_PALETTE`
- `TOGGLE_SECTION` / `SET_TABLE_SORT`
- `SET_JOBS_FILTER` / `SET_JOBS_SEARCH` / `SET_JOBS_SORT`
- `TOGGLE_SESSION_GROUP`
- `TOGGLE_WIDGET` / `REORDER_WIDGETS` / `RESET_WIDGET_LAYOUT`

All localStorage writes happen inside the reducer (palette, widget layout, collapsed sections).

### Rendering Strategy

- `Dashboard` wrapped in `React.memo`. Only re-renders when its connection's slice of state changes.
- `SectionBadge` defined at **module level** as `memo(...)`. Defined inside Dashboard would create a new component type identity on every Dashboard render, causing CollapsibleSection to unmount+remount its badge on every metrics update.
- Widget visibility via **conditional render** (`on(id) && <Widget />`), not `display:none`. Disabled widgets produce zero DOM, zero event listeners, zero chart instances.
- `useMemo` for `layoutMap`, `orderedSections`, `enabledCharts`, series and options in ChartCard and KPIBar.
- `useCallback` for sort handlers, kill handlers.
- History ring buffer capped at 60 readings (2 minutes) via `pushHist()`.

### Performance Architecture

The 2-second poll cycle dispatches `UPDATE_METRICS` to `AppContext`, which creates a new `connections` object on every tick. Without explicit memoization, this would cascade into a full re-render of the entire widget tree every 2 seconds — causing progressive main-thread saturation and eventual "Page Unresponsive" in the browser.

**Memoization boundaries** prevent cascade re-renders:

| Component | Memoization | Trigger condition |
|---|---|---|
| `ChartCard` | `memo()` | Re-renders only when `history`, `value`, `color`, or `yMax` changes |
| `KPICard` | `memo()` | Re-renders only when `primary`, `statusVal`, `history`, or `subtitle` changes |
| `MemoryHealth` | `memo()` | Re-renders only when `conn.metrics.serverPerf` values change |
| `Dashboard` sortedData | 7× `useMemo` | Each table re-sorts only when its own source array or sort state changes |
| `SessionsPanelInner` groups | `useMemo([processes, expandedGroups])` | Group rebuild skipped if processes unchanged |
| `JobsPanelInner` filtered list | `useMemo([jobs, jobsFilter, jobsSearch, jobsSort])` | Filter+sort skipped if inputs unchanged |
| `WhoIsActive` filtered rows | `useMemo([rows, search])` | Filter skipped if rows and search unchanged |
| `SparklineMemo` (KPIBar) | `memo()` + `useMemo` for slice | `history.slice(-20)` only recomputed when history array changes |

**`sortRows()` is module-level** — defined once, never recreated. Called by each `useMemo` via stable reference.

**`rowStyle` callbacks are module-level constants** (`BLOCKING_ROW_STYLE`, `DEADLOCK_ROW_STYLE`) — not inline lambdas. Inline lambdas would create a new function reference per render, invalidating `VirtualTable`'s internal memoization.

**Tooltip content is module-level** (`TT_CPU`, `TT_WAIT`, `TT_IO`, etc.) — inline array literals create new object references every render, forcing `KPICard memo()` to see changed props and re-render even when metric values are identical.

**`useSocket` subscribe guard** — `AppContext` reducer returns a new `connections` object on every `UPDATE_METRICS`, so the `[connections]` effect dependency fires every 2 seconds. A `subscribedRef` (Set) gates the `socket.emit('subscribe')` call: it only emits for IDs not already in the Set, making the effect body O(1) on the hot path with no socket traffic.

**Result:** on a 2s tick where only one metric changes, React re-renders only the components whose specific props changed. The full 17-widget cascade that caused "Page Unresponsive" after extended runtime is eliminated.

### Performance Goals

- No chart resize accumulation across tab switches (chart instances destroyed with Dashboard).
- No chart height feedback loop (fixed pixel height + `flex-shrink:0` + `overflow:hidden`).
- Virtualized tables for all data-heavy sections via `@tanstack/react-virtual` (rows rendered = viewport rows only, regardless of result count).
- Memoized sort/filter on all tabular data — recomputes only when source data or sort/filter state changes, not on every poll tick.
- Sparklines rendered as inline SVG (`<polyline>` + `<circle>`), no chart library overhead.
- Stable reference discipline: no inline array/object literals or lambda functions in JSX props of `memo()`-wrapped components.

---

## Backend Architecture

### Responsibilities

- Accept connection credentials via REST, create mssql pool, store in memory.
- Poll each registered connection every 2 seconds, running all metric queries in parallel via `Promise.all`.
- Emit `metrics` event per connection to all subscribed Socket.io clients.
- Handle graceful pool teardown on disconnect.

### Service Design

```
server.js
├── DB history helpers      loadDbHistory(), saveDbHistory(), pruneDbHistory()
│                           takeDbSizeSnapshot() — daily sys.master_files snapshot
├── Connection store        Map<id, { pool, label, server, handle,
│                                     snapshotHandle, prevIO, prevNet }>
├── buildConfig()           Normalize form input → mssql config object
├── Q{}                     Named SQL query strings (cpu, overview, ioSnapshot,
│                           processes, resourceWaits, dataFileIO,
│                           recentExpensive, activeExpensive, blocking, deadlocks,
│                           serverPerf, jobs, dbSizes, diskDrives)
├── collectMetrics()        Promise.all(14 queries) → extra OS drives merge → emit 'metrics'
└── REST routes + Socket.io event handlers
```

### API Design

**REST (JSON):**
```
POST   /api/connect          { server, database, authType, user, password,
                               encrypt, trustServerCert, label, appIntent }
                             → { id, label, server, color, appIntent }

GET    /api/connections       → [{ id, label, server, color, appIntent }]

DELETE /api/disconnect/:id    → { ok: true }

GET    /api/connections/:id/db-size-history
                             → { "YYYY-MM-DD": { "DbName": { data_bytes, log_bytes, total_bytes } } }
```

**Socket.io events:**
```
Client → Server:
  subscribe   connId      Start receiving metrics for this connection
  unsubscribe connId      Stop receiving (does not stop server poll)

Server → Client:
  metrics     { connId, cpu_percent, waiting_tasks, db_io_mb, batch_requests,
                processes[], resourceWaits[], fileIO[], recentExpensive[],
                activeExpensive[], blocking[], deadlocks[], jobs[], dbSizes[],
                diskDrives[], whoIsActive[], serverPerf{} }
  poll_error  { connId, message }
```

Each client joins a Socket.io room named by `connId`. The server emits to `io.to(connId)`.

### Performance Strategy

- All per-connection queries run in `Promise.all` — parallel, not serial. Single round-trip per poll cycle.
- Delta metrics (I/O MB/s, network MB/s) computed server-side from `prevIO` map. Clients receive pre-computed rates.
- `requestTimeout: 15000` — slow queries don't block the poll cycle; they time out and the next cycle starts fresh.
- Pool size: `max: 5, min: 1`. Idle timeout: 30s. Each connection gets its own isolated pool.
- `POLL_MS` configurable via `.env` (`POLL_INTERVAL_MS`). Default 2000ms.

### Security

- **Authentication:** Windows Integrated (`trustedConnection: true`) or SQL Auth (`user` + `password` from request body, never logged).
- **Authorization:** No app-level auth. Intended for internal network / local use. Add a reverse proxy with auth for external exposure.
- **SQL injection:** All queries use parameterless DMV reads. No user input interpolated into SQL.
- **Credential storage:** Server holds credentials only in the mssql pool config object (in-process memory). Never written to disk or logged. `.env` holds default/dev credentials only; production credentials come from the POST body.
- **Minimum SQL permission required:** `VIEW SERVER STATE` on the target instance.

---

## Operational Features

### Monitoring

| Panel | Source DMV |
|---|---|
| CPU % | `sys.dm_os_ring_buffers` (ProcessUtilization field, XML parse) |
| Waiting Tasks | `sys.dm_exec_requests` (status IN 'suspended','waiting') |
| Database I/O MB/s | `sys.dm_io_virtual_file_stats` delta between polls |
| Batch Requests/sec | `sys.dm_os_performance_counters` |
| Network I/O MB/s | `sys.dm_os_performance_counters` |
| SQL Compilations/sec | `sys.dm_os_performance_counters` |
| Memory (committed, target, PLE) | `sys.dm_os_performance_counters` + `sys.dm_os_sys_info` |
| Active Processes | `sys.dm_exec_sessions` + `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |
| Resource Waits | `sys.dm_os_wait_stats` (benign wait types filtered) |
| Data File I/O | `sys.dm_io_virtual_file_stats` + `sys.master_files` |
| Recent Expensive Queries (1h) | `sys.dm_exec_query_stats` + `sys.dm_exec_sql_text` |
| Active Expensive Queries | `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |
| Blocking Chains | `sys.dm_exec_requests` (blocking_session_id chain) |
| Deadlock History | `sys.dm_xe_session_ring_buffer_targets` (system_health XE session) |
| SQL Agent Jobs | `msdb.dbo.sysjobs` + `msdb.dbo.sysjobhistory` |
| Database Sizes | `sys.master_files` + `FILEPROPERTY` |
| sp_WhoIsActive | `sp_WhoIsActive` (if installed) |
| **Drive Space** | `sys.dm_os_volume_stats` CROSS APPLY `sys.master_files` + `sys.dm_os_enumerate_fixed_drives` / `xp_fixeddrives` |
| **DB Size Trends** | `sys.master_files` (daily snapshot → `data/db-size-history.json`) |

### Drive Space Monitoring

Drive space is collected on every poll cycle via `Q.diskDrives` — a single aggregated query that joins `sys.master_files` with `sys.dm_os_volume_stats`. One row per logical volume that hosts at least one SQL Server file.

**OS-drive visibility** — production servers often have all SQL Server files on non-OS drives (D:, E:, etc.), leaving C:\ out of the DMV results. After the main query, `collectMetrics` runs a supplemental query to include any drives not already covered:

1. **SQL Server 2019+**: `sys.dm_os_enumerate_fixed_drives` — returns all fixed drives with full total + free bytes.
2. **SQL Server 2012–2017 fallback**: `EXEC xp_fixeddrives` — returns free MB only; total size unavailable.

Drives added via the fallback path have `total_bytes = 0`. `DriveCard` detects this and renders a compact **OS DRIVE** card (free space shown, no utilization bar or thresholds — there are no SQL files on the drive to protect).

**Query result columns:**

| Column | Description |
|---|---|
| `volume_mount_point` | Drive letter / mount point (e.g. `C:\`, `D:\`) |
| `total_bytes` / `available_bytes` / `used_bytes` | Raw sizes as FLOAT |
| `used_pct` / `free_pct` | Pre-computed percentages (DECIMAL 5,1) |
| `has_tempdb` | 1 if TempDB files live on this volume |
| `has_log` | 1 if any transaction log files live here |
| `has_data` | 1 if any data (ROWS) files live here (excluding TempDB) |
| `database_count` | COUNT(DISTINCT database_id) on this volume |
| `file_count` | Total SQL files on this volume |

**Drive type classification** (`driveType()` in `thresholds.js`):

```
C:\ (or C:/)  → system
has_tempdb     → tempdb
has_log only   → log
all others     → data
```

**Threshold engine** (`DRIVE_THRESHOLDS` in `thresholds.js`):

All thresholds are **free-space percentages** (lower = more full = worse):

| Drive type | Warning | Critical | Emergency |
|---|---|---|---|
| `system` C:\ | < 20% free | < 10% free | < 5% free |
| `data` | < 15% free | < 8% free | — |
| `log` | < 25% free | < 15% free | — |
| `tempdb` | < 25% free | < 15% free | — |

`driveStatusLevel(drive)` returns `{ color, label, level }`:
- level 0 → `C_OK` (#16a34a) HEALTHY
- level 1 → `C_WARN` (#ea580c) WARNING
- level 2 → `C_CRIT` (#dc2626) CRITICAL
- level 3 → `C_EMERGENCY` (#7f1d1d) EMERGENCY

**History and trend (`diskHistory` in `AppContext`):**

`diskHistory: { [volume_mount_point]: number[] }` — per-volume ring buffer of `free_pct` readings, capped at `HISTORY_MAX = 60` (2 minutes). Built in `UPDATE_METRICS` reducer alongside the existing metric history arrays.

Trend calculation (module-level `calcTrend()` in `DriveMonitor.jsx`):
1. Take last 30 readings (last 60s)
2. `slope = (last − first) / count` — change in free_pct per reading
3. `slopePerHour = slope × 1800` (1800 readings/hr at 2s intervals)
4. ETA to full: `free_pct / |slope| × 2s` — only projected when slope < −0.005%/reading (suppresses noise)

ETA display: `< 1 hr` / `X hr` / `X days` / `> 1 week`.

**`DriveMonitor` component rendering rules:**
- Renders `null` when `diskDrives` array is empty (safe for connections that fail the DMV query)
- Default sort: `free_pct` ascending (most critical drive first)
- All per-drive cards memoized with `memo()` + `useMemo([history])` for trend — prevents sort/header re-renders from recomputing trend on all drives

### Database Size Trend Monitoring

Tracks how database sizes change over time using daily snapshots stored in a local JSON file (`data/db-size-history.json`). This is the only persistent state written by the server process (read-only against SQL Server is maintained — the snapshot query reads `sys.master_files` only).

**Snapshot query** (`takeDbSizeSnapshot()` in `server.js`):
```sql
SELECT DB_NAME(mf.database_id) AS database_name,
  SUM(CASE WHEN type_desc='ROWS' THEN size*8192 ELSE 0 END) AS data_bytes,
  SUM(CASE WHEN type_desc='LOG'  THEN size*8192 ELSE 0 END) AS log_bytes,
  SUM(size)*8192                                             AS total_bytes
FROM sys.master_files mf
WHERE mf.database_id > 0 AND mf.state = 0
GROUP BY mf.database_id
```

**Capture schedule:**
- Snapshot taken immediately on first connection to a server.
- Hourly interval (`setInterval`, 1hr) checks if today's snapshot exists; takes it if not. This means exactly one snapshot per calendar day regardless of how long the connection has been open.
- `snapshotHandle` stored on the `conn` object alongside `handle` and cleared in the disconnect handler.

**Persistence (`data/db-size-history.json`):**
```json
{
  "SERVER\\INSTANCE": {
    "YYYY-MM-DD": {
      "DatabaseName": { "data_bytes": 0, "log_bytes": 0, "total_bytes": 0 }
    }
  }
}
```
- Keyed by `conn.server` (the raw server string from the connect form — stable across restarts, unlike the ephemeral `connId` UUID).
- History pruned to last 10 calendar days on every write via `pruneDbHistory()`.
- File created automatically in `data/` (created at startup if absent).

**REST endpoint:**
```
GET /api/connections/:id/db-size-history
→ { "YYYY-MM-DD": { "DbName": { data_bytes, log_bytes, total_bytes }, ... }, ... }
```

**`DbSizeTrend` component (`src/components/DbSizeTrend.jsx`):**
- Fetches history on mount and re-fetches every 5 minutes.
- Derives chart series in a single `useMemo([history])`: sorts databases by current total size, maps each to a GB-unit series array aligned on the sorted date axis.
- **ApexCharts multi-series line chart** — one series per database (capped at 15 visible in chart), smooth curve, markers at each data point, date-formatted x-axis (`MM-DD`).
- **Search filter** — input filters both the chart series and the growth table simultaneously.
- **Growth table** — one row per database showing: Total Size, Data, Log, 10-Day Growth (signed, amber for growth / green for reclaim), Daily Avg, and a **SPIKE** badge when any single-day delta exceeds 3× the average daily growth for that database.
- Shows graceful empty state when no history exists yet ("Snapshots captured daily — data will appear after the first day").

**State shape addition (`AppContext`):**
No reducer changes needed — `DbSizeTrend` manages its own local state via `useState`/`useEffect` and fetches directly from the REST endpoint. History data is not pushed via Socket.io since it is low-frequency (daily) and fetched on demand.

### Dashboard Features

- **KPI Bar** — 6 cards: CPU, Waiting Tasks, Sessions, Database I/O, SQL Memory, Page Life Expectancy. Each card shows: current value, 30s delta trend, micro sparkline (last 20 readings), status badge (WARN/CRITICAL only), threshold tooltip on hover.
- **Live Charts** — 7 area charts (CPU, Waiting Tasks, DB I/O, Batch Requests, Network I/O, Compilations, Memory). 60-point rolling window (2 minutes). Fixed 224px height.
- **Memory Health** — committed vs target vs max memory bars, PLE gauge, memory clerk breakdown.
- **SQL Agent Jobs** — filterable by status (all/running/failed/succeeded), searchable, sortable. Virtualized.
- **Sessions Panel** — active connections grouped by database. Toggle groups. Virtualized.
- **sp_WhoIsActive** — expandable rows showing full SQL text. Manual refresh. Search filter.
- **Database Sizes** — per-database size cards with data/log fill bars and low-disk alerts.
- **Collapsible Sections** — all tabular sections collapse/expand, state persisted per connection.
- **Widget Sidebar** — toggle any widget on/off; drag sections to reorder. Layout persisted to `localStorage`.
- **Drive Space Monitor** — one card per logical volume hosting SQL Server files, plus OS-only drives sourced from `sys.dm_os_enumerate_fixed_drives` or `xp_fixeddrives`. Utilization bar, Total/Used/Free sizes, type badge (SYSTEM/DATA/LOG/TEMPDB/OS DRIVE), trend arrow with %/hr rate and ETA-to-full forecast. Expandable detail with DB/file counts and threshold reference. Sort by % Free (default, most critical first), Drive letter, or Size. Header shows aggregate critical/warning badge counts. Threshold-based color coding with four severity levels (Healthy/Warning/Critical/Emergency). OS drives with no SQL files render a compact card showing free space only.
- **Database Size Trends** — 10-day rolling history of database sizes. Daily snapshots persisted to `data/db-size-history.json` (one snapshot per calendar day, taken on connect and checked hourly). ApexCharts multi-series line chart with one series per database (up to 15 in chart), database search filter, and growth table showing Total/Data/Log sizes, 10-day growth, daily average, and spike detection.
- **Multi-connection Tabs** — monitor multiple SQL Server instances simultaneously.
- **Themes/Palettes** — Enterprise (default), Dark, Midnight, Forest, Ocean, Rose, Slate. CSS var swap, persisted.

---

## Engineering Standards

### Code Quality

- No hardcoded color values in component code. All colors via CSS custom properties or semantic tokens from `thresholds.js`.
- No logic duplicated across components. Shared formatters in `src/lib/fmt.js`. Shared column definitions in `src/lib/tableCols.js`. Shared threshold logic in `src/lib/thresholds.js`.
- Module-level component definitions only. No components defined inside render functions (prevents React identity churn → unmount/remount cascades).
- CSS token classes (`.vt-th`, `.form-input`, etc.) for patterns used in 2+ components. Inline styles only for values that are dynamic or component-specific.

### Testing

- **Test runner:** Vitest 4 + jsdom environment
- **Coverage:** 79 tests across 8 files
  - `lib/fmt.test.js` — formatting utilities
  - `lib/widgetRegistry.test.js` — registry integrity, layout persistence
  - `context/reducer.test.jsx` — all reducer actions including history cap and localStorage side effects
  - `components/JobsPanel.test.jsx` — filter, search, sort, status badges
  - `components/SessionsPanel.test.jsx` — grouping, expand, process count
  - `components/WhoIsActive.test.jsx` — fetch, refresh, expand row, search, error state
  - `components/WidgetSidebar.test.jsx` — toggle, reorder, reset, close
  - `integration/persistence.test.js` — localStorage round-trips for layout and palette

- **Key test patterns:**
  - `renderWithContext(ui)` wraps with `AppProvider` for reducer access
  - `@tanstack/react-virtual` mocked to return all rows (no viewport math in jsdom)
  - `socket.io-client` mocked to noop
  - `ResizeObserver` stubbed
  - `fetch` stubbed per test

### DevOps

```bash
npm start          # Production: builds Vite → dist/, starts server.js
npm run dev        # Vite dev server (HMR) + server.js via concurrently
npm run build      # Vite production build to dist/
npm test           # Vitest watch
npm run test:run   # Vitest single pass (CI)
npm run test:coverage  # Coverage report
```

Environment config via `.env`:
```
PORT=3000
POLL_INTERVAL_MS=2000
AUTH_TYPE=windows|sql
DB_USER=
DB_PASS=
```

---

## Expected Outcome

A production-grade internal SQL Server observability tool that:

- Shows **live metrics within 2 seconds** of a condition occurring on the server
- Handles **multiple simultaneous SQL Server connections** with zero cross-connection interference
- Renders **smoothly at any window size** without chart height drift, resize accumulation, or layout thrashing
- Adapts **fully to dark/light/custom themes** with no component-level theme logic
- Allows operators to **customize the dashboard layout** (widget visibility, section order) with preferences persisted across sessions
- Requires **no database schema changes** and only `VIEW SERVER STATE` permission
- Maintains **79+ passing tests** across all core logic, state management, and UI components
- Proactively alerts operations teams to **drive space risks** before they cause SQL Server service disruption, with per-volume thresholds tuned to drive type (system/data/log/tempdb) and live trend forecasting
- Surfaces **database size growth trends** over 10 days with daily average rates and spike detection, enabling capacity planning before storage is exhausted
