import React, { useState, useMemo, useCallback } from 'react'
import { RefreshCw, AlertTriangle, ChevronDown, Copy } from 'lucide-react'

const COLS = [
  { key: 'database_name',         label: 'Database'         },
  { key: 'table_name',            label: 'Table'            },
  { key: 'equality_columns',      label: 'Equality Cols'    },
  { key: 'inequality_columns',    label: 'Inequality Cols'  },
  { key: 'included_columns',      label: 'Included Cols'    },
  { key: 'user_seeks',            label: 'Seeks'            },
  { key: 'estimated_improvement', label: 'Est. Improvement' },
]

export default function MissingIndexes({ connId, topN, dbFilter }) {
  const [collapsed, setCollapsed]   = useState(false)
  const [status,    setStatus]      = useState('idle')
  const [rows,      setRows]        = useState([])
  const [error,     setError]       = useState(null)
  const [meta,      setMeta]        = useState(null)

  const load = useCallback(async (force = false) => {
    setStatus('loading')
    setError(null)
    try {
      const url = `/api/connections/${connId}/missing-indexes${force ? '?force=1' : ''}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setRows(data.rows || [])
      setMeta({ ts: data.ts, cached: data.cached, count: data.count, ttlMinutes: data.ttlMinutes })
      setStatus('results')
    } catch (e) {
      setError(e.message)
      setStatus('error')
    }
  }, [connId])

  const displayRows = useMemo(() => {
    let r = rows
    if (dbFilter) r = r.filter(row => row.database_name === dbFilter)
    return r.slice(0, topN)
  }, [rows, topN, dbFilter])

  const tsStr = meta ? new Date(meta.ts).toLocaleTimeString() : null

  return (
    <div className="mc overflow-hidden">

      {/* ── Section header ── */}
      <div className="section-toggle flex items-center justify-between px-5 py-3 gap-4 flex-wrap">
        <button
          className="flex items-center gap-3 text-left min-w-0"
          onClick={() => setCollapsed(c => !c)}
        >
          <ChevronDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-bold leading-none" style={{ color: 'var(--text-primary)', letterSpacing: '-.01em' }}>
              Missing Indexes
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              DMV analysis · On-demand
            </span>
          </div>
          {status === 'results' && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
              background: 'var(--section-hover)', color: 'var(--text-secondary)',
              border: '1px solid var(--input-border)',
            }}>
              {displayRows.length}
            </span>
          )}
        </button>

        <div className="flex items-center gap-3 flex-shrink-0">
          {status !== 'results' && (
            <button
              onClick={() => load()}
              disabled={status === 'loading'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{ background: 'var(--divider)', color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
            >
              <RefreshCw size={11} className={status === 'loading' ? 'animate-spin' : ''} />
              {status === 'loading' ? 'Analysing…' : 'Analyse'}
            </button>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="p-1 rounded-md transition-colors"
            style={{ lineHeight: 0, color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <ChevronDown size={14} className={`chevron ${collapsed ? '' : 'open'}`} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className={`section-body ${collapsed ? 'collapsed' : ''}`}>
        <div className="section-body-inner">

          {/* Idle */}
          {status === 'idle' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div style={{
                width: 44, height: 44, borderRadius: 12,
                background: 'var(--section-hover)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <AlertTriangle size={20} style={{ color: 'var(--text-muted)', opacity: .5 }} />
              </div>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                Run analysis to identify missing indexes.
              </span>
            </div>
          )}

          {/* Loading */}
          {status === 'loading' && (
            <div className="flex items-center justify-center gap-2.5 py-12">
              <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Running DMV query…</span>
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="mx-5 my-4 flex flex-col gap-3">
              <div className="flex items-start gap-3 px-4 py-3 rounded-xl text-xs"
                style={{ background: 'rgba(239,68,68,.06)', color: '#dc2626', border: '1px solid rgba(239,68,68,.2)' }}>
                <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                <span style={{ lineHeight: 1.5 }}>{error}</span>
              </div>
              <div className="flex justify-center">
                <button
                  onClick={() => load()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
                  style={{ background: 'var(--divider)', color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
                >
                  <RefreshCw size={11} />
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Results */}
          {status === 'results' && (
            <>
              {/* Cache badge line */}
              <div className="flex items-center justify-between px-5 py-2 gap-3 flex-wrap"
                style={{ borderBottom: '1px solid var(--divider)', background: 'var(--section-hover)' }}>
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {meta?.cached && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                      background: 'rgba(245,158,11,.1)', color: '#b45309',
                      border: '1px solid rgba(245,158,11,.25)',
                    }}>
                      Cached
                    </span>
                  )}
                  {tsStr && (
                    <span className="tabular-nums">Updated {tsStr}</span>
                  )}
                  {meta?.ttlMinutes && (
                    <span>· TTL {meta.ttlMinutes}min</span>
                  )}
                </div>
                <button
                  onClick={() => load(true)}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-colors"
                  style={{ background: 'var(--divider)', color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
                >
                  <RefreshCw size={10} />
                  Force Refresh
                </button>
              </div>

              {/* Empty results */}
              {displayRows.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <span className="text-sm font-semibold" style={{ color: '#22c55e' }}>No missing indexes found</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>SQL Server has no missing index suggestions for this database.</span>
                </div>
              )}

              {/* Table */}
              {displayRows.length > 0 && (
                <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--divider)' }}>
                        {COLS.map(c => (
                          <th key={c.key}
                            className="px-3 py-2 text-left font-semibold"
                            style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap', background: 'var(--section-hover)' }}>
                            {c.label}
                          </th>
                        ))}
                        <th style={{ background: 'var(--section-hover)' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {displayRows.map((row, i) => (
                        <tr
                          key={i}
                          style={{ borderBottom: '1px solid var(--divider)', transition: 'background .1s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          {COLS.map(c => (
                            <td key={c.key} className="px-3 py-2" style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {row[c.key] == null ? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span> : String(row[c.key])}
                            </td>
                          ))}
                          <td className="px-3 py-2">
                            <button
                              onClick={() => navigator.clipboard.writeText(row.create_index_sql)}
                              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-colors"
                              style={{ background: 'var(--divider)', color: 'var(--text-secondary)', border: '1px solid var(--input-border)', whiteSpace: 'nowrap' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
                              title={row.create_index_sql}
                            >
                              <Copy size={10} />
                              Copy INDEX
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  )
}
