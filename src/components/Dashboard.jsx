import React, { useEffect, useState, useRef } from 'react'
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
import WhoIsActive from './WhoIsActive'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogClose } from './ui/Dialog'

const SECTION_IDS = WIDGET_REGISTRY.filter(w => w.group === 'section').map(w => w.id)

// ── Responsive grid column calculator ────────────────────────────────────────
// Returns number of chart columns based on count of enabled charts + viewport width.
// Updates on window resize — no deps beyond `count`.
function useChartCols(count) {
  const [cols, setCols] = useState(() => calcCols(count))
  useEffect(() => {
    const update = () => setCols(calcCols(count))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [count])
  return cols
}

function calcCols(count) {
  if (count === 0) return 0
  const w = window.innerWidth
  const screenMax = w < 640 ? 1 : w < 1024 ? 2 : w < 1536 ? 3 : 4
  return Math.min(count, screenMax)
}

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

export default function Dashboard({ connId }) {
  const { state, dispatch } = useApp()
  const conn = state.connections[connId]
  const lastUpdated = useTimeSince(conn?.lastUpdate)
  const [killDialog, setKillDialog] = useState(null)
  const [killResult, setKillResult] = useState(null)

  if (!conn) return null

  const m  = conn.metrics
  const sp = m?.serverPerf || {}
  const p  = PALETTES[state.palette] || PALETTES['Enterprise']

  // ── Widget enabled check ─────────────────────────────────────────────────
  const layoutMap = Object.fromEntries((state.widgetLayout || []).map(w => [w.id, w.enabled]))
  function on(id) { return layoutMap[id] !== false }

  // Ordered section list from widgetLayout
  const orderedSections = (state.widgetLayout || [])
    .filter(w => SECTION_IDS.includes(w.id) && w.enabled)
    .map(w => w.id)

  // ── Sort helpers ─────────────────────────────────────────────────────────
  function handleSort(tableId, col) {
    const current = conn.sortState[tableId]
    const dir = current.col === col ? (current.dir === 'desc' ? 'asc' : 'desc') : 'desc'
    dispatch({ type: 'SET_TABLE_SORT', connId, tableId, col, dir })
  }

  function sortedData(tableId) {
    const rows = m?.[
      tableId === 'proc'      ? 'processes'
      : tableId === 'waits'   ? 'resourceWaits'
      : tableId === 'fileio'  ? 'dataFileIO'
      : tableId === 'recent'  ? 'recentExpensive'
      : tableId === 'active'  ? 'activeExpensive'
      : tableId === 'blocking'? 'blocking'
      : tableId === 'deadlocks'?'deadlocks'
      : tableId] || []
    const { col, dir } = conn.sortState[tableId]
    return [...rows].sort((a, b) => {
      const av = a[col], bv = b[col], mult = dir === 'desc' ? -1 : 1
      if (av == null && bv == null) return 0
      if (av == null) return 1; if (bv == null) return -1
      return typeof av === 'string' ? mult * av.localeCompare(bv) : mult * (av - bv)
    })
  }

  // ── Kill sleeping ────────────────────────────────────────────────────────
  function killAllSleeping() {
    const sleeping = (m?.processes || []).filter(r => String(r.status).toLowerCase() === 'sleeping')
    if (sleeping.length === 0) { setKillResult({ error: 'No sleeping sessions to kill.' }); return }
    setKillResult(null)
    setKillDialog({ count: sleeping.length })
  }

  async function confirmKillSleeping() {
    setKillDialog(null)
    try {
      const res  = await fetch(`/api/connections/${connId}/kill-sleeping`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setKillResult({ killed: data.killed })
    } catch (err) {
      setKillResult({ error: err.message })
    }
  }

  // ── Section badge ────────────────────────────────────────────────────────
  function SectionBadge({ count, alertWhen }) {
    const isAlert = alertWhen && count > 0
    return (
      <span className="text-xs px-2 py-0.5 rounded font-semibold tabular-nums"
        style={{
          background: isAlert ? 'rgba(220,38,38,.1)' : 'var(--badge-bg)',
          color: isAlert ? 'var(--c-crit)' : 'var(--badge-text)',
        }}>
        {count}
      </span>
    )
  }

  // ── Chart config ─────────────────────────────────────────────────────────
  const ALL_CHARTS = [
    { id: 'chart_cpu',          title: '% Processor Time',    subtitle: 'SQL CPU utilization',          value: m ? m.cpu_percent + '%' : '--',                        color: p.chartCpu,  yMax: 100,  history: conn.history.cpu },
    { id: 'chart_wait',         title: 'Waiting Tasks',        subtitle: 'Suspended / waiting requests', value: m ? m.waiting_tasks : '--',                            color: p.chartWait, yMax: null, history: conn.history.wait },
    { id: 'chart_io',           title: 'Database I/O',         subtitle: 'MB/s read + write',            value: m ? m.db_io_mb + ' MB/s' : '--',                       color: p.chartIo,   yMax: null, history: conn.history.io },
    { id: 'chart_batch',        title: 'Batch Requests/sec',   subtitle: 'Batches received per second',  value: m ? m.batch_requests?.toLocaleString() : '--',         color: p.chartBatch,yMax: null, history: conn.history.batch },
    { id: 'chart_net',          title: 'Network I/O',          subtitle: 'MB/s SQL connections',         value: m ? (sp.netMbs || 0) + ' MB/s' : '--',                 color: p.chartIo,   yMax: null, history: conn.history.netMb },
    { id: 'chart_compilations', title: 'Compilations/sec',     subtitle: 'SQL compilations per second',  value: m ? (sp.compilationsSec || 0).toLocaleString() : '--', color: p.chartCpu,  yMax: null, history: conn.history.compilations },
  ]
  const enabledCharts = ALL_CHARTS.filter(c => on(c.id))
  const chartCols     = useChartCols(enabledCharts.length)

  // Row 3 visibility
  const showJobs     = on('jobs_panel')
  const showSessions = on('sessions_panel')
  const bothRow3     = showJobs && showSessions

  // ── Section renderer ─────────────────────────────────────────────────────
  function renderSection(id) {
    switch (id) {
      case 'db_sizes':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="dbsizes" title="Database Sizes &amp; Disk Usage">
            <div className="p-5"><DbSizes data={m?.dbSizes} /></div>
          </CollapsibleSection>
        )
      case 'processes':
        return (
          <CollapsibleSection
            key={id}
            connId={connId}
            sectionId="proc"
            title="Processes"
            badge={<SectionBadge count={m?.processes?.length || 0} />}
            extra={
              <button
                type="button"
                onClick={e => { e.stopPropagation(); killAllSleeping() }}
                className="text-xs font-semibold px-2.5 py-1 rounded-md bg-red-50 text-red-600 border border-red-200 hover:bg-red-600 hover:text-white transition-colors"
              >
                Kill All Sleeping
              </button>
            }
          >
            <VirtualTable
              rows={sortedData('proc')}
              columns={TABLE_COLS.proc}
              height={320}
              sortCol={conn.sortState.proc.col}
              sortDir={conn.sortState.proc.dir}
              onSort={col => handleSort('proc', col)}
              extraCol
              renderExtraCell={row => (
                String(row.status || '').toLowerCase() === 'sleeping'
                  ? <button className="kill-btn" onClick={() => {
                      if (window.confirm(`Kill SPID ${row.session_id}?`)) {
                        fetch(`/api/connections/${connId}/kill`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ sessionId: row.session_id }),
                        })
                      }
                    }}>Kill</button>
                  : null
              )}
            />
          </CollapsibleSection>
        )
      case 'resource_waits':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="waits" title="Resource Waits" badge={<SectionBadge count={m?.resourceWaits?.length || 0} />}>
            <VirtualTable rows={sortedData('waits')} columns={TABLE_COLS.waits} height={280}
              sortCol={conn.sortState.waits.col} sortDir={conn.sortState.waits.dir} onSort={col => handleSort('waits', col)} />
          </CollapsibleSection>
        )
      case 'file_io':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="fileio" title="Data File I/O" badge={<SectionBadge count={m?.dataFileIO?.length || 0} />}>
            <VirtualTable rows={sortedData('fileio')} columns={TABLE_COLS.fileio} height={280}
              sortCol={conn.sortState.fileio.col} sortDir={conn.sortState.fileio.dir} onSort={col => handleSort('fileio', col)} />
          </CollapsibleSection>
        )
      case 'recent_expensive':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="recent" title="Recent Expensive Queries" badge={<SectionBadge count={m?.recentExpensive?.length || 0} />}>
            <VirtualTable rows={sortedData('recent')} columns={TABLE_COLS.recent} height={280}
              sortCol={conn.sortState.recent.col} sortDir={conn.sortState.recent.dir} onSort={col => handleSort('recent', col)} />
          </CollapsibleSection>
        )
      case 'active_expensive':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="active" title="Active Expensive Queries" badge={<SectionBadge count={m?.activeExpensive?.length || 0} />}>
            <VirtualTable rows={sortedData('active')} columns={TABLE_COLS.active} height={280}
              sortCol={conn.sortState.active.col} sortDir={conn.sortState.active.dir} onSort={col => handleSort('active', col)} />
          </CollapsibleSection>
        )
      case 'who_is_active':
        return <WhoIsActive key={id} connId={connId} />
      case 'blocking':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="blocking" title="Blocking Chains" badge={<SectionBadge count={m?.blocking?.length || 0} alertWhen />}>
            <VirtualTable rows={sortedData('blocking')} columns={TABLE_COLS.blocking} height={240}
              sortCol={conn.sortState.blocking.col} sortDir={conn.sortState.blocking.dir} onSort={col => handleSort('blocking', col)}
              rowStyle={(_, i) => i === 0 ? { background: '#fef2f2' } : {}} />
          </CollapsibleSection>
        )
      case 'deadlocks':
        return (
          <CollapsibleSection key={id} connId={connId} sectionId="deadlocks" title="Deadlock History" badge={<SectionBadge count={m?.deadlocks?.length || 0} alertWhen />}>
            <VirtualTable rows={sortedData('deadlocks')} columns={TABLE_COLS.deadlocks} height={240}
              sortCol={conn.sortState.deadlocks.col} sortDir={conn.sortState.deadlocks.dir} onSort={col => handleSort('deadlocks', col)}
              rowStyle={() => ({ background: '#fff7ed' })} />
          </CollapsibleSection>
        )
      default:
        return null
    }
  }

  return (
    <div>
      {/* Kill sleeping — confirm dialog */}
      <Dialog open={!!killDialog} onOpenChange={open => !open && setKillDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kill Sleeping Sessions</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
              Kill <strong style={{ color: 'var(--text-primary)' }}>{killDialog?.count}</strong> sleeping session{killDialog?.count !== 1 ? 's' : ''} on{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{conn.label}</strong>?
            </p>
            <p className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <button
                  className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--divider)', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}
                >
                  Cancel
                </button>
              </DialogClose>
              <button
                onClick={confirmKillSleeping}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
                style={{ background: '#dc2626' }}
              >
                Kill Sessions
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

      {/* Charts — dynamic column grid, collapses on disable, responsive to viewport */}
      {enabledCharts.length > 0 && chartCols > 0 && (
        <div
          className="mb-6"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${chartCols}, minmax(0, 1fr))`,
            gap: '1.5rem',
          }}
        >
          {enabledCharts.map(c => (
            <div key={c.id} className="widget-enter">
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
      )}

      {/* Row 3: Jobs + Sessions — explicit col-span passed from Dashboard */}
      {(showJobs || showSessions) && (
        <div
          className="mb-6"
          style={{
            display: 'grid',
            gap: '1.5rem',
            gridTemplateColumns: bothRow3 ? '2fr 1fr' : '1fr',
          }}
        >
          {showJobs     && <JobsPanel     jobs={m?.jobs || []}           connId={connId} className="widget-enter" />}
          {showSessions && <SessionsPanel processes={m?.processes || []} connId={connId} className="widget-enter" />}
        </div>
      )}

      {/* Memory Health */}
      {on('memory_health') && (
        <div className="widget-enter">
          <MemoryHealth conn={conn} />
        </div>
      )}

      {/* Collapsible sections — ordered and filtered by widgetLayout */}
      {orderedSections.length > 0 && (
        <div className="space-y-6">
          {orderedSections.map(id => renderSection(id))}
        </div>
      )}
    </div>
  )
}
