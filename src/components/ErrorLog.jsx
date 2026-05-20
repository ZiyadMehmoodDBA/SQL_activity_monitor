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
