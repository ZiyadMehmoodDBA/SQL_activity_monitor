// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  fetchUserDatabases,
  fetchDbWeights,
  calcProgressPct,
  computeHealthScore,
  paginateResults,
  runWithConcurrency,
  scanDatabaseWithTimeout,
} from '../../server/indexScanOrchestrator.js'

// Minimal mock pool factory
function makePool(recordsets) {
  let callCount = 0
  return {
    request: () => ({
      query: async () => ({ recordset: recordsets[callCount++] || [] }),
    }),
  }
}

describe('fetchUserDatabases', () => {
  it('returns database names from recordset', async () => {
    const pool = makePool([[
      { db_name: 'db1' },
      { db_name: 'db2' },
    ]])
    const dbs = await fetchUserDatabases(pool)
    expect(dbs).toEqual(['db1', 'db2'])
  })

  it('returns empty array when no user databases', async () => {
    const pool = makePool([[]])
    expect(await fetchUserDatabases(pool)).toEqual([])
  })
})

describe('fetchDbWeights', () => {
  it('returns weight map by db name', async () => {
    const pool = makePool([[
      { db_name: 'db1', size_bytes: 1_000_000 },
      { db_name: 'db2', size_bytes: 2_000_000 },
    ]])
    const weights = await fetchDbWeights(pool, ['db1', 'db2'])
    expect(weights).toEqual({ db1: 1_000_000, db2: 2_000_000 })
  })

  it('assigns 1 as fallback for DB missing from query result', async () => {
    const pool = makePool([[{ db_name: 'db1', size_bytes: 500_000 }]])
    const weights = await fetchDbWeights(pool, ['db1', 'db2'])
    expect(weights.db1).toBe(500_000)
    expect(weights.db2).toBe(1)
  })
})

describe('calcProgressPct', () => {
  it('returns 0 when totalWeight is 0', () => {
    expect(calcProgressPct(0, 0)).toBe(0)
  })
  it('returns correct pct', () => {
    expect(calcProgressPct(25, 100)).toBeCloseTo(25)
  })
  it('caps at 100', () => {
    expect(calcProgressPct(200, 100)).toBe(100)
  })
})

describe('computeHealthScore', () => {
  it('returns score 100 with Healthy when no indexes', () => {
    const result = computeHealthScore([])
    expect(result.score).toBe(100)
    expect(result.severity).toBe('Healthy')
    expect(result.totalIndexes).toBe(0)
  })

  it('returns Critical when many rebuild-needed indexes', () => {
    const dbResults = [{
      totalIndexes: 10,
      disabledCount: 0,
      fragmented: Array(8).fill({ recommendation: 'REBUILD' }),
      missing: [],
      unused: [],
      duplicate: [],
    }]
    const result = computeHealthScore(dbResults)
    expect(result.score).toBeLessThan(70)
    expect(result.severity).toBe('Critical')
    expect(result.fragmentedCount).toBe(8)
  })

  it('aggregates across multiple DB results', () => {
    const dbResults = [
      { totalIndexes: 5, disabledCount: 0, fragmented: [{ recommendation: 'REBUILD' }], missing: [], unused: [], duplicate: [] },
      { totalIndexes: 5, disabledCount: 0, fragmented: [{ recommendation: 'OK' }], missing: [], unused: [], duplicate: [] },
    ]
    const result = computeHealthScore(dbResults)
    expect(result.totalIndexes).toBe(10)
    expect(result.fragmentedCount).toBe(1)
  })

  it('returns Warning for score 70-90', () => {
    const dbResults = [{
      totalIndexes: 10,
      disabledCount: 0,
      fragmented: [{ recommendation: 'REBUILD' }, { recommendation: 'REBUILD' }, { recommendation: 'REBUILD' }, { recommendation: 'REBUILD' }],
      missing: [{ index_name: 'IX_1' }],
      unused: [],
      duplicate: [{ index_name: 'IX_2' }],
    }]
    const result = computeHealthScore(dbResults)
    expect(result.severity).toBe('Warning')
  })
})

describe('paginateResults', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    database_name: i < 5 ? 'db1' : 'db2',
    table_name: `Table${i}`,
    index_name: `IX_${i}`,
  }))

  it('returns first page with correct total', () => {
    const r = paginateResults(rows, { page: 1, pageSize: 3 })
    expect(r.total).toBe(10)
    expect(r.rows.length).toBe(3)
    expect(r.page).toBe(1)
    expect(r.pageSize).toBe(3)
  })

  it('filters by database name', () => {
    const r = paginateResults(rows, { page: 1, pageSize: 50, db: 'db1' })
    expect(r.total).toBe(5)
    expect(r.rows.every(r => r.database_name === 'db1')).toBe(true)
  })

  it('filters by search text (table_name)', () => {
    const r = paginateResults(rows, { page: 1, pageSize: 50, search: 'table3' })
    expect(r.total).toBe(1)
    expect(r.rows[0].table_name).toBe('Table3')
  })

  it('returns empty rows for out-of-range page', () => {
    const r = paginateResults(rows, { page: 99, pageSize: 5 })
    expect(r.total).toBe(10)
    expect(r.rows.length).toBe(0)
  })
})

describe('runWithConcurrency', () => {
  it('runs all items and collects results', async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await runWithConcurrency(items, 3, async (n) => n * 2, () => false)
    expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10])
  })

  it('respects concurrency limit', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const items = Array.from({ length: 6 }, (_, i) => i)
    await runWithConcurrency(items, 2, async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 10))
      concurrent--
    }, () => false)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('stops early when shouldStop returns true', async () => {
    const processed = []
    const items = [1, 2, 3, 4, 5]
    await runWithConcurrency(
      items,
      1,
      async (n) => { processed.push(n) },
      () => processed.length >= 1
    )
    expect(processed.length).toBeLessThanOrEqual(2)
  })
})

describe('scanDatabaseWithTimeout', () => {
  it('returns db result on success', async () => {
    const mockScan = async () => ({ db: 'testdb', totalIndexes: 5, fragmented: [], missing: [], unused: [], duplicate: [], disabledCount: 0 })
    const result = await scanDatabaseWithTimeout(null, 'testdb', 'LIMITED', 5000, mockScan)
    expect(result.db).toBe('testdb')
    expect(result.timedOut).toBeUndefined()
  })

  it('returns timedOut=true when scanner exceeds timeout', async () => {
    const slowScan = async () => new Promise(r => setTimeout(r, 500))
    const result = await scanDatabaseWithTimeout(null, 'testdb', 'LIMITED', 50, slowScan)
    expect(result.timedOut).toBe(true)
    expect(result.db).toBe('testdb')
    expect(result.fragmented).toEqual([])
  })
})
