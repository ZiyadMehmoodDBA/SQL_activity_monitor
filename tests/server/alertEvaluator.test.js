// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import store from '../../server/metricsStore.js';
import { createAlertEvaluator } from '../../server/alertEvaluator.js';

// Same store init/teardown as tests/server/metricsAlertsStore.test.js.
// _store is passed to createAlertEvaluator so the evaluator shares the same
// in-memory instance that the test initialises (avoids ESM/CJS singleton split).

const MON = Date.UTC(2026, 0, 5); // hour_of_week 0
const MIN = 60_000;
const KEY = 'SRV\\INST';

let emits;
let evaluator;

function setup({ mean = 30, stddev = 1, kpi = 'cpu_pct', computedAt = MON } = {}) {
  store.insertSnapshot(KEY, 'Srv', { cpu_pct: 10 }, MON - MIN);
  const id = store.getServerIdForKey(KEY);
  // Seed a baseline row for every hour bucket the test touches (bucket 0 and 1 in eval window)
  const ins = store._db().prepare(
    'INSERT INTO baselines (server_id, kpi, hour_of_week, mean, stddev, sample_count, computed_at) VALUES (?,?,?,?,?,?,?)'
  );
  for (const how of [0, 1]) ins.run(id, kpi, how, mean, stddev, 100, computedAt);
  emits = [];
  evaluator = createAlertEvaluator({
    listServers: () => [{ connectionId: 'c1', instanceKey: KEY }],
    emit: (connId, payload) => emits.push({ connId, payload }),
    _store: store,
  });
  evaluator.start();
  return id;
}

function feed(id, kpi, value, ts) {
  store._db().prepare(`INSERT INTO samples_raw (server_id, ts, ${kpi}) VALUES (?,?,?)`).run(id, ts - 1000, value);
}

function tick(id, kpi, value, ts) {
  feed(id, kpi, value, ts);
  evaluator.evaluate(ts);
}

