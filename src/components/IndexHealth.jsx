import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useIndexHealthApi } from '../hooks/useIndexHealthApi'
import ScanControls from './indexHealth/ScanControls'
import ScanProgress from './indexHealth/ScanProgress'
import HealthScore from './indexHealth/HealthScore'
import SummaryStrip from './indexHealth/SummaryStrip'
import IndexInventory from './indexHealth/IndexInventory'
import DetailModal from './indexHealth/DetailModal'

function sessionKey(connId) { return `index-health-scan-${connId}` }

function pollInterval(pct) {
  if (pct < 40) return 2000
  if (pct < 80) return 5000
  return 10000
}

function Banner({ color, children }) {
  return (
    <div style={{ marginBottom: 10, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500,
      background: `${color}14`, border: `1px solid ${color}44`, color }}>
      {children}
    </div>
  )
}

const TERMINAL = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled', 'expired'])

export default function IndexHealth({ connId }) {
  const [phase, setPhase]                     = useState('idle')
  const [scanId, setScanId]                   = useState(null)
  const [mode, setMode]                       = useState('LIMITED')
  const [progress, setProgress]               = useState(null)
  const [summary, setSummary]                 = useState(null)
  const [metadata, setMetadata]               = useState(null)
  const [timedOutDbs, setTimedOutDbs]         = useState([])
  const [error, setError]                     = useState(null)
  const [activeTab, setActiveTab]             = useState('fragmented')
  const [inventoryPage, setInventoryPage]     = useState(1)
  const [inventoryFilter, setInventoryFilter] = useState({ db: 'all', search: '' })
  const [inventoryData, setInventoryData]     = useState(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [selectedRow, setSelectedRow]         = useState(null)
  const pollRef  = useRef(null)

  const { startScan, pollProgress, fetchResults, cancelScan } = useIndexHealthApi(connId)

  const loadInventory = useCallback(async (sid, tab, pg, filter) => {
    setInventoryLoading(true)
    try {
      const serverTab = (tab === 'unused' || tab === 'duplicate') ? 'unusedAndDuplicate' : tab
      const res = await fetchResults(sid, serverTab, { page: pg, pageSize: 50, ...filter })
      if (res.expired) {
        setPhase('expired')
        sessionStorage.removeItem(sessionKey(connId))
        return
      }
      if (res.timedOutDbs) setTimedOutDbs(res.timedOutDbs)
      if (res.summary)     setSummary(res.summary)
      if (res.metadata)    setMetadata(res.metadata)
      const rawData = res.fragmented || res.missing || res.unusedAndDuplicate
      let rows = rawData?.rows ?? []
      if (tab === 'unused')    rows = rows.filter(r => r._rowType === 'unused')
      if (tab === 'duplicate') rows = rows.filter(r => r._rowType === 'duplicate')
      setInventoryData({ rows, total: rawData?.total ?? 0, page: rawData?.page ?? 1, pageSize: rawData?.pageSize ?? 50 })
    } catch {
      // non-fatal — keep existing data
    } finally {
      setInventoryLoading(false)
    }
  }, [connId, fetchResults])

  // Session recovery on mount
  useEffect(() => {
    const saved = sessionStorage.getItem(sessionKey(connId))
    if (!saved) return
    setScanId(saved)
    setPhase('running')
  }, [connId])

  // Polling loop — only IndexHealth.jsx polls
  useEffect(() => {
    if (!scanId) return
    if (!['pending', 'running'].includes(phase)) return

    let alive = true

    async function tick() {
      if (!alive) return
      try {
        const prog = await pollProgress(scanId)
        if (!alive) return
        setProgress(prog)
        if (TERMINAL.has(prog.status)) {
          setPhase(prog.status)
          return
        }
        pollRef.current = setTimeout(tick, pollInterval(prog.pct ?? 0))
      } catch (err) {
        if (!alive) return
        // A 404 from the progress endpoint means the scan is gone (expired/evicted).
        if (err?.status === 404 || err?.message?.includes('404')) {
          setPhase('expired')
          sessionStorage.removeItem(sessionKey(connId))
          return
        }
        pollRef.current = setTimeout(tick, 10000)
      }
    }

    tick()
    return () => {
      alive = false
      clearTimeout(pollRef.current)
    }
  }, [scanId, phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load initial results when scan transitions to completed
  useEffect(() => {
    if (!scanId) return
    if (phase !== 'completed' && phase !== 'completed_with_warnings') return
    loadInventory(scanId, 'fragmented', 1, { db: 'all', search: '' })
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear sessionStorage for terminal non-result states
  useEffect(() => {
    if (phase === 'failed' || phase === 'cancelled' || phase === 'expired') {
      sessionStorage.removeItem(sessionKey(connId))
    }
  }, [phase, connId])

  async function handleStartScan() {
    setError(null)
    setSummary(null)
    setMetadata(null)
    setInventoryData(null)
    setProgress(null)
    setTimedOutDbs([])
    setActiveTab('fragmented')
    setInventoryPage(1)
    setInventoryFilter({ db: 'all', search: '' })
    setPhase('pending')
    try {
      const res = await startScan({ mode, databases: [] })
      if (res.conflict) {
        setScanId(res.scanId)
        setPhase('running')
        sessionStorage.setItem(sessionKey(connId), res.scanId)
        return
      }
      setScanId(res.scanId)
      sessionStorage.setItem(sessionKey(connId), res.scanId)
    } catch (err) {
      setError(err.message)
      setPhase('failed')
    }
  }

  async function handleCancelScan() {
    if (!scanId) return
    try {
      await cancelScan(scanId)
    } catch {}
    setPhase('cancelled')
    sessionStorage.removeItem(sessionKey(connId))
  }

  function handleTabChange(tab) {
    setActiveTab(tab)
    setInventoryPage(1)
    if (scanId && (phase === 'completed' || phase === 'completed_with_warnings')) {
      loadInventory(scanId, tab, 1, inventoryFilter)
    }
  }

  function handlePageChange(pg) {
    setInventoryPage(pg)
    if (scanId && (phase === 'completed' || phase === 'completed_with_warnings')) {
      loadInventory(scanId, activeTab, pg, inventoryFilter)
    }
  }

  function handleFilterChange(filter) {
    setInventoryFilter(filter)
    setInventoryPage(1)
    if (scanId && (phase === 'completed' || phase === 'completed_with_warnings')) {
      loadInventory(scanId, activeTab, 1, filter)
    }
  }

  const hasResults = phase === 'completed' || phase === 'completed_with_warnings'
  const isActive   = phase === 'pending' || phase === 'running'

  return (
    <div style={{ background: 'var(--card-bg)', borderRadius: 12, border: '1px solid var(--divider)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Index Health</span>
        <ScanControls
          mode={mode}
          onModeChange={setMode}
          phase={phase}
          onStartScan={handleStartScan}
          onCancelScan={handleCancelScan}
        />
      </div>

      {/* Body */}
      <div style={{ padding: '14px 18px' }}>
        {/* Banners */}
        {phase === 'expired' && (
          <Banner color="#6b7280">Scan results have expired. Run a new scan to refresh.</Banner>
        )}
        {phase === 'failed' && error && (
          <Banner color="#ef4444">Scan failed: {error}</Banner>
        )}
        {timedOutDbs.length > 0 && hasResults && (
          <Banner color="#f59e0b">
            {timedOutDbs.length} database{timedOutDbs.length > 1 ? 's' : ''} timed out during scan: {timedOutDbs.join(', ')}
          </Banner>
        )}

        {isActive && <ScanProgress phase={phase} progress={progress} />}

        {hasResults && summary && (
          <>
            <HealthScore summary={summary} />
            <SummaryStrip summary={summary} timedOutDbs={timedOutDbs} />
            <IndexInventory
              activeTab={activeTab}
              onTabChange={handleTabChange}
              data={inventoryData}
              loading={inventoryLoading}
              filter={inventoryFilter}
              onFilterChange={handleFilterChange}
              page={inventoryPage}
              onPageChange={handlePageChange}
              summary={summary}
              onRowClick={row => setSelectedRow({ ...row, _tab: activeTab })}
            />
          </>
        )}
      </div>

      {selectedRow && <DetailModal row={selectedRow} onClose={() => setSelectedRow(null)} />}
    </div>
  )
}
