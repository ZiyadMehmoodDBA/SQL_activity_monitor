// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'
import { runRollup } from '../../server/metricsRollup.js'

const H = 3_600_000, DAY = 86_400_000
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H)

function metricsWith(cpu) {
  return { cpu_percent: cpu, waiting_tasks: 0, db_io_mb: 0, batch_requests: 0,
    serverPerf: {}, resourceWaits: [], blocking: [] }
}

describe('pickResolution', () => {
  it('selects by span per spec', async () => {
    const { pickResolution } = await import('../../server/metricsStore.js')
    expect(pickResolution(2 * H)).toBe('raw')
    expect(pickResolution(2 * H + 1)).toBe('1m')
    expect(pickResolution(48 * H)).toBe('1m')
    expect(pickResolution(48 * H + 1)).toBe('15m')
    expect(pickResolution(14 * DAY)).toBe('15m')
    expect(pickResolution(14 * DAY + 1)).toBe('1h')
  })
})

describe('getHistory', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('raw resolution returns raw rows in range, ordered', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    store.insertSnapshot('S', 'S', metricsWith(20), T0 + 2_000)
    store.insertSnapshot('S', 'S', metricsWith(30), T0 + 10 * H) // outside range
    const { resolution, rows } = store.getHistory('S', T0, T0 + H, 'raw')
    expect(resolution).toBe('raw')
    expect(rows.map(r => r.cpu_pct)).toEqual([10, 20])
  })

  it('auto picks raw for a 1h span', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    expect(store.getHistory('S', T0, T0 + H).resolution).toBe('raw')
  })

  it('unknown instance key → empty rows, no throw', () => {
    expect(store.getHistory('NOPE', T0, T0 + H)).toEqual({ resolution: 'raw', rows: [] })
  })

  it('disabled store → { resolution: null, rows: [] }', () => {
    store.close(); store.initialize('.')
    expect(store.getHistory('S', T0, T0 + H)).toEqual({ resolution: null, rows: [] })
  })

  it('1m resolution serves rolled rows AND fills the un-rolled tail from raw', () => {
    // 2 rolled minutes, then raw-only samples past the watermark
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    store.insertSnapshot('S', 'S', metricsWith(30), T0 + 2_000)
    store.insertSnapshot('S', 'S', metricsWith(50), T0 + 60_000)
    runRollup(store._db(), T0 + 120_000)          // watermark = T0+120000
    store.insertSnapshot('S', 'S', metricsWith(70), T0 + 125_000) // past watermark
    const { rows } = store.getHistory('S', T0, T0 + 180_000, '1m')
    expect(rows.map(r => r.ts)).toEqual([T0, T0 + 60_000, T0 + 120_000])
    expect(rows[0].cpu_pct_avg).toBe(20)       // rolled
    expect(rows[1].cpu_pct_avg).toBe(50)       // rolled
    expect(rows[2].cpu_pct_avg).toBe(70)       // tail aggregated on the fly
    expect(rows[2].sample_count).toBe(1)
  })

  it('tail fill does not duplicate buckets already rolled', () => {
    store.insertSnapshot('S', 'S', metricsWith(10), T0)
    runRollup(store._db(), T0 + 60_000)
    const { rows } = store.getHistory('S', T0, T0 + 60_000, '1m')
    expect(rows.filter(r => r.ts === T0)).toHaveLength(1)
  })
})

describe('getWaitHistory / getBlockingHistory', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('returns wait delta rows in range', () => {
    const w = v => [{ wait_type: 'X', wait_time_ms: v, waiting_tasks_count: v, signal_wait_time_ms: 0, max_wait_time_ms: 0 }]
    store.insertSnapshot('S', 'S', { ...metricsWith(1), resourceWaits: w(100) }, T0)
    store.insertSnapshot('S', 'S', { ...metricsWith(1), resourceWaits: w(300) }, T0 + 60_000)
    const { rows } = store.getWaitHistory('S', T0, T0 + H)
    expect(rows).toHaveLength(1)
    expect(rows[0].wait_time_ms).toBe(200)
  })

  it('returns blocking rows in range; unknown key → empty', () => {
    store.insertSnapshot('S', 'S', { ...metricsWith(1), blocking: [{
      blocking_session_id: 5, blocked_session_id: 6, wait_type: 'LCK_M_X',
      wait_time: 10, database_name: 'db1',
    }] }, T0)
    expect(store.getBlockingHistory('S', T0, T0 + H).rows).toHaveLength(1)
    expect(store.getBlockingHistory('NOPE', T0, T0 + H).rows).toEqual([])
  })
})
