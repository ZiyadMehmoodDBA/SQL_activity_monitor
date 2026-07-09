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
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    const mig = db.prepare('SELECT version, description FROM schema_migrations').all()
    expect(mig).toHaveLength(2)
    expect(mig[0].version).toBe(1)
    expect(mig[1].version).toBe(2)
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
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n).toBe(2)
  })
})

describe('migration v2 (alerting)', () => {
  let db
  beforeEach(() => { db = new Database(':memory:') })

  it('creates baselines and alerts tables and bumps user_version to 2', () => {
    migrate(db)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('baselines','alerts')"
    ).all().map((r) => r.name).sort()
    expect(tables).toEqual(['alerts', 'baselines'])
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    db.close()
  })

  it('baselines has composite PK columns and alerts has severity default critical', () => {
    migrate(db)
    const bCols = db.prepare('SELECT name FROM pragma_table_info(?)').all('baselines').map((r) => r.name)
    expect(bCols).toEqual(['server_id', 'kpi', 'hour_of_week', 'mean', 'stddev', 'sample_count', 'computed_at'])
    const aCols = db.prepare('SELECT name FROM pragma_table_info(?)').all('alerts').map((r) => r.name)
    expect(aCols).toEqual(['id', 'server_id', 'kpi', 'started_at', 'resolved_at', 'peak_value', 'peak_at', 'baseline_mean', 'baseline_stddev', 'direction', 'severity', 'acked_at'])
    db.prepare("INSERT INTO servers (instance_key, display_name, first_seen, last_seen) VALUES ('S','S',0,0)").run()
    db.prepare("INSERT INTO alerts (server_id, kpi, started_at, direction) VALUES (1, 'cpu_pct', 0, 'above')").run()
    expect(db.prepare('SELECT severity FROM alerts').get().severity).toBe('critical')
    db.close()
  })

  it('migrate is idempotent at v2', () => {
    migrate(db)
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    db.close()
  })

  it('has index ix_alerts_server', () => {
    migrate(db)
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_alerts_server'").get()
    expect(idx).toBeTruthy()
    db.close()
  })
})
