# Persistent Connection Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top server TabBar with a persistent Connections section in a left slide-out sidebar, with profiles persisted in localStorage, background reconnect on startup, and global refresh-all.

**Architecture:** New `ConnectionContext` becomes the single owner of connection lifecycle (profiles + live state + selection + socket). `AppContext` is slimmed to palette/widgetLayout/sidebarOpen. Server gains `POST /api/refresh/all` and `/api/refresh/:id` plus spec socket events (`metricsUpdated`, `connectionStatusChanged`, `refreshFailed`, `serverRemoved`).

**Tech Stack:** React 18 (context + reducer), Socket.io 4, Express, mssql/Tedious, Vitest + Testing Library (jsdom), Tailwind CDN-style inline vars, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-07-08-persistent-connection-manager-design.md`

## Global Constraints

- **Never persist SQL passwords** to localStorage, cookies, or profiles. Session-only opt-in via sessionStorage key `sqlmon-session-passwords` (single object keyed by connection id).
- Storage keys exactly: `sqlmon-connection-profiles`, `sqlmon-ui-state`, `sqlmon-session-passwords`. Legacy keys `sqlmon-saved-conn`, `sqlmon-conn-id`, `sqlmon-saved-pass` are migrated once then deleted.
- Profile `schemaVersion: 1`. Enums lowercase: `authenticationType: 'windows' | 'sql'`.
- Live status enum: `connected | connecting | disconnected | reconnecting | failed | expired`. `refreshState: 'idle' | 'refreshing' | 'failed'` is independent of status.
- Unexpected disconnect → `reconnecting` → ONE retry after 5s → `failed`. No infinite retry.
- `expired` means exactly: SQL auth awaiting credentials.
- Sidebar width 288px (18rem). Status shown with icon + color, never color alone.
- Refresh completion is event-driven (correlation `refreshRequestId`), 12s timeout marks stragglers `refreshState:'failed'`.
- Connection-string profiles: if the string contains a password token (`/(^|;)\s*(password|pwd)\s*=/i`), REJECT with an error telling the user to use the Login tab. Never store a password-bearing string.
- Git: stage files by name (never `git add .`), commit style `feat(scope): message`.
- Run tests with `npx vitest run <file>` (vitest 4, jsdom environment already configured).

---

### Task 1: profileStore — persistence, migration, session passwords

**Files:**
- Create: `src/lib/profileStore.js`
- Test: `src/__tests__/lib/profileStore.test.js`

**Interfaces:**
- Consumes: nothing (leaf module; browser `localStorage`/`sessionStorage`).
- Produces (used by Task 4):
  - `loadProfiles(): Profile[]`, `saveProfiles(profiles: Profile[]): void`
  - `loadUiState(): { selectedConnectionId: string|null }`, `saveUiState(uiState): void`
  - `getSessionPassword(id): string|null`, `setSessionPassword(id, pw): void`, `clearSessionPassword(id): void`
  - `migrateLegacyStorage(): void` — idempotent, deletes legacy keys.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/lib/profileStore.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadProfiles, saveProfiles, loadUiState, saveUiState,
  getSessionPassword, setSessionPassword, clearSessionPassword,
  migrateLegacyStorage,
} from '../../lib/profileStore'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('profiles round-trip', () => {
  it('returns [] when nothing stored', () => {
    expect(loadProfiles()).toEqual([])
  })

  it('saves and loads profiles', () => {
    const p = { schemaVersion: 1, id: 'a1', displayName: 'Dev', serverName: 'DEVBOX', authenticationType: 'windows', autoConnect: true, displayOrder: 0, createdAt: 't', updatedAt: 't' }
    saveProfiles([p])
    expect(loadProfiles()).toEqual([p])
  })

  it('returns [] on corrupt JSON without throwing', () => {
    localStorage.setItem('sqlmon-connection-profiles', '{not json')
    expect(loadProfiles()).toEqual([])
  })

  it('filters entries missing id or serverName', () => {
    localStorage.setItem('sqlmon-connection-profiles', JSON.stringify([{ id: 'ok', serverName: 'S' }, { bogus: true }, null]))
    expect(loadProfiles()).toEqual([{ id: 'ok', serverName: 'S' }])
  })
})

describe('ui state', () => {
  it('defaults selectedConnectionId to null', () => {
    expect(loadUiState()).toEqual({ selectedConnectionId: null })
  })

  it('round-trips selection', () => {
    saveUiState({ selectedConnectionId: 'c9' })
    expect(loadUiState().selectedConnectionId).toBe('c9')
  })
})

describe('session passwords', () => {
  it('stores under single sqlmon-session-passwords object', () => {
    setSessionPassword('c1', 'hunter2')
    setSessionPassword('c2', 'swordfish')
    expect(JSON.parse(sessionStorage.getItem('sqlmon-session-passwords'))).toEqual({ c1: 'hunter2', c2: 'swordfish' })
    expect(getSessionPassword('c1')).toBe('hunter2')
  })

  it('clearSessionPassword removes only that id', () => {
    setSessionPassword('c1', 'a')
    setSessionPassword('c2', 'b')
    clearSessionPassword('c1')
    expect(getSessionPassword('c1')).toBeNull()
    expect(getSessionPassword('c2')).toBe('b')
  })

  it('never touches localStorage', () => {
    setSessionPassword('c1', 'a')
    expect(localStorage.getItem('sqlmon-session-passwords')).toBeNull()
  })
})

describe('migrateLegacyStorage', () => {
  it('converts legacy keys to one profile and deletes them', () => {
    localStorage.setItem('sqlmon-saved-conn', JSON.stringify({
      server: 'HCMPSDB01\\HCMPS', label: 'Prod', database: 'master',
      authType: 'windows', color: '#10b981', appIntent: 'ReadOnly',
      encrypt: 'false', trustServerCert: true,
    }))
    localStorage.setItem('sqlmon-conn-id', '11111111-1111-4111-8111-111111111111')
    sessionStorage.setItem('sqlmon-saved-pass', 'leaky')

    migrateLegacyStorage()

    const profiles = loadProfiles()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      schemaVersion: 1,
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Prod',
      serverName: 'HCMPSDB01\\HCMPS',
      authenticationType: 'windows',
      autoConnect: true,
      displayOrder: 0,
    })
    expect(loadUiState().selectedConnectionId).toBe('11111111-1111-4111-8111-111111111111')
    expect(localStorage.getItem('sqlmon-saved-conn')).toBeNull()
    expect(localStorage.getItem('sqlmon-conn-id')).toBeNull()
    expect(sessionStorage.getItem('sqlmon-saved-pass')).toBeNull()
  })

  it('sql-auth legacy profile gets autoConnect false and username kept', () => {
    localStorage.setItem('sqlmon-saved-conn', JSON.stringify({ server: 'S1', authType: 'sql', user: 'sa' }))
    localStorage.setItem('sqlmon-conn-id', '22222222-2222-4222-8222-222222222222')
    migrateLegacyStorage()
    expect(loadProfiles()[0]).toMatchObject({ authenticationType: 'sql', autoConnect: false, username: 'sa' })
  })

  it('is idempotent: second run does not duplicate or overwrite', () => {
    localStorage.setItem('sqlmon-saved-conn', JSON.stringify({ server: 'S1', authType: 'windows' }))
    localStorage.setItem('sqlmon-conn-id', '33333333-3333-4333-8333-333333333333')
    migrateLegacyStorage()
    const first = loadProfiles()
    // simulate stray legacy keys reappearing
    localStorage.setItem('sqlmon-saved-conn', JSON.stringify({ server: 'OTHER' }))
    migrateLegacyStorage()
    expect(loadProfiles()).toEqual(first)
    expect(localStorage.getItem('sqlmon-saved-conn')).toBeNull()
  })

  it('with no legacy keys, writes empty profile array (marks migration done)', () => {
    migrateLegacyStorage()
    expect(localStorage.getItem('sqlmon-connection-profiles')).toBe('[]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/lib/profileStore.test.js`
