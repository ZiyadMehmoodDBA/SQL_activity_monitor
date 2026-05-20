import React, { useEffect, useState, useCallback, useMemo, memo, useRef } from 'react'
import { useApp } from '../context/AppContext'
import { PALETTES } from '../lib/palettes'
import { TABLE_COLS } from '../lib/tableCols'
import { WIDGET_REGISTRY } from '../lib/widgetRegistry'
import KPIBar from './KPIBar'
import ChartCard from './ChartCard'
import JobsPanel from './JobsPanel'
import SessionsPanel from './SessionsPanel'
import MemoryHealth from './MemoryHealth'
import CollapsibleSection from './CollapsibleSection'
import VirtualTable from './VirtualTable'
import DbSizes from './DbSizes'
import DbSizeTrend from './DbSizeTrend'
import DriveMonitor from './DriveMonitor'
import WhoIsActive from './WhoIsActive'
import BackupHealth, { ageMs, FULL_CRIT_MS, LOG_CRIT_MS } from './BackupHealth'
import ErrorLog from './ErrorLog'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogClose } from './ui/Dialog'

const SECTION_IDS = WIDGET_REGISTRY.filter(w => w.group === 'section').map(w => w.id)

// ── Category metadata for current waits severity panel ───────────────────────
const WAIT_CATEGORY_META = {
  locking:      { label: 'Locking',      color: '#ef4444', bg: 'rgba(239,68,68,.15)',    tip: 'Sessions blocked by row/page/object locks. Check blocking chains.' },
  io:           { label: 'Disk I/O',     color: '#f97316', bg: 'rgba(249,115,22,.15)',   tip: 'Waiting on physical I/O. Check disk throughput and file placement.' },
  log_io:       { label: 'Log I/O',      color: '#f59e0b', bg: 'rgba(245,158,11,.15)',   tip: 'Transaction log writes are a bottleneck. Check log disk or VLF count.' },
  memory:       { label: 'Memory',       color: '#dc2626', bg: 'rgba(220,38,38,.15)',    tip: 'Memory grants pending or memory allocation contention. Check PLE and max server memory.' },
  latch:        { label: 'Latch',        color: '#a855f7', bg: 'rgba(168,85,247,.15)',   tip: 'Buffer pool page latch contention. Could be tempdb or hot pages.' },
  parallelism:  { label: 'Parallelism',  color: '#3b82f6', bg: 'rgba(59,130,246,.12)',   tip: 'Parallel query coordination. Usually benign; review MAXDOP if excessive.' },
  network:      { label: 'Network',      color: '#06b6d4', bg: 'rgba(6,182,212,.12)',    tip: 'Client not consuming results fast enough (ASYNC_NETWORK_IO). App-side issue.' },
  cpu_pressure: { label: 'CPU/Threads',  color: '#dc2626', bg: 'rgba(220,38,38,.15)',    tip: 'THREADPOOL wait — worker threads exhausted. Immediate attention required.' },
  other:        { label: 'Other',        color: '#64748b', bg: 'rgba(100,116,139,.12)',  tip: 'Miscellaneous waits. Check wait_type for details.' },
}

