import React, { useEffect } from 'react'
import { X } from 'lucide-react'
import ConnectionList from './ConnectionList'

export default function ConnectionSidebar({ open, onClose, onAddConnection, onRequestPassword }) {
  useEffect(() => {
    if (!open) return
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40" style={{ background: 'rgba(0,0,0,.35)' }} onClick={onClose} />
      )}
      <div
        className="fixed top-0 left-0 h-full z-50 flex flex-col"
        style={{
          width: 288,
          background: 'var(--card-bg)',
          borderRight: '1px solid var(--input-border)',
          boxShadow: '8px 0 32px rgba(0,0,0,.25)',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform .22s cubic-bezier(.4,0,.2,1)',
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--divider)' }}
        >
          <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Connections</span>
          <button
            onClick={onClose}
            aria-label="Close connections sidebar"
            className="p-1 rounded-md transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={16} />
          </button>
        </div>
        <ConnectionList onAddConnection={onAddConnection} onRequestPassword={onRequestPassword} />
      </div>
    </>
  )
}
