# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Live web-based SQL Server Activity Monitor. Clones SSMS Activity Monitor with animated scrolling charts and real-time data tables. Targets `HCMPSDB01\HCMPS`.

## Running

```bash
# First time
cp .env.example .env
# Edit .env with AUTH_TYPE and credentials
npm install
npm start
# Opens at http://localhost:3000
```

## Architecture

- **server.js** — Node.js + Express + Socket.io. Polls SQL Server every 2s via `mssql` (Tedious driver), broadcasts all metrics to connected clients via Socket.io `metrics` event.
- **public/index.html** — Single-file vanilla JS frontend. Chart.js for animated live charts, Tailwind CDN for styling. No build step.

## Data flow

```
SQL Server (DMVs) → server.js poll loop (2s) → Socket.io emit → index.html receives → Chart.js + table render
```

## Key SQL queries (server.js)

All queries run in parallel via `Promise.all` on each poll cycle:

| Metric | Source |
|--------|--------|
| CPU % | `sys.dm_os_ring_buffers` (XML parsing, ProcessUtilization field) |
| Waiting tasks | `sys.dm_exec_requests` (suspended/waiting count) |
| DB I/O MB/s | `sys.dm_io_virtual_file_stats` delta between polls |
| Batch requests/sec | `sys.dm_os_performance_counters` |
| Processes table | `sys.dm_exec_sessions` + `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |
| Resource waits | `sys.dm_os_wait_stats` (benign waits filtered out) |
| Data File I/O | `sys.dm_io_virtual_file_stats` + `sys.master_files` |
| Recent expensive | `sys.dm_exec_query_stats` (last 1 hour) |
| Active expensive | `sys.dm_exec_requests` + `sys.dm_exec_sql_text` |

## Auth

Configured via `.env`:
- `AUTH_TYPE=windows` — Windows integrated auth (trusted connection via Tedious)
- `AUTH_TYPE=sql` — SQL auth, reads `DB_USER` / `DB_PASS`

Required SQL Server permission: `VIEW SERVER STATE`

## AI-generated SQL review policy

Per `devInstruction.md`: all AI-generated SQL must be manually reviewed before `npm start`. This includes queries in `server.js` poll loop, kill endpoints, and any new DMV joins. Do not execute AI-generated SQL against a production instance without review.

Kill endpoints (`/kill`, `/kill-sleeping`) are disabled by default. Requires `ALLOW_KILL=true` in `.env`.
