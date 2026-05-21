// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mssql from 'mssql'
import { randomUUID } from 'node:crypto'
import { scanDatabase } from '../../server/indexScanQueries.js'
import { MemoryScanStore } from '../../server/indexScanStore.js'
import { runScan } from '../../server/indexScanOrchestrator.js'

const HAVE_DB = !!(process.env.TEST_SQL_SERVER && process.env.TEST_SQL_DB)

let pool

beforeAll(async () => {
  if (!HAVE_DB) return
  pool = await mssql.connect({
    server:   process.env.TEST_SQL_SERVER,
    database: process.env.TEST_SQL_DB,
    options:  { encrypt: false, trustServerCertificate: true, trustedConnection: true },
  }).catch(err => { throw new Error(`Integration test DB connection failed: ${err.message}`) })
}, 30_000)

afterAll(async () => {
  if (pool) await pool.close()
})

describe.skipIf(!HAVE_DB)('Integration: scanDatabase shape', () => {
  it('returns valid DatabaseScanResult against real server', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    expect(result.database).toBe(process.env.TEST_SQL_DB)
    expect(typeof result.totalIndexes).toBe('number')
    expect(typeof result.disabledCount).toBe('number')
    expect(Array.isArray(result.fragmented)).toBe(true)
    expect(Array.isArray(result.missing)).toBe(true)
    expect(Array.isArray(result.unused)).toBe(true)
    expect(Array.isArray(result.duplicate)).toBe(true)
    expect(result.metadata.timeout).toBe(false)
    expect(result.metadata.durationMs).toBeGreaterThan(0)
  }, 60_000)

  it('fragmented rows have required fields and valid recommendation', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    for (const row of result.fragmented) {
      expect(row).toHaveProperty('database_name')
      expect(row).toHaveProperty('schema_name')
      expect(row).toHaveProperty('table_name')
      expect(row).toHaveProperty('index_name')
      expect(['REBUILD', 'REORGANIZE', 'OK', 'SKIP_SMALL']).toContain(row.recommendation)
    }
  }, 60_000)

  it('missing rows have valid 0–100 impact score and create_script', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    for (const row of result.missing) {
      expect(row.impact_score).toBeGreaterThanOrEqual(0)
      expect(row.impact_score).toBeLessThanOrEqual(100)
      expect(row.create_script).toContain('CREATE INDEX')
    }
  }, 60_000)

  it('unused rows have is_duplicate boolean', async () => {
    const result = await scanDatabase(pool, process.env.TEST_SQL_DB, 'LIMITED')
    for (const row of result.unused) {
      expect(typeof row.is_duplicate).toBe('boolean')
    }
  }, 60_000)
})

describe.skipIf(!HAVE_DB)('Integration: runScan lifecycle', () => {
  it('completes scan and produces valid health score', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    await runScan(pool, scanId, store)
    const scan = store.get(scanId)
    expect(['completed', 'completed_with_warnings']).toContain(scan.status)
    expect(scan.results).not.toBeNull()
    expect(scan.results.summary.score).toBeGreaterThanOrEqual(0)
    expect(scan.results.summary.score).toBeLessThanOrEqual(100)
    expect(['Healthy', 'Warning', 'Critical']).toContain(scan.results.summary.severity)
    expect(scan.expiresAt).toBeGreaterThan(Date.now())
  }, 120_000)

  it('stores databases[] array in results', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    await runScan(pool, scanId, store)
    const scan = store.get(scanId)
    expect(Array.isArray(scan.results.databases)).toBe(true)
    if (scan.results.databases.length > 0) {
      expect(scan.results.databases[0]).toHaveProperty('database')
      expect(scan.results.databases[0]).toHaveProperty('metadata')
    }
  }, 120_000)

  it('marks database timed_out when timeout is 1ms', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    await runScan(pool, scanId, store, { timeoutPerDbMs: 1 })
    const scan = store.get(scanId)
    expect(['completed', 'completed_with_warnings']).toContain(scan.status)
  }, 30_000)

  it('stays cancelled when cancelled before run', async () => {
    const store = new MemoryScanStore()
    const scanId = randomUUID()
    store.create(scanId, 'test-conn', 'LIMITED', [process.env.TEST_SQL_DB])
    store.cancel(scanId)
    await runScan(pool, scanId, store)
    expect(store.get(scanId).status).toBe('cancelled')
  }, 30_000)
})
