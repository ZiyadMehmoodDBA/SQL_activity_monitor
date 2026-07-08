import React, { createContext, useContext, useReducer } from 'react'
import { loadLayout, saveLayout, defaultLayout } from '../lib/widgetRegistry'

const initialState = {
  palette: localStorage.getItem('palette') || 'Enterprise',
  widgetLayout: loadLayout(),
  sidebarOpen: false,
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_PALETTE':
      localStorage.setItem('palette', action.palette)
      return { ...state, palette: action.palette }
    case 'SET_SIDEBAR_OPEN':
      return { ...state, sidebarOpen: action.open }
    case 'TOGGLE_WIDGET': {
      const next = state.widgetLayout.map(w =>
        w.id === action.widgetId ? { ...w, enabled: !w.enabled } : w
      )
      saveLayout(next)
      return { ...state, widgetLayout: next }
    }
    case 'REORDER_WIDGETS': {
      const panelItems = state.widgetLayout.filter(w => !action.sectionIds.includes(w.id))
      const next = [...panelItems, ...action.sectionLayout]
      saveLayout(next)
      return { ...state, widgetLayout: next }
    }
    case 'RESET_WIDGET_LAYOUT': {
      const next = defaultLayout()
      saveLayout(next)
      return { ...state, widgetLayout: next }
    }
    default:
      return state
  }
}

export const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
