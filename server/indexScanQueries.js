'use strict'

async function scanDatabase(pool, db, mode) {
  return {
    database:     db,
    totalIndexes: 0,
    disabledCount: 0,
    fragmented:   [],
    missing:      [],
    unused:       [],
    duplicate:    [],
    metadata: {
      durationMs:  0,
      startedAt:   new Date().toISOString(),
      completedAt: new Date().toISOString(),
      timeout:     false,
    },
  }
}

module.exports = { scanDatabase }
