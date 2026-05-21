# Index Health — Design Spec

**Date:** 2026-05-21  
**Phase:** Phase 1 of Indexing & Query Optimization  
**Status:** Approved

---

## 1. Architecture

### Overview

Index Health is an async on-demand scan module. It does NOT run on the 2s polling loop. DBAs trigger scans manually; results are cached server-side with a 2-hour TTL.

### Why Async

SQL Server index DMVs (`sys.dm_db_index_physical_stats`) can take 30–120s per database in DETAILED mode. Synchronous HTTP would timeout, exhaust the connection pool, and produce poor UX on large estates.

### Scan Lifecycle

```
POST /scan        → { scanId }
GET  /progress    → { status, pct, currentDb, completedDbs, totalDbs, eta }
GET  /results     → paginated results
DELETE /scan/:id  → cancel
```

State machine: `pending → running → completed / completed_with_warnings / failed / cancelled`

### Approved Modifications (Section 1)

1. **IScanStore abstraction** — `MemoryScanStore` (MVP), `RedisScanStore` (future). Interface: `create / update / get / cancel / list / cleanup`.
2. **Scan metadata returned** with results: `{ scanMode, serverVersion, scanDurationMs, scanStartedAt, serverRestartTime }`.
3. **Weighted progress** by DB file size (`sys.master_files` SUM of size), not DB count. Prevents 10-second small DBs each counting as much as a 500GB warehouse.
4. **maxConcurrentDB = 3** — scan up to 3 databases in parallel. Configurable via `INDEX_SCAN_CONCURRENCY` env var (default 3, max 5).
5. **timeoutPerDB = 120s** — per-database hard timeout. On timeout: mark DB as `timed_out`, continue scan, surface warning in results header.
6. **TTL = 2h** — results expire 2 hours after scan completion. GET /results after TTL returns 404 → frontend shows "Scan expired" with Re-run button.
7. **Soft delete on cancel** — cancelled scan keeps partial results (completedDbs worth of data). Frontend shows partial results with "Scan cancelled — X of Y databases completed" banner.
8. **`/api/connections/:id/index-health/*`** — all endpoints scoped under connection ID. Connection must exist in the active connection Map.
9. **No auto-scan on connect** — Index Health never runs automatically. Only on explicit DBA trigger.
10. **Concurrent scan guard** — if a scan is already running for the connection, POST /scan returns 409 with `{ scanId: existingId }`.

---

## 2. SQL Collection Layer

### Scan Modes

| Mode | `sys.dm_db_index_physical_stats` mode | Typical duration |
|------|---------------------------------------|-----------------|
| LIMITED | `LIMITED` | < 5 min |
| SAMPLED | `SAMPLED` | 5–15 min |
| DETAILED | `DETAILED` | 15–30 min |

### Per-Database Query Pattern

```sql
DECLARE @db_id INT = DB_ID(N'<db>');
DECLARE @sql NVARCHAR(MAX);
SET @sql = N'USE ' + QUOTENAME(@db) + N'; SELECT ...';
EXEC sp_executesql @sql;
```

All dynamic SQL uses `QUOTENAME()` on database and object names.

### Fragmentation Data

Source: `sys.dm_db_index_physical_stats` + `sys.indexes` + `sys.objects` + `sys.schemas` + `sys.partitions`

Captured per result:
- `database_name`, `schema_name`, `table_name`, `index_name`
- `index_type_desc` — filter: CLUSTERED, NONCLUSTERED, COLUMNSTORE only (exclude HEAP, XML, SPATIAL, HASH)
- `avg_fragmentation_in_percent`
- `page_count`
- `partition_number`, `partition_count`
- `data_compression_desc`

**Recommendation logic (SKIP_SMALL threshold: page_count < 1000):**
- `page_count < 1000` → `SKIP_SMALL`
- `avg_fragmentation >= 30% AND page_count >= 1000` → `REBUILD`
- `avg_fragmentation 5–30% AND page_count >= 1000` → `REORGANIZE`
- `avg_fragmentation < 5%` → `OK`

### Missing Index Data

Source: `sys.dm_db_missing_index_details` + `sys.dm_db_missing_index_group_stats` + `sys.dm_db_missing_index_groups`

Impact score (normalized 0–100):
```
raw = avg_total_user_cost * (avg_user_impact / 100.0) * (user_seeks + user_scans)
normalized = LEAST(raw / max_raw_in_resultset * 100, 100)
```

