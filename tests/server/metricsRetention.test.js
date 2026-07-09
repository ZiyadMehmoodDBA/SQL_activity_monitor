// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'
import { prune, RETENTION } from '../../server/metricsRetention.js'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

function metricsWith() {
  return { cpu_percent: 1, waiting_tasks: 0, db_io_mb: 0, batch_requests: 0,
    serverPerf: {}, resourceWaits: [], blocking: [] }
}

describe('metricsRetention', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('retention ladder matches the spec', () => {
    const map = Object.fromEntries(RETENTION.map(r => [r.table, r.keepMs]))
    expect(map.samples_raw).toBe(7 * DAY)
    expect(map.samples_1m).toBe(90 * DAY)
    expect(map.samples_15m).toBe(365 * DAY)
    expect(map.waits_samples).toBe(90 * DAY)
    expect(map.blocking_events).toBe(365 * DAY)
    expect(map.samples_1h).toBeUndefined() // kept forever
  })

  it('prune removes only rows older than each cutoff', () => {
    const db = store._db()
    store.insertSnapshot('S', 'S', metricsWith(), NOW - 8 * DAY)  // expired raw
    store.insertSnapshot('S', 'S', metricsWith(), NOW - 6 * DAY)  // kept raw
    const sid = db.prepare('SELECT id FROM servers').get().id
    db.prepare(`INSERT INTO samples_1h (server_id, ts, sample_count) VALUES (?, ?, 1)`)
      .run(sid, NOW - 400 * DAY) // ancient 1h row must survive
    db.prepare(`INSERT INTO waits_samples (server_id, ts, wait_type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms)
      VALUES (?, ?, 'X', 1, 1, 1)`).run(sid, NOW - 91 * DAY)
    const deleted = prune(db, NOW)
    expect(deleted.samples_raw).toBe(1)
    expect(deleted.waits_samples).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM samples_raw').get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM samples_1h').get().n).toBe(1)
  })

  it('store.prune/vacuum/checkpoint do not throw (enabled or disabled)', () => {
    expect(() => { store.prune(); store.vacuum(); store.checkpoint() }).not.toThrow()
    store.close()
    store.initialize('.') // disabled mode
    expect(() => { store.prune(); store.vacuum(); store.checkpoint() }).not.toThrow()
  })

  it('health() reports enabled:false in disabled mode', () => {
    store.close()
    store.initialize('.')
    expect(store.health()).toEqual({ enabled: false })
  })

  it('health() reports counts, servers, schema version, meta', () => {
    store.insertSnapshot('S', 'Server S', metricsWith(), NOW - 1_000)
    const h = store.health(NOW)
    expect(h.enabled).toBe(true)
    expect(h.schemaVersion).toBe(2)
    expect(h.counts.samples_raw).toBe(1)
    expect(h.servers).toHaveLength(1)
    expect(h.servers[0].instance_key).toBe('S')
    expect(h.servers[0].oldest_raw).toBe(NOW - 1_000)
    expect(h.servers[0].newest_raw).toBe(NOW - 1_000)
    expect(h.meta.last_insert_at).toBe(String(NOW - 1_000))
    expect(h.insertErrorCount).toBe(0)
    expect(h.rawInsertRatePerSec).toBeCloseTo(1 / 60, 5)
    expect(h.migrations).toHaveLength(2)
  })

  it('alerts older than 365d are pruned on started_at', () => {
    store.insertSnapshot('S', 'S', metricsWith(), NOW)
    const sid = store.getServerIdForKey('S')
    const old = store.openAlert({ serverId: sid, kpi: 'cpu_pct', startedAt: NOW - 366 * DAY, value: 90, mean: 30, stddev: 5, direction: 'above' })
    const fresh = store.openAlert({ serverId: sid, kpi: 'io_mb', startedAt: NOW - 364 * DAY, value: 200, mean: 20, stddev: 5, direction: 'above' })
    expect(old).toBeTypeOf('number')
    expect(fresh).toBeTypeOf('number')
    const deleted = prune(store._db(), NOW)
    expect(deleted.alerts).toBe(1)
    expect(store._db().prepare('SELECT COUNT(*) AS n FROM alerts').get().n).toBe(1)
  })
})
