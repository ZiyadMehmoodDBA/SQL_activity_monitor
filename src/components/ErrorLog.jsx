import React, { useState, useCallback } from 'react'
import { RefreshCw, AlertTriangle, X, ChevronDown } from 'lucide-react'

const MSG_PREVIEW_LEN = 160

function fmtTime(iso) {
  if (!iso) return { date: '—', time: '—' }
  const d = new Date(iso)
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }
}

function severityMeta(severity) {
  if (severity >= 20) return { label: 'Fatal',    color: '#ef4444', bg: 'rgba(239,68,68,.08)',  ring: 'rgba(239,68,68,.2)',  strip: '#ef4444' }
  if (severity >= 17) return { label: 'Error',    color: '#f97316', bg: 'rgba(249,115,22,.08)', ring: 'rgba(249,115,22,.2)', strip: '#f97316' }
  return                     { label: 'Warning',  color: '#f59e0b', bg: 'rgba(245,158,11,.08)', ring: 'rgba(245,158,11,.2)', strip: '#f59e0b' }
}

/* ── Detail modal ─────────────────────────────────────────────────────────── */
function DetailModal({ row, onClose }) {
  if (!row) return null
  const { date, time } = fmtTime(row.event_time)
  const meta  = severityMeta(row.severity)
  const msg   = row.message || 'No message available.'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8"
      style={{ background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col w-full max-w-xl rounded-2xl overflow-hidden"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--input-border)',
          boxShadow: '0 32px 80px rgba(0,0,0,.4)',
          maxHeight: '85vh',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Severity strip */}
        <div style={{ height: 3, background: meta.strip, flexShrink: 0 }} />

        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: '1px solid var(--divider)' }}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span style={{
                fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 99,
                background: meta.bg, color: meta.color, border: `1px solid ${meta.ring}`,
                textTransform: 'uppercase', letterSpacing: '.06em',
              }}>
                {meta.label}
              </span>
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                Severity {row.severity}
              </span>
            </div>
            <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
              Error {row.error_number}
            </h2>
            <p className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {date} · {time}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg mt-0.5 transition-colors flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={15} />
          </button>
        </div>

        {/* Meta strip */}
        <div className="flex gap-8 px-6 py-3" style={{ borderBottom: '1px solid var(--divider)', background: 'var(--section-hover)' }}>
          {[['Error #', row.error_number], ['Severity', row.severity], ['State', row.state ?? '—']].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-muted)' }}>{k}</span>
              <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Message */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-muted)', marginBottom: 12 }}>
            Message
          </p>
          <p className="text-sm" style={{ color: 'var(--text-primary)', lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {msg}
          </p>
        </div>
      </div>
    </div>
  )
}

