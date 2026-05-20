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
  const bg      = isFatal ? 'rgba(239,68,68,.1)'  : 'rgba(249,115,22,.1)'
  const ring    = isFatal ? 'rgba(239,68,68,.25)' : 'rgba(249,115,22,.25)'
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
      background: bg, color, border: `1px solid ${ring}`,
    }}>
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
          <AlertTriangle size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
          <span className="text-sm font-bold" style={{ color: 'var(--text-primary)', letterSpacing: '-.01em' }}>
            SQL Error Log
          </span>
          {rows.length > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
              background: 'rgba(239,68,68,.12)', color: '#ef4444',
              border: '1px solid rgba(239,68,68,.2)',
            }}>
              {rows.length}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2 flex-shrink-0">
          {tsStr && (
            <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {tsStr}
            </span>
          )}
          <button
            onClick={() => { if (collapsed) setCollapsed(false); doFetch() }}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={{
              background: 'var(--divider)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--input-border)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Scanning…' : 'Analyse'}
          </button>
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

      {/* Body */}
      <div className={`section-body ${collapsed ? 'collapsed' : ''}`}>
        <div className="section-body-inner">

          {/* Error banner */}
          {error && (
            <div className="mx-5 mt-4 flex items-start gap-3 px-4 py-3 rounded-xl text-xs"
              style={{ background: 'rgba(239,68,68,.06)', color: '#dc2626', border: '1px solid rgba(239,68,68,.2)' }}>
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span style={{ lineHeight: 1.5 }}>{error}</span>
            </div>
          )}

          <div style={{ maxHeight: 420, overflowY: 'auto' }}>

            {/* Idle — never fetched */}
            {!loading && !error && lastTs === null && (
              <div className="flex flex-col items-center justify-center py-12 gap-2">
                <AlertTriangle size={20} style={{ color: 'var(--text-muted)', opacity: .4 }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  No scan yet
                </span>
                <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 240, lineHeight: 1.5 }}>
                  Click Analyse to scan for SQL Server errors (severity ≥ 17, last 24 h)
                </span>
              </div>
            )}

            {/* Fetched — no results */}
            {!loading && !error && lastTs !== null && rows.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-2">
                <span className="text-sm font-medium" style={{ color: '#22c55e' }}>
                  No errors found
                </span>
                <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 280, lineHeight: 1.5 }}>
                  Ring buffer is clear — if you suspect errors, ring buffer may have been overwritten
                </span>
              </div>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center gap-2 py-12">
                <RefreshCw size={13} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Scanning ring buffer…</span>
              </div>
            )}

            {/* Results table */}
            {rows.length > 0 && (
              <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th className="wia-th" style={{ whiteSpace: 'nowrap' }}>Time</th>
                    <th className="wia-th">Error #</th>
                    <th className="wia-th">Sev</th>
                    <th className="wia-th">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.event_time}-${r.error_number}`} className="wia-row">
                      <td className="wia-td tabular-nums" style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 11 }}>
                        {fmtTime(r.event_time)}
                      </td>
                      <td className="wia-td tabular-nums" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {r.error_number}
                      </td>
                      <td className="wia-td">
                        <SeverityBadge severity={r.severity} />
                      </td>
                      <td className="wia-td" style={{ color: 'var(--text-primary)', maxWidth: 500, lineHeight: 1.4 }}>
                        {r.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