Expected: FAIL — cannot resolve `../../lib/profileStore`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/profileStore.js`:

```js
// Persistence layer for connection profiles + UI state + session passwords.
// SECURITY INVARIANT: passwords only ever touch sessionStorage, never localStorage.

const PROFILES_KEY   = 'sqlmon-connection-profiles'
const UI_STATE_KEY   = 'sqlmon-ui-state'
const SESSION_PW_KEY = 'sqlmon-session-passwords'

const LEGACY_CONN_KEY = 'sqlmon-saved-conn'
const LEGACY_ID_KEY   = 'sqlmon-conn-id'
const LEGACY_PW_KEY   = 'sqlmon-saved-pass'

export function loadProfiles() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILES_KEY))
    if (!Array.isArray(raw)) return []
    return raw.filter(p => p && typeof p.id === 'string' && typeof p.serverName === 'string')
  } catch {
    return []
  }
}

export function saveProfiles(profiles) {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)) } catch {}
}

export function loadUiState() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_STATE_KEY))
    return { selectedConnectionId: raw?.selectedConnectionId ?? null }
  } catch {
    return { selectedConnectionId: null }
  }
}

export function saveUiState(uiState) {
  try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState)) } catch {}
}

function loadSessionPasswords() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_PW_KEY)) || {} } catch { return {} }
}

export function getSessionPassword(id) {
  return loadSessionPasswords()[id] ?? null
}

export function setSessionPassword(id, password) {
  try {
    const all = loadSessionPasswords()
    all[id] = password
    sessionStorage.setItem(SESSION_PW_KEY, JSON.stringify(all))
  } catch {}
}

export function clearSessionPassword(id) {
  try {
    const all = loadSessionPasswords()
    delete all[id]
    sessionStorage.setItem(SESSION_PW_KEY, JSON.stringify(all))
  } catch {}
}

