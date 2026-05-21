'use strict'

class MemoryScanStore {
  constructor() {
    this._scans = new Map()
  }

  create(scanId, connId, scanMode, databases) {
    const record = {
      scanId,
      connId,
      status: 'pending',
      scanMode,
      databases,
      completedDbs: [],
      timedOutDbs: [],
      totalDbs: databases.length,
      totalWeight: 0,
      completedWeight: 0,
      currentDb: null,
      error: null,
      results: null,
      metadata: null,
      createdAt: Date.now(),
      completedAt: null,
      expiresAt: null,
    }
    this._scans.set(scanId, record)
    return record
  }

  update(scanId, patch) {
    const record = this._scans.get(scanId)
    if (!record) return null
    Object.assign(record, patch)
    return record
  }

  get(scanId) {
    return this._scans.get(scanId) || null
  }

  getActiveScanByConn(connId) {
    for (const s of this._scans.values()) {
      if (s.connId === connId && (s.status === 'pending' || s.status === 'running')) return s
    }
    return null
  }

  cancel(scanId) {
    const record = this._scans.get(scanId)
    if (!record) return false
    if (record.status !== 'pending' && record.status !== 'running') return false
    record.status = 'cancelled'
    record.completedAt = Date.now()
    return true
  }

  cleanup(nowMs) {
    let count = 0
    for (const [id, s] of this._scans.entries()) {
      if (s.expiresAt !== null && nowMs > s.expiresAt) {
        this._scans.delete(id)
        count++
      }
    }
    return count
  }
}

module.exports = { MemoryScanStore }
