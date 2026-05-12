import React, { useState, useEffect } from 'react'
import { useApp } from './context/AppContext'
import { useSocket } from './hooks/useSocket'
import { applyPalette } from './lib/palettes'
import Header from './components/Header'
import TabBar from './components/TabBar'
import ConnectModal from './components/ConnectModal'
import Dashboard from './components/Dashboard'
import WidgetSidebar from './components/WidgetSidebar'

export default function App() {
  const { state, dispatch } = useApp()
  const [showConnect, setShowConnect] = useState(false)
  const [showWidgets, setShowWidgets] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [prefill, setPrefill] = useState(null)
  const [prefillError, setPrefillError] = useState('')
  const socketRef = useSocket(dispatch, state.connections)

  // Apply palette on mount and when it changes
  useEffect(() => {
    applyPalette(state.palette)
  }, [state.palette])

  // On mount: attempt silent reconnect from localStorage, or show ConnectModal fresh.
  useEffect(() => {
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem('sqlmon-saved-conn')) } catch { return null }
    })()

    const cleanupStale = () =>
      fetch('/api/connections')
        .then(r => r.json())
        .then(existing => existing.forEach(c =>
          fetch(`/api/disconnect/${c.id}`, { method: 'DELETE' }).catch(() => {})
        ))
        .catch(() => {})

    if (!saved) {
      cleanupStale().finally(() => setShowConnect(true))
      return
    }

    setReconnecting(true)
    setPrefill(saved)   // hold saved config so banner can show label
    cleanupStale()

    const body = { ...saved }
    if (saved.authType === 'sql') {
      body.password = sessionStorage.getItem('sqlmon-saved-pass') || ''
    }

    fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async r => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error || 'Reconnect failed')
        return data
      })
      .then(conn => {
        dispatch({ type: 'ADD_CONN', conn })
        setPrefill(null)
      })
      .catch(err => {
        setPrefillError(`Auto-reconnect failed: ${err.message}`)
        setShowConnect(true)
      })
      .finally(() => setReconnecting(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleConnected(conn, formBody) {
    dispatch({ type: 'ADD_CONN', conn })
    if (socketRef.current) {
      socketRef.current.emit('subscribe', conn.id)
    }
    // Persist config (no password) for silent reconnect on next refresh
    if (formBody) {
      const { password: _pw, ...toSave } = formBody
      try { localStorage.setItem('sqlmon-saved-conn', JSON.stringify(toSave)) } catch {}
      if (formBody.authType === 'sql' && formBody.password) {
        try { sessionStorage.setItem('sqlmon-saved-pass', formBody.password) } catch {}
      }
    }
    setShowConnect(false)
    setPrefill(null)
    setPrefillError('')
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
    // Clear persisted session for this server
    try {
      const saved = JSON.parse(localStorage.getItem('sqlmon-saved-conn'))
      if (saved?.server === conn.server) {
        localStorage.removeItem('sqlmon-saved-conn')
        sessionStorage.removeItem('sqlmon-saved-pass')
      }
    } catch {}
  }

  const connIds = Object.keys(state.connections)
  const activeConn = state.activeConnId ? state.connections[state.activeConnId] : null
  const isConnected = connIds.length > 0 && !!activeConn?.lastUpdate

  return (
    <div className="min-h-screen" style={{ background: 'var(--body-bg)', color: 'var(--body-text)' }}>
      {reconnecting && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: 'var(--header-bg)', color: '#fff',
          textAlign: 'center', padding: '9px 16px',
          fontSize: 13, fontWeight: 600, letterSpacing: '.01em',
        }}>
          Reconnecting to {prefill?.label || prefill?.server || 'server'}…
        </div>
      )}
      <Header connected={isConnected} onToggleWidgets={() => setShowWidgets(v => !v)} widgetSidebarOpen={showWidgets} />
      <WidgetSidebar open={showWidgets} onClose={() => setShowWidgets(false)} />

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
        ) : state.activeConnId ? (
          <Dashboard key={state.activeConnId} connId={state.activeConnId} />
        ) : null}
      </main>

      <ConnectModal
        open={showConnect}
        onClose={() => setShowConnect(false)}
        onConnected={handleConnected}
        prefill={prefill}
        prefillError={prefillError}
      />
    </div>
  )
}