// One-time idempotent migration from the single-connection legacy keys.
// Legacy sessionStorage password is discarded, never migrated.
export function migrateLegacyStorage() {
  const alreadyMigrated = localStorage.getItem(PROFILES_KEY) !== null
  if (!alreadyMigrated) {
    let saved = null
    try { saved = JSON.parse(localStorage.getItem(LEGACY_CONN_KEY)) } catch {}
    const id = localStorage.getItem(LEGACY_ID_KEY)
    if (saved && saved.server && id) {
      const ts = new Date().toISOString()
      const isSql = saved.authType === 'sql'
      saveProfiles([{
        schemaVersion: 1,
        id,
        displayName: saved.label || saved.server,
        serverName: saved.server,
        authenticationType: isSql ? 'sql' : 'windows',
        database: saved.database || 'master',
        username: isSql ? (saved.user || undefined) : undefined,
        color: saved.color || '#3b82f6',
        appIntent: saved.appIntent || 'ReadWrite',
        encrypt: saved.encrypt ?? 'false',
        trustServerCert: saved.trustServerCert !== false,
        hostNameInCertificate: saved.hostNameInCertificate || undefined,
        connectionString: undefined,
        autoConnect: !isSql,
        displayOrder: 0,
        lastConnectedAt: undefined,
        createdAt: ts,
        updatedAt: ts,
      }])
      saveUiState({ selectedConnectionId: id })
    } else {
      saveProfiles([])
    }
  }
  try {
    localStorage.removeItem(LEGACY_CONN_KEY)
    localStorage.removeItem(LEGACY_ID_KEY)
    sessionStorage.removeItem(LEGACY_PW_KEY)
  } catch {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/lib/profileStore.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/profileStore.js src/__tests__/lib/profileStore.test.js
git commit -m "feat(connections): profile persistence layer with legacy-key migration"
```

---

### Task 2: connectionReducer — pure reducer + state machine

**Files:**
- Create: `src/context/connectionReducer.js`
- Test: `src/__tests__/context/connectionReducer.test.js`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 4, 5):
  - `connectionReducer(state, action)` — pure function.
  - `initialConnectionState = { profiles: [], connections: {}, selectedConnectionId: null, isInitializing: true, isRefreshing: false }`
  - `makeLive(profile)` — builds a live entry: `{ id, status:'disconnected', refreshState:'idle', lastRefresh:null, lastError:null, label, server, color, appIntent, metrics:null, history:{cpu,wait,io,batch,netMb,compilations: []}, diskHistory:{}, lastUpdate:null, jobsFilter:'all', jobsSearch:'', jobsSort:{col:null,dir:'asc'}, expandedSessionGroups:Set, collapsedSections:Set, sortState:{...} }` (same runtime shape components already consume from AppContext, plus status fields).
  - Actions: `INIT {profiles, selectedConnectionId}`, `ADD_PROFILE {profile}`, `UPDATE_PROFILE {id, updates}`, `REMOVE_PROFILE {id}`, `SET_STATUS {id, status, error?}`, `SET_SELECTED {connId}`, `UPDATE_METRICS {connId, metrics}`, `REFRESH_START {ids}`, `REFRESH_SETTLED {failedIds}`, `REFRESH_CONN_FAILED {connId}`, plus per-connection UI actions copied verbatim from AppContext: `SET_JOBS_FILTER`, `SET_JOBS_SEARCH`, `SET_JOBS_SORT`, `TOGGLE_SESSION_GROUP`, `TOGGLE_SECTION`, `SET_TABLE_SORT`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/context/connectionReducer.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/context/connectionReducer.test.js`
Expected: FAIL — cannot resolve `../../context/connectionReducer`.

- [ ] **Step 3: Write the implementation**

Create `src/context/connectionReducer.js`. The history/section/sort logic is MOVED from `src/context/AppContext.jsx` (lines 4–57 there) — copy it here; Task 5 deletes it from AppContext.

```js
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
      localStorage.setItem(`sqlmon-collapsed-${action.connId}`, JSON.stringify([...next]))
      return updateConn(state, action.connId, { collapsedSections: next })
    }
    case 'SET_TABLE_SORT': {
      const conn = state.connections[action.connId]
      if (!conn) return state
      return updateConn(state, action.connId, {
        sortState: { ...conn.sortState, [action.tableId]: { col: action.col, dir: action.dir } },
      })
    }
    default:
      return state
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/context/connectionReducer.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/connectionReducer.js src/__tests__/context/connectionReducer.test.js
git commit -m "feat(connections): pure connection reducer with profile/live state machine"
```

---

### Task 3: Server — refresh endpoints + spec socket events

**Files:**
- Modify: `server.js:812-843` (poll fn + connect response), `server.js:845-855` (disconnect), new endpoints after `/api/disconnect/:id`

**Interfaces:**
- Consumes: existing `connections` Map (`server.js:91`), `collectMetrics`, `io`, `requireConn` (`server.js:105`).
- Produces (used by Task 4 client):
  - Socket events: `metricsUpdated { connectionId, refreshRequestId, metrics, timestamp }`, `refreshFailed { connectionId, refreshRequestId, reason }`, `connectionStatusChanged { connectionId, status, error }`, `serverRemoved { connectionId }`. The old `metrics` and `poll_error` events are REPLACED.
  - `POST /api/refresh/all` body `{ refreshRequestId }` → 204.
  - `POST /api/refresh/:id` body `{ refreshRequestId }` → 204 (404 unknown id).
  - `conn.poll(refreshRequestId?)` stored on each connection entry.

⚠ Per CLAUDE.md AI-SQL review policy: this task adds NO new SQL — it reuses `collectMetrics`. Do not add queries.

- [ ] **Step 1: Update the poll function inside `POST /api/connect`**

In `server.js`, replace the poll block (currently lines 811–827):

```js
    // Start polling
    const poll = async (refreshRequestId = null) => {
      const c = connections.get(id);
      if (!c) return;
      try {
        const metrics = await collectMetrics(c.pool, c.prevIO, c.prevNet);
        c.prevIO  = metrics._prevIO;  delete metrics._prevIO;
        c.prevNet = metrics._prevNet; delete metrics._prevNet;
        io.to(`conn:${id}`).emit('metricsUpdated', {
          connectionId: id, refreshRequestId, metrics, timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`[${displayLabel}] Poll error:`, err.message);
        io.to(`conn:${id}`).emit('refreshFailed', {
          connectionId: id, refreshRequestId, reason: err.message,
        });
      }
    };

    await poll();
    conn.poll   = poll;
    conn.handle = setInterval(poll, POLL_MS);
```

Note: `setInterval` invokes `poll` with no arguments, so background polls carry `refreshRequestId: null` — only explicit refreshes get a correlation id.

- [ ] **Step 2: Emit pool-level disconnects**

Immediately after the `pool` is created and session-init batch runs (after current `server.js:786`), add:

```js
    pool.on('error', err => {
      io.to(`conn:${id}`).emit('connectionStatusChanged', {
        connectionId: id, status: 'disconnected', error: err.message,
      });
    });
```

⚠ `id` is declared at current line 791, AFTER the session-init batch. Place this listener AFTER the `let id = ...` line so `id` is in scope (e.g., right before `const displayLabel = ...`).

- [ ] **Step 3: Emit serverRemoved on disconnect**

In `app.delete('/api/disconnect/:id', ...)` (`server.js:845`), before `res.json({ ok: true })`, add:

```js
  io.to(`conn:${req.params.id}`).emit('serverRemoved', { connectionId: req.params.id });
```

- [ ] **Step 4: Add refresh endpoints**

Insert after the `/api/disconnect/:id` handler:

```js
app.post('/api/refresh/all', (req, res) => {
  const refreshRequestId = typeof req.body?.refreshRequestId === 'string'
    ? req.body.refreshRequestId : null;
  for (const [, c] of connections) {
    if (c.poll) c.poll(refreshRequestId);   // fire-and-forget; data arrives via socket
  }
  res.status(204).end();
});

app.post('/api/refresh/:id', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const refreshRequestId = typeof req.body?.refreshRequestId === 'string'
    ? req.body.refreshRequestId : null;
  if (conn.poll) conn.poll(refreshRequestId);
  res.status(204).end();
});
```

- [ ] **Step 5: Verify manually**

There are no server unit tests in this repo. Verify with the dev SQL Server instance (per CLAUDE.md, dev is set in `.env` — never point at production for testing):

Run: `node server.js` (in background), then:
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/refresh/all -H "Content-Type: application/json" -d "{\"refreshRequestId\":\"test-123\"}"
```
Expected: `204`. Also expected: `POST /api/refresh/:id` with an unknown id returns `404`.
Stop the server afterward.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(server): refresh endpoints and connection lifecycle socket events"
```

---

### Task 4: ConnectionContext — provider, socket, startup restore, API

**Files:**
- Create: `src/context/ConnectionContext.jsx`
- Modify: `src/main.jsx`
- Delete: `src/hooks/useSocket.js` (socket ownership moves into the provider; delete AFTER Task 6 removes its last import in `App.jsx` — the delete step lives in Task 6)

**Interfaces:**
- Consumes: Task 1 (`profileStore`), Task 2 (`connectionReducer`), Task 3 socket events/endpoints, existing `POST /api/connect` (`server.js:775`, accepts `_clientId`), `DELETE /api/disconnect/:id`, `GET /api/connections`.
- Produces (used by Tasks 5–8): `useConnections()` returning:
  - state: `connections` (live map, object keyed by id), `profiles`, `selectedConnectionId`, `isInitializing`, `isRefreshing`, `enrichedConnections` (`[{ profile, live, displayStatus, isSelected }]`, sorted by `displayOrder`)
  - actions: `addConnection(form)`, `updateConnection(id, updates)`, `removeConnection(id)`, `reconnect(id, password?)`, `renameConnection(id, name)`, `setSelected(id)`, `refreshAllConnections()`
  - lookups: `getProfile(id)`, `getLiveConnection(id)`, `getEnrichedConnection(id)`
  - selectors: `selectedConnection`, `selectedMetrics`, `selectedHistory`
  - `dispatch` (for the per-connection UI actions components already use)

`form` shape (from ConnectModal, unchanged field names): `{ server, label, database, authType, user, password, encrypt, trustServerCert, hostNameInCertificate, appIntent, color, rememberPassword, connectionString }`.

- [ ] **Step 1: Write the implementation**

Create `src/context/ConnectionContext.jsx`:

```jsx
import React, { createContext, useContext, useReducer, useEffect, useRef, useMemo, useCallback } from 'react'
import { io } from 'socket.io-client'
import { connectionReducer, initialConnectionState } from './connectionReducer'
import {
  loadProfiles, saveProfiles, loadUiState, saveUiState,
  getSessionPassword, setSessionPassword, clearSessionPassword,
  migrateLegacyStorage,
} from '../lib/profileStore'

const RETRY_DELAY_MS   = 5000
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
  const initRef     = useRef(false)       // StrictMode double-mount guard
  const refreshRef  = useRef(null)        // { requestId, pending: Set, timer }
  const retriedRef  = useRef(new Set())   // ids that already used their single auto-retry
  stateRef.current = state

  const subscribe = useCallback(id => {
    socketRef.current?.emit('subscribe', id)
  }, [])

  // ── Connect helper: POST /api/connect for an existing profile ──────────────
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

  // ── Single auto-retry after unexpected disconnect ───────────────────────────
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

  // ── Socket lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io()
    socketRef.current = socket

    // Covers first connect AND every reconnect: re-subscribe all known profiles.
    // Without this, a dropped socket silently stops all metric flow.
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
      // Removed server-side (another tab). Keep profile, mark disconnected.
      if (stateRef.current.connections[connectionId]) {
        dispatch({ type: 'SET_STATUS', id: connectionId, status: 'disconnected' })
      }
    })

    return () => { socket.disconnect(); socketRef.current = null }
  }, [retryOnce, settleRefresh])

  // ── Startup: migrate → load → INIT (all live entries first) → reconnect ────
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    migrateLegacyStorage()
    const profiles = loadProfiles()
    const ui = loadUiState()
    dispatch({ type: 'INIT', profiles, selectedConnectionId: ui.selectedConnectionId })

    const known = new Set(profiles.map(p => p.id))
    // Evict orphaned server-side pools (e.g. from removed profiles)
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
            // no session password → stays 'expired' (set by INIT)
          } else if (p.autoConnect) {
            connectProfile(p).catch(() => {})
          }
        }
      })
  }, [connectProfile])

  // ── Persist profiles / selection whenever they change ──────────────────────
  useEffect(() => {
    if (!state.isInitializing) saveProfiles(state.profiles)
  }, [state.profiles, state.isInitializing])

  useEffect(() => {
    if (!state.isInitializing) saveUiState({ selectedConnectionId: state.selectedConnectionId })
  }, [state.selectedConnectionId, state.isInitializing])

  // ── Public API ──────────────────────────────────────────────────────────────
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
    if (refreshRef.current) return   // refresh lock: concurrent calls are no-ops
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
```

- [ ] **Step 2: Wire provider in `src/main.jsx`**

Replace the file contents:

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { AppProvider } from './context/AppContext'
import { ConnectionProvider } from './context/ConnectionContext'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </AppProvider>
  </React.StrictMode>
)
```

- [ ] **Step 3: Verify it builds and existing tests still pass**

Run: `npx vite build`
Expected: build succeeds (nothing imports the provider's hook yet).
Run: `npx vitest run`
Expected: all existing tests still pass (App still uses AppContext until Tasks 5–6).

- [ ] **Step 4: Commit**

```bash
git add src/context/ConnectionContext.jsx src/main.jsx
git commit -m "feat(connections): ConnectionContext provider — startup restore, socket ownership, refresh orchestration"
```

---

### Task 5: Slim AppContext + migrate dashboard components to useConnections

**Files:**
- Modify: `src/context/AppContext.jsx` (full rewrite below)
- Modify: `src/components/Dashboard.jsx:4,296-297`, `src/components/JobsPanel.jsx:4,76-77`, `src/components/SessionsPanel.jsx:4,84-85`, `src/components/CollapsibleSection.jsx:2,5-6`
- Modify: `src/test/helpers.jsx`, `src/test/setup.js`
- Modify: `src/__tests__/context/reducer.test.jsx`, `src/__tests__/components/JobsPanel.test.jsx`, `src/__tests__/components/SessionsPanel.test.jsx`

**Interfaces:**
- Consumes: `useConnections()` from Task 4 (`connections`, `dispatch` — action names for per-connection UI state are IDENTICAL to the old AppContext actions, so component edits are mechanical).
- Produces: slimmed `useApp()` state `{ palette, widgetLayout, sidebarOpen }`, actions `SET_PALETTE`, `SET_SIDEBAR_OPEN {open}`, `TOGGLE_WIDGET`, `REORDER_WIDGETS`, `RESET_WIDGET_LAYOUT`. Consumed by Header (Task 6) and App (Task 8).

- [ ] **Step 1: Rewrite `src/context/AppContext.jsx`**

Replace the entire file (connection state moved to connectionReducer in Task 2; widget/palette logic copied verbatim):

```jsx
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
      // Rebuild: panels first (in original order), then new section order
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
```

- [ ] **Step 2: Migrate the four connection-consuming components**

Identical mechanical edit in each file. Dispatch action names are unchanged, so ONLY the import and the two state lines change.

`src/components/Dashboard.jsx` — line 4:
```jsx
import { useConnections } from '../context/ConnectionContext'
```
lines 296–297:
```jsx
  const { connections, dispatch } = useConnections()
  const conn = connections[connId]
```

`src/components/JobsPanel.jsx` — line 4: same import swap; lines 76–77:
```jsx
  const { connections, dispatch } = useConnections()
  const conn = connections[connId]
```

`src/components/SessionsPanel.jsx` — line 4: same import swap; lines 84–85:
```jsx
  const { connections, dispatch } = useConnections()
  const conn = connections[connId]
```

`src/components/CollapsibleSection.jsx` — line 2: same import swap; lines 5–6:
```jsx
  const { connections, dispatch } = useConnections()
  const conn = connections[connId]
```

If any of these files also reference `useApp` for palette/widgets, keep that call — only the connection reads move.

- [ ] **Step 3: Update test infrastructure**

`src/test/setup.js` — append (so the provider's socket/fetch startup is inert in tests):

```js
import { vi } from 'vitest'

vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }),
}))

