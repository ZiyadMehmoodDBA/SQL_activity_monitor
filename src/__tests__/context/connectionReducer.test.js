import { describe, it, expect } from 'vitest'
import { connectionReducer, initialConnectionState, makeLive } from '../../context/connectionReducer'

const winProfile = (over = {}) => ({
  schemaVersion: 1, id: 'w1', displayName: 'Dev', serverName: 'DEVBOX',
  authenticationType: 'windows', autoConnect: true, displayOrder: 0,
  color: '#3b82f6', appIntent: 'ReadWrite', createdAt: 't', updatedAt: 't', ...over,
})
const sqlProfile = (over = {}) => winProfile({ id: 's1', authenticationType: 'sql', autoConnect: false, username: 'sa', ...over })

function initState(profiles, selectedConnectionId = null) {
  return connectionReducer(initialConnectionState, { type: 'INIT', profiles, selectedConnectionId })
}

describe('INIT', () => {
  it('creates a live entry per profile before any connect attempt', () => {
    const s = initState([winProfile(), sqlProfile()])
    expect(Object.keys(s.connections).sort()).toEqual(['s1', 'w1'])
    expect(s.isInitializing).toBe(false)
  })

  it('windows autoConnect starts connecting; sql starts expired', () => {
    const s = initState([winProfile(), sqlProfile()])
    expect(s.connections['w1'].status).toBe('connecting')
    expect(s.connections['s1'].status).toBe('expired')
  })

  it('windows without autoConnect starts disconnected', () => {
    const s = initState([winProfile({ autoConnect: false })])
    expect(s.connections['w1'].status).toBe('disconnected')
  })

  it('selection: saved id wins, else first by displayOrder, else null', () => {
    expect(initState([winProfile(), sqlProfile()], 's1').selectedConnectionId).toBe('s1')
    expect(initState([sqlProfile({ displayOrder: 1 }), winProfile({ displayOrder: 0 })]).selectedConnectionId).toBe('w1')
    expect(initState([], 'ghost').selectedConnectionId).toBeNull()
  })

  it('saved selection pointing at removed profile falls back to first', () => {
    expect(initState([winProfile()], 'ghost').selectedConnectionId).toBe('w1')
  })
})

describe('status transitions', () => {
  it('SET_STATUS updates status and lastError', () => {
    let s = initState([winProfile()])
    s = connectionReducer(s, { type: 'SET_STATUS', id: 'w1', status: 'failed', error: 'timeout' })
    expect(s.connections['w1'].status).toBe('failed')
    expect(s.connections['w1'].lastError).toBe('timeout')
  })

  it('SET_STATUS for unknown id is a no-op', () => {
    const s = initState([winProfile()])
    expect(connectionReducer(s, { type: 'SET_STATUS', id: 'nope', status: 'failed' })).toBe(s)
  })
})

describe('UPDATE_METRICS', () => {
  const metrics = {
    cpu_percent: 50, waiting_tasks: 1, db_io_mb: 2, batch_requests: 10,
    serverPerf: { netMbs: 0.1, compilationsSec: 3 },
  }

  it('appends history, marks connected, refreshState idle, lastRefresh set', () => {
    let s = initState([winProfile()])
    s = connectionReducer(s, { type: 'REFRESH_START', ids: ['w1'] })
    s = connectionReducer(s, { type: 'UPDATE_METRICS', connId: 'w1', metrics })
    const c = s.connections['w1']
    expect(c.history.cpu).toEqual([50])
    expect(c.status).toBe('connected')
    expect(c.refreshState).toBe('idle')
    expect(c.lastRefresh).toBeTypeOf('number')
  })

  it('ignores metrics for removed connections', () => {
    const s = initState([winProfile()])
    expect(connectionReducer(s, { type: 'UPDATE_METRICS', connId: 'ghost', metrics })).toBe(s)
  })
})

