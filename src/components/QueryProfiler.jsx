import React, { useState, useCallback } from 'react'
import { RefreshCw, AlertTriangle, Info, Zap, Database, Search, ChevronDown } from 'lucide-react'

// ── Plan issue metadata ───────────────────────────────────────────────────────
const ISSUE_META = {
  key_lookup:          { label: 'Key Lookup',          color: '#f97316', bg: 'rgba(249,115,22,.13)', icon: '⚠', tip: 'Add INCLUDE columns to nonclustered index to eliminate extra lookups.' },
  implicit_conversion: { label: 'Implicit Conversion', color: '#f97316', bg: 'rgba(249,115,22,.13)', icon: '⚠', tip: 'Datatype mismatch forces index scan. Match param type to column type.' },
  missing_index_hint:  { label: 'Missing Index',       color: '#f59e0b', bg: 'rgba(245,158,11,.13)', icon: '💡', tip: 'Optimizer detected a beneficial missing index for this query.' },
  spill:               { label: 'TempDB Spill',        color: '#ef4444', bg: 'rgba(239,68,68,.13)',  icon: '🔴', tip: 'Sort or hash join spilled to TempDB — memory grant too small or data too large.' },
  table_scan:          { label: 'Table Scan',          color: '#ef4444', bg: 'rgba(239,68,68,.13)',  icon: '🔴', tip: 'Full table scan — add or improve index on filter/join columns.' },
  clustered_scan:      { label: 'Clustered Scan',      color: '#f59e0b', bg: 'rgba(245,158,11,.13)', icon: '⚠', tip: 'Clustered index scan — may be OK for small tables, costly on large ones.' },
  columnstore_scan:    { label: 'Columnstore',         color: '#3b82f6', bg: 'rgba(59,130,246,.12)', icon: 'ℹ', tip: 'Columnstore index scan — normal for analytics queries.' },
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 }

const TABS = [
  { id: 'top-queries',   label: 'Top Queries',      icon: Zap },
  { id: 'missing-idx',   label: 'Missing Indexes',  icon: Search },
  { id: 'fragmentation', label: 'Index Health',     icon: Database },
]

function fmt(n, decimals = 0) {
  if (n == null) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: decimals })
}

