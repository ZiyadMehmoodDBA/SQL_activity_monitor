'use strict'

async function scanDatabase(pool, db, mode) {
  return {
    db,
    totalIndexes: 0,
    disabledCount: 0,
    fragmented: [],
    missing: [],
    unused: [],
    duplicate: [],
  }
}

module.exports = { scanDatabase }