// ConnectionProvider startup calls fetch('/api/connections'); stub unless a test overrides it.
if (!globalThis.fetch || !vi.isMockFunction(globalThis.fetch)) {
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => [] })
  ))
}
```

If an existing test stubs `fetch` itself, its local stub wins (it assigns after setup) — do not remove local stubs.

`src/test/helpers.jsx` — update the render helper and add a profile factory:

```jsx
import { ConnectionProvider } from '../context/ConnectionContext'

export function renderWithContext(ui) {
  return render(
    <AppProvider>
      <ConnectionProvider>{ui}</ConnectionProvider>
    </AppProvider>
  )
}

export function makeProfileFixture(overrides = {}) {
  return {
    schemaVersion: 1, id: 'c1', displayName: 'Dev', serverName: 'DEV',
    authenticationType: 'windows', autoConnect: false, displayOrder: 0,
    color: '#3b82f6', appIntent: 'ReadWrite', createdAt: 't', updatedAt: 't',
    ...overrides,
  }
}
```

(Keep the existing `makeJob`/`makeSession`/`makeProcess`/`makeWiaRow`/`makeMetrics` factories unchanged.)

- [ ] **Step 4: Update the affected test files**

`src/__tests__/context/reducer.test.jsx`: DELETE every describe block that exercises connection-scoped actions — `ADD_CONN`, `REMOVE_CONN`, `UPDATE_METRICS`, `SET_ACTIVE`, `HYDRATE_FAILED`, `SET_JOBS_FILTER/SEARCH/SORT`, `TOGGLE_SESSION_GROUP`, `TOGGLE_SECTION`, `SET_TABLE_SORT` (these behaviors are now covered by `connectionReducer.test.js` from Task 2). KEEP the blocks for `SET_PALETTE`, `TOGGLE_WIDGET`, `REORDER_WIDGETS`, `RESET_WIDGET_LAYOUT`. If a kept block references `ADD_CONN` in setup, drop that setup line.

`src/__tests__/components/JobsPanel.test.jsx` and `SessionsPanel.test.jsx`: these seed a connection via the old `ADD_CONN` dispatch. Replace the seeding pattern: wherever the test dispatches `{ type: 'ADD_CONN', conn: {...} }` via `useApp`, switch the inspector/harness to `useConnections()` and dispatch:

```js
dispatch({ type: 'ADD_PROFILE', profile: makeProfileFixture() })
dispatch({ type: 'UPDATE_METRICS', connId: 'c1', metrics: makeMetrics({ jobs: [...] }) })
```

(`ADD_PROFILE` creates the live entry; `UPDATE_METRICS` payload shape is unchanged.) Keep all assertions as-is — component rendering is unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Known acceptable failures at this point: NONE in test files. (`App.jsx` still imports the old AppContext shape — it compiles because `state.connections` is merely `undefined` there until Task 8; App is not under unit test.)

- [ ] **Step 6: Commit**

```bash
git add src/context/AppContext.jsx src/components/Dashboard.jsx src/components/JobsPanel.jsx src/components/SessionsPanel.jsx src/components/CollapsibleSection.jsx src/test/helpers.jsx src/test/setup.js src/__tests__/context/reducer.test.jsx src/__tests__/components/JobsPanel.test.jsx src/__tests__/components/SessionsPanel.test.jsx
git commit -m "refactor(context): slim AppContext to UI prefs; dashboard components read ConnectionContext"
```

---

### Task 6: Sidebar UI — ConnectionSidebar, ConnectionList, ConnectionItem, ConnectionContextMenu + Header wiring

**Files:**
- Create: `src/components/ConnectionSidebar.jsx`, `src/components/ConnectionList.jsx`, `src/components/ConnectionItem.jsx`, `src/components/ConnectionContextMenu.jsx`
- Modify: `src/components/Header.jsx:74-79` (hamburger becomes a button), `Header.jsx:80-100` (add refresh-all button)
- Test: `src/__tests__/components/ConnectionList.test.jsx`

**Interfaces:**
- Consumes: `useConnections()` (Task 4): `enrichedConnections`, `isInitializing`, `isRefreshing`, `setSelected`, `reconnect`, `renameConnection`, `removeConnection`, `refreshAllConnections`; `useApp()` (Task 5): `sidebarOpen`, `SET_SIDEBAR_OPEN`.
- Produces (used by Tasks 7–8):
  - `<ConnectionSidebar open onClose onAddConnection onRequestPassword(id) />`
  - `<ConnectionList onAddConnection onRequestPassword />`
  - `<ConnectionItem enriched onSelect(id) onOpenMenu(id, x, y) />`
  - `<ConnectionContextMenu enriched x y onClose onRequestPassword(id) />`

Visual rules (spec §5): panel width 288px, left side, slide animation matching `WidgetSidebar.jsx:154-163` pattern (but `left:0` / `translateX(-100%)`); status = icon + color, never color alone; skeletons while `isInitializing`; pinned Add button; selected row gets accent border.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/components/ConnectionList.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest'
import { screen, act } from '@testing-library/react'
import React, { useEffect } from 'react'
import { renderWithContext, makeProfileFixture } from '../../test/helpers'
import { useConnections } from '../../context/ConnectionContext'
import ConnectionList from '../../components/ConnectionList'

function Harness({ seed = [], onCtx }) {
  const ctx = useConnections()
  useEffect(() => {
    seed.forEach(p => ctx.dispatch({ type: 'ADD_PROFILE', profile: p }))
    onCtx?.(ctx)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <ConnectionList onAddConnection={() => {}} onRequestPassword={() => {}} />
}

describe('ConnectionList', () => {
  it('shows empty state with call-to-action when no profiles', async () => {
    renderWithContext(<Harness />)
    expect(await screen.findByText(/no saved connections/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add connection/i })).toBeInTheDocument()
  })

  it('renders one row per profile with server name', async () => {
    renderWithContext(<Harness seed={[
      makeProfileFixture({ id: 'a', displayName: 'Prod', serverName: 'HCMPSDB01' }),
      makeProfileFixture({ id: 'b', displayName: 'Dev', serverName: 'DEVBOX', displayOrder: 1 }),
    ]} />)
    expect(await screen.findByText('Prod')).toBeInTheDocument()
    expect(screen.getByText('Dev')).toBeInTheDocument()
    expect(screen.getByText('HCMPSDB01')).toBeInTheDocument()
  })

  it('marks the selected row with aria-current', async () => {
    renderWithContext(<Harness seed={[makeProfileFixture({ id: 'a', displayName: 'Prod' })]} />)
    const row = (await screen.findByText('Prod')).closest('[role="button"], button')
    expect(row).toHaveAttribute('aria-current', 'true')
  })

  it('status indicator has an accessible label, not color alone', async () => {
    renderWithContext(<Harness seed={[makeProfileFixture({ id: 'a', displayName: 'Prod' })]} />)
    await screen.findByText('Prod')
    // ADD_PROFILE creates status 'connected'
    expect(screen.getByLabelText(/connected/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/components/ConnectionList.test.jsx`