Include columns capped at 16. `TRUNCATED_INCLUDE_LIST = true` if original count exceeded 16.

Script generation: `WITH (ONLINE = ON)` only if edition supports online index operations. Max 16 include columns enforced. `QUOTENAME()` on all identifiers.

### Unused Index Data

Source: `sys.dm_db_index_usage_stats` + `sys.indexes` + `sys.objects`

Scoped to current `sqlserver_start_time` from `sys.dm_os_sys_info` — surfaced as `serverRestartTime` in scan metadata and shown in UI as usage window.

Unused = `user_seeks + user_scans + user_lookups = 0` (since server restart), `user_updates > 0`.

### Duplicate Index Detection

Two indexes are duplicate if all match: key columns (same order + ASC/DESC), included columns (same set), `filter_definition`, `has_filter`. Excludes primary keys and unique constraints from duplicate candidates.

### Version Detection

```sql
SELECT SERVERPROPERTY('ProductMajorVersion') AS major_version
```

NOT `@@VERSION`. Used to gate `ONLINE = ON` availability and `STRING_AGG` vs `FOR XML PATH` fallback (SQL Server 2017+ = major version 14).

### Health Score

Score: 0–100. Severity: Healthy > 90 / Warning 70–89 / Critical < 70.

Weights:
- Fragmentation (REBUILD count / total indexes): 40%
- Missing (normalized impact of top missing): 30%
- Duplicate (duplicate count / total indexes): 15%
- Disabled (disabled count / total indexes): 15%

Formula: `score = 100 - (frag_penalty*0.4 + missing_penalty*0.3 + dup_penalty*0.15 + disabled_penalty*0.15)`

---

## 3. Frontend Design and Progressive Rendering

### Component Tree

```
Dashboard.jsx
└── renderSection('index_health')
    └── <IndexHealth connId={id} />        # owns all scan state
        ├── <ScanControls />               # mode dropdown + DB selector + Run/Cancel
        ├── <ScanProgress />               # progress bar, polling (with backoff)
        ├── <HealthScoreCard />            # big score + severity + scan metadata
        ├── <SummaryStrip />               # 6 KPI mini-cards
        ├── <IndexInventory />             # 3-tab filterable/sortable table
        └── <IndexDetailModal />           # full-screen overlay, SQL script panel
```

### Scan Controls

Single horizontal bar: mode dropdown + optional DB multiselect + Run/Cancel button.

- Mode options: `LIMITED / SAMPLED / DETAILED` — each shows subtitle (duration estimate) as tooltip
- DB multiselect defaults to "All"; can cherry-pick individual databases
- Run Scan → becomes Cancel (with spinner) once scan starts
- Disabled (not hidden) while scan running

### Polling with Exponential Backoff

```javascript
// Backoff schedule based on progress pct
function pollInterval(pct) {
  if (pct >= 80) return 10_000   // 10s — nearly done, low value in polling fast
  if (pct >= 40) return 5_000    // 5s
  return 2_000                   // 2s — early phase, user wants feedback
}
```

Frontend calls `GET /progress` on each tick; next tick scheduled after response using the above function. No fixed interval timer.

### scanId Session Storage

On scan start (POST response): `sessionStorage.setItem('index-health-scan-{connId}', scanId)`

On mount: check sessionStorage for existing scanId → if found, GET /progress immediately → if still running, resume polling; if completed, GET /results directly; if 404/cancelled/failed, clear storage and show idle state.

On scan complete or cancel: `sessionStorage.removeItem('index-health-scan-{connId}')`

### Progress Display

```
┌───────────────────────────────────────────────────────────────────┐
│  Scanning: medcare_db_dev  (3 / 11 databases)      [✕ Cancel]    │
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  27%                    │
│  Est. ~4m remaining                                               │
└───────────────────────────────────────────────────────────────────┘
```

- Progress bar: `transition: width 400ms ease`
- ETA hidden until > 5% progress
- Cancel: DELETE request, button disabled while awaiting 204

### Health Score Card

Full-width card (~96px tall). Large numeral score with circular arc progress ring (color = severity). Severity chip: `Critical / Warning / Healthy`. Meta strip below: `LIMITED · 11 databases · 2m 41s · SQL Server 2019 · Scan: 14 May 10:32`.

### Summary Strip

