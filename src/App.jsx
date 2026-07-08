import React, { useState, useEffect } from 'react'
import { useApp } from './context/AppContext'
import { useConnections } from './context/ConnectionContext'
import { applyPalette } from './lib/palettes'
import Header from './components/Header'
import ConnectModal from './components/ConnectModal'
import ReconnectModal from './components/ReconnectModal'
import ConnectionSidebar from './components/ConnectionSidebar'
import ConnectionTabBar from './components/ConnectionTabBar'
import Dashboard from './components/Dashboard'
import WidgetSidebar from './components/WidgetSidebar'

export default function App() {
  const { state, dispatch } = useApp()
  const { profiles, selectedConnectionId, selectedConnection, isInitializing } = useConnections()
  const [showConnect, setShowConnect] = useState(false)
  const [showWidgets, setShowWidgets] = useState(false)
  const [reconnectId, setReconnectId] = useState(null)

  useEffect(() => {
    applyPalette(state.palette)
  }, [state.palette])

  // First run with no saved profiles: open connect modal
  useEffect(() => {
    if (!isInitializing && profiles.length === 0) setShowConnect(true)
  }, [isInitializing, profiles.length])

  const isConnected = !!selectedConnection?.lastUpdate
  const closeSidebar = () => dispatch({ type: 'SET_SIDEBAR_OPEN', open: false })

  return (
    <div className="min-h-screen" style={{ background: 'var(--body-bg)', color: 'var(--body-text)' }}>
      <div className="sticky top-0 z-50">
        <Header connected={isConnected} onToggleWidgets={() => setShowWidgets(v => !v)} widgetSidebarOpen={showWidgets} />
        <ConnectionTabBar onAddConnection={() => { closeSidebar(); setShowConnect(true) }} />
      </div>
      <WidgetSidebar open={showWidgets} onClose={() => setShowWidgets(false)} />

      <ConnectionSidebar
        open={state.sidebarOpen}
        onClose={closeSidebar}
        onAddConnection={() => { closeSidebar(); setShowConnect(true) }}
        onRequestPassword={id => { closeSidebar(); setReconnectId(id) }}
      />

      <main className="p-6" style={{ maxWidth: 1920, margin: '0 auto' }}>
        {isInitializing ? null : profiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-center">
            <svg className="w-16 h-16 text-slate-300 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            <h2 className="text-xl font-semibold text-slate-500 mb-2">No Saved Connections</h2>
            <p className="text-slate-400 text-sm mb-6">Connect to a SQL Server instance to start monitoring</p>
            <button
              onClick={() => setShowConnect(true)}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm hover:opacity-90 transition-opacity"
              style={{ background: 'var(--header-bg)' }}
            >
              + New Connection
            </button>
          </div>
        ) : selectedConnectionId ? (
          <Dashboard key={selectedConnectionId} connId={selectedConnectionId} />
        ) : null}
      </main>

      <ConnectModal open={showConnect} onClose={() => setShowConnect(false)} />
      <ReconnectModal connectionId={reconnectId} onClose={() => setReconnectId(null)} />
    </div>
  )
}
