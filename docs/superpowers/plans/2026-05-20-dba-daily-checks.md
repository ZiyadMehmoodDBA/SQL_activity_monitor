# DBA Daily Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three DBA daily-check widgets — Backup Health, SQL Error Log, Failed Jobs badge — based on Brad McGehee's Sure DBA Checklist.

**Architecture:** Backup Health is polled every 2s alongside existing metrics (added to `collectMetrics` `Promise.all`). SQL Error Log is on-demand via a new Express endpoint, rendered by a self-contained component (mirrors WhoIsActive pattern). Failed Jobs badge is derived client-side from existing `m.jobs` data — no backend change needed.

**Tech Stack:** Node.js/Express, mssql (Tedious), React 18, Socket.io, Tailwind CDN, existing `wia-th`/`wia-td` CSS classes.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server.js` | Modify | Add `Q.backupHealth`, wire into `Promise.all`, add `/error-log` endpoint |
| `src/components/BackupHealth.jsx` | Create | Pure table component — renders backup status rows |
| `src/components/ErrorLog.jsx` | Create | Self-contained on-demand component with its own CollapsibleSection |
| `src/components/JobsPanel.jsx` | Modify | Accept + render `failedCount` badge in header |
| `src/components/Dashboard.jsx` | Modify | Import new components, add renderSection cases, derive `backupCritCount` + `failedJobsCount` |
| `src/lib/widgetRegistry.js` | Modify | Add `backup_health` + `error_log` entries |

---

## Task 1: Add Q.backupHealth to server.js

**Files:**
- Modify: `server.js` — append to Q object, add to Promise.all destructuring + array, add to return

- [ ] **Step 1: Append the query to the Q object**

In `server.js`, locate the closing `};` of the `Q` object (line ~456). Add before it:

```javascript
  backupHealth: `
    SELECT
      d.name                                                        AS database_name,
      d.recovery_model_desc,
      MAX(CASE WHEN bs.type = 'D' THEN bs.backup_finish_date END)  AS last_full,
      MAX(CASE WHEN bs.type = 'I' THEN bs.backup_finish_date END)  AS last_diff,
      MAX(CASE WHEN bs.type = 'L' THEN bs.backup_finish_date END)  AS last_log
    FROM sys.databases d
    LEFT JOIN msdb.dbo.backupset bs
      ON  bs.database_name = d.name
      AND bs.backup_finish_date > DATEADD(DAY, -60, GETDATE())
    WHERE d.database_id > 4
      AND d.state = 0
    GROUP BY d.name, d.recovery_model_desc
    ORDER BY d.name`,
```

- [ ] **Step 2: Add backupHealthR to the Promise.all destructuring**

Find this line in `collectMetrics`:
```javascript
const [cpuR, ovR, ioR, procR, waitR, curWaitR, fileR, recentR, activeR, dbSizesR, blockingR, deadlocksR, perfR, jobsR, diskR] = await Promise.all([
```

Replace with:
```javascript
const [cpuR, ovR, ioR, procR, waitR, curWaitR, fileR, recentR, activeR, dbSizesR, blockingR, deadlocksR, perfR, jobsR, diskR, backupHealthR] = await Promise.all([
```

- [ ] **Step 3: Add the query to the Promise.all array**

Find the last entry in the array:
```javascript
    req().query(Q.diskDrives).catch(err => { console.error('[diskDrives]', err.message); return { recordset: [] }; }),
  ]);
```

Replace with:
```javascript
    req().query(Q.diskDrives).catch(err => { console.error('[diskDrives]', err.message); return { recordset: [] }; }),
    req().query(Q.backupHealth).catch(err => { console.error('[backupHealth]', err.message); return { recordset: [] }; }),
  ]);
```

- [ ] **Step 4: Add backupHealth to the return object**

Find:
```javascript
    jobs:            jobsR.recordset,
    diskDrives:      diskDrives,
