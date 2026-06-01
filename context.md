# App Context — SQL Server Activity Monitor

## What It Is

A live, web-based SQL Server observability dashboard that replicates and extends SSMS Activity Monitor. It pushes real-time SQL Server metrics to any browser over WebSocket at a 2-second cycle — no page refresh, no polling from the client, no stored procedures, no schema changes on the target server.

Built for DBA and infrastructure teams who need instant visibility across multiple SQL Server instances from a single internal web app.

---

## Problem It Solves

SSMS Activity Monitor is desktop-only, single-server, and requires a SQL Server Management Studio installation. This app exposes the same DMV-based diagnostics — CPU, waits, I/O, blocking, deadlocks, jobs, drive space — in a browser tab accessible to the entire team, with multi-server tabs, persistent layout preferences, and alerting thresholds that SSMS does not have.

---

## Requirements

| Requirement | Detail |
|---|---|
| Runtime | Node.js 20 LTS |
| Target SQL Server | 2012 or later |
| SQL permission | `VIEW SERVER STATE` (read-only, no DBA role needed) |
| Authentication | Windows Integrated or SQL Server login |
| Optional | `sp_WhoIsActive` installed on monitored instance |
| Browser | Any modern browser (Chrome, Edge, Firefox) |
| Network | LAN / internal network — no external traffic required |

---

## Benefits

- **Zero schema impact** — all queries target public DMVs (`sys.dm_*`). No tables created, no stored procs, no temp objects.
- **Read-only by design** — `VIEW SERVER STATE` is the only permission required. Kill-session endpoints exist but are disabled by default (`ALLOW_KILL=false`).
- **Multi-server** — monitor N SQL Server instances simultaneously; each connection is isolated in its own tab and Socket.io room with no cross-connection state leakage.
- **Sub-2-second latency** — server pushes on every poll cycle; clients never request metrics. A blocking event or CPU spike appears in the dashboard within 2 seconds.
- **No agent, no collector, no sidecar** — one Node process is the entire backend. Runs on any Windows or Linux box on the LAN.
- **Persistent preferences** — widget visibility, section order, color theme, and collapsed sections are all stored in `localStorage` and survive page reloads and server restarts.
- **Proactive alerting** — WARN/CRITICAL thresholds on KPI cards and drive space cards surface issues before they escalate. Drive space cards show live trend slope (%/hr) and ETA-to-full forecast.

---

## Architecture Summary

**Pattern:** Event-driven push. The server owns the poll clock; clients are passive receivers.

```
SQL Server DMVs (14 queries, Promise.all, every 2s)
    └─► server.js collectMetrics()
            └─► Socket.io emit 'metrics' → room[connId]
                    └─► useSocket hook → dispatch UPDATE_METRICS
                            └─► AppContext reducer → ring buffers
                                    └─► Dashboard → memoized component tree
```

No client-to-server polling. No REST calls on the hot path. The only REST calls are connection management (connect, disconnect, list) and low-frequency on-demand fetches (DB size history, Index Health scan results, sp_WhoIsActive).

---

## Frontend

**Stack:** React 18 · Vite 5 · Tailwind CSS · ApexCharts · TanStack React Virtual · Socket.io-client

### Structure

| Path | Role |
|---|---|
| `src/main.jsx` | React root — mounts `AppProvider` then `App` |
| `src/App.jsx` | Shell — renders Header, TabBar, active Dashboard, ConnectModal, WidgetSidebar |
| `src/index.css` | All design tokens as CSS custom properties; utility classes; dark mode overrides |
| `src/context/AppContext.jsx` | Single `useReducer` store for all app state; localStorage persistence inside reducer |
| `src/hooks/useSocket.js` | Socket.io lifecycle — subscribes to `metrics` events, dispatches to reducer, guards re-subscriptions with a `Set` ref |
| `src/lib/widgetRegistry.js` | Widget manifest (id, label, default enabled/order); layout load/save from localStorage |
| `src/lib/thresholds.js` | WARN/CRIT thresholds per metric; drive type classifier; threshold-to-color mapper |
| `src/lib/palettes.js` | 10 named color themes; writes CSS variable overrides to `:root` at runtime |
| `src/lib/fmt.js` | `fmtNum`, `fmtBytes`, `fmtMs`, `fmtJobDuration` — compact notation (`82.9M`, `4.3k`, `1h 22m`) |
| `src/lib/tableCols.js` | Column definitions for all sortable tables — centralizes header labels, accessor keys, widths |
| `src/components/Dashboard.jsx` | Orchestrator — reads connection state, renders enabled widgets in user-defined order |
| `src/components/KPIBar.jsx` | 6-card metric strip; each card has current value, 30s delta, SVG sparkline, WARN/CRIT badge |
| `src/components/ChartCard.jsx` | ApexCharts area chart wrapper; fixed 224px height to prevent flex-grow feedback loops |
| `src/components/VirtualTable.jsx` | Generic virtualized sortable table via `@tanstack/react-virtual`; renders only visible rows |
| `src/components/CollapsibleSection.jsx` | Animated expand/collapse wrapper; collapse state persisted per connection in `localStorage` |
| `src/components/DriveMonitor.jsx` | Per-volume capacity cards with utilization bars, trend slope, ETA-to-full, and severity color coding |
| `src/components/DbSizeTrend.jsx` | 10-day size history chart + growth table; fetches from REST on mount, re-fetches every 5 min |
| `src/components/IndexHealth.jsx` | Async fragmentation scan orchestrator with progress tracking, session recovery, and detail modal |
| `src/components/ConnectModal.jsx` | Connection form — Login tab (server/auth/label/color) + Connection String tab; saves history |
| `src/components/WidgetSidebar.jsx` | Toggle widget visibility; drag sections to reorder; layout persists to localStorage |

