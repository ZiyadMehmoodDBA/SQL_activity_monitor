import React, { createContext, useContext, useReducer } from 'react'
import { loadLayout, saveLayout, defaultLayout } from '../lib/widgetRegistry'

const HISTORY_MAX = 60

function pushHist(arr, val) {
  const next = [...arr, val]
  if (next.length > HISTORY_MAX) next.shift()
  return next
}

// All section IDs that exist in Dashboard.jsx — always collapsed on page load/refresh
const ALL_SECTIONS_COLLAPSED = new Set([
  'proc', 'waits', 'fileio', 'recent', 'active',
  'blocking', 'deadlocks', 'dbsizes', 'dbsizetrend',
  'cpu', 'tempdb',
])

function makeConn(conn) {
  // Always start fully collapsed — ignore any persisted state
  const collapsedSections = new Set(ALL_SECTIONS_COLLAPSED)
  return {
    id: conn.id,
    label: conn.label,
    server: conn.server,
    color: conn.color || '#3b82f6',
    appIntent: conn.appIntent || 'ReadWrite',
    metrics: null,
    history: {
      cpu: [],
      wait: [],
      io: [],
      batch: [],
      netMb: [],
      compilations: [],
    },
    lastUpdate: null,
    diskHistory: {},     // { 'C:\\': number[] } — free_pct ring buffer per volume
    jobsFilter: 'all',
    jobsSearch: '',
    jobsSort: { col: null, dir: 'asc' },
    expandedSessionGroups: new Set(),
    collapsedSections,
    sortState: {
      proc:            { col: 'cpu_time',              dir: 'desc' },
      waits:           { col: 'wait_time_ms',          dir: 'desc' },
      fileio:          { col: 'io_stall',              dir: 'desc' },
      recent:          { col: 'avg_elapsed_ms',        dir: 'desc' },
      active:          { col: 'elapsed_sec',           dir: 'desc' },
      blocking:        { col: 'wait_time',             dir: 'desc' },
      deadlocks:       { col: 'deadlock_time',         dir: 'desc' },
      cpu:             { col: 'total_worker_time',     dir: 'desc' },
      tempdb:          { col: 'total_pages',           dir: 'desc' },
      missing_indexes: { col: 'estimated_improvement', dir: 'desc' },
    },
  }
}

// Synchronously hydrate saved connection so first render shows Dashboard,
// not the landing page. Uses same ID the server will receive via _clientId.
function makeInitialState() {
  const base = {
    palette: localStorage.getItem('palette') || 'Enterprise',
    widgetLayout: loadLayout(),
  }
  try {
    const saved  = JSON.parse(localStorage.getItem('sqlmon-saved-conn'))
    const connId = localStorage.getItem('sqlmon-conn-id')
    if (saved && connId) {
      const conn = makeConn({
        id:        connId,
        label:     saved.label || saved.server || 'Restoring…',
        server:    saved.server || '',
        color:     saved.color  || '#3b82f6',
        appIntent: saved.appIntent || 'ReadWrite',
      })
      return { ...base, connections: { [connId]: conn }, activeConnId: connId }
    }
  } catch {}
  return { ...base, connections: {}, activeConnId: null }
}

const initialState = makeInitialState()

