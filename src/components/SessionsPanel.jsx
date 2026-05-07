import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useApp } from '../context/AppContext'

export default function SessionsPanel({ processes, connId }) {
  const { state, dispatch } = useApp()
  const conn = state.connections[connId]
  const expanded = conn?.expandedSessionGroups || new Set()
  const parentRef = useRef(null)

  // Build groups
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

  // Flatten to virtual rows (group row + optional detail rows)
  const flatRows = []
  for (const g of groups) {
    const key = `${g.login}||${g.host}`
    flatRows.push({ type: 'group', group: g, key })
    if (expanded.has(key)) {
      const sorted = [...g.sessions].sort((a, b) => (b.cpu_time || 0) - (a.cpu_time || 0))
      for (const s of sorted) {
        flatRows.push({ type: 'session', session: s, groupKey: key })
      }
    }
  }

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => flatRows[i]?.type === 'session' ? 52 : 42,
    overscan: 5,
  })

  async function killSession(sessionId) {
    if (!window.confirm(`Kill SPID ${sessionId}?`)) return
    try {
      await fetch(`/api/connections/${connId}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
    } catch (err) {
      alert('Kill failed: ' + err.message)
    }
  }

  return (
    <div className="col-span-4 mc flex flex-col" style={{ minHeight: 280 }} id={`sessions-panel-${connId}`}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wide">Connected Sessions</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-bold leading-none tabular-nums" style={{ fontSize: 22, color: '#3b82f6' }}>
            {(processes || []).length}
          </span>
        </div>
      </div>
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto"
        style={{ minHeight: 0, height: 300, position: 'relative' }}
      >
        {flatRows.length === 0 ? (
          <span className="text-xs text-slate-400 italic px-5 py-3 block">No sessions</span>
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
                      isOpen={expanded.has(item.key)}
                      onToggle={() => dispatch({ type: 'TOGGLE_SESSION_GROUP', connId, key: item.key })}
                    />
                  ) : (
                    <SessionRow session={item.session} onKill={() => killSession(item.session.session_id)} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function GroupRow({ group, isOpen, onToggle }) {
  const hasActive = group.statuses.has('running') || group.statuses.has('suspended')
  const dotColor  = group.isBlocked ? '#dc2626' : hasActive ? '#22c55e' : '#94a3b8'
  const countColor = group.count >= 10 ? '#dc2626' : group.count >= 5 ? '#ea580c' : '#3b82f6'
  const cpuFmt = group.totalCpu >= 1000 ? Math.round(group.totalCpu / 1000) + 's' : group.totalCpu + 'ms'

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-slate-50 transition-colors select-none border-b border-slate-50"
      onClick={onToggle}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-slate-700 truncate text-xs" title={group.host}>{group.host}</div>
        <div className="text-slate-400 truncate" style={{ fontSize: 10 }}>{group.login}</div>
      </div>
      {group.isBlocked && (
        <span style={{ fontSize: 9, fontWeight: 700, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>
          ⚠ BLOCKED
        </span>
      )}
      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: countColor, background: countColor + '18' }}>
        {group.count}
      </span>
      <span className="text-[10px] text-slate-400 flex-shrink-0">{cpuFmt}</span>
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
  const q = s.last_query ? s.last_query.substring(0, 80).trim().replace(/\s+/g, ' ') : ''
  const sCpu  = (s.cpu_time || 0) >= 1000 ? Math.round((s.cpu_time || 0) / 1000) + 's' : (s.cpu_time || 0) + 'ms'
  const sElap = s.elapsed_sec ? (s.elapsed_sec >= 60 ? Math.round(s.elapsed_sec / 60) + 'm' : s.elapsed_sec + 's') : '—'

  return (
    <div style={{ background: 'var(--card-bg)', borderLeft: `3px solid ${stColor}`, margin: '2px 0', padding: '5px 10px', fontSize: 10 }}>
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