Expected: FAIL — cannot resolve `ConnectionList`.

- [ ] **Step 3: Create `src/components/ConnectionItem.jsx`**

```jsx
import React from 'react'
import { CheckCircle2, Loader2, XCircle, KeyRound, MoreHorizontal } from 'lucide-react'

const STATUS_META = {
  connected:    { Icon: CheckCircle2, color: '#10b981', label: 'Connected' },
  connecting:   { Icon: Loader2,      color: '#f59e0b', label: 'Connecting', spin: true },
  reconnecting: { Icon: Loader2,      color: '#f59e0b', label: 'Reconnecting', spin: true },
  disconnected: { Icon: XCircle,      color: '#ef4444', label: 'Disconnected' },
  failed:       { Icon: XCircle,      color: '#ef4444', label: 'Connection failed' },
  expired:      { Icon: KeyRound,     color: 'var(--text-muted)', label: 'Password required' },
}

export default function ConnectionItem({ enriched, onSelect, onOpenMenu }) {
  const { profile, live, displayStatus, isSelected } = enriched
  const meta = STATUS_META[displayStatus] || STATUS_META.disconnected
  const tooltip = live?.lastError ? `${meta.label} — ${live.lastError}` : meta.label

  return (
    <button
      onClick={() => onSelect(profile.id)}
      onContextMenu={e => { e.preventDefault(); onOpenMenu(profile.id, e.clientX, e.clientY) }}
      aria-current={isSelected ? 'true' : 'false'}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg mb-0.5 text-left transition-colors focus:outline-none focus-visible:ring-2"
      style={{
        background: isSelected ? 'var(--section-hover)' : 'transparent',
        borderLeft: `3px solid ${isSelected ? (profile.color || '#3b82f6') : 'transparent'}`,
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--row-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = isSelected ? 'var(--section-hover)' : 'transparent' }}
    >
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ background: profile.color || '#3b82f6' }}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {profile.displayName}
        </span>
        <span className="block text-xs truncate" style={{ color: 'var(--text-muted)' }}>
          {profile.serverName}
        </span>
      </span>
      <span title={tooltip} aria-label={meta.label} className="flex-shrink-0 flex items-center">
        <meta.Icon size={15} color={meta.color} className={meta.spin ? 'animate-spin' : ''} />
      </span>
      <span
        role="button"
        tabIndex={-1}
        aria-label={`Actions for ${profile.displayName}`}
        className="flex-shrink-0 p-0.5 rounded"
        style={{ color: 'var(--text-muted)' }}
        onClick={e => { e.stopPropagation(); onOpenMenu(profile.id, e.clientX, e.clientY) }}
      >
        <MoreHorizontal size={15} />
      </span>
    </button>
  )
}
```

