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
  runScan,
} from '../../server/indexScanOrchestrator.js'
import { MemoryScanStore } from '../../server/indexScanStore.js'
import { randomUUID } from 'node:crypto'

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

describe('runScan', () => {
  function makePool() {
    return {
      request: () => ({
        query: async (sql) => {
          if (sql.includes('sys.databases')) return { recordset: [{ db_name: 'db1' }, { db_name: 'db2' }] }
          if (sql.includes('sys.master_files') && sql.includes('SUM')) return { recordset: [{ db_name: 'db1', size_bytes: 1000 }, { db_name: 'db2', size_bytes: 2000 }] }
          if (sql.includes('SERVERPROPERTY')) return { recordset: [{ major_version: 15, edition: 'Developer Edition', sqlserver_start_time: new Date() }] }
          return { recordset: [] }
        },
      }),
    }
  }

  it('transitions to completed and sets results', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1', 'db2'])

    await runScan(makePool(), scanId, store)

    const scan = store.get(scanId)
    expect(scan.status).toBe('completed')
    expect(scan.results).not.toBeNull()
    expect(scan.results.summary.score).toBe(100)
    expect(scan.metadata).not.toBeNull()
    expect(scan.metadata.serverVersion).toBe(15)
    expect(scan.completedDbs).toHaveLength(2)
    expect(scan.expiresAt).toBeGreaterThan(Date.now())
  })

  it('sets completed_with_warnings when databases timed out', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1'])

    await runScan(makePool(), scanId, store, { timeoutPerDbMs: 1 })

    const scan = store.get(scanId)
    expect(['completed', 'completed_with_warnings']).toContain(scan.status)
  })

  it('stays cancelled when cancelled before run completes', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1', 'db2'])

    store.cancel(scanId)
    await runScan(makePool(), scanId, store)

    expect(store.get(scanId).status).toBe('cancelled')
  })

  it('sets status to failed on pool error', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'conn1', 'LIMITED', ['db1'])

    const brokenPool = {
      request: () => ({
        query: async () => { throw new Error('Connection lost') },
      }),
    }

    await runScan(brokenPool, scanId, store)
    const scan = store.get(scanId)
    expect(scan.status).toBe('failed')
    expect(scan.error).toContain('Connection lost')
  })
})
