// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryScanStore } from '../../server/indexScanStore.js'

describe('MemoryScanStore', () => {
  let store

  beforeEach(() => { store = new MemoryScanStore() })

  describe('create', () => {
    it('returns a record with pending status', () => {
      const r = store.create('scan1', 'conn1', 'LIMITED', ['db1', 'db2'])
      expect(r.scanId).toBe('scan1')
      expect(r.connId).toBe('conn1')
      expect(r.status).toBe('pending')
      expect(r.scanMode).toBe('LIMITED')
      expect(r.databases).toEqual(['db1', 'db2'])
      expect(r.totalDbs).toBe(2)
      expect(r.completedDbs).toEqual([])
      expect(r.timedOutDbs).toEqual([])
      expect(r.totalWeight).toBe(0)
      expect(r.completedWeight).toBe(0)
      expect(r.currentDb).toBeNull()
      expect(r.error).toBeNull()
      expect(r.results).toBeNull()
      expect(r.metadata).toBeNull()
      expect(typeof r.createdAt).toBe('number')
      expect(r.completedAt).toBeNull()
      expect(r.expiresAt).toBeNull()
    })
  })

  describe('get', () => {
    it('returns null for unknown scan', () => {
      expect(store.get('nope')).toBeNull()
    })
    it('returns record after create', () => {
      store.create('s1', 'c1', 'SAMPLED', [])
      expect(store.get('s1')).not.toBeNull()
    })
  })

  describe('update', () => {
    it('merges patch into record', () => {
      store.create('s1', 'c1', 'LIMITED', ['db1'])
      const r = store.update('s1', { status: 'running', currentDb: 'db1' })
      expect(r.status).toBe('running')
      expect(r.currentDb).toBe('db1')
      expect(r.scanId).toBe('s1')  // other fields preserved
    })
    it('returns null for unknown scanId', () => {
      expect(store.update('ghost', { status: 'running' })).toBeNull()
    })
  })

  describe('getActiveScanByConn', () => {
    it('returns null when no scans exist', () => {
      expect(store.getActiveScanByConn('c1')).toBeNull()
    })
    it('returns pending scan for connId', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.getActiveScanByConn('c1')?.scanId).toBe('s1')
    })
    it('returns running scan for connId', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { status: 'running' })
      expect(store.getActiveScanByConn('c1')?.scanId).toBe('s1')
    })
    it('returns null when scan is completed', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { status: 'completed' })
      expect(store.getActiveScanByConn('c1')).toBeNull()
    })
    it('returns null for different connId', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.getActiveScanByConn('c2')).toBeNull()
    })
  })

  describe('cancel', () => {
    it('sets status to cancelled and returns true', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.cancel('s1')).toBe(true)
      expect(store.get('s1').status).toBe('cancelled')
    })
    it('returns false for unknown scanId', () => {
      expect(store.cancel('ghost')).toBe(false)
    })
    it('returns false when already completed', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { status: 'completed' })
      expect(store.cancel('s1')).toBe(false)
      expect(store.get('s1').status).toBe('completed')
    })
  })

  describe('cleanup', () => {
    it('deletes expired scans', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { expiresAt: Date.now() - 1 })
      const count = store.cleanup(Date.now())
      expect(count).toBe(1)
      expect(store.get('s1')).toBeNull()
    })
    it('keeps non-expired scans', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      store.update('s1', { expiresAt: Date.now() + 60_000 })
      expect(store.cleanup(Date.now())).toBe(0)
      expect(store.get('s1')).not.toBeNull()
    })
    it('keeps scans with null expiresAt (still running)', () => {
      store.create('s1', 'c1', 'LIMITED', [])
      expect(store.cleanup(Date.now())).toBe(0)
    })
  })
})