function truncate(s, max = 120) {
  if (!s) return '—'
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

function SeverityIcon({ severity }) {
  if (severity === 'critical') return <AlertTriangle size={11} style={{ color: '#ef4444' }} />
  if (severity === 'warning')  return <AlertTriangle size={11} style={{ color: '#f97316' }} />
  return <Info size={11} style={{ color: '#3b82f6' }} />
}

// ── Top Queries tab ───────────────────────────────────────────────────────────
function TopQueriesTab({ rows, connId, sortCol, setSortCol, sortDir, setSortDir }) {
  const [expanded,   setExpanded]   = useState(null)
  // planCache: index → { issues, loading, error }
  const [planCache,  setPlanCache]  = useState({})

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('desc') }
  }

  async function expandRow(i, row) {
    if (expanded === i) { setExpanded(null); return }
    setExpanded(i)
    if (planCache[i] || !row.plan_handle_hex) return
    setPlanCache(c => ({ ...c, [i]: { loading: true, issues: [], error: null } }))
    try {
      const r = await fetch(`/api/connections/${connId}/profiler/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planHandleHex: row.plan_handle_hex }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setPlanCache(c => ({ ...c, [i]: { loading: false, issues: d.issues || [], error: null } }))
    } catch (e) {
      setPlanCache(c => ({ ...c, [i]: { loading: false, issues: [], error: e.message } }))
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortCol] ?? 0, bv = b[sortCol] ?? 0
    return sortDir === 'desc' ? bv - av : av - bv
  })

  const TH = ({ col, label, right }) => (
    <th
      className="wia-th"
      style={{ cursor: 'pointer', textAlign: right ? 'right' : 'left', userSelect: 'none', whiteSpace: 'nowrap' }}
      onClick={() => toggleSort(col)}
    >
      {label} {sortCol === col ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  )

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th className="wia-th" style={{ width: 28 }}></th>
            <TH col="avg_cpu_ms"        label="Avg CPU (ms)"     right />
            <TH col="avg_elapsed_ms"    label="Avg Elapsed (ms)"  right />
            <TH col="avg_logical_reads" label="Avg Reads"          right />
            <TH col="execution_count"   label="Executions"         right />
            <th className="wia-th" style={{ width: 90 }}>Plan Issues</th>
            <th className="wia-th">Database / Query</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const isOpen  = expanded === i
            const plan    = planCache[i]
            const issues  = (plan?.issues || []).sort((a, b) =>
              (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
            )
            const worstSev = issues[0]?.severity
            const rowBorder = worstSev === 'critical' ? '2px solid rgba(239,68,68,.35)'
                            : worstSev === 'warning'  ? '2px solid rgba(249,115,22,.3)'
                            : '2px solid transparent'
            return (
              <React.Fragment key={i}>
                <tr
                  className="wia-row"
                  style={{ cursor: 'pointer', borderLeft: rowBorder }}
                  onClick={() => expandRow(i, row)}
                >
                  <td className="wia-td text-center" style={{ color: 'var(--text-muted)' }}>
                    {plan?.loading
                      ? <RefreshCw size={10} className="animate-spin" style={{ display: 'inline' }} />
                      : <ChevronDown size={10} style={{ display: 'inline', transition: 'transform .15s', transform: isOpen ? 'none' : 'rotate(-90deg)' }} />
                    }
                  </td>
                  <td className="wia-td tabular-nums text-right" style={{ fontWeight: 600, color: row.avg_cpu_ms > 1000 ? '#ef4444' : 'var(--text-primary)' }}>
                    {fmt(row.avg_cpu_ms)}
                  </td>
                  <td className="wia-td tabular-nums text-right" style={{ color: 'var(--text-secondary)' }}>
                    {fmt(row.avg_elapsed_ms)}
                  </td>
                  <td className="wia-td tabular-nums text-right" style={{ color: 'var(--text-secondary)' }}>
                    {fmt(row.avg_logical_reads)}
                  </td>
                  <td className="wia-td tabular-nums text-right" style={{ color: 'var(--text-muted)' }}>
                    {fmt(row.execution_count)}
                  </td>
                  <td className="wia-td">
                    {plan?.loading && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>analysing…</span>}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {issues.slice(0, 3).map((iss, j) => {
                        const m = ISSUE_META[iss.type] || {}
                        return (
                          <span key={j} title={iss.message} style={{
                            fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                            background: m.bg || 'var(--divider)', color: m.color || 'var(--text-secondary)',
                          }}>
                            {m.icon} {m.label || iss.type}
                          </span>
                        )
                      })}
                    </div>
                  </td>
                  <td className="wia-td" style={{ maxWidth: 320 }}>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>{row.database_name || ''}</div>
                    <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)' }}>
                      {truncate(row.query_text, 100)}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} style={{ padding: '10px 16px 14px', background: 'var(--input-bg)', borderBottom: '1px solid var(--divider)' }}>
                      {/* Stats */}
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
                        {[
                          ['Total CPU',     fmt(row.total_cpu_ms) + ' ms'],
                          ['Total Elapsed', fmt(row.total_elapsed_ms) + ' ms'],
                          ['Total Reads',   fmt(row.total_logical_reads)],
                          ['Executions',    fmt(row.execution_count)],
                        ].map(([k, v]) => (
                          <div key={k}>
                            <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{k}</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{v}</div>
                          </div>
                        ))}
                      </div>
                      {/* Plan findings */}
                      {plan?.loading && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>Fetching plan…</div>
                      )}
                      {plan?.error && (
                        <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 10 }}>Plan error: {plan.error}</div>
                      )}
                      {issues.length > 0 && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-muted)', marginBottom: 6 }}>
                            Plan Findings
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            {issues.map((iss, j) => {
                              const m = ISSUE_META[iss.type] || {}
                              return (
                                <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 7,
                                  padding: '6px 10px', borderRadius: 6, background: m.bg || 'var(--divider)',
                                  border: `1px solid ${m.color || 'var(--divider)'}33` }}>
                                  <SeverityIcon severity={iss.severity} />
                                  <div>
                                    <span style={{ fontWeight: 700, fontSize: 11, color: m.color || 'var(--text-primary)' }}>{m.label || iss.type}</span>
                                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 6 }}>{iss.message}</span>
                                    {m.tip && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{m.tip}</div>}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {plan && !plan.loading && issues.length === 0 && !plan.error && (
                        <div style={{ fontSize: 11, color: '#22c55e', marginBottom: 10 }}>✓ No plan issues detected</div>
                      )}
                      {/* Query text */}
                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-muted)', marginBottom: 4 }}>
                        Query Text
                      </div>
                      <pre style={{
                        fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)',
                        background: 'var(--card-bg)', border: '1px solid var(--divider)',
                        borderRadius: 6, padding: '8px 10px', overflowX: 'auto',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, maxHeight: 200,
                      }}>
                        {row.query_text || '(not available)'}
                      </pre>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Missing Indexes tab ───────────────────────────────────────────────────────
function MissingIndexesTab({ rows }) {
  function bracketCol(name) {
    // Strip any existing brackets then re-wrap — prevents [[col]] double-bracket bug
    return `[${name.trim().replace(/^\[|\]$/g, '')}]`
  }

  function bracketColList(colStr) {
    if (!colStr) return null
    return colStr.split(',').map(bracketCol).join(', ')
  }

  function createScript(row) {
    const eqCols   = bracketColList(row.equality_columns)
    const ineqCols = bracketColList(row.inequality_columns)
    const keyCols  = [eqCols, ineqCols].filter(Boolean).join(', ')
    const incl     = row.included_columns
      ? `\nINCLUDE (${bracketColList(row.included_columns)})` : ''
    const firstCol = (row.equality_columns || row.inequality_columns || 'cols')
      .split(',')[0].trim().replace(/^\[|\]$/g, '')
    const idxName  = `IX_${row.table_name}_${firstCol}`
    return `CREATE NONCLUSTERED INDEX [${idxName}]\nON [${row.schema_name}].[${row.table_name}] (${keyCols})${incl};`
  }

  function copyScript(row) {
    navigator.clipboard?.writeText(createScript(row)).catch(() => {})
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th className="wia-th">Table</th>
            <th className="wia-th">Equality Columns</th>
            <th className="wia-th">Inequality Columns</th>
            <th className="wia-th">Include Columns</th>
            <th className="wia-th" style={{ textAlign: 'right' }}>Impact %</th>
            <th className="wia-th" style={{ textAlign: 'right' }}>Seeks</th>
            <th className="wia-th" style={{ textAlign: 'right' }}>Scans</th>
            <th className="wia-th" style={{ width: 80 }}>Script</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="wia-row">
              <td className="wia-td" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                <div>{row.table_name || '—'}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{row.database_name}</div>
              </td>
              <td className="wia-td" style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)', maxWidth: 160 }}>
                <span className="block truncate" title={row.equality_columns}>{row.equality_columns || '—'}</span>
              </td>
              <td className="wia-td" style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', maxWidth: 140 }}>
                <span className="block truncate" title={row.inequality_columns}>{row.inequality_columns || '—'}</span>
              </td>
              <td className="wia-td" style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', maxWidth: 140 }}>
                <span className="block truncate" title={row.included_columns}>{row.included_columns || '—'}</span>
              </td>
              <td className="wia-td tabular-nums text-right">
                <span style={{
                  fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                  background: row.impact_pct >= 70 ? 'rgba(239,68,68,.13)' : row.impact_pct >= 40 ? 'rgba(249,115,22,.13)' : 'rgba(245,158,11,.1)',
                  color:      row.impact_pct >= 70 ? '#ef4444'             : row.impact_pct >= 40 ? '#f97316'             : '#f59e0b',
                }}>
                  {row.impact_pct}%
                </span>
              </td>
              <td className="wia-td tabular-nums text-right" style={{ color: 'var(--text-secondary)' }}>{fmt(row.user_seeks)}</td>
              <td className="wia-td tabular-nums text-right" style={{ color: 'var(--text-secondary)' }}>{fmt(row.user_scans)}</td>
              <td className="wia-td">
                <button
                  onClick={() => copyScript(row)}
                  style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                    border: '1px solid var(--divider)', background: 'var(--input-bg)',
                    color: 'var(--sort-active)', cursor: 'pointer' }}
                >
                  Copy SQL
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={8} style={{ textAlign: 'center', padding: '20px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No missing index recommendations (impact ≥ 10%) since last restart
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ── Index Fragmentation tab ───────────────────────────────────────────────────
function FragmentationTab({ rows, cached, ts }) {
  const ACTION_STYLE = {
    REBUILD:    { color: '#ef4444', bg: 'rgba(239,68,68,.13)' },
    REORGANIZE: { color: '#f97316', bg: 'rgba(249,115,22,.13)' },
    OK:         { color: '#22c55e', bg: 'rgba(34,197,94,.10)' },
  }
  return (
    <div>
      {cached && ts && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '6px 14px', borderBottom: '1px solid var(--divider)' }}>
          Cached result — refreshes every 5 min. Last: {new Date(ts).toLocaleTimeString()}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th className="wia-th">Table</th>
              <th className="wia-th">Index</th>
              <th className="wia-th">Type</th>
              <th className="wia-th" style={{ textAlign: 'right' }}>Fragmentation %</th>
              <th className="wia-th" style={{ textAlign: 'right' }}>Pages</th>
              <th className="wia-th">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const s = ACTION_STYLE[row.recommended_action] || ACTION_STYLE.OK
              return (
                <tr key={i} className="wia-row">
                  <td className="wia-td" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{row.table_name}</td>
                  <td className="wia-td" style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)', maxWidth: 200 }}>
                    <span className="block truncate" title={row.index_name}>{row.index_name}</span>
                  </td>
                  <td className="wia-td" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{row.index_type_desc}</td>
                  <td className="wia-td text-right">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                      <div style={{ width: 60, height: 5, borderRadius: 3, background: 'var(--divider)', overflow: 'hidden' }}>
                        <div style={{ width: `${Math.min(row.fragmentation_pct, 100)}%`, height: '100%', borderRadius: 3,
                          background: row.fragmentation_pct >= 40 ? '#ef4444' : row.fragmentation_pct >= 10 ? '#f97316' : '#22c55e' }} />
                      </div>
                      <span style={{ fontWeight: 600, color: row.fragmentation_pct >= 40 ? '#ef4444' : row.fragmentation_pct >= 10 ? '#f97316' : 'var(--text-secondary)' }}>
                        {row.fragmentation_pct}%
                      </span>
                    </div>
                  </td>
                  <td className="wia-td tabular-nums text-right" style={{ color: 'var(--text-muted)' }}>{fmt(row.page_count)}</td>
                  <td className="wia-td">
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: s.bg, color: s.color }}>
                      {row.recommended_action}
                    </span>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '20px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No indexes with fragmentation {'>'} 10% and page count {'>'} 100
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function QueryProfiler({ connId }) {
  const [collapsed,     setCollapsed]     = useState(() => {
    try { return localStorage.getItem(`profiler-${connId}-collapsed`) === '1' } catch { return false }
  })
  const [activeTab,     setActiveTab]     = useState('top-queries')
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [topQueries,    setTopQueries]    = useState([])
  const [missingIdx,    setMissingIdx]    = useState([])
  const [fragData,      setFragData]      = useState({ rows: [], cached: false, ts: null })
  const [sortCol,       setSortCol]       = useState('avg_cpu_ms')
  const [sortDir,       setSortDir]       = useState('desc')
  const [lastTs,        setLastTs]        = useState(null)

  function toggleCollapsed() {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem(`profiler-${connId}-collapsed`, next ? '1' : '0') } catch {}
      return next
    })
  }

  const fetchTab = useCallback(async (tab) => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'top-queries') {
        const r = await fetch(`/api/connections/${connId}/profiler/top-queries`)
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        setTopQueries(d.rows || [])
        setLastTs(d.ts)
      } else if (tab === 'missing-idx') {
        const r = await fetch(`/api/connections/${connId}/profiler/missing-indexes`)
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        setMissingIdx(d.rows || [])
        setLastTs(d.ts)
      } else if (tab === 'fragmentation') {
        const r = await fetch(`/api/connections/${connId}/profiler/index-fragmentation`)
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        setFragData({ rows: d.rows || [], cached: d.cached, ts: d.ts })
        setLastTs(d.ts)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [connId])

  function switchTab(tab) {
    setActiveTab(tab)
    fetchTab(tab)
  }

  const tsStr = lastTs ? new Date(lastTs).toLocaleTimeString() : null

  return (
    <div className="mc overflow-hidden">

      {/* ── Header (section-toggle styling, chevron on right) ── */}
      <div className="section-toggle flex items-center justify-between px-5 py-3 gap-3">

        {/* Left: title — click to collapse */}
        <button
          className="flex items-center gap-2 text-left"
          onClick={toggleCollapsed}
        >
          <Zap size={13} style={{ color: 'var(--sort-active)', flexShrink: 0 }} />
          <span className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            Query Profiler
          </span>
          {topQueries.some(q => (q.plan_issues || []).some(i => i.severity === 'critical')) && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
              background: 'rgba(239,68,68,.15)', color: '#ef4444' }}>
              critical
            </span>
          )}
          {topQueries.some(q => (q.plan_issues || []).some(i => i.severity === 'warning')) && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
              background: 'rgba(249,115,22,.13)', color: '#f97316' }}>
              warnings
            </span>
          )}
        </button>

        {/* Right: controls + chevron */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {tsStr && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{tsStr}</span>
          )}
          <button
            onClick={() => { if (collapsed) setCollapsed(false); fetchTab(activeTab) }}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium"
            style={{ background: 'var(--divider)', color: 'var(--text-secondary)' }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading…' : 'Analyse'}
          </button>
          {/* Chevron — rightmost, matches CollapsibleSection convention */}
          <button onClick={toggleCollapsed} style={{ lineHeight: 0, color: 'var(--text-muted)' }}>
            <ChevronDown
              size={14}
              className={`chevron ${collapsed ? '' : 'open'}`}
            />
          </button>
        </div>
      </div>

      {/* ── Animated body (same CSS as CollapsibleSection) ── */}
      <div className={`section-body ${collapsed ? 'collapsed' : ''}`}>
        <div className="section-body-inner">

          {/* Tabs bar */}
          <div className="flex items-center gap-0.5 px-4 pt-2" style={{ borderBottom: '1px solid var(--divider)' }}>
            {TABS.map(tab => {
              const Icon = tab.icon
              const active = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => switchTab(tab.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors"
                  style={{
                    background:   active ? 'var(--card-bg)'     : 'transparent',
                    color:        active ? 'var(--sort-active)' : 'var(--text-muted)',
                    borderBottom: active ? '2px solid var(--sort-active)' : '2px solid transparent',
                    marginBottom: -1,
                  }}
                >
                  <Icon size={11} />
                  {tab.label}
                  {tab.id === 'top-queries' && topQueries.length > 0 && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '0 4px', borderRadius: 8,
                      background: 'var(--badge-bg)', color: 'var(--badge-text)' }}>
                      {topQueries.length}
                    </span>
                  )}
                  {tab.id === 'missing-idx' && missingIdx.length > 0 && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '0 4px', borderRadius: 8,
                      background: 'rgba(245,158,11,.15)', color: '#f59e0b' }}>
                      {missingIdx.length}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Error */}
          {error && (
            <div className="mx-5 mt-3 flex items-center gap-2 px-3 py-2 rounded-md text-xs border"
              style={{ background: '#fef2f2', color: '#dc2626', borderColor: '#fecaca' }}>
              <AlertTriangle size={12} />
              {error}
            </div>
          )}

          {/* Tab content */}
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {!loading && !error && activeTab === 'top-queries' && topQueries.length === 0 && (
              <div className="py-10 text-center text-xs italic" style={{ color: 'var(--text-muted)' }}>
                Click Analyse to profile the plan cache
              </div>
            )}
            {activeTab === 'top-queries' && topQueries.length > 0 && (
              <TopQueriesTab rows={topQueries} connId={connId} sortCol={sortCol} setSortCol={setSortCol} sortDir={sortDir} setSortDir={setSortDir} />
            )}
            {activeTab === 'missing-idx' && !loading && !error && (
              <MissingIndexesTab rows={missingIdx} />
            )}
            {activeTab === 'fragmentation' && !loading && !error && (
              <FragmentationTab rows={fragData.rows} cached={fragData.cached} ts={fragData.ts} />
            )}
            {loading && (
              <div className="py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                {activeTab === 'fragmentation' ? 'Scanning index physical stats…' : 'Querying plan cache…'}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
