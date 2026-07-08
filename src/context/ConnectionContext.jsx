import React, { createContext, useContext, useReducer, useEffect, useRef, useMemo, useCallback } from 'react'
import { io } from 'socket.io-client'
import { connectionReducer, initialConnectionState } from './connectionReducer'
import {
  loadProfiles, saveProfiles, loadUiState, saveUiState,
  getSessionPassword, setSessionPassword, clearSessionPassword,
  migrateLegacyStorage,
} from '../lib/profileStore'

const RETRY_DELAY_MS     = 5000
const REFRESH_TIMEOUT_MS = 12000
const PASSWORD_IN_CONNSTR = /(^|;)\s*(password|pwd)\s*=/i

function profileToConnectBody(profile, password) {
  if (profile.connectionString) {
    return { connectionString: profile.connectionString, color: profile.color, _clientId: profile.id }
  }
  return {
    server:    profile.serverName,
    label:     profile.displayName,
    database:  profile.database,
    authType:  profile.authenticationType,
    user:      profile.authenticationType === 'sql' ? profile.username : undefined,
    password:  profile.authenticationType === 'sql' ? password : undefined,
    encrypt:   profile.encrypt,
    trustServerCert: profile.trustServerCert,
    hostNameInCertificate: profile.hostNameInCertificate,
    appIntent: profile.appIntent,
    color:     profile.color,
    _clientId: profile.id,
  }
}

function formToProfile(form, id, displayOrder) {
  const ts = new Date().toISOString()
  const isSql = form.authType === 'sql'
  return {
    schemaVersion: 1,
    id,
    displayName: form.label?.trim() || form.server || 'Connection',
    serverName: form.server || '(connection string)',
    authenticationType: isSql ? 'sql' : 'windows',
    database: form.database || 'master',
    username: isSql ? form.user : undefined,
    color: form.color || '#3b82f6',
    appIntent: form.appIntent || 'ReadWrite',
    encrypt: form.encrypt ?? 'false',
    trustServerCert: form.trustServerCert !== false,
    hostNameInCertificate: form.hostNameInCertificate || undefined,
    connectionString: form.connectionString || undefined,
    autoConnect: !isSql,
    displayOrder,
    lastConnectedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  }
}

const ConnectionContext = createContext(null)