describe('alertEvaluator', () => {
  beforeEach(() => { store.initialize(':memory:'); });
  afterEach(() => { store.close(); });

  it('opens at exactly 5 consecutive breaches, not 4', () => {
    const id = setup(); // mean 30, effective sd = max(1, 1.5, 5) = 5 → open above 45
    for (let i = 0; i < 4; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
    tick(id, 'cpu_pct', 90, MON + 4 * MIN);
    const active = store.getActiveAlerts();
    expect(active).toHaveLength(1);
    expect(emits).toHaveLength(1);
    expect(emits[0].payload.resolvedAt).toBeNull();
    expect(emits[0].payload.severity).toBe('critical');
  });

  it('breach counter resets on a non-breach value', () => {
    const id = setup();
    for (let i = 0; i < 4; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    tick(id, 'cpu_pct', 30, MON + 4 * MIN); // reset
    for (let i = 5; i < 9; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('resolves with 2σ hysteresis after 5 calm evaluations', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    // calm = inside mean+2σ_eff = 30+10 = 40
    for (let i = 5; i < 9; i++) tick(id, 'cpu_pct', 35, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(1);
    tick(id, 'cpu_pct', 35, MON + 9 * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
    const resolveEmit = emits.at(-1);
    expect(resolveEmit.payload.resolvedAt).toBe(MON + 9 * MIN);
  });

  it('value between 2σ and 3σ neither opens nor resolves (hysteresis gap)', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    for (let i = 5; i < 15; i++) tick(id, 'cpu_pct', 42, MON + i * MIN); // 40 < 42 < 45
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('ple_sec alerts on below only', () => {
    const id = setup({ kpi: 'ple_sec', mean: 3000, stddev: 200 });
    for (let i = 0; i < 5; i++) tick(id, 'ple_sec', 9999, MON + i * MIN); // high PLE = healthy
    expect(store.getActiveAlerts()).toHaveLength(0);
    for (let i = 5; i < 10; i++) tick(id, 'ple_sec', 100, MON + i * MIN); // below 3000-3*200=2400
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('three-way stddev floor suppresses noise on near-constant low metrics', () => {
    const id = setup({ mean: 2, stddev: 0.1 }); // relative floor 0.1, absolute floor 5 → open above 2+15=17
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 10, MON + i * MIN); // would breach without floor
    expect(store.getActiveAlerts()).toHaveLength(0);
    for (let i = 5; i < 10; i++) tick(id, 'cpu_pct', 20, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('skips stale baselines (>35d)', () => {
    const id = setup({ computedAt: MON - 36 * 86_400_000 });
    for (let i = 0; i < 6; i++) tick(id, 'cpu_pct', 99, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('no baseline row → silent', () => {
    store.insertSnapshot(KEY, 'Srv', { cpu_pct: 10 }, MON - MIN);
    const id = store.getServerIdForKey(KEY);
    emits = [];
    evaluator = createAlertEvaluator({
      listServers: () => [{ connectionId: 'c1', instanceKey: KEY }],
      emit: () => {},
      _store: store,
    });
    evaluator.start();
    for (let i = 0; i < 6; i++) tick(id, 'cpu_pct', 99, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('tracks peak_value and peak_at while active', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    tick(id, 'cpu_pct', 97, MON + 5 * MIN);
    tick(id, 'cpu_pct', 93, MON + 6 * MIN);
    const row = store.getActiveAlerts()[0];
    expect(row.peak_value).toBe(97);
    expect(row.peak_at).toBe(MON + 5 * MIN);
  });

  it('restart re-adopts active alerts so they can still resolve', () => {
    const id = setup();
    for (let i = 0; i < 5; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    // New evaluator instance = restart
    const ev2 = createAlertEvaluator({
      listServers: () => [{ connectionId: 'c1', instanceKey: KEY }],
      emit: (c, p) => emits.push({ connId: c, payload: p }),
      _store: store,
    });
    ev2.start();
    for (let i = 5; i < 10; i++) { feed(id, 'cpu_pct', 31, MON + i * MIN); ev2.evaluate(MON + i * MIN); }
    expect(store.getActiveAlerts()).toHaveLength(0);
  });

  it('dedupe: no second active alert per pair even at 5 more breaches', () => {
    const id = setup();
    for (let i = 0; i < 15; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store._db().prepare("SELECT COUNT(*) AS c FROM alerts WHERE kpi='cpu_pct'").get().c).toBe(1);
  });

  it('server with no fresh samples is skipped for the cycle', () => {
    const id = setup();
    for (let i = 0; i < 4; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    evaluator.evaluate(MON + 10 * MIN); // no samples in last 60s → no reset, no advance
    tick(id, 'cpu_pct', 90, MON + 11 * MIN);
    expect(store.getActiveAlerts()).toHaveLength(1); // counter preserved across skipped cycle
  });

  it('emit failure never throws out of evaluate', () => {
    const id = setup();
    evaluator = createAlertEvaluator({
      listServers: () => [{ connectionId: 'c1', instanceKey: KEY }],
      emit: () => { throw new Error('boom'); },
      _store: store,
    });
    evaluator.start();
    expect(() => {
      for (let i = 0; i < 6; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    }).not.toThrow();
    expect(store.getActiveAlerts()).toHaveLength(1);
  });

  it('duplicate connections to the same instance evaluate once per cycle', () => {
    const id = setup();
    evaluator = createAlertEvaluator({
      listServers: () => [
        { connectionId: 'c1', instanceKey: KEY },
        { connectionId: 'c2', instanceKey: KEY },
      ],
      emit: () => {},
      _store: store,
    });
    evaluator.start();
    for (let i = 0; i < 3; i++) tick(id, 'cpu_pct', 90, MON + i * MIN);
    expect(store.getActiveAlerts()).toHaveLength(0); // 3 cycles, not 6 counter increments
  });
});