function CurrentWaitsPanel({ rows }) {
  if (!rows || rows.length === 0) return null
  return (
    <div style={{ padding: '10px 14px 4px', borderBottom: '1px solid var(--divider)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
        Live Wait Breakdown
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {rows.map(r => {
          const meta = WAIT_CATEGORY_META[r.category] || WAIT_CATEGORY_META.other
          return (
            <div key={r.wait_type} title={`${r.wait_type}\n${meta.tip}\nMax wait: ${r.max_wait_ms?.toLocaleString()} ms`}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px',
                borderRadius: 6, background: meta.bg, border: `1px solid ${meta.color}33`,
                cursor: 'default', fontSize: 11 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 600, color: meta.color }}>{r.session_count}</span>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{r.wait_type}</span>
              {r.sample_blocker_id > 0 && (
                <span style={{ fontSize: 9, fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,.18)', borderRadius: 3, padding: '1px 4px' }}>
                  SPID {r.sample_blocker_id}
                </span>
              )}
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                {r.avg_wait_ms >= 1000 ? `${(r.avg_wait_ms/1000).toFixed(1)}s avg` : `${Math.round(r.avg_wait_ms)}ms avg`}
              </span>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
        {Object.entries(
          rows.reduce((acc, r) => {
            const cat = r.category || 'other'
            acc[cat] = (acc[cat] || 0) + r.session_count
            return acc
          }, {})
        ).sort((a,b) => b[1]-a[1]).map(([cat, count]) => {
          const meta = WAIT_CATEGORY_META[cat] || WAIT_CATEGORY_META.other
          return (
            <span key={cat} style={{ fontSize: 10, color: meta.color, fontWeight: 600 }}>
              {meta.label}: {count}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ── Module-level components (stable identity, no remount on Dashboard re-render) ──

function useTimeSince(ts) {
  const [display, setDisplay] = useState('Waiting…')
  useEffect(() => {
    if (!ts) { setDisplay('Waiting…'); return }
    const update = () => {
      const ago = Math.floor((Date.now() - ts) / 1000)
      if (ago <= 2) setDisplay('Live')
      else setDisplay(`${ago}s ago`)
    }
    update()
    const iv = setInterval(update, 1000)
    return () => clearInterval(iv)
  }, [ts])
  return display
}

// Stable component — NOT defined inside Dashboard, so no remount on parent re-render
const SectionBadge = memo(function SectionBadge({ count, alertWhen }) {
  const isAlert = alertWhen && count > 0
  return (
    <span
      className="text-xs px-2 py-0.5 rounded font-semibold tabular-nums"
      style={{
        background: isAlert ? 'rgba(220,38,38,.1)' : 'var(--badge-bg)',
        color: isAlert ? 'var(--c-crit)' : 'var(--badge-text)',
      }}
    >
      {count}
    </span>
  )
})

// ── Generic sort (pure, module-level — never recreated) ───────────────────────
function sortRows(rows, { col, dir }) {
  if (!rows || rows.length === 0) return []
  const mult = dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const av = a[col], bv = b[col]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return typeof av === 'string' ? mult * av.localeCompare(bv) : mult * (av - bv)
  })
}

// Stable rowStyle constants (no lambda recreated per render)
const BLOCKING_ROW_STYLE  = (_, i) => i === 0 ? { background: '#fef2f2' } : undefined
const DEADLOCK_ROW_STYLE  = () => ({ background: '#fff7ed' })

const VTABLE_SECTION_CFG = {
  file_io:          { sectionId: 'fileio',    title: 'Data File I/O',            sortKey: 'fileio',    height: 280, metricKey: 'dataFileIO' },
  recent_expensive: { sectionId: 'recent',    title: 'Recent Expensive Queries', sortKey: 'recent',    height: 280, metricKey: 'recentExpensive' },
  active_expensive: { sectionId: 'active',    title: 'Active Expensive Queries', sortKey: 'active',    height: 280, metricKey: 'activeExpensive' },
  blocking:         { sectionId: 'blocking',  title: 'Blocking Chains',          sortKey: 'blocking',  height: 240, metricKey: 'blocking',  rowStyle: BLOCKING_ROW_STYLE, alertWhen: true },
  deadlocks:        { sectionId: 'deadlocks', title: 'Deadlock History',         sortKey: 'deadlocks', height: 240, metricKey: 'deadlocks', rowStyle: DEADLOCK_ROW_STYLE, alertWhen: true },
}

// ── Chart config builder (pure, no side effects) ──────────────────────────────
function buildCharts(m, sp, conn, p) {
  return [
    { id: 'chart_cpu',          title: '% Processor Time',    subtitle: 'SQL CPU utilization',          value: m ? m.cpu_percent + '%' : '--',                        color: p.chartCpu,   yMax: 100,  history: conn.history.cpu },
    { id: 'chart_wait',         title: 'Waiting Tasks',        subtitle: 'Suspended / waiting requests', value: m ? m.waiting_tasks : '--',                            color: p.chartWait,  yMax: null, history: conn.history.wait },
    { id: 'chart_io',           title: 'Database I/O',         subtitle: 'MB/s read + write',            value: m ? m.db_io_mb + ' MB/s' : '--',                       color: p.chartIo,    yMax: null, history: conn.history.io },
    { id: 'chart_batch',        title: 'Batch Requests/sec',   subtitle: 'Batches received per second',  value: m ? m.batch_requests?.toLocaleString() : '--',         color: p.chartBatch, yMax: null, history: conn.history.batch },
    { id: 'chart_net',          title: 'Network I/O',          subtitle: 'MB/s SQL connections',         value: m ? (sp.netMbs || 0) + ' MB/s' : '--',                 color: p.chartIo,    yMax: null, history: conn.history.netMb },
    { id: 'chart_compilations', title: 'Compilations/sec',     subtitle: 'SQL compilations per second',  value: m ? (sp.compilationsSec || 0).toLocaleString() : '--', color: p.chartCpu,   yMax: null, history: conn.history.compilations },
  ]
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default memo(function Dashboard({ connId }) {
  const { state, dispatch } = useApp()
  const conn = state.connections[connId]
  const lastUpdated = useTimeSince(conn?.lastUpdate)
  const [bulkKill,   setBulkKill]   = useState(null)   // null | { count, confirmed }
  const [singleKill, setSingleKill] = useState(null)   // null | { sessionId, login, host, confirmed, killing, error }
  const [killResult, setKillResult] = useState(null)
  const killResultTimer = useRef(null)
  const showKillResult = useCallback(result => {
    clearTimeout(killResultTimer.current)
    setKillResult(result)
    killResultTimer.current = setTimeout(() => setKillResult(null), 5000)
  }, [])
  useEffect(() => () => clearTimeout(killResultTimer.current), [])

  if (!conn) return null

  const m  = conn.metrics
  const sp = m?.serverPerf || {}
  const p  = PALETTES[state.palette] || PALETTES['Enterprise']

  // ── Stable widget layout map (only recomputes when widgetLayout changes) ──
  const layoutMap = useMemo(
    () => Object.fromEntries((state.widgetLayout || []).map(w => [w.id, w.enabled])),
    [state.widgetLayout]
  )
  const on = useCallback((id) => layoutMap[id] !== false, [layoutMap])

  const orderedSections = useMemo(
    () => (state.widgetLayout || [])
      .filter(w => SECTION_IDS.includes(w.id) && w.enabled)
      .map(w => w.id),
    [state.widgetLayout]
  )

  // allCharts intentionally excludes layoutMap — chart instances must NEVER be
  // destroyed/recreated on toggle (that creates new ApexCharts + ResizeObservers
  // that accumulate across repeated toggle cycles).  Visibility is handled by a
  // display:none wrapper div — the instance stays mounted, just hidden.
  const allCharts = useMemo(
    () => buildCharts(m, sp, conn, p),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m, sp, conn.history, p]
  )

  const showJobs     = on('jobs_panel')
  const showSessions = on('sessions_panel')

  // ── Sort helpers ─────────────────────────────────────────────────────────
  const handleSort = useCallback((tableId, col) => {
    const current = conn.sortState[tableId]
    const dir = current.col === col ? (current.dir === 'desc' ? 'asc' : 'desc') : 'desc'
    dispatch({ type: 'SET_TABLE_SORT', connId, tableId, col, dir })
  }, [conn.sortState, connId, dispatch])

  // Memoized sorted datasets — each recomputes only when its source data or sort state changes,
  // NOT on every 2s metrics update that doesn't affect that table.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedProc      = useMemo(() => sortRows(m?.processes,       conn.sortState.proc),      [m?.processes,       conn.sortState.proc])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedWaits     = useMemo(() => sortRows(m?.resourceWaits,   conn.sortState.waits),     [m?.resourceWaits,   conn.sortState.waits])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedFileio    = useMemo(() => sortRows(m?.dataFileIO,      conn.sortState.fileio),    [m?.dataFileIO,      conn.sortState.fileio])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedRecent    = useMemo(() => sortRows(m?.recentExpensive, conn.sortState.recent),    [m?.recentExpensive, conn.sortState.recent])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedActive    = useMemo(() => sortRows(m?.activeExpensive, conn.sortState.active),    [m?.activeExpensive, conn.sortState.active])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedBlocking  = useMemo(() => sortRows(m?.blocking,        conn.sortState.blocking),  [m?.blocking,        conn.sortState.blocking])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedDeadlocks = useMemo(() => sortRows(m?.deadlocks,       conn.sortState.deadlocks), [m?.deadlocks,       conn.sortState.deadlocks])

  const sortedByKey = { fileio: sortedFileio, recent: sortedRecent, active: sortedActive, blocking: sortedBlocking, deadlocks: sortedDeadlocks }

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

  // ── Kill sleeping ─────────────────────────────────────────────────────────
  const killAllSleeping = useCallback(() => {
    const sleeping = (m?.processes || []).filter(r => String(r.status).toLowerCase() === 'sleeping')
    if (sleeping.length === 0) { showKillResult({ error: 'No sleeping sessions to kill.' }); return }
    setKillResult(null)
    setBulkKill({ count: sleeping.length, confirmed: false })
  }, [m?.processes])

  const confirmKillSleeping = useCallback(async () => {
    setBulkKill(null)
    try {
      const res  = await fetch(`/api/connections/${connId}/kill-sleeping`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      showKillResult({ killed: data.killed })
    } catch (err) {
      showKillResult({ error: err.message })
    }
  }, [connId, showKillResult])

  const confirmSingleKill = useCallback(async () => {
    if (!singleKill) return
    setSingleKill(s => s ? { ...s, killing: true, error: null } : null)
    try {
      const res  = await fetch(`/api/connections/${connId}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: singleKill.sessionId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setSingleKill(null)
      showKillResult({ killed: 1 })
    } catch (err) {
      setSingleKill(s => s ? { ...s, killing: false, error: err.message } : null)
    }
  }, [connId, singleKill, showKillResult])

  // ── Section renderer ──────────────────────────────────────────────────────
  function renderSection(id) {
    const cfg = VTABLE_SECTION_CFG[id]
    if (cfg) {
      return (
        <CollapsibleSection key={id} connId={connId} sectionId={cfg.sectionId} title={cfg.title}
          badge={<SectionBadge count={m?.[cfg.metricKey]?.length || 0} alertWhen={cfg.alertWhen} />}>
          <VirtualTable rows={sortedByKey[cfg.sortKey]} columns={TABLE_COLS[cfg.sortKey]}
            height={cfg.height}
            sortCol={conn.sortState[cfg.sortKey].col} sortDir={conn.sortState[cfg.sortKey].dir}
            onSort={col => handleSort(cfg.sortKey, col)}
            rowStyle={cfg.rowStyle} />
        </CollapsibleSection>
      )
    }
    switch (id) {
      case 'db_sizes':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="dbsizes" title="Database Sizes &amp; Disk Usage">
            <div style={{ padding: 20, maxHeight: 500, overflowY: 'auto' }}><DbSizes data={m?.dbSizes} /></div>
          </CollapsibleSection>
        )
      case 'db_size_trend':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="dbsizetrend" title="Database Size Trends (10-Day)">
            <div style={{ padding: 20, maxHeight: 720, overflowY: 'auto' }}><DbSizeTrend connId={connId} /></div>
          </CollapsibleSection>
        )
      case 'processes':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="proc" title="Processes"
            badge={<SectionBadge count={m?.processes?.length || 0} />}
            extra={
              <button type="button" onClick={e => { e.stopPropagation(); killAllSleeping() }}
                className="text-xs font-semibold px-2.5 py-1 rounded-md bg-red-50 text-red-600 border border-red-200 hover:bg-red-600 hover:text-white transition-colors">
                Kill All Sleeping
              </button>
            }
          >
            <VirtualTable rows={sortedProc} columns={TABLE_COLS.proc} height={320}
              sortCol={conn.sortState.proc.col} sortDir={conn.sortState.proc.dir}
              onSort={col => handleSort('proc', col)} extraCol
              renderExtraCell={row => (
                String(row.status || '').toLowerCase() === 'sleeping'
                  ? <button className="kill-btn" onClick={() =>
                      setSingleKill({ sessionId: row.session_id, login: row.login_name, host: row.host_name, confirmed: false, killing: false, error: null })
                    }>Kill</button>
                  : null
              )}
            />
          </CollapsibleSection>
        )
      case 'resource_waits':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="waits" title="Resource Waits"
            badge={<SectionBadge count={m?.currentWaits?.length ? m.currentWaits.reduce((s,r)=>s+r.session_count,0) : (m?.resourceWaits?.length || 0)} alertWhen={m?.currentWaits?.length > 0} />}>
            <CurrentWaitsPanel rows={m?.currentWaits} />
            <VirtualTable rows={sortedWaits} columns={TABLE_COLS.waits} height={240}
              sortCol={conn.sortState.waits.col} sortDir={conn.sortState.waits.dir} onSort={col => handleSort('waits', col)} />
          </CollapsibleSection>
        )
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
    }
  }

  return (
    <div>
      {/* Kill sleeping — confirm dialog */}
      <Dialog open={!!bulkKill} onOpenChange={open => !open && setBulkKill(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kill Sleeping Sessions</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
              Kill <strong style={{ color: 'var(--text-primary)' }}>{bulkKill?.count}</strong> sleeping session{bulkKill?.count !== 1 ? 's' : ''} on{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{conn.label}</strong>?
            </p>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>This cannot be undone.</p>
            <label className="flex items-start gap-2 mb-6 cursor-pointer">
              <input type="checkbox" checked={!!bulkKill?.confirmed}
                onChange={e => setBulkKill(b => b ? { ...b, confirmed: e.target.checked } : null)}
                style={{ marginTop: 2, accentColor: '#dc2626', flexShrink: 0 }} />
              <span className="text-xs" style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                I understand this terminates sessions on a <strong>production</strong> server and cannot be undone.
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <button className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--divider)', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}>
                  Cancel
                </button>
              </DialogClose>
              <button onClick={confirmKillSleeping} disabled={!bulkKill?.confirmed}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-opacity"
                style={{ background: bulkKill?.confirmed ? '#dc2626' : '#9ca3af', cursor: bulkKill?.confirmed ? 'pointer' : 'not-allowed' }}>
                Kill Sessions
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Single session kill — confirm dialog */}
      <Dialog open={!!singleKill} onOpenChange={open => !open && setSingleKill(null)}>
        <DialogContent style={{ maxWidth: 400 }}>
          <DialogHeader>
            <DialogTitle>Kill session {singleKill?.sessionId}?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Terminate SPID <strong>{singleKill?.sessionId}</strong>
              {singleKill?.login ? ` (${singleKill.login}` : ''}
              {singleKill?.host  ? ` @ ${singleKill.host})` : (singleKill?.login ? ')' : '')}.
              Any open transaction will be rolled back.
            </p>
            {singleKill?.error && (
              <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(239,68,68,.12)',
                border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '8px 12px', marginBottom: 14 }}>
                {singleKill.error}
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 18, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!singleKill?.confirmed}
                onChange={e => setSingleKill(s => s ? { ...s, confirmed: e.target.checked } : null)}
                style={{ marginTop: 2, accentColor: '#dc2626', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                I understand this terminates a session on a <strong>production</strong> server and cannot be undone.
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <button disabled={singleKill?.killing}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--divider)', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}>
                  Cancel
                </button>
              </DialogClose>
              <button onClick={confirmSingleKill} disabled={singleKill?.killing || !singleKill?.confirmed}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-opacity"
                style={{ background: (singleKill?.killing || !singleKill?.confirmed) ? '#9ca3af' : '#dc2626',
                  cursor: (singleKill?.killing || !singleKill?.confirmed) ? 'not-allowed' : 'pointer' }}>
                {singleKill?.killing ? 'Killing…' : 'Kill Session'}
              </button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Kill sleeping — result toast */}
      {killResult && (
        <div
          className="fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl text-sm font-semibold shadow-2xl flex items-center gap-3"
          style={{
            background: 'var(--card-bg)',
            border: `1px solid ${killResult.error ? 'rgba(220,38,38,.4)' : 'rgba(34,197,94,.3)'}`,
            boxShadow: 'var(--card-shadow), 0 8px 24px rgba(0,0,0,.3)',
          }}
        >
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: killResult.error ? '#dc2626' : '#22c55e' }} />
          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {killResult.error ? `Error: ${killResult.error}` : `Killed ${killResult.killed} session(s)`}
          </span>
          <button onClick={() => setKillResult(null)} className="ml-2 opacity-50 hover:opacity-100 transition-opacity text-lg leading-none" style={{ color: 'var(--text-muted)' }}>
            &times;
          </button>
        </div>
      )}

      {/* Connection header */}
      <div className="flex items-center gap-3 px-0.5 mb-6 pb-4" style={{ borderBottom: '1px solid rgba(0,0,0,.07)' }}>
        <span className="w-2.5 h-2.5 rounded-full dot-live flex-shrink-0" />
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--body-text)' }}>{conn.label}</span>
        <span className="text-xs text-slate-400 font-mono">{conn.server}</span>
        <span className="ml-auto text-xs font-semibold tabular-nums transition-colors" style={{ fontSize: 11, color: lastUpdated === 'Live' ? '#22c55e' : 'var(--text-muted)' }}>
          {lastUpdated}
        </span>
      </div>

      {/* KPI bar */}
      {on('kpi_bar') && <KPIBar conn={conn} />}

      {/* Charts — chart instances are kept mounted to avoid ApexCharts
           destroy/create cycles on toggle; display:none hides without unmounting.
           overflow:hidden on both the grid and each cell prevents ApexCharts
           ResizeObserver from accumulating height across refresh ticks. */}
      <div
        className="gap-6 mb-6"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', alignItems: 'start', overflow: 'hidden' }}
      >
        {allCharts.map(c => (
          <div key={c.id} style={on(c.id) ? { overflow: 'hidden' } : { display: 'none' }}>
            <ChartCard
              title={c.title}
              subtitle={c.subtitle}
              value={c.value}
              history={c.history}
              color={c.color}
              yMax={c.yMax}
            />
          </div>
        ))}
      </div>

      {/* Row 3: Jobs + Sessions */}
      {(showJobs || showSessions) && (
        <div className={`gap-6 mb-6 ${showJobs && showSessions ? 'grid grid-cols-12' : 'grid grid-cols-1'}`}>
          {showJobs     && <JobsPanel     jobs={m?.jobs || []}           connId={connId} failedCount={failedJobsCount} />}
          {showSessions && <SessionsPanel processes={m?.processes || []} connId={connId} />}
        </div>
      )}

      {/* Memory Health */}
      {on('memory_health') && <MemoryHealth conn={conn} />}

      {/* Drive Space Monitor */}
      {on('drive_monitor') && <DriveMonitor conn={conn} />}

      {/* Collapsible sections — ordered and filtered by widgetLayout */}
      {orderedSections.length > 0 && (
        <div className="space-y-6">
          {orderedSections.map(id => renderSection(id))}
        </div>
      )}
    </div>
  )
})