describe('refresh lifecycle', () => {
  it('REFRESH_START sets isRefreshing and per-conn refreshing', () => {
    let s = initState([winProfile()])
    s = connectionReducer(s, { type: 'REFRESH_START', ids: ['w1'] })
    expect(s.isRefreshing).toBe(true)
    expect(s.connections['w1'].refreshState).toBe('refreshing')
  })

  it('REFRESH_SETTLED clears flag and marks stragglers failed', () => {
    let s = initState([winProfile(), sqlProfile()])
    s = connectionReducer(s, { type: 'REFRESH_START', ids: ['w1', 's1'] })
    s = connectionReducer(s, { type: 'REFRESH_SETTLED', failedIds: ['s1'] })
    expect(s.isRefreshing).toBe(false)
    expect(s.connections['s1'].refreshState).toBe('failed')
  })
})

describe('profiles', () => {
  it('ADD_PROFILE appends, creates connected live entry, selects it', () => {
    let s = initState([])
    s = connectionReducer(s, { type: 'ADD_PROFILE', profile: winProfile() })
    expect(s.profiles).toHaveLength(1)
    expect(s.connections['w1'].status).toBe('connected')
    expect(s.selectedConnectionId).toBe('w1')
  })

  it('UPDATE_PROFILE merges and syncs label/color into live entry', () => {
    let s = initState([winProfile()])
    s = connectionReducer(s, { type: 'UPDATE_PROFILE', id: 'w1', updates: { displayName: 'Renamed', color: '#ef4444' } })
    expect(s.profiles[0].displayName).toBe('Renamed')
    expect(s.connections['w1'].label).toBe('Renamed')
    expect(s.connections['w1'].color).toBe('#ef4444')
    expect(s.profiles[0].updatedAt).not.toBe('t')
  })

  it('REMOVE_PROFILE drops both layers; selection falls back to first remaining, else null', () => {
    let s = initState([winProfile({ displayOrder: 0 }), sqlProfile({ displayOrder: 1 })], 'w1')
    s = connectionReducer(s, { type: 'REMOVE_PROFILE', id: 'w1' })
    expect(s.profiles).toHaveLength(1)
    expect(s.connections['w1']).toBeUndefined()
    expect(s.selectedConnectionId).toBe('s1')
    s = connectionReducer(s, { type: 'REMOVE_PROFILE', id: 's1' })
    expect(s.selectedConnectionId).toBeNull()
  })
})

describe('per-connection UI actions (moved from AppContext)', () => {
  it('TOGGLE_SECTION flips membership in collapsedSections', () => {
    let s = initState([winProfile()])
    const before = s.connections['w1'].collapsedSections.has('proc')
    s = connectionReducer(s, { type: 'TOGGLE_SECTION', connId: 'w1', sectionId: 'proc' })
    expect(s.connections['w1'].collapsedSections.has('proc')).toBe(!before)
  })

  it('SET_TABLE_SORT updates only the named table', () => {
    let s = initState([winProfile()])
    s = connectionReducer(s, { type: 'SET_TABLE_SORT', connId: 'w1', tableId: 'proc', col: 'session_id', dir: 'asc' })
    expect(s.connections['w1'].sortState.proc).toEqual({ col: 'session_id', dir: 'asc' })
    expect(s.connections['w1'].sortState.waits.col).toBe('wait_time_ms')
  })

  it('SET_JOBS_FILTER / SEARCH / SORT and TOGGLE_SESSION_GROUP work per conn', () => {
    let s = initState([winProfile()])
    s = connectionReducer(s, { type: 'SET_JOBS_FILTER', connId: 'w1', filter: 'failed' })
    s = connectionReducer(s, { type: 'SET_JOBS_SEARCH', connId: 'w1', search: 'backup' })
    s = connectionReducer(s, { type: 'SET_JOBS_SORT', connId: 'w1', sort: { col: 'job_name', dir: 'asc' } })
    s = connectionReducer(s, { type: 'TOGGLE_SESSION_GROUP', connId: 'w1', key: 'g1' })
    const c = s.connections['w1']
    expect(c.jobsFilter).toBe('failed')
    expect(c.jobsSearch).toBe('backup')
    expect(c.jobsSort).toEqual({ col: 'job_name', dir: 'asc' })
    expect(c.expandedSessionGroups.has('g1')).toBe(true)
  })
})
