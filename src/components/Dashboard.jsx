import React, { useEffect, useState, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { PALETTES } from '../lib/palettes'
import { TABLE_COLS } from '../lib/tableCols'
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
  const [killDialog, setKillDialog] = useState(null) // { count } | null
  const [killResult, setKillResult] = useState(null) // { killed, error } | null

  if (!conn) return null

  const m  = conn.metrics
  const sp = m?.serverPerf || {}
  const p  = PALETTES[state.palette] || PALETTES['Enterprise']

  function handleSort(tableId, col) {
    const current = conn.sortState[tableId]
    const dir = current.col === col ? (current.dir === 'desc' ? 'asc' : 'desc') : 'desc'
    dispatch({ type: 'SET_TABLE_SORT', connId, tableId, col, dir })
  }

  function sortedData(tableId) {
    const rows = m?.[tableId === 'proc' ? 'processes'
      : tableId === 'waits'     ? 'resourceWaits'
      : tableId === 'fileio'    ? 'dataFileIO'
      : tableId === 'recent'    ? 'recentExpensive'
      : tableId === 'active'    ? 'activeExpensive'
      : tableId === 'blocking'  ? 'blocking'
      : tableId === 'deadlocks' ? 'deadlocks'
      : tableId] || []
    const { col, dir } = conn.sortState[tableId]
    return [...rows].sort((a, b) => {
      const av = a[col], bv = b[col], mult = dir === 'desc' ? -1 : 1
      if (av == null && bv == null) return 0
      if (av == null) return 1; if (bv == null) return -1
      return typeof av === 'string' ? mult * av.localeCompare(bv) : mult * (av - bv)
    })
  }

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

  const chartKeys   = ['cpu', 'wait', 'io', 'batch']
  const chartTitles = ['% Processor Time', 'Waiting Tasks', 'Database I/O', 'Batch Requests/sec']
  const chartSubs   = ['SQL CPU utilization', 'Suspended / waiting requests', 'MB/s read + write', 'Batches received per second']
  const chartColors = [p.chartCpu, p.chartWait, p.chartIo, p.chartBatch]
  const chartVals   = [
    m ? m.cpu_percent + '%' : '--',
    m ? m.waiting_tasks : '--',
    m ? m.db_io_mb + ' MB/s' : '--',
    m ? m.batch_requests?.toLocaleString() : '--',
  ]
  const chartYMax = [100, null, null, null]

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
                  style={{
                    background: 'var(--divider)',
                    border: '1px solid var(--input-border)',
                    color: 'var(--text-secondary)',
                  }}
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
            color: killResult.error ? '#f87171' : '#4ade80',
            boxShadow: 'var(--card-shadow), 0 8px 24px rgba(0,0,0,.3)',
          }}
        >
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: killResult.error ? '#dc2626' : '#22c55e' }}
          />
          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {killResult.error ? `Error: ${killResult.error}` : `Killed ${killResult.killed} session(s)`}
          </span>
          <button
            onClick={() => setKillResult(null)}
            className="ml-2 opacity-50 hover:opacity-100 transition-opacity text-lg leading-none"
            style={{ color: 'var(--text-muted)' }}
          >
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
      <KPIBar conn={conn} />

      {/* Row 1: 4 chart cards */}
      <div className="grid grid-cols-4 gap-6 mb-6">
        {chartKeys.map((k, i) => (
          <div id={`chart-${k}-${connId}`} key={k}>
            <ChartCard
              title={chartTitles[i]}
              subtitle={chartSubs[i]}
              value={chartVals[i]}
              history={conn.history[k]}
              color={chartColors[i]}
              yMax={chartYMax[i]}
            />
          </div>
        ))}
      </div>

      {/* Row 2: Network + Compilations */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <ChartCard
          title="Network I/O"
          subtitle="MB/s SQL connections"
          value={m ? (sp.netMbs || 0) + ' MB/s' : '--'}
          history={conn.history.netMb}
          color={p.chartIo}
        />
        <ChartCard
          title="Compilations/sec"
          subtitle="SQL compilations per second"
          value={m ? (sp.compilationsSec || 0).toLocaleString() : '--'}
          history={conn.history.compilations}
          color={p.chartCpu}
        />
      </div>

      {/* Row 3: Jobs + Sessions */}
      <div className="grid grid-cols-12 gap-6 mb-6">
        <JobsPanel jobs={m?.jobs || []} connId={connId} />
        <SessionsPanel processes={m?.processes || []} connId={connId} />
      </div>

      {/* Memory Health */}
      <MemoryHealth conn={conn} />

      {/* Collapsible sections */}
      <div className="space-y-6">
        {/* DB Sizes */}
        <CollapsibleSection connId={connId} sectionId="dbsizes" title="Database Sizes &amp; Disk Usage">
          <div className="p-5">
            <DbSizes data={m?.dbSizes} />
          </div>
        </CollapsibleSection>

        {/* Processes */}
        <CollapsibleSection
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

        {/* Resource Waits */}
        <CollapsibleSection
          connId={connId}
          sectionId="waits"
          title="Resource Waits"
          badge={<SectionBadge count={m?.resourceWaits?.length || 0} />}
        >
          <VirtualTable
            rows={sortedData('waits')}
            columns={TABLE_COLS.waits}
            height={280}
            sortCol={conn.sortState.waits.col}
            sortDir={conn.sortState.waits.dir}
            onSort={col => handleSort('waits', col)}
          />
        </CollapsibleSection>

        {/* Data File I/O */}
        <CollapsibleSection
          connId={connId}
          sectionId="fileio"
          title="Data File I/O"
          badge={<SectionBadge count={m?.dataFileIO?.length || 0} />}
        >
          <VirtualTable
            rows={sortedData('fileio')}
            columns={TABLE_COLS.fileio}
            height={280}
            sortCol={conn.sortState.fileio.col}
            sortDir={conn.sortState.fileio.dir}
            onSort={col => handleSort('fileio', col)}
          />
        </CollapsibleSection>

        {/* Recent Expensive Queries */}
        <CollapsibleSection
          connId={connId}
          sectionId="recent"
          title="Recent Expensive Queries"
          badge={<SectionBadge count={m?.recentExpensive?.length || 0} />}
        >
          <VirtualTable
            rows={sortedData('recent')}
            columns={TABLE_COLS.recent}
            height={280}
            sortCol={conn.sortState.recent.col}
            sortDir={conn.sortState.recent.dir}
            onSort={col => handleSort('recent', col)}
          />
        </CollapsibleSection>

        {/* Active Expensive Queries */}
        <CollapsibleSection
          connId={connId}
          sectionId="active"
          title="Active Expensive Queries"
          badge={<SectionBadge count={m?.activeExpensive?.length || 0} />}
        >
          <VirtualTable
            rows={sortedData('active')}
            columns={TABLE_COLS.active}
            height={280}
            sortCol={conn.sortState.active.col}
            sortDir={conn.sortState.active.dir}
            onSort={col => handleSort('active', col)}
          />
        </CollapsibleSection>

        {/* sp_WhoIsActive */}
        <WhoIsActive connId={connId} />

        {/* Blocking Chains */}
        <CollapsibleSection
          connId={connId}
          sectionId="blocking"
          title="Blocking Chains"
          badge={<SectionBadge count={m?.blocking?.length || 0} alertWhen />}
        >
          <VirtualTable
            rows={sortedData('blocking')}
            columns={TABLE_COLS.blocking}
            height={240}
            sortCol={conn.sortState.blocking.col}
            sortDir={conn.sortState.blocking.dir}
            onSort={col => handleSort('blocking', col)}
            rowStyle={(_, i) => i === 0 ? { background: '#fef2f2' } : {}}
          />
        </CollapsibleSection>

        {/* Deadlock History */}
        <CollapsibleSection
          connId={connId}
          sectionId="deadlocks"
          title="Deadlock History"
          badge={<SectionBadge count={m?.deadlocks?.length || 0} alertWhen />}
        >
          <VirtualTable
            rows={sortedData('deadlocks')}
            columns={TABLE_COLS.deadlocks}
            height={240}
            sortCol={conn.sortState.deadlocks.col}
            sortDir={conn.sortState.deadlocks.dir}
            onSort={col => handleSort('deadlocks', col)}
            rowStyle={() => ({ background: '#fff7ed' })}
          />
        </CollapsibleSection>
      </div>
    </div>
  )
}
