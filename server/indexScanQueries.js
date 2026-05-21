'use strict'

/**
 * Returns index data for a single database.
 * Sprint 1 stub — returns empty arrays.
 * Sprint 2 replaces this with real DMV queries.
 *
 * @param {object} pool - mssql ConnectionPool
 * @param {string} db - database name
 * @param {'LIMITED'|'SAMPLED'|'DETAILED'} mode
 * @returns {Promise<{
 *   db: string,
 *   totalIndexes: number,
 *   disabledCount: number,
 *   fragmented: object[],
 *   missing: object[],
 *   unused: object[],
 *   duplicate: object[],
 * }>}
 */
async function scanDatabase(pool, db, mode) {
  // Sprint 1 stub — Sprint 2 replaces with real DMV queries
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
