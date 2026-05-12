import React, { useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useApp } from '../context/AppContext'
import { Maximize2, X } from 'lucide-react'

const COMPACT_H = 360

// ── Sub-components ────────────────────────────────────────────────────────────
function GroupRow({ group, isOpen, onToggle }) {
  const hasActive = group.statuses.has('running') || group.statuses.has('suspended')
  const dotColor  = group.isBlocked ? '#dc2626' : hasActive ? '#22c55e' : '#94a3b8'
  const countColor = group.count >= 10 ? '#dc2626' : group.count >= 5 ? '#ea580c' : 'var(--sort-active)'
  const cpuFmt = group.totalCpu >= 1000 ? Math.round(group.totalCpu / 1000) + 's' : group.totalCpu + 'ms'

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 cursor-pointer select-none transition-colors"
      style={{ borderBottom: '1px solid var(--divider)' }}
      onClick={onToggle}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate text-xs" style={{ color: 'var(--text-primary)' }} title={group.host}>{group.host}</div>
        <div className="truncate" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{group.login}</div>
      </div>
      {group.isBlocked && (
        <span style={{ fontSize: 9, fontWeight: 700, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>
          ⚠ BLOCKED
        </span>
      )}
      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: countColor, background: countColor + '18' }}>
        {group.count}
      </span>
      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{cpuFmt}</span>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>{isOpen ? '▴' : '▾'}</span>
    </div>
  )
}

