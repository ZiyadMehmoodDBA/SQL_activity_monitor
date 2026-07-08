import React, { useState, useRef, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { PALETTES, applyPalette } from '../lib/palettes'
import { LayoutDashboard, RefreshCw } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'

function PaletteItem({ name, swatch, isActive, onClick }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors"
      style={{
        background: isActive
          ? 'var(--section-hover)'
          : hovered
          ? 'var(--row-hover)'
          : 'transparent',
        color: 'var(--text-primary)',
      }}
    >
      <span
        className="w-3.5 h-3.5 rounded-full flex-shrink-0 transition-shadow"
        style={{
          background: swatch,
          boxShadow: isActive
            ? `0 0 0 2px var(--card-bg), 0 0 0 3.5px var(--text-muted)`
            : 'none',
        }}
      />
      <span style={{ fontWeight: isActive ? 600 : 400, color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
        {name}
      </span>
      {isActive && (
        <svg
          className="ml-auto flex-shrink-0"
          style={{ width: 13, height: 13, color: 'var(--sort-active)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  )
}

export default function Header({ connected, onToggleWidgets, widgetSidebarOpen }) {
  const { state, dispatch } = useApp()
  const { isRefreshing, refreshAllConnections } = useConnections()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  function selectPalette(name) {
    applyPalette(name)
    dispatch({ type: 'SET_PALETTE', palette: name })
    setMenuOpen(false)
  }

  return (
    <header
      className="text-white px-5 py-2.5 flex items-center justify-between"
      style={{ background: 'var(--header-bg)', boxShadow: '0 1px 0 rgba(255,255,255,.06),0 2px 12px rgba(0,0,0,.25)' }}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={() => dispatch({ type: 'SET_SIDEBAR_OPEN', open: true })}
          aria-label="Open connections sidebar"
          className="p-1 rounded-md hover:bg-white/10 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 flex-shrink-0" style={{ color: 'var(--header-icon)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <span className="font-bold text-xl tracking-tight">SQL Activity Monitor</span>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'dot-live' : 'dot-idle'}`}></span>
          <span style={{ color: 'var(--header-status-txt)' }}>
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>
        {/* Refresh all connections */}
        <button
          onClick={() => refreshAllConnections()}
          disabled={isRefreshing}
          aria-label="Refresh all connections"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-white/10 transition-colors disabled:opacity-50"
          style={{ color: 'var(--header-icon)' }}
          title="Refresh all connected servers"
        >
          <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>

        {/* Widget sidebar toggle */}
        <button
          onClick={onToggleWidgets}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
          style={{
            color: widgetSidebarOpen ? 'var(--header-bg)' : 'var(--header-icon)',
            background: widgetSidebarOpen ? 'var(--header-icon)' : 'transparent',
          }}
          title="Manage widgets"
        >
          <LayoutDashboard size={14} />
          <span>Widgets</span>
        </button>

        {/* Palette picker */}
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-white/10 transition-colors"
            style={{ color: 'var(--header-icon)' }}
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
            </svg>
            <span>{state.palette}</span>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-9 rounded-xl z-50 overflow-hidden py-1 min-w-[190px]"
              style={{
                background: 'var(--card-bg)',
                border: '1px solid var(--input-border)',
                boxShadow: 'var(--card-shadow)',
              }}
            >
              {Object.entries(PALETTES).map(([name, p]) => {
                const isActive = name === state.palette
                return (
                  <PaletteItem
                    key={name}
                    name={name}
                    swatch={p.swatch}
                    isActive={isActive}
                    onClick={() => selectPalette(name)}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
