// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import store from '../../server/metricsStore.js'

const T0 = 1_700_000_000_000

function metricsWith(over = {}) {
  return {
    cpu_percent: 10, waiting_tasks: 0, db_io_mb: 0, batch_requests: 0,
    serverPerf: {}, resourceWaits: [], blocking: [], ...over,
  }
}
function wait(type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms) {
  return { wait_type: type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms, max_wait_time_ms: 0 }
}
function block(over = {}) {
  return {
    blocking_session_id: 51, blocked_session_id: 72, wait_type: 'LCK_M_X',
    wait_time: 1234, database_name: 'medcare_db_dev',
    blocker_login: 'app', blocker_host: 'H1', blocker_program: 'P1',
    blocked_login: 'rpt', blocked_host: 'H2',
    blocker_query: 'UPDATE t SET x=1', blocked_query: 'SELECT * FROM t',
    parent_object: 'dbo.t', ...over,
  }
}
const waitRows  = () => store._db().prepare('SELECT * FROM waits_samples ORDER BY ts, wait_type').all()
const blockRows = () => store._db().prepare('SELECT * FROM blocking_events ORDER BY id').all()

describe('wait-stat deltas', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('first sample establishes baseline, writes nothing', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('PAGEIOLATCH_SH', 1000, 10, 100)] }), T0)
    expect(waitRows()).toHaveLength(0)
  })

  it('second sample ≥60s later writes deltas', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('PAGEIOLATCH_SH', 1000, 10, 100)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('PAGEIOLATCH_SH', 1500, 13, 130)] }), T0 + 60_000)
    const rows = waitRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].wait_time_ms).toBe(500)
    expect(rows[0].waiting_tasks_count).toBe(3)
    expect(rows[0].signal_wait_time_ms).toBe(30)
    expect(rows[0].ts).toBe(T0 + 60_000)
  })

  it('respects 60s cadence: sample 2s after baseline writes nothing', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 100, 1, 10)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 200, 2, 20)] }), T0 + 2_000)
    expect(waitRows()).toHaveLength(0)
  })

  it('negative delta (counter reset) → re-baseline, no row', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 5000, 50, 500)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 100, 1, 10)] }), T0 + 60_000)
    expect(waitRows()).toHaveLength(0)
    // next interval works off the new baseline
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('X', 300, 4, 40)] }), T0 + 120_000)
    const rows = waitRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].wait_time_ms).toBe(200)
  })

  it('wait type without baseline entry is skipped (added to next baseline)', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 100, 1, 10)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 200, 2, 20), wait('B', 999, 9, 99)] }), T0 + 60_000)
    let rows = waitRows()
    expect(rows.map(r => r.wait_type)).toEqual(['A'])
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 300, 3, 30), wait('B', 1099, 10, 109)] }), T0 + 120_000)
    rows = waitRows()
    const b = rows.find(r => r.wait_type === 'B')
    expect(b.wait_time_ms).toBe(100)
  })

  it('all-zero delta rows are not written', () => {
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 100, 1, 10)] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ resourceWaits: [wait('A', 100, 1, 10)] }), T0 + 60_000)
    expect(waitRows()).toHaveLength(0)
  })
})

describe('blocking dedupe', () => {
  beforeEach(() => { store.initialize(':memory:') })
  afterEach(() => { store.close() })

  it('inserts a blocking event with all columns mapped', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    const rows = blockRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].blocking_sid).toBe(51)
    expect(rows[0].blocked_sid).toBe(72)
    expect(rows[0].wait_type).toBe('LCK_M_X')
    expect(rows[0].wait_ms).toBe(1234)
    expect(rows[0].database_name).toBe('medcare_db_dev')
    expect(rows[0].blocker_query).toBe('UPDATE t SET x=1')
    expect(rows[0].parent_object).toBe('dbo.t')
  })

  it('same tuple within 60s is suppressed', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0 + 2_000)
    expect(blockRows()).toHaveLength(1)
  })

  it('same tuple after 60s is recorded again', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0 + 61_000)
    expect(blockRows()).toHaveLength(2)
  })

  it('new victim / new wait_type / new database is recorded immediately', () => {
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [block()] }), T0)
    store.insertSnapshot('S', 'S', metricsWith({ blocking: [
      block({ blocked_session_id: 99 }),
      block({ wait_type: 'LCK_M_S' }),
      block({ database_name: 'tempdb' }),
    ] }), T0 + 2_000)
    expect(blockRows()).toHaveLength(4)
  })
})