### State Shape

```
AppContext {
  connections: {
    [connId]: {
      id, label, server, color, appIntent,
      metrics: <latest poll payload> | null,
      history: { cpu[], wait[], io[], batch[], netMb[], compilations[] },  // ring buffer, cap 60
      diskHistory: { [volume_mount_point]: number[] },                     // free_pct ring buffer, cap 60
      lastUpdate, jobsFilter, jobsSearch, jobsSort,
      sortState: { proc, waits, fileio, recent, active, blocking, deadlocks },
      expandedSessionGroups: Set, collapsedSections: Set
    }
  },
  activeConnId: string | null,
  palette: string,
  widgetLayout: [{ id, enabled }]
}
```

### Performance Contract

The 2-second `UPDATE_METRICS` dispatch creates a new `connections` object on every tick. Without explicit memoization, this cascades into a full re-render of all 24 widgets every 2 seconds — causing progressive main-thread saturation. The memoization strategy prevents this:

- `Dashboard` — `React.memo`; only re-renders when its own connection slice changes
- `ChartCard`, `KPICard`, `MemoryHealth`, `DriveCard` — all `memo()`; re-render only when their specific props change
- All table data — `useMemo` per table; re-sorts only when source data or sort state changes, not on every tick
- `useSocket` subscribe guard — `Set` ref prevents redundant `socket.emit('subscribe')` on every metrics dispatch
- Module-level constants for `rowStyle` callbacks, tooltip content, and `sortRows` — prevents new object/function references per render from invalidating `memo()` boundaries
- Disabled widgets are fully unmounted (zero DOM, zero event listeners, zero chart instances)

**Result:** on a 2-second tick where only one metric changes, React re-renders only the components whose specific props changed.

---

## Backend

**Stack:** Node.js 20 · Express 4 · Socket.io 4 · mssql 11 (Tedious driver)

### Structure

| Path | Role |
|---|---|
| `server.js` | Single entry point — HTTP server, Socket.io, connection store, poll loop, all REST routes |
| `server/indexScanOrchestrator.js` | Async index health scan — batches `sys.dm_db_index_physical_stats` across databases, tracks progress, stores results in memory with TTL |
| `server/indexScanStore.js` | In-memory Map of scan sessions keyed by scanId; results expire after TTL |
| `server/indexScanQueries.js` | SQL for fragmentation scan, unused index detection, query impact join |
| `server/repository/` | Data access helpers for scan queries |
| `server/scanners/` | Scan strategy logic (batch sizing, progress estimation) |

### Connection Lifecycle

```
POST /api/connect
    → buildConfig()            normalize form input → mssql config
    → sql.connect(config)      create pool (max 5, min 1, idleTimeout 30s)
    → startPolling()           setInterval(collectMetrics, POLL_MS)
    → takeDbSizeSnapshot()     first snapshot immediately; hourly interval for daily
    → store in connections Map
    → return { id, label, server, color, appIntent }

collectMetrics() per tick:
    → Promise.all(14 queries)  all DMV queries in parallel
    → compute deltas           I/O MB/s and Network MB/s from prevIO map
    → io.to(connId).emit('metrics', payload)

DELETE /api/disconnect/:id
    → clearInterval(handle)    stop poll loop
    → pool.close()             release connections
    → delete from Map
```

