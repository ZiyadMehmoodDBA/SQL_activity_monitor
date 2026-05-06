import React, { useState, useRef, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { PALETTES, applyPalette } from '../lib/palettes'

export default function Header({ connected }) {
  const { state, dispatch } = useApp()
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
      className="text-white px-5 py-2.5 flex items-center justify-between sticky top-0 z-50"
      style={{ background: 'var(--header-bg)', boxShadow: '0 1px 0 rgba(255,255,255,.06),0 2px 12px rgba(0,0,0,.25)' }}
    >
      <div className="flex items-center gap-3">
        <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 flex-shrink-0" style={{ color: 'var(--header-icon)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span className="font-bold text-xl tracking-tight">SQL Activity Monitor</span>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'dot-live' : 'dot-idle'}`}></span>
          <span style={{ color: 'var(--header-status-txt)' }}>
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>
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
            <div className="absolute right-0 top-9 bg-white rounded-xl shadow-xl border border-slate-200 z-50 overflow-hidden py-1 min-w-[190px]">
              {Object.entries(PALETTES).map(([name, p]) => (
                <button
                  key={name}
                  onClick={() => selectPalette(name)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-sm hover:bg-slate-50 transition-colors ${name === state.palette ? 'bg-slate-50' : ''}`}
                >
                  <span
                    className={`w-3.5 h-3.5 rounded-full flex-shrink-0 ring-2 ${name === state.palette ? 'ring-slate-400' : 'ring-transparent'}`}
                    style={{ background: p.swatch }}
                  />
                  <span className={`text-slate-700 ${name === state.palette ? 'font-semibold' : ''}`}>{name}</span>
                  {name === state.palette && (
                    <svg className="ml-auto w-3.5 h-3.5 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
