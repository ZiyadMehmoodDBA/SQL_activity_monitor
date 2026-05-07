import React, { useState, useEffect, useMemo, memo } from 'react'
import ReactApexChart from 'react-apexcharts'

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const gb = bytes / 1073741824
  if (gb >= 1)    return gb.toFixed(2) + ' GB'
  const mb = bytes / 1048576
  if (mb >= 1)    return mb.toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(0) + ' KB'
}

function fmtGrowth(bytes) {
  if (!bytes || bytes === 0) return null
  const sign = bytes > 0 ? '+' : ''
  return sign + fmtSize(Math.abs(bytes))
}

// ── Chart color palette ───────────────────────────────────────────────────────
const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#a855f7', '#0ea5e9', '#22c55e', '#fb923c',
]

// ── DbSizeTrend ───────────────────────────────────────────────────────────────
export default memo(function DbSizeTrend({ connId }) {
  const [history, setHistory]     = useState(null)
  const [fetchError, setFetchError] = useState(null)
  const [search, setSearch]       = useState('')

  // Fetch history on mount + refresh every 5 min
  useEffect(() => {
    let cancelled = false

    async function fetchHistory() {
      try {
        const res  = await fetch(`/api/connections/${connId}/db-size-history`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!cancelled) { setHistory(data); setFetchError(null) }
      } catch (err) {
        if (!cancelled) setFetchError(err.message)
      }
    }

    fetchHistory()
    const iv = setInterval(fetchHistory, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [connId])

  // ── Process history into chart series + growth stats ──────────────────────
  const { dates, dbList, series, growthStats } = useMemo(() => {
    if (!history || Object.keys(history).length === 0)
      return { dates: [], dbList: [], series: [], growthStats: [] }

    const dates = Object.keys(history).sort()

    // Collect all DB names present across all dates
    const allDbs = new Set()
    for (const snap of Object.values(history))
      for (const db of Object.keys(snap)) allDbs.add(db)

    // Latest snapshot for current sizes
    const latest     = dates[dates.length - 1]
    const latestSnap = history[latest] || {}

    // Sort by current total_bytes descending
    const dbList = [...allDbs].sort((a, b) =>
      (latestSnap[b]?.total_bytes || 0) - (latestSnap[a]?.total_bytes || 0)
    )

    // Series: one per DB, values in GB
    const series = dbList.map(db => ({
      name: db,
      data: dates.map(d => {
        const bytes = history[d]?.[db]?.total_bytes
        return bytes !== undefined ? parseFloat((bytes / 1073741824).toFixed(4)) : null
      }),
    }))

    // Growth stats per DB
    const growthStats = dbList.map(db => {
      const sizes = dates
        .map(d => history[d]?.[db]?.total_bytes ?? null)
        .filter(v => v !== null)

      const currentSize  = latestSnap[db]?.total_bytes || 0
      const currentData  = latestSnap[db]?.data_bytes  || 0
      const currentLog   = latestSnap[db]?.log_bytes   || 0

      let totalGrowth    = 0
      let avgDailyGrowth = 0
      let maxDailyGrowth = 0
      let hasSpike       = false

      if (sizes.length >= 2) {
        totalGrowth = sizes[sizes.length - 1] - sizes[0]
        const deltas = []
        for (let i = 1; i < sizes.length; i++) {
          const d = sizes[i] - sizes[i - 1]
          if (d > 0) deltas.push(d)
          if (d > maxDailyGrowth) maxDailyGrowth = d
        }
        if (deltas.length > 0) {
          avgDailyGrowth = deltas.reduce((a, b) => a + b, 0) / deltas.length
          hasSpike = avgDailyGrowth > 0 && maxDailyGrowth > avgDailyGrowth * 3
        }
      }

      return { db, currentSize, currentData, currentLog, totalGrowth, avgDailyGrowth, hasSpike }
    })

    return { dates, dbList, series, growthStats }
  }, [history])

  // ── Filter ────────────────────────────────────────────────────────────────
  const lcSearch      = search.trim().toLowerCase()
  const filteredDbs   = lcSearch ? dbList.filter(n => n.toLowerCase().includes(lcSearch)) : dbList
  const filteredSeries  = series.filter(s => filteredDbs.includes(s.name)).slice(0, 15)
  const filteredGrowth  = growthStats.filter(g => filteredDbs.includes(g.db))

  // ── Chart options ─────────────────────────────────────────────────────────
  const chartOptions = useMemo(() => ({
    chart: {
      type:       'line',
      toolbar:    { show: false },
      background: 'transparent',
      animations: { enabled: false },
      fontFamily: 'inherit',
      redrawOnWindowResize: false,
      redrawOnParentResize: false,
    },
    stroke:    { curve: 'smooth', width: 2 },
    colors:    COLORS,
    markers:   { size: 3, hover: { size: 5 } },
    xaxis: {
      categories: dates,
      labels: {
        style:    { colors: '#94a3b8', fontSize: '10px', fontFamily: 'inherit' },
        rotate:   -30,
        formatter: v => (typeof v === 'string' && v.length >= 7) ? v.slice(5) : v,
      },
      axisBorder: { show: false },
      axisTicks:  { show: false },
    },
    yaxis: {
      labels: {
        style:     { colors: '#94a3b8', fontSize: '10px', fontFamily: 'inherit' },
        formatter: v => v == null ? '' : v >= 1 ? v.toFixed(1) + ' GB' : (v * 1024).toFixed(0) + ' MB',
        offsetX:   -4,
      },
    },
    grid: {
      borderColor:    'rgba(0,0,0,.06)',
      strokeDashArray: 4,
    },
    legend: {
      position:   'bottom',
      fontSize:   '11px',
      labels:     { colors: '#94a3b8' },
      itemMargin: { horizontal: 8 },
    },
    dataLabels: { enabled: false },
    tooltip: {
      theme: 'dark',
      style: { fontSize: '11px' },
      y: {
        formatter: v =>
          v == null ? 'No data'
          : v >= 1  ? v.toFixed(3) + ' GB'
          : (v * 1024).toFixed(1) + ' MB',
      },
    },
  }), [dates])

  // ── Render states ─────────────────────────────────────────────────────────
  if (fetchError) return (
    <div style={{ fontSize: 12, color: 'var(--c-warn)', fontStyle: 'italic' }}>
      Error loading history: {fetchError}
    </div>
  )

  if (!history) return (
    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
      Loading…
    </div>
  )

  if (dates.length === 0) return (
    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
      No history yet. Snapshots captured daily — data will appear after the first day.
    </div>
  )

  return (
    <div>
      {/* ── Filter + meta ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter databases…"
          style={{
            fontSize: 12, padding: '4px 10px', borderRadius: 6, width: 220,
            background: 'var(--input-bg)', border: '1px solid var(--input-border)',
            color: 'var(--text-primary)', outline: 'none',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {filteredDbs.length}/{dbList.length} databases · {dates.length} days
        </span>
      </div>

      {/* ── Line chart — fixed height container prevents ApexCharts from growing parent ── */}
      {filteredSeries.length > 0 && (
        <div style={{ height: 320, minHeight: 320, maxHeight: 320, overflow: 'hidden', marginBottom: 20 }}>
          <ReactApexChart
            type="line"
            series={filteredSeries}
            options={chartOptions}
            height={320}
          />
        </div>
      )}

      {/* ── Growth table ── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--divider)' }}>
              {['Database', 'Total Size', 'Data', 'Log', '10-Day Growth', 'Daily Avg', ''].map((h, i) => (
                <th key={i} style={{
                  textAlign: 'left', padding: '5px 10px', whiteSpace: 'nowrap',
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '.06em', color: 'var(--text-muted)',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredGrowth.map(({ db, currentSize, currentData, currentLog, totalGrowth, avgDailyGrowth, hasSpike }) => (
              <tr key={db} style={{ borderBottom: '1px solid var(--divider)' }}>
                <td style={{ padding: '6px 10px', color: 'var(--text-primary)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {db}
                </td>
                <td style={{ padding: '6px 10px', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {fmtSize(currentSize)}
                </td>
                <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {fmtSize(currentData)}
                </td>
                <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {fmtSize(currentLog)}
                </td>
                <td style={{
                  padding: '6px 10px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                  color: totalGrowth > 0 ? '#f59e0b' : totalGrowth < 0 ? '#22c55e' : 'var(--text-muted)',
                }}>
                  {fmtGrowth(totalGrowth) || '—'}
                  {totalGrowth < 0 && <span style={{ color: 'var(--text-muted)' }}> reclaimed</span>}
                </td>
                <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {avgDailyGrowth > 0 ? `+${fmtSize(avgDailyGrowth)}/day` : '—'}
                </td>
                <td style={{ padding: '6px 10px' }}>
                  {hasSpike && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                      background: 'rgba(245,158,11,.12)', color: '#d97706',
                      border: '1px solid rgba(245,158,11,.3)',
                    }}>
                      SPIKE
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
})
