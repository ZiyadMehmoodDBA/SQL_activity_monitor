// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import store from '../../server/metricsStore.js';

// Init/teardown mirrors tests/server/metricsStore.test.js exactly.

const MON = Date.UTC(2026, 0, 5); // Monday 00:00 UTC → hour_of_week 0
const MIN = 60_000;

function seedServer() {
  // Insert one snapshot so the server row exists, then return its id.
  store.insertSnapshot('SRV\\INST', 'Srv', { cpu_pct: 10 }, MON);
  return store.getServerIdForKey('SRV\\INST');
}

describe('alert store wrappers', () => {
  beforeEach(() => { store.initialize(':memory:'); });
  afterEach(() => { store.close(); });

  it('getServerIdForKey returns null for unknown key', () => {
    expect(store.getServerIdForKey('nope')).toBeNull();
  });

  it('getRecentKpiAverages averages last 60s of samples_raw', () => {
    const id = seedServer();
    const db = store._db();
    const ins = db.prepare('INSERT INTO samples_raw (server_id, ts, cpu_pct) VALUES (?, ?, ?)');
    ins.run(id, MON - 10_000, 40);
    ins.run(id, MON - 5_000, 60);
    ins.run(id, MON - 120_000, 999); // outside 60s window
    const avg = store.getRecentKpiAverages(id, MON);
    expect(avg.cpu_pct).toBeCloseTo(50, 6);
    expect(avg.n).toBeGreaterThanOrEqual(2);
  });

  it('openAlert enforces one active alert per (server, kpi)', () => {
    const id = seedServer();
    const a1 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    expect(a1).toBeTypeOf('number');
    const a2 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON + MIN, value: 95, mean: 30, stddev: 5, direction: 'above' });
    expect(a2).toBeNull();
    store.resolveAlert(a1, MON + 10 * MIN);
    const a3 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON + 11 * MIN, value: 91, mean: 30, stddev: 5, direction: 'above' });
    expect(a3).toBeTypeOf('number');
  });

  it('openAlert writes peak, severity critical, baseline stats', () => {
    const id = seedServer();
    const alertId = store.openAlert({ serverId: id, kpi: 'ple_sec', startedAt: MON, value: 50, mean: 3000, stddev: 200, direction: 'below' });
    const row = store._db().prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
    expect(row.peak_value).toBe(50);
    expect(row.peak_at).toBe(MON);
    expect(row.severity).toBe('critical');
    expect(row.baseline_mean).toBe(3000);
    expect(row.direction).toBe('below');
  });

  it('updateAlertPeak and resolveAlert', () => {
    const id = seedServer();
    const alertId = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    store.updateAlertPeak(alertId, 97, MON + 2 * MIN);
    store.resolveAlert(alertId, MON + 9 * MIN);
    const row = store._db().prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
    expect(row.peak_value).toBe(97);
    expect(row.peak_at).toBe(MON + 2 * MIN);
    expect(row.resolved_at).toBe(MON + 9 * MIN);
  });

  it('getAlerts activeOnly and range modes', () => {
    const id = seedServer();
    const a1 = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    store.resolveAlert(a1, MON + MIN);
    store.openAlert({ serverId: id, kpi: 'io_mb', startedAt: MON + 2 * MIN, value: 200, mean: 20, stddev: 5, direction: 'above' });
    const active = store.getAlerts('SRV\\INST', { activeOnly: true });
    expect(active).toHaveLength(1);
    expect(active[0].kpi).toBe('io_mb');
    const ranged = store.getAlerts('SRV\\INST', { from: MON - MIN, to: MON + 5 * MIN });
    expect(ranged).toHaveLength(2);
  });

  it('ackAlert is idempotent and scoped to the server', () => {
    const id = seedServer();
    const alertId = store.openAlert({ serverId: id, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' });
    expect(store.ackAlert('SRV\\INST', alertId, MON + MIN)).toBe(true);
    expect(store.ackAlert('SRV\\INST', alertId, MON + 5 * MIN)).toBe(true); // idempotent
    expect(store._db().prepare('SELECT acked_at FROM alerts WHERE id=?').get(alertId).acked_at).toBe(MON + MIN); // first ack wins
    expect(store.ackAlert('OTHER\\KEY', alertId, MON)).toBe(false);
    expect(store.ackAlert('SRV\\INST', 999999, MON)).toBe(false);
  });

  it('recomputeBaselines wrapper writes rows, sets meta, and getBaselines reads them', () => {
    const id = seedServer();
    const db = store._db();
    const ins = db.prepare('INSERT INTO samples_1m (server_id, ts, cpu_pct_avg, sample_count) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 60; i++) ins.run(id, MON + i * MIN, 25, 30);
    const written = store.recomputeBaselines(MON + 7 * 86_400_000);
    expect(written).toBeGreaterThanOrEqual(1);
    const meta = db.prepare("SELECT value FROM meta WHERE key='last_baseline_at'").get();
    expect(meta).toBeTruthy();
    const rows = store.getBaselines('SRV\\INST', 'cpu_pct');
    expect(rows.find((r) => r.hour_of_week === 0).mean).toBeCloseTo(25, 6);
    expect(store.getAllBaselines().length).toBe(rows.length);
  });

  it('disabled mode: wrappers are no-ops / empty', () => {
    // Close the enabled store and re-initialize in disabled mode (same technique
    // as metricsStore.test.js: pass '.' which is a directory, not a valid DB file).
    store.close();
    store.initialize('.'); // disabled — initialize returns false

    expect(store.getAlerts('SRV\\INST', {})).toEqual([]);
    expect(store.getBaselines('SRV\\INST', 'cpu_pct')).toEqual([]);
    expect(store.getAllBaselines()).toEqual([]);
    expect(store.getActiveAlerts()).toEqual([]);
    expect(store.getServerIdForKey('SRV\\INST')).toBeNull();
    expect(store.getRecentKpiAverages(1, MON)).toBeNull();
    expect(store.openAlert({ serverId: 1, kpi: 'cpu_pct', startedAt: MON, value: 90, mean: 30, stddev: 5, direction: 'above' })).toBeNull();
    expect(store.ackAlert('SRV\\INST', 1, MON)).toBe(false);
    expect(store.recomputeBaselines(MON)).toBe(0);
    // updateAlertPeak and resolveAlert are void — just ensure no throw
    expect(() => store.updateAlertPeak(1, 99, MON)).not.toThrow();
    expect(() => store.resolveAlert(1, MON)).not.toThrow();
  });
});
