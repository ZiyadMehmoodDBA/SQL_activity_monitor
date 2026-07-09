// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { KPI_COLUMNS, applyPragmas, migrate } from '../../server/metricsSchema.js'

describe('metricsSchema', () => {
  let db
  beforeEach(() => { db = new Database(':memory:') })

  it('exposes the 13 KPI columns in spec order', () => {
    expect(KPI_COLUMNS.map(c => c.name)).toEqual([
      'cpu_pct', 'waiting_tasks', 'io_mb', 'batch_req', 'sql_mem_pct',
      'sql_mem_gb', 'ple_sec', 'user_conns', 'compilations_sec',
      'recompilations_sec', 'net_mbs', 'buffer_cache_hit', 'mem_grants_pending',
    ])
  })

  it('applyPragmas sets WAL-compatible pragmas', () => {
    applyPragmas(db)
    // :memory: databases report journal_mode "memory"; the pragma call itself must not throw.
    expect(db.pragma('synchronous', { simple: true })).toBe(1)  // NORMAL
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('migrate creates all tables and sets user_version', () => {
    applyPragmas(db)
    migrate(db)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name)
    for (const t of ['servers', 'schema_migrations', 'samples_raw', 'samples_1m',
      'samples_15m', 'samples_1h', 'waits_samples', 'blocking_events',
      'rollup_state', 'meta']) {
      expect(tables).toContain(t)
    }
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    const mig = db.prepare('SELECT version, description FROM schema_migrations').all()
    expect(mig).toHaveLength(1)
    expect(mig[0].version).toBe(1)
  })

  it('rollup tables have avg/min/max triplets per KPI plus sample_count', () => {
    migrate(db)
    const cols = db.prepare("SELECT name FROM pragma_table_info('samples_1m')").all().map(r => r.name)
    expect(cols).toContain('cpu_pct_avg')
    expect(cols).toContain('cpu_pct_min')
    expect(cols).toContain('cpu_pct_max')
    expect(cols).toContain('mem_grants_pending_max')
    expect(cols).toContain('sample_count')
    // server_id + ts + 13*3 triplets + sample_count = 42
    expect(cols).toHaveLength(42)
  })

  it('migrate is idempotent', () => {
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n).toBe(1)
  })
})