- [ ] **Step 4: Create `src/components/ConnectionContextMenu.jsx`**

```jsx
import React, { useEffect, useRef } from 'react'
import { RotateCw, Pencil, Trash2 } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'

function MenuItem({ icon: Icon, label, onClick, disabled, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ color: danger ? '#ef4444' : 'var(--text-primary)' }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--row-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <Icon size={14} />
      {label}
    </button>
  )
}

export default function ConnectionContextMenu({ enriched, x, y, onClose, onRequestPassword }) {
  const { reconnect, renameConnection, removeConnection } = useConnections()
  const ref = useRef(null)
  const { profile, displayStatus } = enriched
  const busy = displayStatus === 'connecting' || displayStatus === 'reconnecting'

  useEffect(() => {
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const onKey  = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function handleReconnect() {
    onClose()
    if (profile.authenticationType === 'sql') onRequestPassword(profile.id)
    else reconnect(profile.id).catch(() => {})
  }

  function handleRename() {
    onClose()
    const name = window.prompt('Rename connection', profile.displayName)
    if (name && name.trim()) renameConnection(profile.id, name.trim())
  }

  function handleRemove() {
    onClose()
    if (window.confirm(`Remove "${profile.displayName}"? This deletes the saved connection.`)) {
      removeConnection(profile.id)
    }
  }

  return (
    <div
      ref={ref}
      className="fixed z-[70] rounded-xl py-1 min-w-[180px] overflow-hidden"
      style={{
        left: Math.min(x, window.innerWidth - 200),
        top:  Math.min(y, window.innerHeight - 140),
        background: 'var(--card-bg)',
        border: '1px solid var(--input-border)',
        boxShadow: 'var(--card-shadow)',
      }}
    >
      <MenuItem icon={RotateCw} label="Reconnect" onClick={handleReconnect} disabled={busy} />
      <MenuItem icon={Pencil} label="Rename" onClick={handleRename} />
      <div className="my-1" style={{ borderTop: '1px solid var(--divider)' }} />
      <MenuItem icon={Trash2} label="Remove" onClick={handleRemove} danger />
    </div>
  )
}
```

- [ ] **Step 5: Create `src/components/ConnectionList.jsx`**

```jsx
import React, { useState, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'
import ConnectionItem from './ConnectionItem'
import ConnectionContextMenu from './ConnectionContextMenu'

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 mb-0.5 animate-pulse">
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--divider)' }} />
      <span className="flex-1">
        <span className="block h-3 rounded mb-1.5 w-2/3" style={{ background: 'var(--divider)' }} />
        <span className="block h-2.5 rounded w-1/2" style={{ background: 'var(--divider)' }} />
      </span>
    </div>
  )
}

export default function ConnectionList({ onAddConnection, onRequestPassword }) {
  const { enrichedConnections, isInitializing, setSelected, getEnrichedConnection } = useConnections()
  const [menu, setMenu] = useState(null)   // { id, x, y }
  const scrollRef = useRef(null)           // stable ref preserves scroll across re-renders

  function handleSelect(id) {
    setSelected(id)
    const e = getEnrichedConnection(id)
    // Expired: select first (consistent behavior), then prompt for password
    if (e?.displayStatus === 'expired') onRequestPassword(id)
  }

  function handleKeyDown(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(scrollRef.current?.querySelectorAll('button[aria-current]') ?? [])]
    const idx = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? items[idx + 1] ?? items[0] : items[idx - 1] ?? items[items.length - 1]
    next?.focus()
  }

  const menuEnriched = menu ? getEnrichedConnection(menu.id) : null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Pinned Add button — always visible, list scrolls beneath it */}
      <div className="px-3 pt-3 pb-2 flex-shrink-0">
        <button
          onClick={onAddConnection}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-90"
          style={{ background: 'var(--header-bg)' }}
        >
          <Plus size={14} />
          Add Connection
        </button>
      </div>

      <div ref={scrollRef} onKeyDown={handleKeyDown} className="flex-1 overflow-y-auto px-2 pb-3" style={{ scrollbarWidth: 'thin' }}>
        {isInitializing ? (
          <>
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </>
        ) : enrichedConnections.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>No saved connections</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Add a SQL Server instance to start monitoring.</p>
          </div>
        ) : (
          enrichedConnections.map(e => (
            <ConnectionItem
              key={e.profile.id}
              enriched={e}
              onSelect={handleSelect}
              onOpenMenu={(id, x, y) => setMenu({ id, x, y })}
            />
          ))
        )}
      </div>

      {menuEnriched && (
        <ConnectionContextMenu
          enriched={menuEnriched}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRequestPassword={onRequestPassword}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 6: Create `src/components/ConnectionSidebar.jsx`**

Left-side mirror of the `WidgetSidebar.jsx:142-163` slide-out pattern:

```jsx
import React, { useEffect } from 'react'
import { X } from 'lucide-react'
import ConnectionList from './ConnectionList'

