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
- **Zero backend state.** Connections held in memory on the Node process; no persistence layer. Reconnect restores from `/api/connections`.
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
│  │  DB Sizes · Processes · Resource Waits       │   │
│  │  File I/O · Recent/Active Queries            │   │
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

### Performance Goals

- No chart resize accumulation across tab switches (chart instances destroyed with Dashboard).
- No chart height feedback loop (fixed pixel height + `flex-shrink:0` + `overflow:hidden`).
- Virtualized tables for all data-heavy sections via `@tanstack/react-virtual` (rows rendered = viewport rows only, regardless of result count).
- Heavy sections (processes, queries) use `useMemo` on sorted/filtered data to avoid recompute on unrelated state changes.
- Sparklines rendered as inline SVG (`<polyline>` + `<circle>`), no chart library overhead.

---

## Backend Architecture

### Responsibilities

- Accept connection credentials via REST, create mssql pool, store in memory.
- Poll each registered connection every 2 seconds, running all metric queries in parallel via `Promise.all`.
- Emit `metrics` event per connection to all subscribed Socket.io clients.
- Handle graceful pool teardown on disconnect.

### Service Design

```
server.js (monolith — 613 lines)
├── Connection store        Map<id, { pool, label, server, handle, prevIO }>
├── buildConfig()           Normalize form input → mssql config object
├── Q{}                     Named SQL query strings (cpu, overview, waits, fileio,
│                           recentExpensive, activeExpensive, blocking, deadlocks,
│                           jobs, serverPerf, dbSizes, whoIsActive)
├── runPoll(id)             Promise.all(all queries) → emit 'metrics'
├── startPolling(id)        setInterval(runPoll, POLL_MS) → store handle
├── stopPolling(id)         clearInterval + pool close
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
                whoIsActive[], serverPerf{} }
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