function reducer(state, action) {
  switch (action.type) {
    case 'ADD_CONN': {
      const conn = makeConn(action.conn)
      return {
        ...state,
        connections: { ...state.connections, [conn.id]: conn },
        activeConnId: state.activeConnId || conn.id,
      }
    }
    case 'REMOVE_CONN': {
      const { [action.connId]: removed, ...rest } = state.connections
      const remaining = Object.keys(rest)
      const nextActive = state.activeConnId === action.connId
        ? (remaining[0] || null)
        : state.activeConnId
      return { ...state, connections: rest, activeConnId: nextActive }
    }
    // Hydration failed — evict the placeholder and show landing page
    case 'HYDRATE_FAILED': {
      const { [action.connId]: _, ...rest } = state.connections
      return { ...state, connections: rest, activeConnId: Object.keys(rest)[0] || null }
    }
    case 'SET_ACTIVE':
      return { ...state, activeConnId: action.connId }
    case 'UPDATE_METRICS': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      const m = action.metrics
      const sp = m.serverPerf || {}
      const newHistory = {
        cpu:          pushHist(conn.history.cpu,          m.cpu_percent || 0),
        wait:         pushHist(conn.history.wait,         m.waiting_tasks || 0),
        io:           pushHist(conn.history.io,           m.db_io_mb || 0),
        batch:        pushHist(conn.history.batch,        m.batch_requests || 0),
        netMb:        pushHist(conn.history.netMb,        sp.netMbs || 0),
        compilations: pushHist(conn.history.compilations, sp.compilationsSec || 0),
      }
      // Per-volume free_pct history for drive trend analysis
      const newDiskHistory = { ...conn.diskHistory }
      for (const d of (m.diskDrives || [])) {
        const key = d.volume_mount_point
        newDiskHistory[key] = pushHist(newDiskHistory[key] || [], d.free_pct ?? 0)
      }
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.connId]: {
            ...conn,
            metrics: m,
            history: newHistory,
            diskHistory: newDiskHistory,
            lastUpdate: Date.now(),
          },
        },
      }
    }
    case 'SET_PALETTE':
      localStorage.setItem('palette', action.palette)
      return { ...state, palette: action.palette }
    case 'SET_JOBS_FILTER': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return { ...state, connections: { ...state.connections, [action.connId]: { ...conn, jobsFilter: action.filter } } }
    }
    case 'SET_JOBS_SEARCH': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return { ...state, connections: { ...state.connections, [action.connId]: { ...conn, jobsSearch: action.search } } }
    }
    case 'SET_JOBS_SORT': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return { ...state, connections: { ...state.connections, [action.connId]: { ...conn, jobsSort: action.sort } } }
    }
    case 'TOGGLE_SESSION_GROUP': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      const next = new Set(conn.expandedSessionGroups)
      if (next.has(action.key)) next.delete(action.key)
      else next.add(action.key)
      return { ...state, connections: { ...state.connections, [action.connId]: { ...conn, expandedSessionGroups: next } } }
    }
    case 'TOGGLE_SECTION': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      const next = new Set(conn.collapsedSections)
      if (next.has(action.sectionId)) next.delete(action.sectionId)
      else next.add(action.sectionId)
      // Persist to localStorage
      localStorage.setItem(`sqlmon-collapsed-${action.connId}`, JSON.stringify([...next]))
      return { ...state, connections: { ...state.connections, [action.connId]: { ...conn, collapsedSections: next } } }
    }
    case 'SET_TABLE_SORT': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.connId]: {
            ...conn,
            sortState: {
              ...conn.sortState,
              [action.tableId]: { col: action.col, dir: action.dir },
            },
          },
        },
      }
    }
    case 'TOGGLE_WIDGET': {
      const next = state.widgetLayout.map(w =>
        w.id === action.widgetId ? { ...w, enabled: !w.enabled } : w
      )
      saveLayout(next)
      return { ...state, widgetLayout: next }
    }
    case 'REORDER_WIDGETS': {
      // Replace the section portion of the layout with the new order
      // action.sectionLayout: { id, enabled }[] (sections only, in new order)
      const panels = state.widgetLayout.filter(w => {
        const r = state.widgetLayout.find(x => x.id === w.id)
        return action.sectionIds.indexOf(w.id) === -1
      })
      // Rebuild: panels first (in original order), then new section order
      const panelItems = state.widgetLayout.filter(w => !action.sectionIds.includes(w.id))
      const sectionItems = action.sectionLayout
      const next = [...panelItems, ...sectionItems]
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
