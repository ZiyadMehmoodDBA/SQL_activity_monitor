const HISTORY_MAX = 60

function pushHist(arr, val) {
  const next = [...arr, val]
  if (next.length > HISTORY_MAX) next.shift()
  return next
}

const ALL_SECTIONS_COLLAPSED = new Set([
  'proc', 'waits', 'fileio', 'recent', 'active',
  'blocking', 'deadlocks', 'dbsizes', 'dbsizetrend',
  'cpu', 'tempdb',
])

export function makeLive(profile) {
  return {
    id: profile.id,
    status: 'disconnected',
    refreshState: 'idle',
    lastRefresh: null,
    lastError: null,
    label: profile.displayName,
    server: profile.serverName,
    color: profile.color || '#3b82f6',
    appIntent: profile.appIntent || 'ReadWrite',
    metrics: null,
    history: { cpu: [], wait: [], io: [], batch: [], netMb: [], compilations: [] },
    diskHistory: {},
    lastUpdate: null,
    jobsFilter: 'all',
    jobsSearch: '',
    jobsSort: { col: null, dir: 'asc' },
    alerts: [],
    expandedSessionGroups: new Set(),
    collapsedSections: new Set(ALL_SECTIONS_COLLAPSED),
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

function initialStatusFor(profile) {
  if (profile.authenticationType === 'sql') return 'expired'
  return profile.autoConnect ? 'connecting' : 'disconnected'
}

function firstByOrder(profiles) {
  if (profiles.length === 0) return null
  return [...profiles].sort((a, b) => a.displayOrder - b.displayOrder)[0].id
}

export const initialConnectionState = {
  profiles: [],
  connections: {},
  selectedConnectionId: null,
  isInitializing: true,
  isRefreshing: false,
  lastAlertEvent: null,
  deepLink: null,
}

function updateConn(state, connId, patch) {
  const conn = state.connections[connId]
  if (!conn) return state
  return {
    ...state,
    connections: { ...state.connections, [connId]: { ...conn, ...patch } },
  }
}

export function connectionReducer(state, action) {
  switch (action.type) {
    case 'INIT': {
      const connections = {}
      for (const p of action.profiles) {
        connections[p.id] = { ...makeLive(p), status: initialStatusFor(p) }
      }
      const saved = action.selectedConnectionId
      const selectedConnectionId =
        saved && connections[saved] ? saved : firstByOrder(action.profiles)
      return {
        ...state,
        profiles: action.profiles,
        connections,
        selectedConnectionId,
        isInitializing: false,
      }
    }
    case 'ADD_PROFILE': {
      const live = { ...makeLive(action.profile), status: 'connected' }
      return {
        ...state,
        profiles: [...state.profiles, action.profile],
        connections: { ...state.connections, [action.profile.id]: live },
        selectedConnectionId: action.profile.id,
      }
    }
    case 'UPDATE_PROFILE': {
      const profiles = state.profiles.map(p =>
        p.id === action.id
          ? { ...p, ...action.updates, updatedAt: new Date().toISOString() }
          : p
      )
      const updated = profiles.find(p => p.id === action.id)
      let next = { ...state, profiles }
      if (updated && state.connections[action.id]) {
        next = updateConn(next, action.id, {
          label: updated.displayName,
          server: updated.serverName,
          color: updated.color || '#3b82f6',
          appIntent: updated.appIntent || 'ReadWrite',
        })
      }
      return next
    }
    case 'REMOVE_PROFILE': {
      const profiles = state.profiles.filter(p => p.id !== action.id)
      const { [action.id]: _removed, ...connections } = state.connections
      const selectedConnectionId = state.selectedConnectionId === action.id
        ? firstByOrder(profiles)
        : state.selectedConnectionId
      return { ...state, profiles, connections, selectedConnectionId }
    }
    case 'SET_STATUS':
      return updateConn(state, action.id, {
        status: action.status,
        lastError: action.error ?? state.connections[action.id]?.lastError ?? null,
      })
    case 'SET_SELECTED':
      return { ...state, selectedConnectionId: action.connId }
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
      const newDiskHistory = { ...conn.diskHistory }
      for (const d of (m.diskDrives || [])) {
        const key = d.volume_mount_point
        newDiskHistory[key] = pushHist(newDiskHistory[key] || [], d.free_pct ?? 0)
      }
      return updateConn(state, action.connId, {
        metrics: m,
        history: newHistory,
        diskHistory: newDiskHistory,
        lastUpdate: Date.now(),
        lastRefresh: Date.now(),
        status: 'connected',
        refreshState: 'idle',
        lastError: null,
      })
    }
    case 'REFRESH_START': {
      let next = { ...state, isRefreshing: true }
      for (const id of action.ids) next = updateConn(next, id, { refreshState: 'refreshing' })
      return next
    }
    case 'REFRESH_SETTLED': {
      let next = { ...state, isRefreshing: false }
      for (const id of action.failedIds) next = updateConn(next, id, { refreshState: 'failed' })
      return next
    }
    case 'REFRESH_CONN_FAILED':
      return updateConn(state, action.connId, { refreshState: 'failed' })
    case 'SET_JOBS_FILTER':
      return updateConn(state, action.connId, { jobsFilter: action.filter })
    case 'SET_JOBS_SEARCH':
      return updateConn(state, action.connId, { jobsSearch: action.search })
    case 'SET_JOBS_SORT':
      return updateConn(state, action.connId, { jobsSort: action.sort })
    case 'TOGGLE_SESSION_GROUP': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      const next = new Set(conn.expandedSessionGroups)
      if (next.has(action.key)) next.delete(action.key)
      else next.add(action.key)
      return updateConn(state, action.connId, { expandedSessionGroups: next })
    }
    case 'TOGGLE_SECTION': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      const next = new Set(conn.collapsedSections)
      if (next.has(action.sectionId)) next.delete(action.sectionId)
      else next.add(action.sectionId)
      return updateConn(state, action.connId, { collapsedSections: next })
    }
    case 'SET_TABLE_SORT': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return updateConn(state, action.connId, {
        sortState: { ...conn.sortState, [action.tableId]: { col: action.col, dir: action.dir } },
      })
    }
    case 'ALERT_EVENT': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      const a = action.alert
      const rest = (conn.alerts || []).filter((x) => x.id !== a.id)
      const alerts = a.resolvedAt ? rest : [...rest, a]
      const next = updateConn(state, action.connId, { alerts })
      return {
        ...next,
        lastAlertEvent: { connId: action.connId, alert: a, seq: (state.lastAlertEvent?.seq || 0) + 1 },
      }
    }
    case 'ALERTS_LOADED': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return updateConn(state, action.connId, { alerts: action.alerts })
    }
    case 'ALERT_ACKED': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return updateConn(state, action.connId, {
        alerts: (conn.alerts || []).map((a) => (a.id === action.alertId ? { ...a, ackedAt: action.ackedAt } : a)),
      })
    }
    case 'SET_DEEP_LINK':
      return { ...state, deepLink: { connId: action.connId, from: action.from, to: action.to } }
    case 'CLEAR_DEEP_LINK':
      return { ...state, deepLink: null }
    default:
      return state
  }
}
