# Skills — SQL Server Activity Monitor

Skills and competencies demonstrated by this codebase, organized by discipline.

---

## Frontend Engineering

### React 18
- Functional components with hooks throughout — no class components
- `useReducer` + React Context as single-source-of-truth state store; no external state library
- `React.memo` on all leaf components that receive metric props — prevents 2-second cascade re-renders
- `useMemo` for all sorted/filtered table data; `useCallback` for stable event handler references
- Module-level component and constant definitions — avoids React identity churn that causes unmount/remount cascades
- Conditional render (`enabled && <Widget />`) for widget visibility — zero DOM for disabled widgets

### Performance Optimization
- Memoization boundary design: identified exactly which components re-render on every 2s tick without memo, and placed `memo()` + `useMemo` at each boundary
- Stable reference discipline: no inline object literals, array literals, or lambda functions as props to `memo()`-wrapped components — each would create a new reference per render and invalidate the memo
- `useSocket` subscribe guard using `Set` ref — prevents `socket.emit('subscribe')` from firing on every metrics dispatch despite `[connections]` dependency changing every 2s
- Fixed-height chart containers (`224px` with `flex-shrink:0` and `contain:layout`) — eliminates ApexCharts ResizeObserver feedback loops
- `@tanstack/react-virtual` for all large result tables — renders only viewport rows regardless of result count
- Tab switch destroys and recreates Dashboard — no background chart instances or animation timers

### CSS Architecture
- CSS custom property (design token) system — zero hardcoded color values in component code
- All palette variants expressed as token overrides; theme switching is a one-pass write to `:root` style
- `grid-template-rows: 1fr → 0fr` collapse animation — animates to actual content height without a fixed `max-height` cap
- `contain: layout style` on section inner wrapper — isolates ApexCharts ResizeObserver from outer document reflow
- `will-change: grid-template-rows` on animated section body — keeps collapse transitions on their own composite layer
- `data-theme="dark"` attribute on `<html>` for dark mode — no component-level theme logic needed

### Build & Tooling
- Vite 5 with React plugin — HMR dev server, production build to `dist/`
- Tailwind CSS via PostCSS — utility classes co-exist with custom property tokens
- Vitest 4 + `@testing-library/react` + jsdom — 79 tests across state, UI, and integration layers
- `concurrently` for dev: Vite HMR + Node backend in one terminal

---

## Backend Engineering

### Node.js / Express
- Single-process Express server — no worker threads, no microservices, no message queue
- Connection store as in-process `Map<connId, { pool, handle, snapshotHandle, prevIO, prevNet }>` — lightweight, no DB tier required
- `Promise.all` for 14 parallel DMV queries per poll cycle — single round-trip per 2-second tick
- Delta computation server-side (`prevIO` map) — clients receive MB/s rates, not raw counter snapshots
- Graceful pool teardown on disconnect: `clearInterval` → `pool.close()` → `Map.delete()`
- Daily DB size snapshot with hourly idempotency check — exactly one snapshot per calendar day, no duplicates

### Socket.io
- Per-connection Socket.io rooms keyed by `connId` — isolates multi-server broadcast
- Server-initiated push model — clients subscribe once, receive on every poll cycle without polling
- `poll_error` event propagated to client on query failure — UI shows per-connection error state

### SQL Server / DMV Querying
- 19 DMV sources across CPU, waits, I/O, memory, processes, jobs, drive space, deadlocks, backup history, error log
- XEvent ring buffer XML parsing for deadlock history (`sys.dm_xe_session_ring_buffer_targets`)
- `sys.dm_os_ring_buffers` XML parsing for CPU % (ProcessUtilization field)
- Drive space cross-apply: `sys.dm_os_volume_stats` + `sys.master_files` + fallback to `xp_fixeddrives` for SQL Server 2012–2017 compatibility
- 25 benign wait types explicitly filtered from resource wait results
- `requestTimeout: 15000` — slow queries time out without blocking the poll cycle
- Async index fragmentation scan: batched `sys.dm_db_index_physical_stats` with per-database chunking, progress tracking, and session recovery

### Security Design
- Parameterless DMV queries — no SQL injection surface; no user input interpolated into SQL
- Credentials held only in in-process mssql pool config — never written to disk, never logged
- `ALLOW_KILL=false` default — kill-session endpoints return `403` unless explicitly enabled via `.env`
- Minimum permission principle: `VIEW SERVER STATE` only; no `sysadmin`, no `db_owner`
- No app-level auth — scoped for internal network use with reverse-proxy auth expected for external exposure

---

## SQL Server Expertise

| Area | Skill |
|---|---|
| DMV querying | 19 DMV sources; ring buffer XML parsing; delta metrics from file stats |
| Wait statistics | 25 benign wait types filtered; real-time categorization (locking, I/O, memory, parallelism, network) |
| Query performance | `sys.dm_exec_query_stats` for historical; `sys.dm_exec_requests` + `sys.dm_exec_sql_text` for live |
| Blocking analysis | Recursive blocking chain detection via `blocking_session_id`; blocker vs. blocked query comparison |
| Deadlock history | XEvent system_health ring buffer; XML parsing to extract spids, logins, resources, lock modes |
| Index health | `sys.dm_db_index_physical_stats` fragmentation scan; unused index detection via `sys.dm_exec_query_stats` join |
| Drive space | `sys.dm_os_volume_stats` per-volume; OS-drive fallback via `sys.dm_os_enumerate_fixed_drives` and `xp_fixeddrives` |
| Capacity planning | Daily DB size snapshots; 10-day trend; spike detection (3× avg daily growth); drive ETA-to-full forecast |
| SQL Agent | `msdb.dbo.sysjobs` + `sysjobactivity` + `sysjobhistory`; live status, last-run result, duration |
| Backup monitoring | `msdb.dbo.backupset`; last backup age per database; status badge; ETA-to-critical |
| Auth modes | Windows Integrated Auth (Tedious trusted connection) and SQL Server login |

---

## Testing

- **Vitest 4** — fast ESM-native test runner; replaces Jest without config overhead
- **`@testing-library/react`** — user-event simulation; no implementation detail coupling
- `renderWithContext()` helper — wraps components in `AppProvider` for reducer access
- `@tanstack/react-virtual` mocked to return all rows — removes viewport math from jsdom tests
- `socket.io-client` mocked to noop — no real socket in unit tests
- `ResizeObserver` stubbed — prevents jsdom layout errors in chart component tests
- `fetch` stubbed per test — deterministic network responses
- localStorage round-trip integration tests — verifies palette and widget layout persistence

**Coverage areas:** formatting utilities, widget registry, reducer actions + history cap + localStorage side effects, filter/search/sort in all major panels, grouping and expand behavior, sp_WhoIsActive fetch/refresh/expand/search/error, widget sidebar toggle/reorder/reset, localStorage persistence.

---

## Observability / Product Design

- Threshold engine with per-metric WARN/CRIT levels — surfaces issues without noise
- Drive space severity with drive-type-aware thresholds (system / data / log / tempdb have different limits)
- Trend forecasting: slope %/hr from last-30-readings ring buffer; ETA-to-full suppressed below noise floor
- Spike detection in DB size growth: flags when single-day delta > 3× average daily growth
- KPI sparklines from last-20-reading ring buffer — instant visual of trend direction without full chart overhead
- 30-second delta trend per KPI card — shows whether metric is improving or deteriorating, not just current value
- WARN/CRIT badges use both color and text — not color alone (accessibility)
- Compact number notation throughout: `82.9M`, `4.3k`, `1h 22m` — maximizes information density