export function ConnectionProvider({ children }) {
  const [state, dispatch] = useReducer(connectionReducer, initialConnectionState)
  const socketRef   = useRef(null)
  const stateRef    = useRef(state)
  const initRef     = useRef(false)
  const refreshRef  = useRef(null)
  const retriedRef  = useRef(new Set())
  stateRef.current = state

  const subscribe = useCallback(id => {
    socketRef.current?.emit('subscribe', id)
  }, [])

  const connectProfile = useCallback(async (profile, password) => {
    dispatch({ type: 'SET_STATUS', id: profile.id, status: 'connecting' })
    try {
      const res  = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileToConnectBody(profile, password)),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Connection failed')
      dispatch({ type: 'SET_STATUS', id: profile.id, status: 'connected' })
      dispatch({ type: 'UPDATE_PROFILE', id: profile.id, updates: { lastConnectedAt: new Date().toISOString() } })
      subscribe(profile.id)
      retriedRef.current.delete(profile.id)
    } catch (err) {
      const status = profile.authenticationType === 'sql' && !password ? 'expired' : 'failed'
      dispatch({ type: 'SET_STATUS', id: profile.id, status, error: err.message })
      throw err
    }
  }, [subscribe])

  const retryOnce = useCallback(id => {
    const profile = stateRef.current.profiles.find(p => p.id === id)
    if (!profile) return
    if (retriedRef.current.has(id)) {
      dispatch({ type: 'SET_STATUS', id, status: 'failed', error: 'Reconnect retry failed' })
      return
    }
    retriedRef.current.add(id)
    const pw = profile.authenticationType === 'sql' ? getSessionPassword(id) : undefined
    if (profile.authenticationType === 'sql' && !pw) {
      dispatch({ type: 'SET_STATUS', id, status: 'expired', error: 'Password required' })
      return
    }
    connectProfile(profile, pw).catch(() => {})
  }, [connectProfile])

  const settleRefresh = useCallback(() => {
    const r = refreshRef.current
    if (!r) return
    clearTimeout(r.timer)
    refreshRef.current = null
    dispatch({ type: 'REFRESH_SETTLED', failedIds: [...r.pending] })
  }, [])

  useEffect(() => {
    const socket = io()
    socketRef.current = socket

    socket.on('connect', () => {
      for (const p of stateRef.current.profiles) socket.emit('subscribe', p.id)
    })

    socket.on('metricsUpdated', ({ connectionId, refreshRequestId, metrics }) => {
      dispatch({ type: 'UPDATE_METRICS', connId: connectionId, metrics })
      const r = refreshRef.current
      if (r && refreshRequestId === r.requestId) {
        r.pending.delete(connectionId)
        if (r.pending.size === 0) settleRefresh()
      }
    })

    socket.on('refreshFailed', ({ connectionId, refreshRequestId, reason }) => {
      console.error(`[refreshFailed] conn ${connectionId}:`, reason)
      dispatch({ type: 'REFRESH_CONN_FAILED', connId: connectionId })
      const r = refreshRef.current
      if (r && refreshRequestId === r.requestId) {
        r.pending.delete(connectionId)
        if (r.pending.size === 0) settleRefresh()
      }
    })

    socket.on('connectionStatusChanged', ({ connectionId, status, error }) => {
      if (status !== 'disconnected') return
      if (!stateRef.current.connections[connectionId]) return
      dispatch({ type: 'SET_STATUS', id: connectionId, status: 'reconnecting', error })
      setTimeout(() => retryOnce(connectionId), RETRY_DELAY_MS)
    })

    socket.on('serverRemoved', ({ connectionId }) => {
      if (stateRef.current.connections[connectionId]) {
        dispatch({ type: 'SET_STATUS', id: connectionId, status: 'disconnected' })
      }
    })

    return () => { socket.disconnect(); socketRef.current = null }
  }, [retryOnce, settleRefresh])

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    migrateLegacyStorage()
    const profiles = loadProfiles()
    const ui = loadUiState()
    dispatch({ type: 'INIT', profiles, selectedConnectionId: ui.selectedConnectionId })

    const known = new Set(profiles.map(p => p.id))
    fetch('/api/connections')
      .then(r => r.json())
      .then(existing => Promise.allSettled(
        existing
          .filter(c => !known.has(c.id))
          .map(c => fetch(`/api/disconnect/${c.id}`, { method: 'DELETE' }))
      ))
      .catch(() => {})
      .finally(() => {
        for (const p of profiles) {
          if (p.authenticationType === 'sql') {
            const pw = getSessionPassword(p.id)
            if (pw) connectProfile(p, pw).catch(() => {})
          } else if (p.autoConnect) {
            connectProfile(p).catch(() => {})
          }
        }
      })
  }, [connectProfile])

  useEffect(() => {
    if (!state.isInitializing) saveProfiles(state.profiles)
  }, [state.profiles, state.isInitializing])

  useEffect(() => {
    if (!state.isInitializing) saveUiState({ selectedConnectionId: state.selectedConnectionId })
  }, [state.selectedConnectionId, state.isInitializing])

  const addConnection = useCallback(async form => {
    if (form.connectionString && PASSWORD_IN_CONNSTR.test(form.connectionString)) {
      throw new Error('Connection strings containing a password cannot be saved. Use the Login tab with SQL authentication instead.')
    }
    const id = crypto.randomUUID()
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, _clientId: id }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Connection failed')
    const profile = formToProfile(form, id, stateRef.current.profiles.length)
    if (form.authType === 'sql' && form.rememberPassword && form.password) {
      setSessionPassword(id, form.password)
    }
    dispatch({ type: 'ADD_PROFILE', profile })
    subscribe(id)
  }, [subscribe])

  const updateConnection = useCallback(async (id, updates) => {
    dispatch({ type: 'UPDATE_PROFILE', id, updates })
  }, [])

  const renameConnection = useCallback((id, name) => {
    updateConnection(id, { displayName: name })
  }, [updateConnection])

  const removeConnection = useCallback(async id => {
    try { await fetch(`/api/disconnect/${id}`, { method: 'DELETE' }) } catch {}
    socketRef.current?.emit('unsubscribe', id)
    clearSessionPassword(id)
    try { localStorage.removeItem(`sqlmon-collapsed-${id}`) } catch {}
    dispatch({ type: 'REMOVE_PROFILE', id })
  }, [])

  const reconnect = useCallback(async (id, password) => {
    const profile = stateRef.current.profiles.find(p => p.id === id)
    if (!profile) return
    retriedRef.current.delete(id)
    const pw = password ?? (profile.authenticationType === 'sql' ? getSessionPassword(id) : undefined)
    await connectProfile(profile, pw)
  }, [connectProfile])

  const setSelected = useCallback(id => {
    dispatch({ type: 'SET_SELECTED', connId: id })
  }, [])

  const refreshAllConnections = useCallback(async () => {
    if (refreshRef.current) return
    const ids = Object.values(stateRef.current.connections)
      .filter(c => c.status === 'connected')
      .map(c => c.id)
    if (ids.length === 0) return
    const requestId = crypto.randomUUID()
    refreshRef.current = {
      requestId,
      pending: new Set(ids),
      timer: setTimeout(settleRefresh, REFRESH_TIMEOUT_MS),
    }
    dispatch({ type: 'REFRESH_START', ids })
    try {
      await fetch('/api/refresh/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshRequestId: requestId }),
      })
    } catch {
      settleRefresh()
    }
  }, [settleRefresh])

  const enrichedConnections = useMemo(() =>
    [...state.profiles]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(profile => {
        const live = state.connections[profile.id]
        return {
          profile,
          live,
          displayStatus: live?.status ?? 'disconnected',
          isSelected: profile.id === state.selectedConnectionId,
        }
      }),
  [state.profiles, state.connections, state.selectedConnectionId])

  const selectedConnection = state.selectedConnectionId
    ? state.connections[state.selectedConnectionId] ?? null
    : null

  const value = useMemo(() => ({
    connections: state.connections,
    profiles: state.profiles,
    selectedConnectionId: state.selectedConnectionId,
    isInitializing: state.isInitializing,
    isRefreshing: state.isRefreshing,
    enrichedConnections,
    selectedConnection,
    selectedMetrics: selectedConnection?.metrics ?? null,
    selectedHistory: selectedConnection?.history ?? null,
    getProfile: id => state.profiles.find(p => p.id === id) ?? null,
    getLiveConnection: id => state.connections[id] ?? null,
    getEnrichedConnection: id => enrichedConnections.find(e => e.profile.id === id) ?? null,
    addConnection,
    updateConnection,
    renameConnection,
    removeConnection,
    reconnect,
    setSelected,
    refreshAllConnections,
    dispatch,
  }), [state, enrichedConnections, selectedConnection, addConnection, updateConnection,
       renameConnection, removeConnection, reconnect, setSelected, refreshAllConnections])

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnections() {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnections must be used within ConnectionProvider')
  return ctx
}
