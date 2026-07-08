import React from 'react'
import { CheckCircle2, Loader2, XCircle, KeyRound, MoreHorizontal } from 'lucide-react'

const STATUS_META = {
  connected:    { Icon: CheckCircle2, color: '#10b981', label: 'Connected' },
  connecting:   { Icon: Loader2,      color: '#f59e0b', label: 'Connecting', spin: true },
  reconnecting: { Icon: Loader2,      color: '#f59e0b', label: 'Reconnecting', spin: true },
  disconnected: { Icon: XCircle,      color: '#ef4444', label: 'Disconnected' },
  failed:       { Icon: XCircle,      color: '#ef4444', label: 'Connection failed' },
  expired:      { Icon: KeyRound,     color: 'var(--text-muted)', label: 'Password required' },
}

export default function ConnectionItem({ enriched, onSelect, onOpenMenu }) {
  const { profile, live, displayStatus, isSelected } = enriched
  const meta = STATUS_META[displayStatus] || STATUS_META.disconnected
  const tooltip = live?.lastError ? `${meta.label} — ${live.lastError}` : meta.label

  return (
    <button
      onClick={() => onSelect(profile.id)}
      onContextMenu={e => { e.preventDefault(); onOpenMenu(profile.id, e.clientX, e.clientY) }}
      aria-current={isSelected ? 'true' : 'false'}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg mb-0.5 text-left transition-colors focus:outline-none focus-visible:ring-2"
      style={{
        background: isSelected ? 'var(--section-hover)' : 'transparent',
        borderLeft: `3px solid ${isSelected ? (profile.color || '#3b82f6') : 'transparent'}`,
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--row-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = isSelected ? 'var(--section-hover)' : 'transparent' }}
    >
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ background: profile.color || '#3b82f6' }}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {profile.displayName}
        </span>
        <span className="block text-xs truncate" style={{ color: 'var(--text-muted)' }}>
          {profile.serverName}
        </span>
      </span>
      <span title={tooltip} aria-label={meta.label} className="flex-shrink-0 flex items-center">
        <meta.Icon size={15} color={meta.color} className={meta.spin ? 'animate-spin' : ''} />
      </span>
      <span
        role="button"
        tabIndex={-1}
        aria-label={`Actions for ${profile.displayName}`}
        className="flex-shrink-0 p-0.5 rounded"
        style={{ color: 'var(--text-muted)' }}
        onClick={e => { e.stopPropagation(); onOpenMenu(profile.id, e.clientX, e.clientY) }}
      >
        <MoreHorizontal size={15} />
      </span>
    </button>
  )
}