export default function ConnectionSidebar({ open, onClose, onAddConnection, onRequestPassword }) {
  useEffect(() => {
    if (!open) return
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40" style={{ background: 'rgba(0,0,0,.35)' }} onClick={onClose} />
      )}
      <div
        className="fixed top-0 left-0 h-full z-50 flex flex-col"
        style={{
          width: 288,
          background: 'var(--card-bg)',
          borderRight: '1px solid var(--input-border)',
          boxShadow: '8px 0 32px rgba(0,0,0,.25)',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform .22s cubic-bezier(.4,0,.2,1)',
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--divider)' }}
        >
          <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Connections</span>
          <button
            onClick={onClose}
            aria-label="Close connections sidebar"
            className="p-1 rounded-md transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={16} />
          </button>
        </div>
        <ConnectionList onAddConnection={onAddConnection} onRequestPassword={onRequestPassword} />
      </div>
    </>
  )
}
```

- [ ] **Step 7: Wire Header — hamburger opens sidebar, add global refresh button**

In `src/components/Header.jsx`:

Add imports (line 4 area):
```jsx
import { LayoutDashboard, RefreshCw } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'
```

Inside the `Header` component body (after `useApp()` at line 49), add:
```jsx
  const { isRefreshing, refreshAllConnections } = useConnections()
```

Replace the decorative hamburger svg (lines 74–78) with a button (same svg inside):
```jsx
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
```

In the right-side controls (before the Widgets button at line 88), add:
```jsx
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
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run src/__tests__/components/ConnectionList.test.jsx`
Expected: PASS.
Run: `npx vitest run`
Expected: full suite PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/ConnectionSidebar.jsx src/components/ConnectionList.jsx src/components/ConnectionItem.jsx src/components/ConnectionContextMenu.jsx src/components/Header.jsx src/__tests__/components/ConnectionList.test.jsx
git commit -m "feat(sidebar): persistent Connections section with status indicators and context menu"
```

---

### Task 7: ReconnectModal + ConnectModal goes through ConnectionContext

**Files:**
- Create: `src/components/ReconnectModal.jsx`
- Modify: `src/components/ConnectModal.jsx:154` (props), `:190-208` (submitConnect), `:375-397` (add remember-password checkbox)

**Interfaces:**
- Consumes: `useConnections()`: `addConnection(form)`, `reconnect(id, password)`, `getProfile(id)`; `setSessionPassword` from `profileStore`; existing `Dialog` primitives (`src/components/ui/Dialog.jsx`).
- Produces (used by Task 8):
  - `<ReconnectModal connectionId onClose />` — renders nothing when `connectionId` is null.
  - `<ConnectModal open onClose />` — `onConnected`/`prefillError` props REMOVED; form field names unchanged plus new `rememberPassword: boolean`.

- [ ] **Step 1: Create `src/components/ReconnectModal.jsx`**