6 KPI mini-cards, horizontal scroll on mobile. Cards: `rounded-2xl`, number `text-2xl font-bold`, label `text-xs text-muted`.

| Card | Subtext |
|------|---------|
| Total Indexes | across N DBs |
| Fragmented | need rebuild/reorg |
| Missing | by estimated impact |
| Unused | since server restart |
| Duplicate | wasted storage |
| Disabled | blocking queries |

Fragmented / Missing / Disabled show red count badge if nonzero.

### Index Inventory Table

Three tabs: **Fragmented** · **Missing** · **Unused / Duplicate**

Tab strip: underline-indicator style (no pills). Each tab badge shows count.

**Fragmented tab columns:**  
`Database | Table | Index Name | Type | Pages | Frag% | Rec. | Partitions | Actions`

- `Frag%`: colored bar chip (green < 5%, amber 5–30%, red ≥ 30%)
- `Rec.`: `REBUILD / REORGANIZE / OK` badge
- Sort: default frag% desc
- Filter: DB dropdown + free-text (table or index name)
- Server-side pagination: 50 rows/page

**Missing tab columns:**  
`Database | Table | Equality Cols | Inequality Cols | Include Cols | Impact Score | Seeks | Actions`

- Impact Score: 0–100, color-coded
- `TRUNCATED_INCLUDE_LIST` shown as amber warning badge

**Unused / Duplicate tab columns:**  
`Database | Table | Index Name | Type | Reads | Writes | Usage Window | Actions`

- Reads = 0 shown in red for unused
- Duplicate rows show "Duplicate of: [other index name]" inline
- Usage Window: "X days (since server restart)" — tooltip with exact restart timestamp

### Index Detail Modal

Full-screen overlay (`fixed inset-0 z-50`), `rounded-2xl` inner panel, `backdrop-blur-sm` bg.

Two-panel layout: left panel (key/include columns, statistics, last updated); right panel (SQL script with syntax highlight).

Script panel shows:
```sql
ALTER INDEX [IX_Claims_PatientDate]
ON [dbo].[Claims]
REBUILD
WITH (ONLINE = ON,
      MAXDOP = 4,
      FILLFACTOR = 80);
-- Estimated duration: ~4 min
-- Requires SQL Server 2016+ Enterprise/Dev
```

- `ONLINE = ON` only if edition supports (from scan metadata)
- Partition-specific: `REBUILD PARTITION = N` if `partition_count > 1`
- Actions: Copy Script, Close, Export Row CSV

### Widget Registration

```javascript
// widgetRegistry.js
{ id: 'index_health', label: 'Index Health', group: 'section', category: 'Indexing', defaultEnabled: true }
```

```jsx
// Dashboard.jsx renderSection
case 'index_health':
  return <IndexHealth key={id} connId={id} />
```

`IndexHealth` is self-contained — owns scan state, no dependency on the 2s metrics polling. Mounts fresh on `connId` change, clears sessionStorage on unmount only if scan is idle.

---

## 4. Error Handling

- **Per-DB timeout** (120s): mark DB `timed_out`, continue scan, surface in results as warning banner
- **Scan TTL expired** (2h): GET /results returns 404 → frontend shows "Scan expired — results cleared" + Re-run button
- **Concurrent scan** (409): frontend reads `scanId` from response, resumes polling that scan
- **Connection lost mid-scan**: scan continues server-side (not tied to WebSocket). On reconnect, sessionStorage `scanId` recovers state.
- **Partial cancel**: cancelled scans keep completed-DB results. Banner: "Scan cancelled — X of Y databases completed"

---

## 5. File Map

| Path | Action |
|------|--------|
| `server.js` | Add IScanStore, MemoryScanStore, index health endpoints |
| `src/components/IndexHealth.jsx` | New — top-level, scan state machine |
| `src/components/IndexHealthControls.jsx` | New — mode dropdown, DB selector, Run/Cancel |
| `src/components/IndexHealthProgress.jsx` | New — progress bar, polling, backoff |
| `src/components/IndexHealthSummary.jsx` | New — health score card + 6 KPI strip |
| `src/components/IndexInventory.jsx` | New — 3-tab table, filters, pagination |
| `src/components/IndexDetailModal.jsx` | New — full-screen overlay, script panel |
| `src/lib/widgetRegistry.js` | Add `index_health` entry |
| `src/components/Dashboard.jsx` | Add `case 'index_health'` to `renderSection` |