```

Replace with:
```javascript
    jobs:            jobsR.recordset,
    diskDrives:      diskDrives,
    backupHealth:    backupHealthR.recordset,
```

- [ ] **Step 5: Verify server starts without error**

```bash
npm start
```
Expected: server starts, no `[backupHealth]` error in console within first 5s. If error appears, check that `msdb` is accessible with the configured credentials.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(server): add backupHealth query to 2s poll"
```

---

## Task 2: Add /error-log endpoint to server.js

**Files:**
- Modify: `server.js` — add GET route before the SPA fallback

- [ ] **Step 1: Add the route**

Find the comment `// ─── SPA fallback` and insert before it:

```javascript
app.get('/api/connections/:id/error-log', async (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  try {
    const r = await conn.pool.request().query(`
      SELECT TOP 50
        DATEADD(ms, -1 * (osi.ms_ticks - rbf.timestamp), GETDATE())           AS event_time,
        rbf.record.value('(./Record/Exception/Error)[1]',    'int')            AS error_number,
        rbf.record.value('(./Record/Exception/Severity)[1]', 'int')            AS severity,
        rbf.record.value('(./Record/Exception/State)[1]',    'int')            AS state,
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
    `);
    res.json({ rows: r.recordset || [], ts: Date.now() });
  } catch (err) {
    console.error('[error-log]', err.message);
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Test the endpoint manually**

With the server running, open a browser or curl:
```
GET http://localhost:3000/api/connections/<any-valid-id>/error-log
```
Expected: `{ rows: [...], ts: <number> }` — rows may be empty if no severity ≥ 17 errors in last 24h.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): add /error-log endpoint using ring_buffer_exception"
```

---

## Task 3: Create BackupHealth.jsx

**Files:**
- Create: `src/components/BackupHealth.jsx`

- [ ] **Step 1: Create the file**

```jsx
import React from 'react'

export const FULL_WARN_MS = 7  * 86_400_000   // 7 days
export const FULL_CRIT_MS = 14 * 86_400_000   // 14 days
export const LOG_WARN_MS  = 2  * 3_600_000    // 2 hours
export const LOG_CRIT_MS  = 24 * 3_600_000    // 24 hours

export function ageMs(dateStr) {
  if (!dateStr) return Infinity
  return Date.now() - new Date(dateStr).getTime()
}

function BackupBadge({ dateStr, warnMs, critMs, na }) {
  if (na) return <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>N/A</span>
  const age   = ageMs(dateStr)
  const label = dateStr
    ? new Date(dateStr).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never'
  const isCrit = !dateStr || age > critMs
  const isWarn = !isCrit && age > warnMs
  const color  = isCrit ? '#ef4444' : isWarn ? '#f59e0b' : '#22c55e'
  const bg     = isCrit ? 'rgba(239,68,68,.12)' : isWarn ? 'rgba(245,158,11,.12)' : 'rgba(34,197,94,.10)'
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: bg, color, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function RecoveryBadge({ model }) {
  const styles = {
    FULL:        { bg: 'rgba(59,130,246,.12)',  color: '#3b82f6' },
    SIMPLE:      { bg: 'rgba(100,116,139,.12)', color: '#64748b' },
    BULK_LOGGED: { bg: 'rgba(245,158,11,.12)',  color: '#f59e0b' },
  }
  const s = styles[model] || styles.SIMPLE
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: s.bg, color: s.color }}>
      {model}
    </span>
  )
}

export default function BackupHealth({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        No user databases found
      </div>
    )
  }
  return (
    <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
      <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th className="wia-th">Database</th>
            <th className="wia-th">Recovery</th>
            <th className="wia-th">Last Full</th>
            <th className="wia-th">Last Diff</th>
            <th className="wia-th">Last Log</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isFullRec = r.recovery_model_desc !== 'SIMPLE'
            const fullCrit  = !r.last_full || ageMs(r.last_full) > FULL_CRIT_MS
            const logCrit   = isFullRec && (!r.last_log || ageMs(r.last_log) > LOG_CRIT_MS)
            const rowAlert  = fullCrit || logCrit
            return (
              <tr key={i} className="wia-row"
                style={rowAlert ? { borderLeft: '2px solid rgba(239,68,68,.4)' } : undefined}>
                <td className="wia-td" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {r.database_name}
                </td>
                <td className="wia-td">
                  <RecoveryBadge model={r.recovery_model_desc} />
                </td>
                <td className="wia-td">
                  <BackupBadge dateStr={r.last_full} warnMs={FULL_WARN_MS} critMs={FULL_CRIT_MS} />
                </td>
                <td className="wia-td">
                  {r.last_diff
                    ? <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {new Date(r.last_diff).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    : <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td className="wia-td">
                  <BackupBadge
                    dateStr={r.last_log}
                    warnMs={LOG_WARN_MS}
                    critMs={LOG_CRIT_MS}
                    na={!isFullRec}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/BackupHealth.jsx
git commit -m "feat(ui): add BackupHealth table component"
```

