import React, { useState, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'
import ConnectionItem from './ConnectionItem'
import ConnectionContextMenu from './ConnectionContextMenu'

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 mb-0.5 animate-pulse">
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--divider)' }} />
      <span className="flex-1">
        <span className="block h-3 rounded mb-1.5 w-2/3" style={{ background: 'var(--divider)' }} />
        <span className="block h-2.5 rounded w-1/2" style={{ background: 'var(--divider)' }} />
      </span>
    </div>
  )
}

export default function ConnectionList({ onAddConnection, onRequestPassword }) {
  const { enrichedConnections, isInitializing, setSelected, getEnrichedConnection } = useConnections()
  const [menu, setMenu] = useState(null)
  const scrollRef = useRef(null)

  function handleSelect(id) {
    setSelected(id)
    const e = getEnrichedConnection(id)
    if (e?.displayStatus === 'expired') onRequestPassword(id)
  }

  function handleKeyDown(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(scrollRef.current?.querySelectorAll('button[aria-current]') ?? [])]
    const idx = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? items[idx + 1] ?? items[0] : items[idx - 1] ?? items[items.length - 1]
    next?.focus()
  }

  const menuEnriched = menu ? getEnrichedConnection(menu.id) : null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 pt-3 pb-2 flex-shrink-0">
        <button
          onClick={onAddConnection}
          role="button"
          aria-label="Add Connection"
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-90"
          style={{ background: 'var(--header-bg)' }}
        >
          <Plus size={14} />
          Add Connection
        </button>
      </div>

      <div ref={scrollRef} onKeyDown={handleKeyDown} className="flex-1 overflow-y-auto px-2 pb-3" style={{ scrollbarWidth: 'thin' }}>
        {isInitializing ? (
          <>
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </>
        ) : enrichedConnections.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>No saved connections</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Add a SQL Server instance to start monitoring.</p>
          </div>
        ) : (
          enrichedConnections.map(e => (
            <ConnectionItem
              key={e.profile.id}
              enriched={e}
              onSelect={handleSelect}
              onOpenMenu={(id, x, y) => setMenu({ id, x, y })}
            />
          ))
        )}
      </div>

      {menuEnriched && (
        <ConnectionContextMenu
          enriched={menuEnriched}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRequestPassword={onRequestPassword}
        />
      )}
    </div>
  )
}
