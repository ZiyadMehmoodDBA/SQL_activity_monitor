import React from 'react'
import { useApp } from '../context/AppContext'

export default function TabBar({ onAddConnection, onRemoveConnection }) {
  const { state, dispatch } = useApp()
  const connIds = Object.keys(state.connections)

  if (connIds.length === 0) return null

  return (
    <div
      className="flex items-end gap-0.5 px-4 overflow-x-auto"
      style={{
        background: 'var(--body-bg)',
        borderBottom: '1px solid rgba(0,0,0,.07)',
        paddingTop: 4,
        minHeight: 36,
      }}
    >
      {connIds.map(id => {
        const conn = state.connections[id]
        const isActive = state.activeConnId === id
        return (
          <button
            key={id}
            className={`tab ${isActive ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_ACTIVE', connId: id })}
            style={isActive ? { borderBottomColor: conn.color } : {}}
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: conn.color || '#3b82f6' }}
            />
            <span className="tab-label">{conn.label}</span>
            <span
              className="close-btn"
              onClick={(e) => { e.stopPropagation(); onRemoveConnection(id) }}
              title="Disconnect"
            >
              ✕
            </span>
          </button>
        )
      })}
      <button
        onClick={onAddConnection}
        title="New connection"
        className="flex items-center justify-center w-6 h-6 rounded-md text-slate-500 text-lg cursor-pointer hover:bg-slate-200 transition-colors mb-1 flex-shrink-0"
      >
        +
      </button>
    </div>
  )
}
