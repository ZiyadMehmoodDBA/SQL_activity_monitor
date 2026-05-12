import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { RefreshCw, ChevronDown, AlertCircle } from 'lucide-react'

// Extract plain text from sp_WhoIsActive XML-wrapped columns
function extractXmlText(xml) {
  if (!xml) return ''
  const s = String(xml)
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  if (m) return m[1].trim()
  return s.replace(/<[^>]+>/g, '').trim()
}

// Parse "dd hh:mm:ss.mss" → total milliseconds for threshold checks
function parseDurationMs(dur) {
  if (!dur) return 0
  const m = String(dur).match(/(\d+)\s+(\d+):(\d+):(\d+)/)
  if (!m) return 0
  const [, dd, hh, mm, ss] = m.map(Number)
  return (dd * 86400 + hh * 3600 + mm * 60 + ss) * 1000
}

// sp_WhoIsActive column name map (after format_output=1, actual property keys from mssql)
const C = {
  duration:  'dd hh:mm:ss.mss',
  spid:      'session_id',
  blocking:  'blocking_session_id',
  status:    'status',
  login:     'login_name',
  host:      'host_name',
  db:        'database_name',
  cpu:       'cpu',
  reads:     'reads',
  writes:    'writes',
  wait:      'wait_info',
  sql:       'sql_text',
  plan:      'query_plan',
  cmd:       'sql_command',
  startTime: 'start_time',
  tasks:     'tasks',
}

