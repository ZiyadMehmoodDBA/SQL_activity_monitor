// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'
import { runRollup } from '../../server/metricsRollup.js'

// T0 on an exact hour boundary so bucket math is easy to eyeball
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000)

function metricsWith(cpu, ple = 300) {
  return {
    cpu_percent: cpu, waiting_tasks: 1, db_io_mb: 0.5, batch_requests: 100,
    serverPerf: { pleSec: ple }, resourceWaits: [], blocking: [],
  }
}

describe('metricsRollup', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('1m rollup: avg/min/max/sample_count with epoch-aligned buckets', () => {
    // 3 samples inside the first minute bucket, 1 in the next
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    store.insertSnapshot('S', 'S', metricsWith(20), T0 + 2_000)
    store.insertSnapshot('S', 'S', metricsWith(60), T0 + 4_000)
    store.insertSnapshot('S', 'S', metricsWith(50), T0 + 61_000)
    runRollup(store._db(), T0 + 180_000) // both buckets fully in the past
    const rows = store._db().prepare('SELECT * FROM samples_1m ORDER BY ts').all()
    expect(rows).toHaveLength(2)
    expect(rows[0].ts).toBe(T0)                 // exact epoch multiple of 60000
    expect(rows[0].cpu_pct_avg).toBe(30)
    expect(rows[0].cpu_pct_min).toBe(10)
    expect(rows[0].cpu_pct_max).toBe(60)
    expect(rows[0].sample_count).toBe(3)
    expect(rows[1].ts).toBe(T0 + 60_000)
    expect(rows[1].sample_count).toBe(1)
  })

  it('incomplete current bucket is NOT rolled up', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    runRollup(store._db(), T0 + 30_000) // bucket [T0, T0+60s) still open
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM samples_1m').get().n).toBe(0)
  })

  it('NULL KPI values are ignored by aggregates, never counted as zero', () => {
    const m = metricsWith(40)
    const mNull = metricsWith(null)
    store.insertSnapshot('S', 'S', m, T0)
    store.insertSnapshot('S', 'S', mNull, T0 + 2_000)
    runRollup(store._db(), T0 + 120_000)
    const row = store._db().prepare('SELECT * FROM samples_1m').get()
    expect(row.cpu_pct_avg).toBe(40) // not 20
    expect(row.cpu_pct_min).toBe(40)
    expect(row.sample_count).toBe(2) // rows counted, values ignored
  })

  it('all-NULL KPI stores NULL for the whole triplet', () => {
    store.insertSnapshot('S', 'S', metricsWith(null), T0)
    runRollup(store._db(), T0 + 120_000)
    const row = store._db().prepare('SELECT * FROM samples_1m').get()
    expect(row.cpu_pct_avg).toBeNull()
    expect(row.cpu_pct_min).toBeNull()
    expect(row.cpu_pct_max).toBeNull()
  })

  it('watermark advances and re-run is idempotent', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    runRollup(store._db(), T0 + 120_000)
    const wm = store._db().prepare(
      "SELECT watermark_ts FROM rollup_state WHERE resolution='1m'").get().watermark_ts
    expect(wm).toBe(T0 + 120_000)
    runRollup(store._db(), T0 + 120_000) // second run: nothing new
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM samples_1m').get().n).toBe(1)
  })

  it('15m rollup weights averages by sample_count', () => {
    // bucket A: 30 samples of cpu=10; bucket B: 10 samples of cpu=50
    for (let i = 0; i < 30; i++) store.insertSnapshot('S', 'S', metricsWith(10), T0 + i * 2_000)
    for (let i = 0; i < 10; i++) store.insertSnapshot('S', 'S', metricsWith(50), T0 + 60_000 + i * 2_000)
    runRollup(store._db(), T0 + 2 * 3_600_000)
    const row15 = store._db().prepare('SELECT * FROM samples_15m').get()
    // weighted: (30*10 + 10*50) / 40 = 20, NOT the unweighted (10+50)/2 = 30
    expect(row15.cpu_pct_avg).toBeCloseTo(20, 5)
    expect(row15.cpu_pct_min).toBe(10)
    expect(row15.cpu_pct_max).toBe(50)
    expect(row15.sample_count).toBe(40)
    // 1h chained from 15m
    const row1h = store._db().prepare('SELECT * FROM samples_1h').get()
    expect(row1h.cpu_pct_avg).toBeCloseTo(20, 5)
    expect(row1h.ts).toBe(T0)
  })

  it('rolls up each server independently', () => {
    store.insertSnapshot('S1', 'S1', metricsWith(10), T0)
    store.insertSnapshot('S2', 'S2', metricsWith(90), T0)
    runRollup(store._db(), T0 + 120_000)
    const rows = store._db().prepare(
      'SELECT s.instance_key, r.cpu_pct_avg FROM samples_1m r JOIN servers s ON s.id = r.server_id ORDER BY s.instance_key').all()
    expect(rows).toEqual([
      { instance_key: 'S1', cpu_pct_avg: 10 },
      { instance_key: 'S2', cpu_pct_avg: 90 },
    ])
  })

  it('store.rollup() is a no-op when disabled', () => {
    store.close()
    store.initialize('.')  // forces disabled mode
    expect(() => store.rollup()).not.toThrow()
  })
})
