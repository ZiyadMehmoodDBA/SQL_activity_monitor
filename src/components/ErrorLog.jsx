import React, { useState, useCallback } from 'react'
import { RefreshCw, ChevronDown, AlertTriangle, X, ChevronRight } from 'lucide-react'

const MSG_PREVIEW_LEN = 120

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
      background: bg, color, border: `1px solid ${ring}`, whiteSpace: 'nowrap',
    }}>
      {severity}
    </span>
  )
}

function DetailModal({ row, onClose }) {
  if (!row) return null
  const msg = row.message || 'No message available'
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col rounded-2xl w-full max-w-2xl"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--input-border)',
          boxShadow: '0 24px 64px rgba(0,0,0,.35)',
          maxHeight: '80vh',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid var(--divider)' }}>
          <div className="flex items-center gap-3">
            <SeverityBadge severity={row.severity} />
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              Error {row.error_number}
            </span>
            <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {fmtTime(row.event_time)}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={15} />
          </button>
        </div>

        {/* Meta row */}
        <div className="flex gap-6 px-6 py-3" style={{ borderBottom: '1px solid var(--divider)' }}>
          {[
            ['Error #',   row.error_number],
            ['Severity',  row.severity],
            ['State',     row.state],
          ].map(([label, val]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{label}</span>
              <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{val ?? '—'}</span>
            </div>
          ))}
        </div>

        {/* Message body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
            Message
          </p>
          <p className="text-sm" style={{ color: 'var(--text-primary)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {msg}
          </p>
        </div>
      </div>
    </div>
  )
}

export default function ErrorLog({ connId }) {
  const [collapsed,  setCollapsed]  = useState(true)
  const [rows,       setRows]       = useState([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [lastTs,     setLastTs]     = useState(null)
  const [expanded,   setExpanded]   = useState(new Set())
  const [detailRow,  setDetailRow]  = useState(null)

  const doFetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/connections/${connId}/error-log`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setRows(d.rows || [])
      setLastTs(d.ts)
      setExpanded(new Set())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [connId])

  function toggleRow(key) {
    setExpanded(s => {
      const n = new Set(s)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })
  }

  const tsStr = lastTs ? new Date(lastTs).toLocaleTimeString() : null

  return (
    <>
      {detailRow && <DetailModal row={detailRow} onClose={() => setDetailRow(null)} />}

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
              style={{ background: 'var(--divider)', color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
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

            <div style={{ maxHeight: 460, overflowY: 'auto' }}>

              {/* Idle */}
              {!loading && !error && lastTs === null && (
                <div className="flex flex-col items-center justify-center py-12 gap-2">
                  <AlertTriangle size={20} style={{ color: 'var(--text-muted)', opacity: .4 }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>No scan yet</span>
                  <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 240, lineHeight: 1.5 }}>
                    Click Analyse to scan for SQL Server errors (severity ≥ 17, last 24 h)
                  </span>
                </div>
              )}

              {/* Empty */}
              {!loading && !error && lastTs !== null && rows.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 gap-2">
                  <span className="text-sm font-medium" style={{ color: '#22c55e' }}>No errors found</span>
                  <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 280, lineHeight: 1.5 }}>
                    Ring buffer is clear — if you suspect errors, the buffer may have been overwritten
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

              {/* Table */}
              {rows.length > 0 && (
                <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th className="wia-th" style={{ width: 24 }} />
                      <th className="wia-th" style={{ whiteSpace: 'nowrap' }}>Time</th>
                      <th className="wia-th" style={{ whiteSpace: 'nowrap' }}>Error #</th>
                      <th className="wia-th">Sev</th>
                      <th className="wia-th">State</th>
                      <th className="wia-th" style={{ width: '100%' }}>Message</th>
                      <th className="wia-th" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const key     = `${r.event_time}-${r.error_number}`
                      const isOpen  = expanded.has(key)
                      const msg     = r.message || ''
                      const isEmpty = !msg.trim()
                      const isLong  = msg.length > MSG_PREVIEW_LEN
                      const preview = isLong && !isOpen ? msg.slice(0, MSG_PREVIEW_LEN).trimEnd() + '…' : msg

                      return (
                        <React.Fragment key={key}>
                          <tr
                            className="wia-row"
                            style={{ cursor: isLong ? 'pointer' : 'default' }}
                            onClick={() => isLong && toggleRow(key)}
                          >
                            {/* Expand chevron */}
                            <td className="wia-td" style={{ paddingRight: 0, width: 24 }}>
                              {isLong && (
                                <ChevronRight
                                  size={12}
                                  style={{
                                    color: 'var(--text-muted)',
                                    transition: 'transform .15s',
                                    transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                                  }}
                                />
                              )}
                            </td>
                            <td className="wia-td tabular-nums" style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 11 }}>
                              {fmtTime(r.event_time)}
                            </td>
                            <td className="wia-td tabular-nums" style={{ color: 'var(--text-secondary)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                              {r.error_number}
                            </td>
                            <td className="wia-td">
                              <SeverityBadge severity={r.severity} />
                            </td>
                            <td className="wia-td tabular-nums" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                              {r.state ?? '—'}
                            </td>
                            <td
                              className="wia-td"
                              title={isLong && !isOpen ? msg : undefined}
                              style={{ color: isEmpty ? 'var(--text-muted)' : 'var(--text-primary)', lineHeight: 1.5, maxWidth: 0, width: '100%' }}
                            >
                              {isEmpty
                                ? <span style={{ fontStyle: 'italic', opacity: .6 }}>No message available</span>
                                : <span style={{ display: 'block', overflow: isOpen ? 'visible' : 'hidden', whiteSpace: isOpen ? 'pre-wrap' : 'nowrap', textOverflow: isOpen ? 'clip' : 'ellipsis', wordBreak: isOpen ? 'break-word' : 'normal' }}>
                                    {preview}
                                  </span>
                              }
                            </td>
                            {/* View details */}
                            <td className="wia-td" style={{ whiteSpace: 'nowrap' }}>
                              <button
                                onClick={e => { e.stopPropagation(); setDetailRow(r) }}
                                className="px-2 py-1 rounded-md text-xs font-medium transition-colors"
                                style={{ color: 'var(--sort-active)', background: 'transparent' }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                              >
                                Details
                              </button>
                            </td>
                          </tr>
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
