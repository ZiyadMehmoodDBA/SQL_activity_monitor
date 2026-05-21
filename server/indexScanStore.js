'use strict'
// MemoryScanStore — in-memory scan state. IScanStore interface:
//   create(scanId, connId, scanMode, databases) → record
//   update(scanId, patch) → record | null
//   get(scanId) → record | null
//   getActiveScanByConn(connId) → record | null   (status pending|running)
//   cancel(scanId) → boolean
//   cleanup(nowMs, ttlMs) → number  (count deleted)

class MemoryScanStore {
  constructor() {
    this._scans = new Map()
  }
}

module.exports = { MemoryScanStore }