```jsx
import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { KeyRound } from 'lucide-react'
import { useConnections } from '../context/ConnectionContext'
import { setSessionPassword } from '../lib/profileStore'

export default function ReconnectModal({ connectionId, onClose }) {
  const { getProfile, reconnect } = useConnections()
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const profile = connectionId ? getProfile(connectionId) : null

  useEffect(() => {
    setPassword(''); setRemember(false); setError(''); setLoading(false)
  }, [connectionId])

  if (!profile) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      await reconnect(profile.id, password)
      if (remember && password) setSessionPassword(profile.id, password)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent style={{ maxWidth: 420, background: 'var(--card-bg)', border: '1px solid var(--input-border)' }}>
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
            <KeyRound size={16} style={{ color: 'var(--text-secondary)' }} />
          </span>
          <div className="min-w-0">
            <DialogTitle style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
              Reconnect to {profile.displayName}
            </DialogTitle>
            <p className="text-xs truncate m-0" style={{ color: 'var(--text-muted)' }}>
              {profile.serverName} — SQL authentication ({profile.username})
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} autoComplete="off">
          <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            required
            autoComplete="current-password"
            className="w-full rounded-lg px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />

          <label className="flex items-center gap-2.5 mt-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: 'var(--sort-active)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Remember password for this session (cleared when browser closes)
            </span>
          </label>

          {error && (
            <div className="mt-3 rounded-lg px-3 py-2 text-xs font-medium"
                 style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-4 rounded-lg py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed"
            style={{ background: loading ? 'var(--input-border)' : 'var(--sort-active)' }}
          >
            {loading ? 'Reconnecting…' : 'Reconnect'}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Route ConnectModal through the context**

In `src/components/ConnectModal.jsx`:

Line 1 area — add import:
```jsx
import { useConnections } from '../context/ConnectionContext'
```

Line 154 — change signature and add state/hook (remove `onConnected`, `prefillError`):
```jsx
export default function ConnectModal({ open, onClose }) {
  const { addConnection } = useConnections()
  const [rememberPassword, setRememberPassword] = useState(false)
```

In the reset effect (lines 171–188): add `setRememberPassword(false)` alongside the other resets, and change the error line to `setError('')` (prefillError is gone).

Replace `submitConnect` (lines 190–208):
```jsx
  async function submitConnect(body) {
    setError('')
    setLoading(true)
    try {
      await addConnection(body)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }
```

In `handleLoginSubmit` (line 210), add `rememberPassword` to the body:
```jsx
      appIntent, color: selectedColor, rememberPassword,
```

- [ ] **Step 3: Add the remember-password checkbox to the SQL auth block**

Inside the `{authType === 'sql' && (...)}` block (after the username/password grid, lines 375–397), append below the grid `div`:

```jsx
                {authType === 'sql' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none', marginTop: -4 }}>
                    <input
                      type="checkbox"
                      checked={rememberPassword}
                      onChange={e => setRememberPassword(e.target.checked)}
                      style={{ width: 15, height: 15, cursor: 'pointer', accentColor: T.accent, flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 12, color: T.textSub }}>
                      Remember password for this session (never saved to disk)
                    </span>
                  </label>
                )}
```

- [ ] **Step 4: Verify build**

Run: `npx vite build`
Expected: FAILS or warns only where `App.jsx` still passes `onConnected`/`prefillError` — that is fixed in Task 8. If the build fully succeeds (unused props are legal JSX), that's fine too. Run `npx vitest run` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ReconnectModal.jsx src/components/ConnectModal.jsx
git commit -m "feat(connections): ReconnectModal for expired SQL-auth profiles; ConnectModal routes through ConnectionContext"
```

---

### Task 8: App integration — remove TabBar, wire sidebar + modals, delete legacy code

**Files:**
- Modify: `src/App.jsx` (full rewrite below)
- Delete: `src/components/TabBar.jsx`, `src/hooks/useSocket.js`

**Interfaces:**
- Consumes: everything above. No new exports.

- [ ] **Step 1: Rewrite `src/App.jsx`**

The legacy mount-reconnect effect, `handleConnected`, `handleRemoveConnection`, and all direct localStorage/socket access are DELETED — ConnectionContext owns all of it now.

```jsx
import React, { useState, useEffect } from 'react'
import { useApp } from './context/AppContext'
import { useConnections } from './context/ConnectionContext'
import { applyPalette } from './lib/palettes'
import Header from './components/Header'
import ConnectModal from './components/ConnectModal'
import ReconnectModal from './components/ReconnectModal'
import ConnectionSidebar from './components/ConnectionSidebar'
import Dashboard from './components/Dashboard'
import WidgetSidebar from './components/WidgetSidebar'

export default function App() {
  const { state, dispatch } = useApp()
  const { profiles, selectedConnectionId, selectedConnection, isInitializing } = useConnections()
  const [showConnect,    setShowConnect]    = useState(false)
  const [showWidgets,    setShowWidgets]    = useState(false)
  const [reconnectId,    setReconnectId]    = useState(null)

  useEffect(() => {
    applyPalette(state.palette)
  }, [state.palette])

  // First run with no saved profiles: open the connect modal
  useEffect(() => {
    if (!isInitializing && profiles.length === 0) setShowConnect(true)
  }, [isInitializing, profiles.length])

  const isConnected = !!selectedConnection?.lastUpdate
  const closeSidebar = () => dispatch({ type: 'SET_SIDEBAR_OPEN', open: false })

  return (
    <div className="min-h-screen" style={{ background: 'var(--body-bg)', color: 'var(--body-text)' }}>
      <Header connected={isConnected} onToggleWidgets={() => setShowWidgets(v => !v)} widgetSidebarOpen={showWidgets} />
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
```

- [ ] **Step 2: Delete dead files**

```bash
git rm src/components/TabBar.jsx src/hooks/useSocket.js
```

Then verify nothing still imports them:
Run: `npx vite build`
Expected: build succeeds with no unresolved-import errors.

- [ ] **Step 3: Run full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(app): replace TabBar with persistent connection sidebar; ConnectionContext owns lifecycle"
```

---

### Task 9: End-to-end verification + persistence test sweep

**Files:**
- Modify (if needed): `src/__tests__/integration/persistence.test.js`

**Interfaces:** none — verification task.

- [ ] **Step 1: Update legacy persistence tests**

Open `src/__tests__/integration/persistence.test.js`. Any assertion referencing legacy keys updates per this mapping:

| Legacy | New |
|--------|-----|
| `sqlmon-saved-conn` (single object) | `sqlmon-connection-profiles` (array of profiles) |
| `sqlmon-conn-id` | `profile.id` inside the profiles array |
| `sqlmon-saved-pass` (sessionStorage) | `sqlmon-session-passwords` (sessionStorage, object keyed by id) |
| field `authType` | `authenticationType` |
| field `label` | `displayName` |
| field `server` | `serverName` |

If a test asserts the old save-on-connect flow via `App.jsx` handlers (now deleted), rewrite it against `profileStore` functions directly (round-trip + migration already covered in Task 1 — delete duplicates rather than porting them).

- [ ] **Step 2: Full test suite + build**

Run: `npx vitest run`
Expected: PASS, zero skips related to this feature.
Run: `npx vite build`
Expected: success.

- [ ] **Step 3: Manual browser verification (required — UI feature)**

Start: `npm run dev` and open http://localhost:5173. Connect only to the DEV instance (per CLAUDE.md — never production for testing). Verify:

1. Hamburger opens left sidebar (slide-in, backdrop, Escape closes).
2. Add a Windows-auth connection → appears in sidebar with green Connected icon; dashboard renders.
3. Refresh the browser → sidebar repopulates instantly (skeleton → rows), connection auto-reconnects with no ConnectModal flash, selection restored.
4. Add a second connection → switch between them via sidebar; dashboard switches instantly using cached metrics; selection survives refresh.
5. Header Refresh button → spinner runs, stops when metrics arrive (watch for `metricsUpdated` with `refreshRequestId` in the network tab / socket frames).
6. SQL-auth connection with "Remember for this session" OFF → browser refresh → item shows the key icon (expired); clicking it selects it AND opens ReconnectModal; wrong password shows error, correct password reconnects.
7. Context menu: Rename updates the row and persists across refresh; Remove (confirm) deletes the row and clears the dashboard fallback to next profile; Reconnect disabled while connecting.
8. Stop `node server.js` while connected (kill just the server, keep vite) → items go amber (reconnecting) then red (failed) after the single retry; restart server, context-menu Reconnect recovers.
9. DevTools → Application → localStorage: only `sqlmon-connection-profiles`, `sqlmon-ui-state`, `palette`, widget-layout, and `sqlmon-collapsed-*` keys; NO passwords anywhere in localStorage; legacy keys gone.
10. Keyboard: Tab reaches rows, Enter selects, ArrowUp/Down move focus, Escape closes menu/sidebar.

- [ ] **Step 4: Final commit**

```bash
git add src/__tests__/integration/persistence.test.js
git commit -m "test(persistence): migrate integration tests to profile storage keys"
```

---

## Self-Review Notes

- Spec coverage: §1 principles → Tasks 4–5 architecture; §2 data model/storage/migration → Tasks 1–2; §3 state machine/startup → Tasks 2, 4; §4 context API → Task 4; §5 UI/ownership → Tasks 6–8; §6 backend/socket → Task 3; §7 performance → satisfied structurally (cached metrics switch, 204 refresh, memoized enrichment); §8 error matrix → Tasks 2–4; §9 testing → per-task tests + Task 9; §10 phasing → v1.0 menu limited to Reconnect/Rename/Remove.
- Deviation from spec (documented): profile carries the extra connection-config fields (`username`, `encrypt`, `trustServerCert`, `hostNameInCertificate`, `connectionString`) required to rebuild a `/api/connect` body on reconnect. None are credentials.
- Rename uses `window.prompt` in v1.0 (matches existing `window.confirm` usage in the codebase); inline-edit UX deferred to v1.1.