const INTERVALS = [
  { label: 'Off', value: 0 },
  { label: '5s',  value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
  { label: '60s', value: 60000 },
]

const SKIP_KEYS = new Set(['sql_text', 'query_plan', 'sql_command'])

export default function WhoIsActive({ connId }) {
  const [collapsed, setCollapsed] = useState(true)
  const [rows,         setRows]         = useState([])
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState(null)
  const [lastTs,       setLastTs]       = useState(null)
  const [autoInterval, setAutoInterval] = useState(0)
  const [expanded,     setExpanded]     = useState(new Set())
  const [search,       setSearch]       = useState('')
  const [killTarget,   setKillTarget]   = useState(null)   // { spid, login, host }
  const [killing,      setKilling]      = useState(false)
  const [killError,    setKillError]    = useState(null)
  const [killConfirmed,setKillConfirmed]= useState(false)
  const intervalRef = useRef(null)

  const doFetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/connections/${connId}/whoIsActive`)
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

  const doKill = useCallback(async () => {
    if (!killTarget) return
    setKilling(true)
    setKillError(null)
    try {
      const r = await fetch(`/api/connections/${connId}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: killTarget.spid }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setKillTarget(null)
      setKillConfirmed(false)
      // Refresh immediately so the killed session disappears
      await doFetch()
    } catch (e) {
      setKillError(e.message)
    } finally {
      setKilling(false)
    }
  }, [connId, killTarget, doFetch])

  useEffect(() => {
    clearInterval(intervalRef.current)
    if (autoInterval > 0) {
      intervalRef.current = setInterval(doFetch, autoInterval)
    }
    return () => clearInterval(intervalRef.current)
  }, [autoInterval, doFetch])

  function toggleCollapsed() {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem(`wia-${connId}-collapsed`, next ? '1' : '0') } catch {}
      return next
    })
  }

  function toggleExpanded(spid) {
    setExpanded(s => {
      const n = new Set(s)
      n.has(spid) ? n.delete(spid) : n.add(spid)
      return n
    })
  }

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      String(r[C.login]   || '').toLowerCase().includes(q) ||
      String(r[C.host]    || '').toLowerCase().includes(q) ||
      String(r[C.db]      || '').toLowerCase().includes(q) ||
      String(r[C.wait]    || '').toLowerCase().includes(q) ||
      String(r[C.spid]    || '').includes(q)
    )
  }, [rows, search])

  function rowHighlight(row) {
    const blocking = row[C.blocking]
    if (blocking && String(blocking).trim() !== '0' && String(blocking).trim() !== '') {
      return 'wia-row-blocked'
    }
    if (parseDurationMs(row[C.duration]) > 60000) return 'wia-row-long'
    return ''
  }

  const tsStr = lastTs ? new Date(lastTs).toLocaleTimeString() : null

  return (
    <div className="mc overflow-hidden">
      {/* ── Kill confirm dialog ── */}
      {killTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--input-border)',
            borderRadius: 12, padding: '24px 28px', maxWidth: 400, width: '100%',
            boxShadow: '0 24px 64px rgba(0,0,0,.4)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
              Kill session {killTarget.spid}?
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.5 }}>
              This will immediately terminate SPID <strong>{killTarget.spid}</strong>
              {killTarget.login ? ` (${killTarget.login}` : ''}
              {killTarget.host  ? ` @ ${killTarget.host})` : (killTarget.login ? ')' : '')}.
              Any open transaction will be rolled back.
            </div>
            {killError && (
              <div style={{ fontSize: 12, color: '#dc2626', background: 'rgba(239,68,68,.12)',
                border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '8px 12px', marginBottom: 14 }}>
                {killError}
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 18, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={killConfirmed}
                onChange={e => setKillConfirmed(e.target.checked)}
                style={{ marginTop: 2, accentColor: '#dc2626', flexShrink: 0 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                I understand this terminates a session on a <strong>production</strong> server and cannot be undone.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setKillTarget(null); setKillError(null); setKillConfirmed(false) }}
                disabled={killing}
                style={{ padding: '7px 16px', borderRadius: 7, border: '1px solid var(--input-border)',
                  background: 'var(--input-bg)', color: 'var(--text-secondary)', fontSize: 13,
                  fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={doKill}
                disabled={killing || !killConfirmed}
                style={{ padding: '7px 16px', borderRadius: 7, border: 'none',
                  background: killing || !killConfirmed ? '#9ca3af' : '#dc2626', color: '#fff', fontSize: 13,
                  fontWeight: 700, cursor: (killing || !killConfirmed) ? 'not-allowed' : 'pointer' }}>
                {killing ? 'Killing…' : 'Kill Session'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 gap-3 flex-wrap">
        <button
          className="flex items-center gap-2 text-left"
          onClick={toggleCollapsed}
        >
          <ChevronDown
            size={14}
            className={`flex-shrink-0 transition-transform`}
            style={{
              color: 'var(--text-muted)',
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            }}
          />
          <span className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            sp_WhoIsActive
          </span>
          {rows.length > 0 && (
            <span
              className="px-1.5 py-0.5 rounded-full text-xs font-bold"
              style={{ background: 'var(--badge-bg)', color: 'var(--badge-text)' }}
            >
              {rows.length}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2 flex-wrap">
          {tsStr && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {tsStr}
            </span>
          )}

          {/* Auto-refresh interval selector */}
          <div
            className="flex items-center rounded-md p-0.5 gap-0.5"
            style={{ background: 'var(--divider)' }}
          >
            {INTERVALS.map(iv => (
              <button
                key={iv.value}
                onClick={() => setAutoInterval(iv.value)}
                className="px-2 py-0.5 rounded text-xs font-medium transition-colors"
                style={
                  autoInterval === iv.value
                    ? { background: 'var(--tab-active-bg)', color: 'var(--text-primary)', boxShadow: '0 1px 3px rgba(0,0,0,.12)' }
                    : { color: 'var(--text-muted)' }
                }
              >
                {iv.label}
              </button>
            ))}
          </div>

          {/* Manual refresh */}
          <button
            onClick={doFetch}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
            style={{ background: 'var(--divider)', color: 'var(--text-secondary)' }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      {!collapsed && (
        <div>
          {/* Search */}
          <div className="px-5 pb-3">
            <input
              type="text"
              placeholder="Filter by login, host, database, wait type, SPID…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full text-xs px-3 py-1.5 rounded-md outline-none"
              style={{
                background: 'var(--input-bg)',
                border: '1.5px solid var(--input-border)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {/* Error */}
          {error && (
            <div
              className="mx-5 mb-3 flex items-start gap-2 px-3 py-2.5 rounded-md text-xs border"
              style={{ background: '#fef2f2', color: '#dc2626', borderColor: '#fecaca' }}
            >
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Empty state */}
          {!error && rows.length === 0 && !loading && (
            <div className="pb-6 text-center text-xs italic" style={{ color: 'var(--text-muted)' }}>
              {lastTs ? 'No active sessions returned' : 'Click Refresh to load sp_WhoIsActive data'}
            </div>
          )}

          {/* Table */}
          {filtered.length > 0 && (
            <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
              <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th className="wia-th" style={{ width: 28 }}></th>
                    <th className="wia-th" style={{ width: 44 }}></th>
                    <th className="wia-th" style={{ width: 52 }}>SPID</th>
                    <th className="wia-th" style={{ width: 110 }}>Duration</th>
                    <th className="wia-th" style={{ width: 80 }}>Status</th>
                    <th className="wia-th" style={{ width: 130 }}>Login</th>
                    <th className="wia-th" style={{ width: 130 }}>Host</th>
                    <th className="wia-th" style={{ width: 110 }}>Database</th>
                    <th className="wia-th" style={{ width: 80 }}>CPU</th>
                    <th className="wia-th" style={{ width: 80 }}>Reads</th>
                    <th className="wia-th" style={{ width: 80 }}>Writes</th>
                    <th className="wia-th" style={{ width: 60 }}>Blocking</th>
                    <th className="wia-th">Wait / Query</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row, i) => {
                    const spid      = row[C.spid]
                    const isOpen    = expanded.has(spid ?? i)
                    const highlight = rowHighlight(row)
                    const sqlText   = extractXmlText(row[C.sql])
                    const blocking  = row[C.blocking]
                    const hasBlock  = blocking && String(blocking).trim() !== '0' && String(blocking).trim() !== ''
                    const status    = String(row[C.status] || '').toLowerCase()
                    const statusCls = status === 'running'    ? 'status-running'
                                    : status === 'suspended'  ? 'status-suspended'
                                    : status === 'sleeping'   ? 'status-sleeping'
                                    : status === 'background' ? 'status-background'
                                    : 'status-other'

                    return (
                      <React.Fragment key={spid ?? i}>
                        <tr
                          className={`wia-row ${highlight}`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => toggleExpanded(spid ?? i)}
                        >
                          {/* expand chevron */}
                          <td className="wia-td text-center" style={{ color: 'var(--text-muted)' }}>
                            <ChevronDown
                              size={10}
                              style={{ display: 'inline', transition: 'transform .15s', transform: isOpen ? 'none' : 'rotate(-90deg)' }}
                            />
                          </td>
                          {/* kill button */}
                          <td className="wia-td text-center" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={e => { e.stopPropagation(); setKillTarget({ spid, login: row[C.login], host: row[C.host] }) }}
                              style={{
                                fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                                border: '1px solid rgba(220,38,38,.5)', background: 'rgba(220,38,38,.1)',
                                color: '#dc2626', cursor: 'pointer', letterSpacing: '.02em',
                              }}
                            >
                              Kill
                            </button>
                          </td>
                          <td className="wia-td" style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)' }}>
                            {spid ?? '—'}
                          </td>
                          <td className="wia-td" style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                            {row[C.duration] || '—'}
                          </td>
                          <td className="wia-td">
                            {row[C.status]
                              ? <span className={`px-1.5 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${statusCls}`}>{row[C.status]}</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>
                            }
                          </td>
                          <td className="wia-td" style={{ color: 'var(--text-primary)' }}>
                            <span className="block truncate" style={{ maxWidth: 130 }} title={row[C.login]}>{row[C.login] || '—'}</span>
                          </td>
                          <td className="wia-td" style={{ color: 'var(--text-secondary)' }}>
                            <span className="block truncate" style={{ maxWidth: 130 }} title={row[C.host]}>{row[C.host] || '—'}</span>
                          </td>
                          <td className="wia-td" style={{ color: 'var(--text-secondary)' }}>
                            <span className="block truncate" style={{ maxWidth: 110 }} title={row[C.db]}>{row[C.db] || '—'}</span>
                          </td>
                          <td className="wia-td tabular-nums" style={{ color: 'var(--text-primary)' }}>{row[C.cpu] || '—'}</td>
                          <td className="wia-td tabular-nums" style={{ color: 'var(--text-secondary)' }}>{row[C.reads] || '—'}</td>
                          <td className="wia-td tabular-nums" style={{ color: 'var(--text-secondary)' }}>{row[C.writes] || '—'}</td>
                          <td className="wia-td text-center">
                            {hasBlock
                              ? <span style={{ fontWeight: 700, color: '#dc2626' }}>{blocking}</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>
                            }
                          </td>
                          <td className="wia-td" style={{ maxWidth: 280 }}>
                            <span className="flex gap-2 items-baseline min-w-0">
                              {row[C.wait] && (
                                <span
                                  className="shrink-0 px-1.5 py-0.5 rounded text-xs font-semibold"
                                  style={{ background: 'var(--divider)', color: 'var(--text-secondary)', fontSize: 10 }}
                                >
                                  {row[C.wait]}
                                </span>
                              )}
                              {sqlText && (
                                <span
                                  className="block truncate"
                                  style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', maxWidth: 200 }}
                                >
                                  {sqlText.replace(/\s+/g, ' ')}
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>

                        {/* ── Expanded detail row ── */}
                        {isOpen && (
                          <tr className="wia-expand-row">
                            <td colSpan={13} className="wia-expand-td">
                              <div className="flex gap-5 flex-wrap">
                                {/* SQL text */}
                                {sqlText && (
                                  <div className="flex-1 min-w-0" style={{ minWidth: 320 }}>
                                    <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                                      SQL Text
                                    </div>
                                    <pre className="wia-code">{sqlText}</pre>
                                  </div>
                                )}
                                {/* Key/value details */}
                                <div className="shrink-0 grid grid-cols-2 gap-x-4 gap-y-1 text-xs content-start" style={{ minWidth: 240 }}>
                                  {Object.entries(row)
                                    .filter(([k, v]) =>
                                      !SKIP_KEYS.has(k) &&
                                      v !== null && v !== undefined &&
                                      String(v).trim() !== '' &&
                                      String(v).trim() !== '0'
                                    )
                                    .slice(0, 16)
                                    .map(([k, v]) => (
                                      <React.Fragment key={k}>
                                        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{k}</span>
                                        <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                                          {v instanceof Date ? v.toLocaleString() : String(v)}
                                        </span>
                                      </React.Fragment>
                                    ))
                                  }
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
