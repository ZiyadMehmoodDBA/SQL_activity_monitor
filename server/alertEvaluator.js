'use strict';

const { KPI_ALERT_CONFIG, CORE_KPIS } = require('./alertConfig');
const { hourOfWeek } = require('./baselineCalc');

const OPEN_CONSECUTIVE = 5;
const CLOSE_CONSECUTIVE = 5;
const BASELINE_STALE_MS = 35 * 86_400_000;

function effectiveStddev(mean, stddev, minStddev) {
  return Math.max(stddev, 0.05 * Math.abs(mean), minStddev);
}

// _store is for testing only (allows injecting the same store instance as the test).
// In production, omit _store — it defaults to require('./metricsStore').
function createAlertEvaluator({ listServers, emit, _store }) {
  const metricsStore = _store || require('./metricsStore');

  let cache = new Map();      // `${serverId}|${kpi}|${how}` -> baseline row
  const counters = new Map(); // `${serverId}|${kpi}` -> { breach, calm }
  const active = new Map();   // `${serverId}|${kpi}` -> live alert row copy

  function reloadCache() {
    try {
      const next = new Map();
      for (const b of metricsStore.getAllBaselines()) {
        next.set(`${b.server_id}|${b.kpi}|${b.hour_of_week}`, b);
      }
      cache = next;
    } catch (e) { console.error('[alerts] baseline cache reload failed:', e.message); }
  }

  function start() {
    reloadCache();
    try {
      for (const a of metricsStore.getActiveAlerts()) active.set(`${a.server_id}|${a.kpi}`, a);
    } catch (e) { console.error('[alerts] active alert re-adoption failed:', e.message); }
  }

  function safeEmit(connectionId, payload) {
    try { emit(connectionId, payload); }
    catch (e) { console.error('[alerts] emit failed:', e.message); }
  }

  function evaluate(now = Date.now()) {
    let servers;
    try { servers = listServers(); } catch (e) { console.error('[alerts] listServers failed:', e.message); return; }
    const seen = new Set();
    for (const s of servers) {
      if (seen.has(s.instanceKey)) continue; // one evaluation per instance per cycle
      seen.add(s.instanceKey);
      try { evaluateServer(s, now); }
      catch (e) { console.error('[alerts] evaluation error:', e.message); }
    }
  }

  function evaluateServer({ connectionId, instanceKey }, now) {
    const serverId = metricsStore.getServerIdForKey(instanceKey);
    if (serverId == null) return;
    const averages = metricsStore.getRecentKpiAverages(serverId, now);
    if (!averages || !averages.n) return; // no fresh samples → skip cycle, counters preserved
    const how = hourOfWeek(now);

    for (const kpi of CORE_KPIS) {
      const value = averages[kpi];
      if (value == null) continue;
      const cfg = KPI_ALERT_CONFIG[kpi];
      const key = `${serverId}|${kpi}`;
      const b = cache.get(`${serverId}|${kpi}|${how}`);
      if (!b || now - b.computed_at > BASELINE_STALE_MS) {
        counters.delete(key); // silent: no/stale baseline (active alert kept until baseline returns)
        continue;
      }
      const sd = effectiveStddev(b.mean, b.stddev, cfg.minStddev);
      const breach = cfg.direction === 'above'
        ? value > b.mean + cfg.sigmaOpen * sd
        : value < b.mean - cfg.sigmaOpen * sd;
      const calm = cfg.direction === 'above'
        ? value <= b.mean + cfg.sigmaClose * sd
        : value >= b.mean - cfg.sigmaClose * sd;

      const c = counters.get(key) || { breach: 0, calm: 0 };
      const current = active.get(key);

      if (!current) {
        c.breach = breach ? c.breach + 1 : 0;
        if (c.breach >= OPEN_CONSECUTIVE) {
          const id = metricsStore.openAlert({
            serverId, kpi, startedAt: now, value, mean: b.mean, stddev: b.stddev, direction: cfg.direction,
          });
          if (id != null) {
            active.set(key, {
              id, server_id: serverId, kpi, started_at: now,
              peak_value: value, peak_at: now, direction: cfg.direction,
            });
            safeEmit(connectionId, {
              id, kpi, direction: cfg.direction, severity: 'critical',
              value, mean: b.mean, stddev: b.stddev, startedAt: now, resolvedAt: null,
            });
          }
          c.breach = 0;
        }
      } else {
        const worse = current.direction === 'above'
          ? value > current.peak_value
          : value < current.peak_value;
        if (worse) {
          current.peak_value = value;
          current.peak_at = now;
          metricsStore.updateAlertPeak(current.id, value, now);
        }
        c.calm = calm ? c.calm + 1 : 0;
        if (c.calm >= CLOSE_CONSECUTIVE) {
          metricsStore.resolveAlert(current.id, now);
          active.delete(key);
          safeEmit(connectionId, {
            id: current.id, kpi, direction: current.direction, severity: 'critical',
            value, mean: b.mean, stddev: b.stddev, startedAt: current.started_at, resolvedAt: now,
          });
          c.calm = 0; c.breach = 0;
        }
      }
      counters.set(key, c);
    }
  }

  return { start, evaluate, reloadCache };
}

module.exports = { createAlertEvaluator, effectiveStddev };
