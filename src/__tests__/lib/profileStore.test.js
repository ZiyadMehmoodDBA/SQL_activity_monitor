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
