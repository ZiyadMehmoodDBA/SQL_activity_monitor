import React, { useState, useEffect } from 'react'
import { useApp } from './context/AppContext'
import { useSocket } from './hooks/useSocket'
import { applyPalette } from './lib/palettes'
import Header from './components/Header'
import TabBar from './components/TabBar'
import ConnectModal from './components/ConnectModal'
import Dashboard from './components/Dashboard'

export default function App() {
  const { state, dispatch } = useApp()
  const [showConnect, setShowConnect] = useState(false)
  const socketRef = useSocket(dispatch, state.connections)

  // Apply palette on mount and when it changes
  useEffect(() => {
    applyPalette(state.palette)
  }, [state.palette])

  // Fetch existing connections on mount
  useEffect(() => {
    fetch('/api/connections')
      .then(r => r.json())
      .then(existing => {
        if (existing.length === 0) {
          setShowConnect(true)
        } else {
          existing.forEach(conn => dispatch({ type: 'ADD_CONN', conn }))
        }
      })
      .catch(() => {
        setShowConnect(true)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleConnected(conn) {
    dispatch({ type: 'ADD_CONN', conn })
    // Subscribe immediately
    if (socketRef.current) {
      socketRef.current.emit('subscribe', conn.id)
    }
    setShowConnect(false)
  }

  async function handleRemoveConnection(connId) {
    const conn = state.connections[connId]
    if (!conn) return
    if (!window.confirm(`Disconnect from ${conn.label}?`)) return
    try {
      await fetch(`/api/disconnect/${connId}`, { method: 'DELETE' })
    } catch {}
    if (socketRef.current) {
      socketRef.current.emit('unsubscribe', connId)
    }
    dispatch({ type: 'REMOVE_CONN', connId })
  }

  const connIds = Object.keys(state.connections)
  const activeConn = state.activeConnId ? state.connections[state.activeConnId] : null
  const isConnected = connIds.length > 0 && !!activeConn?.lastUpdate

  return (
    <div className="min-h-screen" style={{ background: 'var(--body-bg)', color: 'var(--body-text)' }}>
      <Header connected={isConnected} />

      {connIds.length > 0 && (
        <TabBar
          onAddConnection={() => setShowConnect(true)}
          onRemoveConnection={handleRemoveConnection}
        />
      )}

      <main className="p-6" style={{ maxWidth: 1920, margin: '0 auto' }}>
        {connIds.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-center">
            <svg className="w-16 h-16 text-slate-300 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            <h2 className="text-xl font-semibold text-slate-500 mb-2">No Active Connections</h2>
            <p className="text-slate-400 text-sm mb-6">Connect to a SQL Server instance to start monitoring</p>
            <button
              onClick={() => setShowConnect(true)}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:opacity-90 transition-opacity"
              style={{ background: 'var(--header-bg)' }}
            >
              + New Connection
            </button>
          </div>
        ) : (
          connIds.map(id => (
            <div key={id} style={{ display: state.activeConnId === id ? 'block' : 'none' }}>
              <Dashboard connId={id} />
            </div>
          ))
        )}
      </main>

      <ConnectModal
        open={showConnect}
        onClose={() => setShowConnect(false)}
        onConnected={handleConnected}
      />
    </div>
  )
}
