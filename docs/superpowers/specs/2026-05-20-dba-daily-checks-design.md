# DBA Daily Checks — Design Spec
_2026-05-20_

## Context

Implements three missing items from Brad McGehee's Sure DBA Checklist (General DBA Best Practices → Day-to-Day). The app already covers disk space, performance charts, and blocking chains. This spec covers the three gaps.

---

## Feature 1: Backup Health Widget

### Goal
Show last full/diff/log backup per user database and flag stale or missing backups.

### Backend (server.js)

Add `Q.backupHealth` to the `Q` object:

```sql
SELECT
  d.name                                                          AS database_name,
  d.recovery_model_desc,
  MAX(CASE WHEN bs.type = 'D' THEN bs.backup_finish_date END)    AS last_full,
  MAX(CASE WHEN bs.type = 'I' THEN bs.backup_finish_date END)    AS last_diff,
  MAX(CASE WHEN bs.type = 'L' THEN bs.backup_finish_date END)    AS last_log
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset bs
  ON  bs.database_name = d.name
  AND bs.backup_finish_date > DATEADD(DAY, -60, GETDATE())
WHERE d.database_id > 4
  AND d.state = 0
GROUP BY d.name, d.recovery_model_desc
ORDER BY d.name
```

- Added to `Promise.all` in `collectMetrics` with `.catch(() => ({ recordset: [] }))` guard.
- Result exposed as `backupHealth: backupHealthR.recordset` in the returned metrics object.
- Clients receive it via existing Socket.io `metrics` event — no protocol changes.

### Frontend

**`src/components/BackupHealth.jsx`** — new component.

Structure: `CollapsibleSection` wrapping a scrollable table.

Columns:
| Column | Notes |
|--------|-------|
| DB Name | bold |
| Recovery Model | FULL / SIMPLE / BULK_LOGGED badge |
| Last Full | date + status badge |
| Last Diff | date only, informational |
| Last Log | date + status badge (FULL/BULK_LOGGED only; SIMPLE shows N/A) |

Status badge thresholds:
| Backup type | Green | Yellow (warn) | Red (critical) |
|-------------|-------|---------------|----------------|
| Full | ≤ 7 days | 7–14 days | > 14 days or never |
| Log (FULL/BULK_LOGGED) | ≤ 2 hours | 2–24 hours | > 24 hours or never |
| Diff | no threshold | — | — |

Section header badge = count of DBs with at least one red column.

**`src/lib/widgetRegistry.js`**
```js
{ id: 'backup_health', label: 'Backup Health', group: 'section', category: 'Queries', defaultEnabled: true }
```

**`src/components/Dashboard.jsx`**
- Import `BackupHealth`
- Add `case 'backup_health'` to `renderSection` switch (special case like `db_sizes`, not config-driven)

---

## Feature 2: SQL Server Error Log Widget

### Goal
On-demand view of recent SQL Server exceptions (severity ≥ 17, last 24 hours).

### Backend (server.js)

New route:
```
GET /api/connections/:id/error-log
```

Query (`sys.dm_os_ring_buffers` — no temp tables):
```sql
SELECT TOP 50
  DATEADD(ms, -1 * (osi.ms_ticks - rbf.timestamp), GETDATE())        AS event_time,
  rbf.record.value('(./Record/Exception/Error)[1]',    'int')         AS error_number,
  rbf.record.value('(./Record/Exception/Severity)[1]', 'int')         AS severity,
  rbf.record.value('(./Record/Exception/State)[1]',    'int')         AS state,
  rbf.record.value('(./Record/Exception/Message)[1]',  'nvarchar(4000)') AS message
FROM (
  SELECT timestamp, CAST(record AS XML) AS record
  FROM sys.dm_os_ring_buffers
  WHERE ring_buffer_type = N'RING_BUFFER_EXCEPTION'
) rbf
CROSS JOIN (SELECT ms_ticks FROM sys.dm_os_sys_info) osi
WHERE rbf.record.value('(./Record/Exception/Severity)[1]', 'int') >= 17
  AND DATEADD(ms, -1 * (osi.ms_ticks - rbf.timestamp), GETDATE())
      > DATEADD(HOUR, -24, GETDATE())
ORDER BY event_time DESC
```

Returns `{ rows, ts }`. Uses `requireConn` helper (already exists).

### Frontend

**`src/components/ErrorLog.jsx`** — mirrors WhoIsActive pattern.

- On mount: no auto-load (on-demand)
- "Analyse" button triggers `GET /api/connections/:id/error-log`
- Table columns: Time, Error#, Severity, Message
- Severity cell uses color: red for ≥ 20 (fatal), orange for 17–19
- Header badge shows count when rows present
- Loading/error states identical to WhoIsActive

**`src/lib/widgetRegistry.js`**
```js
{ id: 'error_log', label: 'SQL Error Log', group: 'section', category: 'Queries', defaultEnabled: true }
```

**`src/components/Dashboard.jsx`**
- Import `ErrorLog`
- Add `case 'error_log'` to `renderSection` switch

---

## Feature 3: Failed Jobs Badge

### Goal
Prominently surface job failures in the existing Jobs panel without rebuilding it.

### Backend
No changes. `Q.jobs` already returns `status: 'Failed'` with `last_run_date`.

### Frontend

**`src/components/Dashboard.jsx`**
- Derive `failedJobsCount` from `m?.jobs`:
  ```js
  const failedJobsCount = useMemo(
    () => (m?.jobs || []).filter(j =>
      j.status === 'Failed' &&
      j.last_run_date &&
      Date.now() - new Date(j.last_run_date).getTime() < 86_400_000
    ).length,
    [m?.jobs]
  )
  ```
- Pass `failedCount={failedJobsCount}` to `<JobsPanel>`.

**`src/components/JobsPanel.jsx`**
- Accept `failedCount` prop.
- If `failedCount > 0`, render a red badge next to the "SQL Agent Jobs" title.

---

## Files Changed

| File | Change |
|------|--------|
| `server.js` | Add `Q.backupHealth`, add to poll, add `/error-log` endpoint |
| `src/components/BackupHealth.jsx` | New |
| `src/components/ErrorLog.jsx` | New |
| `src/components/JobsPanel.jsx` | Accept + render `failedCount` badge |
| `src/components/Dashboard.jsx` | Import new components, add cases, derive failedJobsCount |
| `src/lib/widgetRegistry.js` | Add 2 new widget entries |

## Out of Scope
- "Restore backups to test server" — an action, not monitoring
- "Configure SQL Server alerts" — SQL Server Agent config, not in-app
- "Document changes" — not a monitoring concern
- "Learn something new" — not applicable
