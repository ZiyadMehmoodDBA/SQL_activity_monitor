# SQL Server Activity Monitor

A live, web-based SQL Server Activity Monitor — built to replicate and extend SSMS Activity Monitor with animated rolling charts, real-time data tables, multi-server tabs, and a fully configurable widget layout.

![Dashboard](https://img.shields.io/badge/stack-React%2018%20%2B%20Node.js%20%2B%20Socket.io-blue)
![Tests](https://img.shields.io/badge/tests-79%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Features

- **Live metrics every 2 seconds** — CPU, Waiting Tasks, Database I/O, Batch Requests, Network I/O, Compilations, Memory, Page Life Expectancy
- **Animated rolling charts** — 2-minute history window, ApexCharts area charts
- **KPI Strip** — 6 cards with micro sparklines, 30s trend delta, and WARN/CRITICAL status badges
- **Multi-connection tabs** — monitor multiple SQL Server instances simultaneously
- **SQL Agent Jobs** — live job status with filter, search, and sort
- **Sessions Panel** — connected sessions grouped by database
- **sp_WhoIsActive** — expandable rows with full SQL text (requires sp_WhoIsActive to be installed)
- **Database Sizes** — fill bars with low-disk alerts
- **Blocking Chains & Deadlock History** — live chain detection and XEvent ring buffer deadlocks
- **Widget Sidebar** — toggle any widget on/off, drag sections to reorder
- **Themes** — Enterprise (default), Dark, Midnight, Forest, Ocean, Rose, Slate

---

## Requirements

- Node.js 20 LTS
- SQL Server 2012 or later
- SQL login with `VIEW SERVER STATE` permission

---

## Quick Start

```bash
git clone https://github.com/ZiyadMehmoodDBA/SQL_activity_monitor.git
cd SQL_activity_monitor

cp .env.example .env
# Edit .env — set AUTH_TYPE and credentials if using SQL auth

npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) and connect to your SQL Server instance.

---

## Configuration

Edit `.env`:

```env
PORT=3000
POLL_INTERVAL_MS=2000

# windows = integrated auth (no user/pass needed)
# sql     = SQL Server auth
AUTH_TYPE=windows

DB_USER=
DB_PASS=
```

### Authentication

| `AUTH_TYPE` | How it connects |
|---|---|
| `windows` | Trusted connection (Windows Integrated Auth via Tedious) |
| `sql` | SQL Server login — provide `DB_USER` / `DB_PASS` |

Connection credentials can also be entered per-connection in the UI (the `.env` values are defaults for the server process only).

---

## Development

```bash
npm run dev        # Vite HMR dev server + Node backend via concurrently
npm run build      # Production Vite build → dist/
npm start          # Serve built dist/ + run Node backend

npm test           # Vitest watch mode
npm run test:run   # Single pass (CI)
npm run test:coverage  # Coverage report
```

---

## SQL Permission

Minimum required on the target SQL Server instance:

```sql
GRANT VIEW SERVER STATE TO [your_login];
```

All queries are read-only DMV queries. No schema changes, no stored procedures, no temp tables (except `sp_WhoIsActive` which is optional).

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full documentation covering:

- Architectural style and core principles
- Frontend and backend stack
- UI/UX design system and layout strategy
- State management (AppContext + useReducer)
- Rendering strategy and performance guarantees
- REST and Socket.io API contracts
- All monitored DMVs and their sources
- Engineering standards and test coverage

### Data Flow

```
SQL Server DMVs
    └─► server.js poll loop (every 2s, Promise.all)
            └─► Socket.io emit 'metrics' → room per connId
                    └─► useSocket hook → dispatch UPDATE_METRICS
                            └─► AppContext reducer → history ring buffer
                                    └─► Dashboard → KPIBar, Charts, Tables
```

---

## Project Structure

```
├── server.js              # Node.js backend — polling, REST API, Socket.io
├── src/
│   ├── App.jsx            # Shell: header, tabs, active dashboard
│   ├── context/
│   │   └── AppContext.jsx # Global state (useReducer), localStorage persistence
│   ├── hooks/
│   │   └── useSocket.js   # Socket.io lifecycle
│   ├── lib/
│   │   ├── widgetRegistry.js  # Widget manifest, layout persistence
│   │   ├── thresholds.js      # WARN/CRIT thresholds, status color logic
│   │   ├── palettes.js        # Named color themes
│   │   ├── fmt.js             # Number/byte/duration formatters
│   │   └── tableCols.js       # Column definitions for all tables
│   ├── components/            # All React components
│   └── index.css              # Design tokens (CSS custom properties)
├── ARCHITECTURE.md        # Full software architecture documentation
└── .env.example           # Environment variable template
```

---

## Monitored Metrics

| Metric | DMV Source |
|---|---|
| CPU % | `sys.dm_os_ring_buffers` |
| Waiting Tasks | `sys.dm_exec_requests` |
| Database I/O MB/s | `sys.dm_io_virtual_file_stats` (delta) |
| Batch Requests/sec | `sys.dm_os_performance_counters` |
| Network I/O MB/s | `sys.dm_os_performance_counters` |
| SQL Compilations/sec | `sys.dm_os_performance_counters` |
| Memory (committed / target / PLE) | `sys.dm_os_performance_counters` |
| Active Processes | `sys.dm_exec_sessions` + `sys.dm_exec_requests` |
| Resource Waits | `sys.dm_os_wait_stats` |
| Data File I/O | `sys.dm_io_virtual_file_stats` + `sys.master_files` |
| Recent Expensive Queries (1h) | `sys.dm_exec_query_stats` |
| Active Expensive Queries | `sys.dm_exec_requests` |
| Blocking Chains | `sys.dm_exec_requests` (blocking_session_id) |
| Deadlock History | `sys.dm_xe_session_ring_buffer_targets` |
| SQL Agent Jobs | `msdb.dbo.sysjobs` + `msdb.dbo.sysjobhistory` |
| Database Sizes | `sys.master_files` |
| sp_WhoIsActive | `sp_WhoIsActive` (optional) |

---

## License

MIT