/* ── Error item card ──────────────────────────────────────────────────────── */
function ErrorItem({ row, onDetail }) {
  const [open, setOpen] = useState(false)
  const { date, time }  = fmtTime(row.event_time)
  const meta   = severityMeta(row.severity)
  const msg    = row.message || ''
  const isEmpty = !msg.trim()
  const isLong  = msg.length > MSG_PREVIEW_LEN
  const preview = isLong && !open ? msg.slice(0, MSG_PREVIEW_LEN).trimEnd() + '…' : msg

  return (
    <div
      style={{
        borderLeft: `3px solid ${meta.strip}`,
        borderBottom: '1px solid var(--divider)',
        transition: 'background .12s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div className="flex gap-4 px-5 py-4 items-start">

        {/* Timestamp column */}
        <div className="flex-shrink-0 flex flex-col gap-0.5 pt-0.5" style={{ width: 72 }}>
          <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--text-secondary)' }}>{time}</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', tabularNums: true }}>{date}</span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col gap-2">

          {/* Badge row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '1px 7px', borderRadius: 99,
              background: meta.bg, color: meta.color, border: `1px solid ${meta.ring}`,
              textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap',
            }}>
              {meta.label}
            </span>
            <span className="text-xs font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
              Err {row.error_number}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Sev {row.severity} · State {row.state ?? '—'}
            </span>
          </div>

          {/* Message */}
          <p
            className="text-sm"
            style={{
              color: isEmpty ? 'var(--text-muted)' : 'var(--text-primary)',
              lineHeight: 1.6,
              whiteSpace: open ? 'pre-wrap' : 'normal',
              wordBreak: open ? 'break-word' : 'normal',
              fontStyle: isEmpty ? 'italic' : 'normal',
              opacity: isEmpty ? .6 : 1,
            }}
            title={isLong && !open ? msg : undefined}
          >
            {isEmpty ? 'No message available' : preview}
          </p>

          {/* Expand toggle */}
          {isLong && (
            <button
              onClick={() => setOpen(o => !o)}
              className="flex items-center gap-1 text-xs font-medium w-fit transition-opacity"
              style={{ color: 'var(--sort-active)', opacity: .8 }}
              onMouseEnter={e => e.currentTarget.style.opacity = 1}
              onMouseLeave={e => e.currentTarget.style.opacity = .8}
            >
              <ChevronDown
                size={12}
                style={{ transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
              />
              {open ? 'Collapse' : 'Show full message'}
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex-shrink-0 pt-0.5">
          <button
            onClick={() => onDetail(row)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={{
              background: 'var(--divider)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--input-border)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = meta.bg; e.currentTarget.style.color = meta.color; e.currentTarget.style.borderColor = meta.ring }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--divider)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.borderColor = 'var(--input-border)' }}
          >
            Details
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Main component ───────────────────────────────────────────────────────── */
export default function ErrorLog({ connId }) {
  const [collapsed, setCollapsed] = useState(true)
  const [rows,      setRows]      = useState([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [lastTs,    setLastTs]    = useState(null)
  const [detailRow, setDetailRow] = useState(null)

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
  const fatalCount = rows.filter(r => r.severity >= 20).length
  const errorCount = rows.filter(r => r.severity >= 17 && r.severity < 20).length

  return (
    <>
      {detailRow && <DetailModal row={detailRow} onClose={() => setDetailRow(null)} />}

      <div className="mc overflow-hidden">

        {/* ── Section header ── */}
        <div className="section-toggle flex items-center justify-between px-5 py-3 gap-4 flex-wrap">
          <button
            className="flex items-center gap-3 text-left min-w-0"
            onClick={() => setCollapsed(c => !c)}
          >
            <AlertTriangle size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-bold leading-none" style={{ color: 'var(--text-primary)', letterSpacing: '-.01em' }}>
                SQL Error Log
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                Severity ≥ 17 · Ring buffer · Last 24 h
              </span>
            </div>
            {/* Summary badges */}
            {rows.length > 0 && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {fatalCount > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(239,68,68,.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,.2)' }}>
                    {fatalCount} fatal
                  </span>
                )}
                {errorCount > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: 'rgba(249,115,22,.12)', color: '#f97316', border: '1px solid rgba(249,115,22,.2)' }}>
                    {errorCount} error{errorCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            )}
          </button>

          <div className="flex items-center gap-3 flex-shrink-0">
            {tsStr && (
              <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                Last scan {tsStr}
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

        {/* ── Body ── */}
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

            {/* Idle */}
            {!loading && !error && lastTs === null && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: 'var(--section-hover)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <AlertTriangle size={20} style={{ color: 'var(--text-muted)', opacity: .5 }} />
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>No scan yet</span>
                  <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 220, lineHeight: 1.6 }}>
                    Click Analyse to scan the ring buffer for SQL Server exceptions
                  </span>
                </div>
              </div>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center gap-2.5 py-12">
                <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Scanning ring buffer…</span>
              </div>
            )}

            {/* Empty */}
            {!loading && !error && lastTs !== null && rows.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span style={{ fontSize: 20 }}>✓</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm font-semibold" style={{ color: '#22c55e' }}>Ring buffer is clean</span>
                  <span className="text-xs text-center" style={{ color: 'var(--text-muted)', maxWidth: 260, lineHeight: 1.6 }}>
                    No exceptions with severity ≥ 17 in the last 24 hours. Buffer may be overwritten on busy servers.
                  </span>
                </div>
              </div>
            )}

            {/* Error list */}
            {rows.length > 0 && (
              <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                {rows.map(r => (
                  <ErrorItem
                    key={`${r.event_time}-${r.error_number}`}
                    row={r}
                    onDetail={setDetailRow}
                  />
                ))}
              </div>
            )}

          </div>
        </div>
      </div>
    </>
  )
}
