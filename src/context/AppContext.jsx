import React, { createContext, useContext, useReducer } from 'react'

const HISTORY_MAX = 60

function pushHist(arr, val) {
  const next = [...arr, val]
  if (next.length > HISTORY_MAX) next.shift()
  return next
}

function makeConn(conn) {
  // Restore collapsed sections from localStorage
  const stored = localStorage.getItem(`sqlmon-collapsed-${conn.id}`)
  const collapsedSections = stored ? new Set(JSON.parse(stored)) : new Set()
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
    jobsFilter: 'all',
    jobsSearch: '',
    jobsSort: { col: null, dir: 'asc' },
    expandedSessionGroups: new Set(),
    collapsedSections,
    sortState: {
      proc:      { col: 'cpu_time',       dir: 'desc' },
      waits:     { col: 'wait_time_ms',   dir: 'desc' },
      fileio:    { col: 'io_stall',       dir: 'desc' },
      recent:    { col: 'avg_elapsed_ms', dir: 'desc' },
      active:    { col: 'elapsed_sec',    dir: 'desc' },
      blocking:  { col: 'wait_time',      dir: 'desc' },
      deadlocks: { col: 'deadlock_time',  dir: 'desc' },
    },
  }
}

const initialState = {
  connections: {},
  activeConnId: null,
  palette: localStorage.getItem('palette') || 'Enterprise',
}

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
      return {
        ...state,
        connections: {
          ...state.connections,
          [action.connId]: {
            ...conn,
            metrics: m,
            history: newHistory,
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
