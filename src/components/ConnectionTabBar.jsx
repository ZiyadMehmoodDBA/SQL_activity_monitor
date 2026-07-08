import React, { useRef, useCallback } from 'react'
import { Loader2, CheckCircle2, XCircle, Plus, X } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'

const ACTIVE_STATUSES = new Set(['connected', 'connecting', 'reconnecting'])

const STATUS_ICON = {
  connected:    <CheckCircle2 size={12} style={{ color: '#22c55e' }} />,
  connecting:   <Loader2    size={12} style={{ color: '#f59e0b' }} className="animate-spin" />,
  reconnecting: <Loader2    size={12} style={{ color: '#f59e0b' }} className="animate-spin" />,
  disconnected: <XCircle    size={12} style={{ color: '#ef4444' }} />,
  failed:       <XCircle    size={12} style={{ color: '#ef4444' }} />,
}

export default function ConnectionTabBar({ onAddConnection }) {
  const { enrichedConnections, selectedConnectionId, setSelected, disconnectConnection } = useConnections()
  const scrollRef = useRef(null)

  const activeTabs = enrichedConnections.filter(e => ACTIVE_STATUSES.has(e.displayStatus))

  const onWheel = useCallback(e => {
    if (!scrollRef.current) return
    e.preventDefault()
    scrollRef.current.scrollLeft += e.deltaY + e.deltaX
  }, [])

  if (activeTabs.length === 0) return null

  return (
    <div
      style={{
        background: 'var(--header-bg)',
        borderTop: '1px solid rgba(255,255,255,.07)',
        display: 'flex',
        alignItems: 'stretch',
        minHeight: 36,
      }}
    >
      <div
        ref={scrollRef}
        onWheel={onWheel}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          overflowX: 'auto',
          overflowY: 'hidden',
          flex: 1,
          scrollbarWidth: 'none',
        }}
        className="hide-scrollbar"
      >
        {activeTabs.map(({ profile, displayStatus, isSelected: sel }) => {
          const selected = profile.id === selectedConnectionId
          return (
            <button
              key={profile.id}
              onClick={() => setSelected(profile.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 10px',
                minWidth: 0,
                maxWidth: 200,
                flexShrink: 0,
                background: selected ? 'rgba(255,255,255,.10)' : 'transparent',
                borderBottom: selected ? `2px solid ${profile.color ?? '#3b82f6'}` : '2px solid transparent',
                color: selected ? '#fff' : 'rgba(255,255,255,.6)',
                fontSize: 12,
                fontWeight: selected ? 600 : 400,
                cursor: 'pointer',
                transition: 'background .15s, color .15s',
                whiteSpace: 'nowrap',
                position: 'relative',
              }}
              aria-current={selected ? 'true' : 'false'}
              title={profile.displayName}
            >
              {STATUS_ICON[displayStatus] ?? STATUS_ICON.disconnected}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
                {profile.displayName}
              </span>
              <span
                role="button"
                aria-label={`Close ${profile.displayName}`}
                tabIndex={0}
                onClick={e => { e.stopPropagation(); disconnectConnection(profile.id) }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); disconnectConnection(profile.id) } }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginLeft: 2,
                  padding: 2,
                  borderRadius: 4,
                  flexShrink: 0,
                  opacity: .6,
                  cursor: 'pointer',
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                onMouseLeave={e => e.currentTarget.style.opacity = '.6'}
              >
                <X size={11} />
              </span>
            </button>
          )
        })}
      </div>

      <button
        onClick={onAddConnection}
        aria-label="Add connection"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 12px',
          flexShrink: 0,
          color: 'rgba(255,255,255,.5)',
          cursor: 'pointer',
          borderLeft: '1px solid rgba(255,255,255,.08)',
          transition: 'color .15s',
          background: 'transparent',
        }}
        onMouseEnter={e => e.currentTarget.style.color = '#fff'}
        onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,.5)'}
        title="Add connection"
      >
        <Plus size={15} />
      </button>
    </div>
  )
}
