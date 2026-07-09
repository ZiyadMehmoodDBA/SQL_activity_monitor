import React, { useEffect, useState, useCallback, useMemo, memo, useRef } from 'react'
import MissingIndexes from './MissingIndexes'
import QueryTextModal from './QueryTextModal'
import { useApp } from '../context/AppContext'
import { useConnections } from '../context/ConnectionContext'
import { metricStatusColor, C_CRIT, C_WARN } from '../lib/thresholds'
import { escapeHtml, fmtNum, fmtBytes } from '../lib/fmt'
import { PALETTES } from '../lib/palettes'
import { TABLE_COLS } from '../lib/tableCols'
import { WIDGET_REGISTRY } from '../lib/widgetRegistry'
import KPIBar from './KPIBar'
import ChartCard from './ChartCard'
import HistoryRangePicker from './HistoryRangePicker'
import { buildHistorySeries, aggregateWaits } from '../lib/historySeries'
import JobsPanel from './JobsPanel'
import QueryOptimizationSection from './QueryOptimizationSection'
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
import IndexHealth from './IndexHealth'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogClose } from './ui/Dialog'

// ─── PDF Health Report ────────────────────────────────────────────────────────
function printReport(conn) {
  const m = conn?.metrics
  if (!m) { alert('No data yet — wait for the first metrics update.'); return }

  const now  = new Date()
  const ts   = now.toLocaleString()
  const sp   = m.serverPerf || {}
  const fmt  = (v, d = 0) => v == null ? '—' : Number(v).toFixed(d)
  const fN   = v => fmtNum(v)

  const badge = lvl => {
    const map = { ok: ['badge-ok','OK'], warn: ['badge-warn','WARN'], crit: ['badge-crit','CRIT'] }
    const [cls, txt] = map[lvl] || ['badge-none','—']
    return `<span class="badge ${cls}">${txt}</span>`
  }
  const kpiLvl = (key, val) => {
    const c = metricStatusColor(key, val)
    return c === C_CRIT ? 'crit' : c === C_WARN ? 'warn' : val != null ? 'ok' : null
  }

  const kpiHtml = [
    { label: 'CPU Usage',      val: fmt(m.cpu_percent)+'%',      lvl: kpiLvl('cpu',      m.cpu_percent) },
    { label: 'Waiting Tasks',  val: fN(m.waiting_tasks),         lvl: kpiLvl('wait',     m.waiting_tasks) },
    { label: 'DB I/O',         val: fmt(m.db_io_mb, 1)+' MB/s',  lvl: null },
    { label: 'Batch Req/s',    val: fN(m.batch_requests),        lvl: null },
    { label: 'SQL Memory',     val: fmt(sp.sqlMemPct, 1)+'%',    lvl: kpiLvl('sqlmem',   sp.sqlMemPct) },
    { label: 'Page Life Exp.', val: fN(sp.pleSec)+'s',           lvl: kpiLvl('ple',      sp.pleSec) },
  ].map(k => {
    const col = k.lvl === 'crit' ? '#dc2626' : k.lvl === 'warn' ? '#ea580c' : '#1e293b'
    return `<div class="kpi-card"><div class="kpi-label">${escapeHtml(k.label)}</div><div class="kpi-val" style="color:${col}">${escapeHtml(k.val)}</div></div>`
  }).join('')

  const memHtml = `<table><thead><tr><th>Metric</th><th>Value</th><th>Status</th></tr></thead><tbody>
    <tr><td>SQL Memory Used / Target</td><td>${fmt(sp.sqlMemPct,1)}% &nbsp;(${fmt(sp.sqlTotalMemGb,1)} GB / ${fmt(sp.sqlTargetMemGb,1)} GB)</td><td>${badge(kpiLvl('sqlmem',sp.sqlMemPct))}</td></tr>
    <tr><td>Page Life Expectancy</td><td>${fN(sp.pleSec)} s</td><td>${badge(kpiLvl('ple',sp.pleSec))}</td></tr>
    <tr><td>Buffer Cache Hit Ratio</td><td>${fmt(sp.bufferCacheHit,1)}%</td><td>${badge(kpiLvl('bufcache',sp.bufferCacheHit))}</td></tr>
    <tr><td>Memory Grants Pending</td><td>${fmt(sp.memGrantsPending)}</td><td>${badge(kpiLvl('grants',sp.memGrantsPending))}</td></tr>
    <tr><td>User Connections</td><td>${fN(sp.userConns)}</td><td></td></tr>
    <tr><td>Compilations/sec</td><td>${fN(sp.compilationsSec)}</td><td></td></tr>
    <tr><td>Re-Compilations/sec</td><td>${fN(sp.recompilationsSec)}</td><td></td></tr>
  </tbody></table>`

  const waits = (m.resourceWaits || []).slice(0, 10)
  const waitsHtml = waits.length
    ? `<table><thead><tr><th>Wait Type</th><th>Tasks</th><th>Total Wait (ms)</th><th>Max Wait (ms)</th><th>Signal Wait (ms)</th></tr></thead><tbody>${
        waits.map(w => `<tr><td><code>${escapeHtml(w.wait_type)}</code></td><td>${fN(w.waiting_tasks_count)}</td><td>${fN(w.wait_time_ms)}</td><td>${fN(w.max_wait_time_ms)}</td><td>${fN(w.signal_wait_time_ms)}</td></tr>`).join('')
      }</tbody></table>`
    : '<p class="empty">No wait data.</p>'

  const bkpLvl = last => { if (!last) return 'crit'; const d = (Date.now()-new Date(last))/(864e5); return d>7?'crit':d>1?'warn':'ok' }
  const backups = m.backupHealth || []
  const backupsHtml = backups.length
    ? `<table><thead><tr><th>Database</th><th>Recovery Model</th><th>Last Full</th><th>Last Diff</th><th>Last Log</th><th>Status</th></tr></thead><tbody>${
        backups.map(b => `<tr><td>${escapeHtml(b.database_name)}</td><td>${escapeHtml(b.recovery_model_desc)}</td>
          <td>${b.last_full ? new Date(b.last_full).toLocaleString() : '<span style="color:#dc2626">Never</span>'}</td>
          <td>${b.last_diff ? new Date(b.last_diff).toLocaleString() : '—'}</td>
          <td>${b.last_log  ? new Date(b.last_log).toLocaleString()  : '—'}</td>
          <td>${badge(bkpLvl(b.last_full))}</td></tr>`).join('')
      }</tbody></table>`
    : '<p class="empty">No backup data.</p>'

  const sizes = (m.dbSizes || []).slice(0, 15)
  const sizesHtml = sizes.length
    ? `<h2>Database Sizes</h2><table><thead><tr><th>Database</th><th>Allocated</th><th>Volume Total</th><th>Volume Free</th><th>Drive Used %</th></tr></thead><tbody>${
        sizes.map(d => {
          const usedP = d.volume_total_bytes ? ((1 - d.volume_available_bytes/d.volume_total_bytes)*100).toFixed(1)+'%' : '—'
          return `<tr><td>${escapeHtml(d.database_name)}</td><td>${fmtBytes(d.allocated_bytes)}</td><td>${fmtBytes(d.volume_total_bytes)}</td><td>${fmtBytes(d.volume_available_bytes)}</td><td>${usedP}</td></tr>`
        }).join('')
      }</tbody></table>`
    : ''

  const queries = (m.recentExpensive || []).slice(0, 10)
  const queriesHtml = queries.length
    ? `<table><thead><tr><th>Executions</th><th>Avg Elapsed (ms)</th><th>Avg CPU (ms)</th><th>Avg Reads</th><th>Last Executed</th><th style="min-width:200px">Query</th></tr></thead><tbody>${
        queries.map(q => {
          const qt = (q.query_text || '').trim().slice(0, 160)
          return `<tr><td>${fN(q.execution_count)}</td><td>${fmt(q.avg_elapsed_ms)}</td><td>${fmt(q.avg_cpu_ms)}</td><td>${fmt(q.avg_logical_reads)}</td>
            <td style="white-space:nowrap">${escapeHtml(q.last_executed||'—')}</td>
            <td style="font-family:monospace;font-size:9px;word-break:break-all">${escapeHtml(qt)}${qt.length < (q.query_text||'').trim().length ? '…' : ''}</td></tr>`
        }).join('')
      }</tbody></table>`
    : '<p class="empty">No query data.</p>'

  const sessions = (m.processes||[]).filter(p => p.status !== 'sleeping').slice(0, 25)
  const sessionsHtml = sessions.length
    ? `<table><thead><tr><th>SPID</th><th>Login</th><th>Host</th><th>Database</th><th>Status</th><th>Wait Type</th><th>Elapsed (s)</th><th>CPU (ms)</th></tr></thead><tbody>${
        sessions.map(s => `<tr><td>${escapeHtml(s.session_id)}</td><td>${escapeHtml(s.login_name)}</td><td>${escapeHtml(s.host_name)}</td><td>${escapeHtml(s.database_name)}</td><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.wait_type||'—')}</td><td>${escapeHtml(s.elapsed_sec)}</td><td>${fN(s.cpu_time)}</td></tr>`).join('')
      }</tbody></table>`
    : '<p class="empty">No active sessions.</p>'

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SQL Health Report — ${escapeHtml(conn.label||conn.server)} — ${now.toISOString().slice(0,10)}</title>
<style>
*{box-sizing:border-box}body{font-family:'Segoe UI',system-ui,sans-serif;font-size:12px;color:#1e293b;background:#fff;margin:0;padding:24px 28px;line-height:1.5}
h1{font-size:20px;font-weight:800;margin:0 0 2px;letter-spacing:-.02em}h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin:22px 0 8px;border-bottom:1.5px solid #e2e8f0;padding-bottom:5px}
.meta{font-size:11px;color:#94a3b8;margin-bottom:20px}.kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:4px}
.kpi-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px}.kpi-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#94a3b8;margin-bottom:4px}
.kpi-val{font-size:22px;font-weight:700;line-height:1.2}table{width:100%;border-collapse:collapse;margin-bottom:8px}
th{background:#f8fafc;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;padding:5px 8px;text-align:left;border-bottom:1.5px solid #e2e8f0;white-space:nowrap}
td{padding:4px 8px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#334155;vertical-align:top}tr:nth-child(even) td{background:#fafbfc}
.badge{display:inline-block;padding:1px 7px;border-radius:99px;font-size:9px;font-weight:700;letter-spacing:.04em}
.badge-ok{background:#dcfce7;color:#166534}.badge-warn{background:#fef9c3;color:#854d0e}.badge-crit{background:#fee2e2;color:#991b1b}.badge-none{background:#f1f5f9;color:#64748b}
code{font-family:'Cascadia Code',Consolas,monospace;font-size:10px;background:#f1f5f9;padding:1px 4px;border-radius:3px}
.empty{color:#94a3b8;font-style:italic;font-size:11px;margin:4px 0 12px}
.footer{margin-top:32px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8}
@media print{@page{size:A4;margin:12mm 14mm}body{padding:0}table,.kpi-grid{break-inside:avoid}}
</style></head><body>
<h1>SQL Server Health Report</h1>
<div class="meta">${escapeHtml(conn.label||conn.server)} &nbsp;·&nbsp; ${escapeHtml(conn.server)} &nbsp;·&nbsp; Generated ${ts}</div>
<h2>Executive Summary</h2><div class="kpi-grid">${kpiHtml}</div>
<h2>Memory Health</h2>${memHtml}
<h2>Top Resource Waits — Cumulative (Top 10)</h2>${waitsHtml}
<h2>Backup Health</h2>${backupsHtml}
${sizesHtml}
<h2>Recent Expensive Queries — Last Hour (Top 10)</h2>${queriesHtml}
<h2>Active Sessions — Non-sleeping (Top 25)</h2>${sessionsHtml}
<div class="footer">SQL Activity Monitor &nbsp;·&nbsp; Snapshot generated ${ts} &nbsp;·&nbsp; Data reflects last 2-second poll cycle.</div>
</body></html>`

  const blob = new Blob([html], { type: 'text/html' })
  const url  = URL.createObjectURL(blob)
  const w    = window.open(url, '_blank', 'width=960,height=720')
  if (!w) { URL.revokeObjectURL(url); alert('Pop-up blocked — allow pop-ups for this page and try again.'); return }
  w.addEventListener('load', () => {
    setTimeout(() => { w.print(); URL.revokeObjectURL(url) }, 350)
  })
}

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
  recent_expensive: { sectionId: 'recent',    title: 'Recent Expensive Queries', sortKey: 'recent',    height: 280, metricKey: 'recentExpensive', supportsTopN: true, supportsDbFilter: true, supportsClipboard: true },
  active_expensive: { sectionId: 'active',    title: 'Active Expensive Queries', sortKey: 'active',    height: 280, metricKey: 'activeExpensive' },
  blocking:         { sectionId: 'blocking',  title: 'Blocking Chains',          sortKey: 'blocking',  height: 240, metricKey: 'blocking',  rowStyle: BLOCKING_ROW_STYLE, alertWhen: true, supportsDbFilter: true },
  deadlocks:        { sectionId: 'deadlocks', title: 'Deadlock History',         sortKey: 'deadlocks', height: 240, metricKey: 'deadlocks', rowStyle: DEADLOCK_ROW_STYLE, alertWhen: true },
  cpu_intensive:    { sectionId: 'cpu',       title: 'CPU Intensive Queries',    sortKey: 'cpu',       height: 280, metricKey: 'cpuExpensive',  supportsTopN: true, supportsDbFilter: true, supportsQueryView: true },
  tempdb_usage:     { sectionId: 'tempdb',    title: 'TempDB Usage',             sortKey: 'tempdb',    height: 280, metricKey: 'tempdbUsage',   supportsTopN: true },
}

// ── Chart config builder (pure, no side effects) ──────────────────────────────
function buildCharts(m, sp, conn, p) {
  return [
    { id: 'chart_cpu',          histKey: 'cpu',          title: '% Processor Time',    subtitle: 'SQL CPU utilization',          value: m ? m.cpu_percent + '%' : '--',                        color: p.chartCpu,   yMax: 100,  history: conn.history.cpu },
    { id: 'chart_wait',         histKey: 'wait',         title: 'Waiting Tasks',        subtitle: 'Suspended / waiting requests', value: m ? m.waiting_tasks : '--',                            color: p.chartWait,  yMax: null, history: conn.history.wait },
    { id: 'chart_io',           histKey: 'io',           title: 'Database I/O',         subtitle: 'MB/s read + write',            value: m ? m.db_io_mb + ' MB/s' : '--',                       color: p.chartIo,    yMax: null, history: conn.history.io },
    { id: 'chart_batch',        histKey: 'batch',        title: 'Batch Requests/sec',   subtitle: 'Batches received per second',  value: m ? m.batch_requests?.toLocaleString() : '--',         color: p.chartBatch, yMax: null, history: conn.history.batch },
    { id: 'chart_net',          histKey: 'netMb',        title: 'Network I/O',          subtitle: 'MB/s SQL connections',         value: m ? (sp.netMbs || 0) + ' MB/s' : '--',                 color: p.chartIo,    yMax: null, history: conn.history.netMb },
    { id: 'chart_compilations', histKey: 'compilations', title: 'Compilations/sec',     subtitle: 'SQL compilations per second',  value: m ? (sp.compilationsSec || 0).toLocaleString() : '--', color: p.chartCpu,   yMax: null, history: conn.history.compilations },
  ]
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default memo(function Dashboard({ connId }) {
  const { state } = useApp()
  const { connections, dispatch } = useConnections()
  const conn = connections[connId]
  const lastUpdated = useTimeSince(conn?.lastUpdate)
  const [bulkKill,   setBulkKill]   = useState(null)   // null | { count, confirmed }
  const [singleKill, setSingleKill] = useState(null)   // null | { sessionId, login, host, confirmed, killing, error }
  const [queryView,  setQueryView]  = useState(null)   // null | row object
  const [topN,       setTopN]       = useState(10)
  const [dbFilter,   setDbFilter]   = useState('')
  const [killResult, setKillResult] = useState(null)
  const [histRange, setHistRange]     = useState(null)  // null = Live
  const [histData, setHistData]       = useState(null)  // { resolution, timestamps, series, blocking, waits }
  const [histLoading, setHistLoading] = useState(false)
  const [histError, setHistError]     = useState(null)
  const [blockDetail, setBlockDetail] = useState(null) // null | blocking_events row
  useEffect(() => {
    setTopN(10)
    setDbFilter('')
    setQueryView(null)
    setHistRange(null); setHistData(null); setHistError(null)
  }, [connId])
  const killResultTimer = useRef(null)
  const showKillResult = useCallback(result => {
    clearTimeout(killResultTimer.current)
    setKillResult(result)
    killResultTimer.current = setTimeout(() => setKillResult(null), 5000)
  }, [])
  useEffect(() => () => clearTimeout(killResultTimer.current), [])

  useEffect(() => {
    if (!histRange) { setHistData(null); setHistError(null); return }
    let cancelled = false
    setHistLoading(true)
    setHistError(null)
    const qs = `from=${histRange.from}&to=${histRange.to}`
    Promise.all([
      fetch(`/api/connections/${connId}/history?${qs}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`History fetch failed (HTTP ${r.status})`))),
      fetch(`/api/connections/${connId}/history/blocking?${qs}`)
        .then(r => r.ok ? r.json() : { rows: [] }),
      fetch(`/api/connections/${connId}/history/waits?${qs}`)
        .then(r => r.ok ? r.json() : { rows: [] }),
    ]).then(([hist, blocking, waits]) => {
      if (cancelled) return
      const { timestamps, series } = buildHistorySeries(hist.rows, hist.resolution)
      setHistData({ resolution: hist.resolution, timestamps, series, blocking: blocking.rows || [], waits: waits.rows || [] })
    }).catch(err => {
      if (!cancelled) setHistError(err.message)
    }).finally(() => {
      if (!cancelled) setHistLoading(false)
    })
    return () => { cancelled = true }
  }, [histRange, connId])

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
  const showQueryOpt = on('query_optimization')
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

  const waitsWithPct = useMemo(() => {
    const rows = m?.resourceWaits || []
    const total = rows.reduce((s, r) => s + (r.wait_time_ms || 0), 0)
    return rows.map(r => ({
      ...r,
      wait_pct: total > 0 ? +((r.wait_time_ms / total) * 100).toFixed(1) : 0,
    }))
  }, [m?.resourceWaits])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedWaits     = useMemo(() => sortRows(waitsWithPct,        conn.sortState.waits),     [waitsWithPct,        conn.sortState.waits])
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedCpu       = useMemo(() => sortRows(m?.cpuExpensive,    conn.sortState.cpu),       [m?.cpuExpensive,    conn.sortState.cpu])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedTempdb    = useMemo(() => sortRows(m?.tempdbUsage,     conn.sortState.tempdb),    [m?.tempdbUsage,     conn.sortState.tempdb])

  const dbNames = useMemo(() => {
    const sets = [
      ...(m?.recentExpensive || []),
      ...(m?.cpuExpensive    || []),
      ...(m?.blocking        || []),
    ]
    const names = [...new Set(sets.map(r => r.database_name).filter(Boolean))].sort()
    return names
  }, [m?.recentExpensive, m?.cpuExpensive, m?.blocking])

  function applyMvpFilter(rows, topN, dbFilter) {
    let r = rows
    if (dbFilter) r = r.filter(row => row.database_name === dbFilter)
    return r.slice(0, topN)
  }

  const filteredRecent   = applyMvpFilter(sortedRecent,   topN, dbFilter)
  const filteredCpu      = applyMvpFilter(sortedCpu,      topN, dbFilter)
  const filteredBlocking = applyMvpFilter(sortedBlocking, topN, dbFilter)

  const sortedByKey = { fileio: sortedFileio, recent: filteredRecent, active: sortedActive, blocking: filteredBlocking, deadlocks: sortedDeadlocks, cpu: filteredCpu, tempdb: sortedTempdb }

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
          {id === 'cpu_intensive' && (
            <div className="flex items-center gap-3 px-4 py-2 text-xs text-gray-500">
              <label className="flex items-center gap-1">
                Top:
                <select value={topN} onChange={e => setTopN(Number(e.target.value))} className="ml-1 border rounded px-1 py-0.5 text-xs">
                  {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                Database:
                <select value={dbFilter} onChange={e => setDbFilter(e.target.value)} className="ml-1 border rounded px-1 py-0.5 text-xs">
                  <option value="">All</option>
                  {dbNames.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            </div>
          )}
          <VirtualTable rows={sortedByKey[cfg.sortKey]} columns={TABLE_COLS[cfg.sortKey]}
            height={cfg.height}
            sortCol={conn.sortState[cfg.sortKey].col} sortDir={conn.sortState[cfg.sortKey].dir}
            onSort={col => handleSort(cfg.sortKey, col)}
            rowStyle={cfg.rowStyle}
            {...(cfg.supportsClipboard ? {
              extraCol: true,
              renderExtraCell: row => (
                <button className="copy-btn" onClick={() => navigator.clipboard.writeText(row.query_text || '').catch(() => {})}>Copy</button>
              ),
            } : {})}
            {...(cfg.supportsQueryView ? {
              extraCol: true,
              renderExtraCell: row => (
                <button className="copy-btn" onClick={() => setQueryView(row)}>View</button>
              ),
            } : {})}
          />
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
      case 'resource_waits': {
        const histWaits = histRange && histData ? aggregateWaits(histData.waits) : null
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="waits"
            title={histRange ? 'Resource Waits — history range' : 'Resource Waits'}
            badge={<SectionBadge count={histWaits ? histWaits.length : (m?.currentWaits?.length ? m.currentWaits.reduce((s,r)=>s+r.session_count,0) : (m?.resourceWaits?.length || 0))} alertWhen={!histRange && m?.currentWaits?.length > 0} />}>
            {!histRange && <CurrentWaitsPanel rows={m?.currentWaits} />}
            <VirtualTable rows={histWaits ?? sortedWaits} columns={TABLE_COLS.waits} height={240}
              sortCol={conn.sortState.waits.col} sortDir={conn.sortState.waits.dir} onSort={col => handleSort('waits', col)} />
          </CollapsibleSection>
        )
      }
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
      case 'index_health':
        return <IndexHealth key={id} connId={connId} />
      case 'missing_indexes':
        return <MissingIndexes key={id} connId={connId} topN={topN} dbFilter={dbFilter} />
      default:
        return null
    }
  }

  return (
    <div>
      <QueryTextModal row={queryView} onClose={() => setQueryView(null)} />

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

      {/* Blocking event detail dialog */}
      <Dialog open={!!blockDetail} onOpenChange={open => !open && setBlockDetail(null)}>
        <DialogContent style={{ maxWidth: 560 }}>
          <DialogHeader>
            <DialogTitle>Blocking event — {blockDetail ? new Date(blockDetail.ts).toLocaleString() : ''}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {blockDetail && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <p><strong>Blocker</strong> SPID {blockDetail.blocking_sid} — {blockDetail.blocker_login || '—'} @ {blockDetail.blocker_host || '—'} ({blockDetail.blocker_program || '—'})</p>
                <p><strong>Blocked</strong> SPID {blockDetail.blocked_sid} — {blockDetail.blocked_login || '—'} @ {blockDetail.blocked_host || '—'}</p>
                <p><strong>Wait</strong> {blockDetail.wait_type || '—'} · {blockDetail.wait_ms != null ? `${blockDetail.wait_ms.toLocaleString()} ms` : '—'} · {blockDetail.database_name || '—'} {blockDetail.parent_object ? `· ${blockDetail.parent_object}` : ''}</p>
                <p style={{ marginTop: 10, fontWeight: 700 }}>Blocker query</p>
                <pre className="font-mono" style={{ fontSize: 11, background: 'var(--input-bg)', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{blockDetail.blocker_query || '—'}</pre>
                <p style={{ marginTop: 10, fontWeight: 700 }}>Blocked query</p>
                <pre className="font-mono" style={{ fontSize: 11, background: 'var(--input-bg)', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{blockDetail.blocked_query || '—'}</pre>
              </div>
            )}
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
        <button
          onClick={() => printReport(conn)}
          title="Download PDF Health Report"
          style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--divider)', background: 'var(--input-bg)', color: 'var(--text-primary)', cursor: 'pointer', flexShrink: 0, marginLeft: 8 }}
          onMouseOver={e => e.currentTarget.style.borderColor = 'var(--sort-active)'}
          onMouseOut={e  => e.currentTarget.style.borderColor = 'var(--divider)'}
        >↓ Report</button>
      </div>

      {/* KPI bar */}
      {on('kpi_bar') && <KPIBar conn={conn} />}

      <HistoryRangePicker value={histRange} onChange={setHistRange} />
      {histRange && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2 rounded-lg"
          style={{ background: 'rgba(59,130,246,.08)', border: '1px solid rgba(59,130,246,.25)', fontSize: 12 }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            Viewing history{histData?.resolution ? ` — ${histData.resolution} resolution` : ''}
            {histLoading ? ' (loading…)' : ''}
          </span>
          {histError && <span style={{ color: '#dc2626' }}>{histError}</span>}
          {!histLoading && !histError && histData && histData.timestamps.length === 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              No history for this range — the store may be disabled or the range predates available data.
            </span>
          )}
          <button onClick={() => setHistRange(null)} className="ml-auto"
            style={{ fontSize: 11, fontWeight: 600, color: 'var(--sort-active)', cursor: 'pointer', background: 'none', border: 'none' }}>
            Back to Live
          </button>
        </div>
      )}

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
              subtitle={histRange ? `History — ${histRange.key}` : c.subtitle}
              value={c.value}
              history={histRange ? (histData?.series?.[c.histKey] ?? []) : c.history}
              timestamps={histRange ? (histData?.timestamps ?? []) : undefined}
              color={c.color}
              yMax={c.yMax}
              events={histRange && c.histKey === 'cpu' ? (histData?.blocking ?? []) : undefined}
            />
          </div>
        ))}
      </div>

      {histRange && histData && histData.blocking.length > 0 && (
        <div className="mc mb-6" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.065em', marginBottom: 8 }}>
            Blocking events in range ({histData.blocking.length}) — marked ⛔ on the CPU chart
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {histData.blocking.map(b => (
              <button key={b.id} onClick={() => setBlockDetail(b)}
                className="flex items-center gap-3 w-full text-left px-2 py-1.5 rounded hover:bg-black/5"
                style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>
                <span className="tabular-nums" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                  {new Date(b.ts).toLocaleString()}
                </span>
                <span style={{ fontWeight: 600, color: '#ef4444' }}>SPID {b.blocking_sid} → {b.blocked_sid}</span>
                <span className="font-mono" style={{ fontSize: 11 }}>{b.wait_type || '—'}</span>
                <span style={{ color: 'var(--text-muted)' }}>{b.database_name || ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Query Optimization widgets */}
      {showQueryOpt && (
        <QueryOptimizationSection
          blocking={m?.blocking || []}
          cpuRows={m?.cpuExpensive || []}
          ioRows={m?.ioExpensive || []}
        />
      )}

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
