// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'

function fakeMetrics(over = {}) {
  return {
    cpu_percent: 42, waiting_tasks: 3, db_io_mb: 1.5, batch_requests: 200,
    serverPerf: {
      sqlMemPct: 80.5, sqlMemGb: 12.2, pleSec: 3000, userConns: 55,
      compilationsSec: 10, recompilationsSec: 1, netMbs: 0.7,
      bufferCacheHit: 99.9, memGrantsPending: 0,
    },
    resourceWaits: [], blocking: [],
    ...over,
  }
}

describe('metricsStore core', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('initialize on :memory: returns true', () => {
    store.close()
    expect(store.initialize(':memory:')).toBe(true)
  })

  it('initialize failure → disabled no-op mode, insertSnapshot does not throw', () => {
    store.close()
    // A directory path is not a valid database file → open fails
    expect(store.initialize('.')).toBe(false)
    expect(() => store.insertSnapshot('SRV1', 'Server 1', fakeMetrics())).not.toThrow()
  })

  it('insertSnapshot writes one samples_raw row with mapped KPI values', () => {
    const now = 1_700_000_000_000
    store.insertSnapshot('SRV1\\PROD', 'Prod box', fakeMetrics(), now)
    const row = store._db().prepare('SELECT * FROM samples_raw').get()
    expect(row.ts).toBe(now)
    expect(row.cpu_pct).toBe(42)
    expect(row.waiting_tasks).toBe(3)
    expect(row.io_mb).toBe(1.5)
    expect(row.batch_req).toBe(200)
    expect(row.sql_mem_pct).toBe(80.5)
    expect(row.ple_sec).toBe(3000)
    expect(row.buffer_cache_hit).toBe(99.9)
    expect(row.mem_grants_pending).toBe(0)
  })

  it('missing/non-numeric KPI values store NULL, not 0', () => {
    const m = fakeMetrics()
    delete m.serverPerf.pleSec
    m.cpu_percent = 'n/a'
    store.insertSnapshot('SRV1', 'S1', m, 1_700_000_000_000)
    const row = store._db().prepare('SELECT cpu_pct, ple_sec FROM samples_raw').get()
    expect(row.cpu_pct).toBeNull()
    expect(row.ple_sec).toBeNull()
  })

  it('upserts servers row: same instance_key reused, display_name/last_seen refreshed', () => {
    store.insertSnapshot('SRV1', 'Old name', fakeMetrics(), 1000)
    store.insertSnapshot('SRV1', 'New name', fakeMetrics(), 2000)
    const rows = store._db().prepare('SELECT * FROM servers').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].instance_key).toBe('SRV1')
    expect(rows[0].display_name).toBe('New name')
    expect(rows[0].first_seen).toBe(1000)
    expect(rows[0].last_seen).toBe(2000)
  })

  it('different instance_key creates a second servers row', () => {
    store.insertSnapshot('SRV1', 'A', fakeMetrics(), 1000)
    store.insertSnapshot('SRV2', 'B', fakeMetrics(), 1000)
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM servers').get().n).toBe(2)
  })

  it('duplicate (server, ts) insert is caught, does not throw', () => {
    store.insertSnapshot('SRV1', 'A', fakeMetrics(), 1000)
    expect(() => store.insertSnapshot('SRV1', 'A', fakeMetrics(), 1000)).not.toThrow()
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM samples_raw').get().n).toBe(1)
  })
})