---

## Task 4: Create ErrorLog.jsx

**Files:**
- Create: `src/components/ErrorLog.jsx`

- [ ] **Step 1: Create the file**

```jsx
import React, { useState, useCallback } from 'react'
import { RefreshCw, ChevronDown, AlertTriangle } from 'lucide-react'

function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function SeverityBadge({ severity }) {
  const isFatal = severity >= 20
  const color   = isFatal ? '#ef4444' : '#f97316'
  const bg      = isFatal ? 'rgba(239,68,68,.12)' : 'rgba(249,115,22,.12)'
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: bg, color }}>
      {severity}
    </span>
  )
}

export default function ErrorLog({ connId }) {
  const [collapsed, setCollapsed] = useState(true)
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [lastTs,  setLastTs]  = useState(null)

  const doFetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/connections/${connId}/error-log`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setRows(d.rows || [])
      setLastTs(d.ts)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [connId])

  const tsStr = lastTs ? new Date(lastTs).toLocaleTimeString() : null

  return (
    <div className="mc overflow-hidden">
      {/* Header */}
      <div className="section-toggle flex items-center justify-between px-5 py-3 gap-3">
        <button className="flex items-center gap-2 text-left" onClick={() => setCollapsed(c => !c)}>
          <AlertTriangle size={13} style={{ color: 'var(--sort-active)', flexShrink: 0 }} />
          <span className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>SQL Error Log</span>
          {rows.length > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
              background: 'rgba(239,68,68,.15)', color: '#ef4444',
            }}>
              {rows.length}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          {tsStr && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{tsStr}</span>
          )}
          <button
            onClick={() => { if (collapsed) setCollapsed(false); doFetch() }}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium"
            style={{ background: 'var(--divider)', color: 'var(--text-secondary)' }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading…' : 'Analyse'}
          </button>
          <button
            onClick={() => setCollapsed(c => !c)}
            style={{ lineHeight: 0, color: 'var(--text-muted)' }}
          >
            <ChevronDown size={14} className={`chevron ${collapsed ? '' : 'open'}`} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className={`section-body ${collapsed ? 'collapsed' : ''}`}>
        <div className="section-body-inner">
          {error && (
            <div
              className="mx-5 mt-3 flex items-center gap-2 px-3 py-2 rounded-md text-xs border"
              style={{ background: '#fef2f2', color: '#dc2626', borderColor: '#fecaca' }}
            >
              <AlertTriangle size={12} />
              {error}
            </div>
          )}
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {!loading && !error && lastTs === null && (
              <div className="py-10 text-center text-xs italic" style={{ color: 'var(--text-muted)' }}>
                Click Analyse to scan for SQL Server errors (severity ≥ 17, last 24h)
              </div>
            )}
            {!loading && !error && lastTs !== null && rows.length === 0 && (
              <div className="py-10 text-center text-xs italic" style={{ color: 'var(--text-muted)' }}>
                No errors in ring buffer — may have been overwritten if server had many exceptions
              </div>
            )}
            {rows.length > 0 && (
              <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th className="wia-th" style={{ whiteSpace: 'nowrap' }}>Time</th>
                    <th className="wia-th">Error#</th>
                    <th className="wia-th">Severity</th>
                    <th className="wia-th">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="wia-row">
                      <td className="wia-td tabular-nums" style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 10 }}>
                        {fmtTime(r.event_time)}
                      </td>
                      <td className="wia-td tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                        {r.error_number}
                      </td>
                      <td className="wia-td">
                        <SeverityBadge severity={r.severity} />
                      </td>
                      <td className="wia-td" style={{ color: 'var(--text-primary)', maxWidth: 500 }}>
                        {r.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {loading && (
              <div className="py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                Scanning ring buffer…
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ErrorLog.jsx
git commit -m "feat(ui): add ErrorLog on-demand component"
```

---

## Task 5: Update widgetRegistry.js

**Files:**
- Modify: `src/lib/widgetRegistry.js`

- [ ] **Step 1: Add two new widget entries**

Find the last entry in `WIDGET_REGISTRY` (currently ends with `deadlocks`):
```javascript
  { id: 'deadlocks',           label: 'Deadlock History',         group: 'section', category: 'Blocking',    defaultEnabled: true },
```

Add after it:
```javascript
  { id: 'backup_health',       label: 'Backup Health',            group: 'section', category: 'Queries',     defaultEnabled: true },
  { id: 'error_log',           label: 'SQL Error Log',            group: 'section', category: 'Queries',     defaultEnabled: true },
```

- [ ] **Step 2: Verify the registry array still closes correctly**

The file should end with:
```javascript
  { id: 'error_log', label: 'SQL Error Log', group: 'section', category: 'Queries', defaultEnabled: true },
]
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/widgetRegistry.js
git commit -m "feat(registry): add backup_health and error_log widget entries"
```

---

## Task 6: Update Dashboard.jsx

**Files:**
- Modify: `src/components/Dashboard.jsx`

- [ ] **Step 1: Add imports**

Find the existing import block at the top. After:
```jsx
import WhoIsActive from './WhoIsActive'
```

Add:
```jsx
import BackupHealth, { ageMs, FULL_CRIT_MS, LOG_CRIT_MS } from './BackupHealth'
import ErrorLog from './ErrorLog'
```

- [ ] **Step 2: Add backupCritCount and failedJobsCount memos**

Find the line after `const sortedByKey = { ... }`. Add these two memos:

```jsx
  const backupCritCount = useMemo(
    () => (m?.backupHealth || []).filter(r => {
      const fullCrit = ageMs(r.last_full) > FULL_CRIT_MS
      const logCrit  = r.recovery_model_desc !== 'SIMPLE' && ageMs(r.last_log) > LOG_CRIT_MS
      return fullCrit || logCrit
    }).length,
    [m?.backupHealth]
  )

  const failedJobsCount = useMemo(
    () => (m?.jobs || []).filter(j =>
      j.status === 'Failed' &&
      j.last_run_date &&
      Date.now() - new Date(j.last_run_date).getTime() < 86_400_000
    ).length,
    [m?.jobs]
  )
```

- [ ] **Step 3: Add backup_health and error_log cases to renderSection**

In the `renderSection` function, find:
```jsx
      case 'who_is_active':
        return <WhoIsActive key={id} connId={connId} />
      default:
        return null
```

Replace with:
```jsx
      case 'who_is_active':
        return <WhoIsActive key={id} connId={connId} />
      case 'backup_health':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="backup_health" title="Backup Health"
            badge={<SectionBadge count={backupCritCount} alertWhen={backupCritCount > 0} />}>
            <BackupHealth rows={m?.backupHealth} />
          </CollapsibleSection>
        )
      case 'error_log':
        return <ErrorLog key={id} connId={connId} />
      default:
        return null
```

- [ ] **Step 4: Pass failedCount to JobsPanel**

Find:
```jsx
          {showJobs     && <JobsPanel     jobs={m?.jobs || []}           connId={connId} />}
```

Replace with:
```jsx
          {showJobs && <JobsPanel jobs={m?.jobs || []} connId={connId} failedCount={failedJobsCount} />}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Dashboard.jsx
git commit -m "feat(dashboard): wire BackupHealth, ErrorLog, failedJobsCount"
```

---

## Task 7: Update JobsPanel.jsx

**Files:**
- Modify: `src/components/JobsPanel.jsx`

- [ ] **Step 1: Add failedCount prop to outer JobsPanel and thread it to JobsPanelInner**

Find the outer export:
```jsx
export default function JobsPanel({ jobs, connId }) {
```

Replace with:
```jsx
export default function JobsPanel({ jobs, connId, failedCount = 0 }) {
```

Find both `<JobsPanelInner` calls (compact + expanded). Both currently look like:
```jsx
          <JobsPanelInner
            jobs={jobs}
            connId={connId}
            expanded={false}
            onExpand={() => setExpanded(true)}
            onClose={() => setExpanded(false)}
            scrollRef={compactRef}
          />
```

Add `failedCount={failedCount}` to each:
```jsx
          <JobsPanelInner
            jobs={jobs}
            connId={connId}
            expanded={false}
            onExpand={() => setExpanded(true)}
            onClose={() => setExpanded(false)}
            scrollRef={compactRef}
            failedCount={failedCount}
          />
```

(Do the same for the expanded portal instance.)

- [ ] **Step 2: Accept failedCount in JobsPanelInner and render badge**

Find:
```jsx
function JobsPanelInner({ jobs, connId, expanded, onExpand, onClose, scrollRef }) {
```

Replace with:
```jsx
function JobsPanelInner({ jobs, connId, expanded, onExpand, onClose, scrollRef, failedCount = 0 }) {
```

Find this line in the header section:
```jsx
        <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>SQL Agent Jobs</span>
```

Add the badge immediately after it:
```jsx
        <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>SQL Agent Jobs</span>
        {failedCount > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: 'rgba(239,68,68,.15)', color: '#ef4444',
          }}>
            {failedCount} failed 24h
          </span>
        )}
```

- [ ] **Step 3: Start the app and verify**

```bash
npm start
```

Open `http://localhost:3000`. Connect to a SQL Server instance and verify:

1. **Backup Health** — section appears, shows one row per user DB. Stale/missing full backups show red badge. SIMPLE-recovery DBs show N/A for Last Log.
2. **SQL Error Log** — section appears, click Analyse. If no severity ≥ 17 errors in last 24h, shows "No errors in ring buffer" message. Error row displays Time / Error# / Severity / Message.
3. **Failed Jobs** — if any SQL Agent job has status = Failed and `last_run_date` within 24h, the Jobs panel header shows a red "N failed 24h" badge.
4. Check Widget Settings (hamburger menu) — both Backup Health and SQL Error Log appear in the Queries category and can be toggled.

- [ ] **Step 4: Commit**

```bash
git add src/components/JobsPanel.jsx
git commit -m "feat(jobs): add 24h failed jobs badge to panel header"
```

---

## Self-Review Notes

- `ageMs` and the crit constants are exported from `BackupHealth.jsx` and imported in `Dashboard.jsx` — no duplication.
- `RING_BUFFER_EXCEPTION` may return empty if ring buffer was overwritten; UI explicitly says so.
- Both new widgets appear in `WIDGET_REGISTRY` so they show in the Widget Settings panel and respect enable/disable.
- `failedCount` defaults to `0` in both `JobsPanel` and `JobsPanelInner` — safe if prop not passed.
- No changes to AppContext reducer needed — `backupHealth` flows through the existing `metrics` Socket.io event path.
