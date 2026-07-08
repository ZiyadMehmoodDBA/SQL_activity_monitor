import React, { useEffect, useRef } from 'react'
import { RotateCw, Pencil, Trash2 } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'

function MenuItem({ icon: Icon, label, onClick, disabled, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ color: danger ? '#ef4444' : 'var(--text-primary)' }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--row-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <Icon size={14} />
      {label}
    </button>
  )
}

export default function ConnectionContextMenu({ enriched, x, y, onClose, onRequestPassword }) {
  const { reconnect, renameConnection, removeConnection } = useConnections()
  const ref = useRef(null)
  const { profile, displayStatus } = enriched
  const busy = displayStatus === 'connecting' || displayStatus === 'reconnecting'

  useEffect(() => {
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey  = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function handleReconnect() {
    onClose()
    if (profile.authenticationType === 'sql') onRequestPassword(profile.id)
    else reconnect(profile.id).catch(() => {})
  }

  function handleRename() {
    onClose()
    const name = window.prompt('Rename connection', profile.displayName)
    if (name && name.trim()) renameConnection(profile.id, name.trim())
  }

  function handleRemove() {
    onClose()
    if (window.confirm(`Remove "${profile.displayName}"? This deletes the saved connection.`)) {
      removeConnection(profile.id)
    }
  }

  return (
    <div
      ref={ref}
      className="fixed z-[70] rounded-xl py-1 min-w-[180px] overflow-hidden"
      style={{
        left: Math.min(x, window.innerWidth - 200),
        top:  Math.min(y, window.innerHeight - 140),
        background: 'var(--card-bg)',
        border: '1px solid var(--input-border)',
        boxShadow: 'var(--card-shadow)',
      }}
    >
      <MenuItem icon={RotateCw} label="Reconnect" onClick={handleReconnect} disabled={busy} />
      <MenuItem icon={Pencil} label="Rename" onClick={handleRename} />
      <div className="my-1" style={{ borderTop: '1px solid var(--divider)' }} />
      <MenuItem icon={Trash2} label="Remove" onClick={handleRemove} danger />
    </div>
  )
}