function SessionRow({ session: s, onKill }) {
  const stLow   = String(s.status || '').toLowerCase()
  const stColor = stLow === 'running'   ? '#16a34a'
                : stLow === 'suspended' ? '#ea580c'
                : stLow === 'sleeping'  ? '#94a3b8'
                : '#475569'
  const q    = s.last_query ? s.last_query.substring(0, 120).trim().replace(/\s+/g, ' ') : ''
  const sCpu  = (s.cpu_time || 0) >= 1000 ? Math.round((s.cpu_time || 0) / 1000) + 's' : (s.cpu_time || 0) + 'ms'
  const sElap = s.elapsed_sec ? (s.elapsed_sec >= 60 ? Math.round(s.elapsed_sec / 60) + 'm' : s.elapsed_sec + 's') : '—'

  return (
    <div style={{ background: 'var(--card-bg)', borderLeft: `3px solid ${stColor}`, margin: '1px 0', padding: '5px 10px', fontSize: 10, borderBottom: '1px solid var(--divider)' }}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>SPID {s.session_id}</span>
        <span style={{ color: stColor, fontWeight: 600, textTransform: 'capitalize' }}>{s.status}</span>
        {s.blocking_session_id > 0 && (
          <span style={{ color: '#dc2626', fontSize: 10, fontWeight: 700 }} title={`Blocked by SPID ${s.blocking_session_id}`}>⊘ BLK</span>
        )}
        {s.wait_type && (
          <span style={{ fontSize: 9, color: 'var(--text-secondary)', background: 'var(--divider)', borderRadius: 3, padding: '1px 4px' }}>{s.wait_type}</span>
        )}
        <span className="ml-auto" style={{ color: 'var(--text-secondary)' }}>CPU {sCpu}</span>
        <span style={{ color: 'var(--text-muted)' }}>/ {sElap}</span>
        {stLow === 'sleeping' && (
          <button className="kill-btn" onClick={(e) => { e.stopPropagation(); onKill() }}>Kill</button>
        )}
      </div>
      {q && (
        <div
          style={{ color: 'var(--text-secondary)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 9 }}
          title={s.last_query || ''}
        >
          {q}
        </div>
      )}
    </div>
  )
}

// ── Inner panel (shared between compact + expanded) ───────────────────────────
function SessionsPanelInner({ processes, connId, expanded, onExpand, onClose, scrollRef }) {
  const { state, dispatch } = useApp()
  const conn = state.connections[connId]
  const expandedGroups = conn?.expandedSessionGroups || new Set()
  const [killTarget,   setKillTarget]   = useState(null)   // { sessionId, login, host }
  const [killing,      setKilling]      = useState(false)
  const [killError,    setKillError]    = useState(null)
  const [killConfirmed,setKillConfirmed]= useState(false)

  // Memoize group building — only reruns when processes array or expanded set changes,
  // not on every 2s metrics update that doesn't affect sessions.
  const { groups, flatRows } = useMemo(() => {
    const map = new Map()
    for (const row of (processes || [])) {
      const host  = row.host_name  || '(unknown)'
      const login = row.login_name || '(unknown)'
      const key   = `${login}||${host}`
      if (!map.has(key)) {
        map.set(key, { host, login, count: 0, totalCpu: 0, statuses: new Set(), isBlocked: false, sessions: [] })
      }
      const g = map.get(key)
      g.count++
      g.totalCpu += (row.cpu_time || 0)
      g.statuses.add(String(row.status).toLowerCase())
      if (row.blocking_session_id > 0) g.isBlocked = true
      g.sessions.push(row)
    }

    const groups = [...map.values()].sort((a, b) => b.totalCpu - a.totalCpu)

    const flatRows = []
    for (const g of groups) {
      const key = `${g.login}||${g.host}`
      flatRows.push({ type: 'group', group: g, key })
      if (expandedGroups.has(key)) {
        const sorted = [...g.sessions].sort((a, b) => (b.cpu_time || 0) - (a.cpu_time || 0))
        for (const s of sorted) {
          flatRows.push({ type: 'session', session: s, groupKey: key })
        }
      }
    }
    return { groups, flatRows }
  }, [processes, expandedGroups])

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => flatRows[i]?.type === 'session' ? 52 : 42,
    overscan: 8,
  })

  async function confirmKill() {
    if (!killTarget) return
    setKilling(true)
    setKillError(null)
    try {
      const r = await fetch(`/api/connections/${connId}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: killTarget.sessionId }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setKillTarget(null)
      setKillConfirmed(false)
    } catch (err) {
      setKillError(err.message)
    } finally {
      setKilling(false)
    }
  }

  const blocked  = groups.filter(g => g.isBlocked).length
  const active   = groups.filter(g => g.statuses.has('running') || g.statuses.has('suspended')).length

  return (
    <>
      {/* ── Kill confirm dialog ── */}
      {killTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 2000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--input-border)',
            borderRadius: 12, padding: '24px 28px', maxWidth: 400, width: '100%',
            boxShadow: '0 24px 64px rgba(0,0,0,.4)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
              Kill session {killTarget.sessionId}?
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.5 }}>
              This will immediately terminate SPID <strong>{killTarget.sessionId}</strong>
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
                onClick={confirmKill}
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
      <div className="flex items-center px-4 py-2.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--divider)' }}>
        <svg className="w-3.5 h-3.5 mr-2 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="text-[12px] font-semibold uppercase tracking-wide mr-2" style={{ color: 'var(--text-secondary)' }}>Connected Sessions</span>

        {/* Summary stats */}
        <div className="flex items-center gap-2 flex-1 text-xs">
          <span className="font-bold tabular-nums" style={{ color: 'var(--sort-active)', fontSize: 15 }}>
            {(processes || []).length}
          </span>
          {active > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(34,197,94,.12)', color: '#22c55e', fontSize: 10 }}>
              {active} active
            </span>
          )}
          {blocked > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded font-semibold" style={{ background: 'rgba(220,38,38,.12)', color: '#dc2626', fontSize: 10 }}>
              {blocked} blocked
            </span>
          )}
        </div>

        <button
          onClick={expanded ? onClose : onExpand}
          className="p-1 rounded-md transition-colors flex-shrink-0"
          style={{ color: 'var(--text-muted)' }}
          title={expanded ? 'Minimize' : 'Expand'}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          {expanded ? <X size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      {/* ── Scroll area ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto op-scroll" style={{ minHeight: 0 }}>
        {flatRows.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', padding: '12px 16px', display: 'block' }}>No sessions</span>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vItem => {
              const item = flatRows[vItem.index]
              return (
                <div key={vItem.key} style={{ position: 'absolute', top: vItem.start, width: '100%' }}>
                  {item.type === 'group' ? (
                    <GroupRow
                      group={item.group}
                      groupKey={item.key}
                      connId={connId}
                      isOpen={expandedGroups.has(item.key)}
                      onToggle={() => dispatch({ type: 'TOGGLE_SESSION_GROUP', connId, key: item.key })}
                    />
                  ) : (
                    <SessionRow session={item.session} onKill={() => setKillTarget({ sessionId: item.session.session_id, login: item.session.login_name, host: item.session.host_name })} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function SessionsPanel({ processes, connId }) {
  const [expanded, setExpanded] = useState(false)
  const compactRef  = useRef(null)
  const expandedRef = useRef(null)

  return (
    <>
      {/* ── Compact panel (always in grid) ── */}
      <div className="col-span-4 mc flex flex-col" style={{ height: COMPACT_H, overflow: 'hidden' }} id={`sessions-panel-${connId}`}>
        <SessionsPanelInner
          processes={processes}
          connId={connId}
          expanded={false}
          onExpand={() => setExpanded(true)}
          onClose={() => setExpanded(false)}
          scrollRef={compactRef}
        />
      </div>

      {/* ── Expanded overlay (portal, no grid shift) ── */}
      {expanded && createPortal(
        <>
          <div
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)' }}
            onClick={() => setExpanded(false)}
          />
          <div
            className="fixed z-50 mc flex flex-col"
            style={{
              top: 20, bottom: 20,
              left: '50%', transform: 'translateX(-50%)',
              width: 'min(560px, calc(100vw - 40px))',
              overflow: 'hidden',
              boxShadow: 'var(--card-shadow), 0 32px 64px rgba(0,0,0,.45)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <SessionsPanelInner
              processes={processes}
              connId={connId}
              expanded={true}
              onExpand={() => {}}
              onClose={() => setExpanded(false)}
              scrollRef={expandedRef}
            />
          </div>
        </>,
        document.body
      )}
    </>
  )
}