### REST API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/connect` | Establish connection, create pool, start polling |
| `GET` | `/api/connections` | List active connections (id, label, server, color, appIntent) |
| `DELETE` | `/api/disconnect/:id` | Stop polling, close pool |
| `GET` | `/api/connections/:id/db-size-history` | 10-day rolling DB size snapshots |
| `GET` | `/api/connections/:id/error-log` | SQL Error Log (last 24h) |
| `GET` | `/api/connections/:id/whoIsActive` | sp_WhoIsActive results |
| `POST` | `/api/connections/:id/kill` | Kill session (requires `ALLOW_KILL=true`) |
| `POST` | `/api/connections/:id/kill-sleeping` | Kill idle sessions (requires `ALLOW_KILL=true`) |
| `POST` | `/api/connections/:id/index-health/scan` | Start async fragmentation scan |
| `GET` | `/api/connections/:id/index-health/scan/:scanId/progress` | Poll scan progress + ETA |
| `GET` | `/api/connections/:id/index-health/scan/:scanId/results` | Paginated scan results |

### Socket.io Protocol

```
Client → Server:
  subscribe   connId    Join room, start receiving metrics for this connection
  unsubscribe connId    Leave room (server continues polling, just stops emitting to this client)

Server → Client:
  metrics     { connId, cpu_percent, waiting_tasks, db_io_mb, batch_requests,
                processes[], resourceWaits[], fileIO[], recentExpensive[],
                activeExpensive[], blocking[], deadlocks[], jobs[], dbSizes[],
                diskDrives[], serverPerf{} }
  poll_error  { connId, message }
```

### Performance Contract

- All 14 DMV queries per connection run in `Promise.all` — parallel, not serial; single round-trip per poll cycle
- Delta metrics (I/O MB/s, Network MB/s) computed server-side from `prevIO` map — client receives pre-computed rates, not raw counters
- `requestTimeout: 15000` — slow queries time out independently without blocking the next poll cycle
- Each connection gets its own isolated mssql pool; no shared state between connections
- Credentials held only in in-process pool config; never written to disk, never logged

### Security Model

- SQL injection not possible — all queries are parameterless DMV reads; no user input is interpolated into SQL
- Credentials from POST body stored only in-process; `.env` holds only default dev credentials
- `ALLOW_KILL=false` by default; kill endpoints return 403 unless explicitly enabled
- No app-level auth — intended for internal network use; add a reverse proxy with auth for external exposure
- Minimum SQL permission: `VIEW SERVER STATE`; no `sysadmin`, no `db_owner`

---

## Monitored DMVs

| Metric | Source |
|---|---|
| CPU % | `sys.dm_os_ring_buffers` (XML parse, ProcessUtilization) |
| Waiting Tasks | `sys.dm_exec_requests` |
| Database I/O MB/s | `sys.dm_io_virtual_file_stats` (delta) |
| Batch Requests/sec, Network I/O, Compilations | `sys.dm_os_performance_counters` |
| Memory (committed / target / PLE) | `sys.dm_os_performance_counters` + `sys.dm_os_sys_info` |
| Active Processes | `sys.dm_exec_sessions` + `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |
| Resource Waits | `sys.dm_os_wait_stats` (25 benign types filtered) |
| Data File I/O | `sys.dm_io_virtual_file_stats` + `sys.master_files` |
| Recent Expensive Queries (1h) | `sys.dm_exec_query_stats` + `sys.dm_exec_sql_text` |
| Active Expensive Queries | `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |
| Blocking Chains | `sys.dm_exec_requests` (blocking_session_id) |
| Deadlock History | `sys.dm_xe_session_ring_buffer_targets` (system_health, XML parse) |
| SQL Agent Jobs | `msdb.dbo.sysjobs` + `msdb.dbo.sysjobactivity` + `msdb.dbo.sysjobhistory` |
| Database Sizes | `sys.master_files` |
| Drive Space | `sys.dm_os_volume_stats` + `sys.dm_os_enumerate_fixed_drives` / `xp_fixeddrives` |
| DB Size Trends | `sys.master_files` (daily snapshot → `data/db-size-history.json`) |
| Backup Health | `msdb.dbo.backupset` (last 60 days) |
| SQL Error Log | `sys.dm_os_ring_buffers` (RING_BUFFER_RESOURCE_MONITOR, last 24h) |
| Index Fragmentation | `sys.dm_db_index_physical_stats` + `sys.dm_exec_query_stats` (async scan) |
