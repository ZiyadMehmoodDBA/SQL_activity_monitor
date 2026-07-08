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
