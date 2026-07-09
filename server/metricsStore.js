'use strict';

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./metricsSchema');
const { runRollup } = require('./metricsRollup');
const retention = require('./metricsRetention');
const baselineCalc = require('./baselineCalc');

let db = null;
let enabled = false;
let stmts = null;
let insertTx = null;
let insertErrors = 0;
const serverIds = new Map();      // instance_key -> server_id
const waitState = new Map();      // server_id -> { lastWriteTs, baseline: Map }
const blockingRecent = new Map(); // server_id -> Map(dedupeKey -> ts)

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function kpiValues(metrics) {
  const sp = metrics.serverPerf || {};
  return {
    cpu_pct:            num(metrics.cpu_percent),
    waiting_tasks:      num(metrics.waiting_tasks),
    io_mb:              num(metrics.db_io_mb),
    batch_req:          num(metrics.batch_requests),
    sql_mem_pct:        num(sp.sqlMemPct),
    sql_mem_gb:         num(sp.sqlMemGb),
    ple_sec:            num(sp.pleSec),
    user_conns:         num(sp.userConns),
    compilations_sec:   num(sp.compilationsSec),
    recompilations_sec: num(sp.recompilationsSec),
    net_mbs:            num(sp.netMbs),
    buffer_cache_hit:   num(sp.bufferCacheHit),
    mem_grants_pending: num(sp.memGrantsPending),
  };
}

function prepareStatements() {
  const names = schema.KPI_COLUMNS.map(c => c.name);
  stmts = {
    upsertServer: db.prepare(`
      INSERT INTO servers (instance_key, display_name, first_seen, last_seen)
      VALUES (@key, @name, @now, @now)
      ON CONFLICT(instance_key) DO UPDATE SET
        display_name = excluded.display_name,
        last_seen    = excluded.last_seen`),
    getServerId: db.prepare('SELECT id FROM servers WHERE instance_key = ?'),
    insertRaw: db.prepare(`
      INSERT INTO samples_raw (server_id, ts, ${names.join(', ')})
      VALUES (@server_id, @ts, ${names.map(n => '@' + n).join(', ')})`),
    insertWait: db.prepare(`
      INSERT INTO waits_samples (server_id, ts, wait_type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)`),
    insertBlocking: db.prepare(`
      INSERT INTO blocking_events (server_id, ts, blocking_sid, blocked_sid, wait_type, wait_ms,
        database_name, blocker_login, blocker_host, blocker_program, blocked_login, blocked_host,
        blocker_query, blocked_query, parent_object)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    metaSet: db.prepare(`
      INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),

    // --- alerting (migration v2) ---
    serverIdByKey: db.prepare('SELECT id FROM servers WHERE instance_key = ?'),
    recentKpiAvg: db.prepare(`
      SELECT AVG(cpu_pct) AS cpu_pct, AVG(waiting_tasks) AS waiting_tasks,
             AVG(io_mb) AS io_mb, AVG(batch_req) AS batch_req,
             AVG(ple_sec) AS ple_sec, AVG(mem_grants_pending) AS mem_grants_pending,
             COUNT(*) AS n
      FROM samples_raw WHERE server_id = ? AND ts > ?
    `),
    allBaselines: db.prepare('SELECT * FROM baselines'),
    baselinesByKpi: db.prepare(`
      SELECT hour_of_week, mean, stddev, sample_count, computed_at
      FROM baselines WHERE server_id = ? AND kpi = ? ORDER BY hour_of_week
    `),
    activeAlerts: db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL'),
    activeAlertForPair: db.prepare('SELECT id FROM alerts WHERE server_id = ? AND kpi = ? AND resolved_at IS NULL'),
    insertAlert: db.prepare(`
      INSERT INTO alerts (server_id, kpi, started_at, peak_value, peak_at, baseline_mean, baseline_stddev, direction, severity)
      VALUES (@serverId, @kpi, @startedAt, @value, @startedAt, @mean, @stddev, @direction, 'critical')
    `),
    updateAlertPeak: db.prepare('UPDATE alerts SET peak_value = ?, peak_at = ? WHERE id = ?'),
    resolveAlert: db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?'),
    ackAlert: db.prepare('UPDATE alerts SET acked_at = COALESCE(acked_at, ?) WHERE id = ? AND server_id = ?'),
    alertsActiveByServer: db.prepare('SELECT * FROM alerts WHERE server_id = ? AND resolved_at IS NULL ORDER BY started_at DESC'),
    alertsRangeByServer: db.prepare('SELECT * FROM alerts WHERE server_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC'),
  };

  insertTx = db.transaction((instanceKey, displayName, metrics, now) => {
    const serverId = getServerId(instanceKey, displayName, now);
    stmts.insertRaw.run({ server_id: serverId, ts: now, ...kpiValues(metrics) });
    writeBlocking(serverId, metrics.blocking, now);   // Task 4
    writeWaits(serverId, metrics.resourceWaits, now); // Task 4
  });
}

function getServerId(instanceKey, displayName, now) {
  stmts.upsertServer.run({ key: instanceKey, name: displayName ?? null, now });
  let id = serverIds.get(instanceKey);
  if (id === undefined) {
    id = stmts.getServerId.get(instanceKey).id;
    serverIds.set(instanceKey, id);
  }
  return id;
}

const WAITS_INTERVAL_MS = 60_000;
const BLOCKING_DEDUPE_MS = 60_000;

function writeWaits(serverId, resourceWaits, now) {
  if (!Array.isArray(resourceWaits) || resourceWaits.length === 0) return;
  let state = waitState.get(serverId);
  if (!state) { state = { lastWriteTs: 0, baseline: null }; waitState.set(serverId, state); }
  if (state.baseline && now - state.lastWriteTs < WAITS_INTERVAL_MS) return;

  const current = new Map(resourceWaits.map(w => [w.wait_type, w]));
  if (!state.baseline) {
    state.baseline = current;
    state.lastWriteTs = now;
    return;
  }
  // Any negative delta means the DMV counters were reset (SQL restart or
  // DBCC SQLPERF clear) — re-baseline and skip this write entirely.
  for (const [type, w] of current) {
    const prev = state.baseline.get(type);
    if (prev && (num(w.wait_time_ms) < num(prev.wait_time_ms)
              || num(w.signal_wait_time_ms) < num(prev.signal_wait_time_ms)
              || num(w.waiting_tasks_count) < num(prev.waiting_tasks_count))) {
      state.baseline = current;
      state.lastWriteTs = now;
      return;
    }
  }
  for (const [type, w] of current) {
    const prev = state.baseline.get(type);
    if (!prev) continue; // first sighting: no baseline for this type yet
    const dWait   = num(w.wait_time_ms)        - num(prev.wait_time_ms);
    const dTasks  = num(w.waiting_tasks_count) - num(prev.waiting_tasks_count);
    const dSignal = num(w.signal_wait_time_ms) - num(prev.signal_wait_time_ms);
    if (dWait === 0 && dTasks === 0 && dSignal === 0) continue;
    stmts.insertWait.run(serverId, now, type, dWait, dTasks, dSignal);
  }
  state.baseline = current;
  state.lastWriteTs = now;
}

function writeBlocking(serverId, blocking, now) {
  if (!Array.isArray(blocking) || blocking.length === 0) return;
  let recent = blockingRecent.get(serverId);
  if (!recent) { recent = new Map(); blockingRecent.set(serverId, recent); }
  for (const [k, ts] of recent) if (now - ts >= BLOCKING_DEDUPE_MS) recent.delete(k);
  for (const b of blocking) {
    const key = `${b.blocking_session_id}|${b.blocked_session_id}|${b.wait_type ?? ''}|${b.database_name ?? ''}`;
    if (recent.has(key)) continue;
    recent.set(key, now);
    stmts.insertBlocking.run(
      serverId, now,
      num(b.blocking_session_id), num(b.blocked_session_id),
      b.wait_type ?? null, num(b.wait_time), b.database_name ?? null,
      b.blocker_login ?? null, b.blocker_host ?? null, b.blocker_program ?? null,
      b.blocked_login ?? null, b.blocked_host ?? null,
      b.blocker_query ?? null, b.blocked_query ?? null, b.parent_object ?? null
    );
  }
}

function initialize(dbPath) {
  try {
    const Database = require('better-sqlite3');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    db = new Database(dbPath);
    schema.applyPragmas(db);
    schema.migrate(db);
    prepareStatements();
    enabled = true;
  } catch (err) {
    console.warn('[metrics-db] persistence disabled:', err.message);
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    enabled = false;
  }
  return enabled;
}

function insertSnapshot(instanceKey, displayName, metrics, now = Date.now()) {
  if (!enabled) return;
  try {
    insertTx(instanceKey, displayName, metrics, now);
    stmts.metaSet.run('last_insert_at', String(now), now);
  } catch (err) {
    insertErrors += 1;
    try { stmts.metaSet.run('insert_error_count', String(insertErrors), now); } catch { /* ignore */ }
    console.error('[metrics-db] insert failed:', err.message);
  }
}

function close() {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  enabled = false;
  stmts = null;
  insertTx = null;
  insertErrors = 0;
  serverIds.clear();
  waitState.clear();
  blockingRecent.clear();
}

function _db() { return db; }

function rollup(now = Date.now()) {
  if (!enabled) return;
  try {
    runRollup(db, now);
    stmts.metaSet.run('last_rollup_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] rollup failed:', err.message);
  }
}

function prune(now = Date.now()) {
  if (!enabled) return;
  try {
    retention.prune(db, now);
    stmts.metaSet.run('last_prune_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] prune failed:', err.message);
  }
}

function vacuum(now = Date.now()) {
  if (!enabled) return;
  try {
    if (retention.vacuumIfNeeded(db)) stmts.metaSet.run('last_vacuum_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] vacuum failed:', err.message);
  }
}

function checkpoint(now = Date.now()) {
  if (!enabled) return;
  try {
    retention.checkpoint(db);
    stmts.metaSet.run('last_checkpoint_at', String(now), now);
  } catch (err) {
    console.error('[metrics-db] checkpoint failed:', err.message);
  }
}

const RESOLUTION_MS = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000 };

function pickResolution(spanMs) {
  if (spanMs <= 2 * 3_600_000) return 'raw';
  if (spanMs <= 48 * 3_600_000) return '1m';
  if (spanMs <= 14 * 86_400_000) return '15m';
  return '1h';
}

function tailSql(bucketMs) {
  const cols = schema.KPI_COLUMNS.map(c =>
    `AVG(${c.name}) AS ${c.name}_avg, MIN(${c.name}) AS ${c.name}_min, MAX(${c.name}) AS ${c.name}_max`
  ).join(', ');
  return `SELECT server_id, ts - ts % ${bucketMs} AS ts, ${cols}, COUNT(*) AS sample_count
    FROM samples_raw
    WHERE server_id = @serverId AND ts >= @from AND ts <= @to
    GROUP BY 2 ORDER BY 2`;
}

function resolveServerId(instanceKey) {
  return db.prepare('SELECT id FROM servers WHERE instance_key = ?').get(instanceKey)?.id ?? null;
}

function getHistory(instanceKey, fromMs, toMs, resolution = 'auto') {
  if (!enabled) return { resolution: null, rows: [] };
  const res = resolution === 'auto' ? pickResolution(toMs - fromMs) : resolution;
  const serverId = resolveServerId(instanceKey);
  if (serverId === null) return { resolution: res, rows: [] };

  if (res === 'raw') {
    const rows = db.prepare(
      `SELECT * FROM samples_raw WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`
    ).all(serverId, fromMs, toMs);
    return { resolution: 'raw', rows };
  }

  const ms = RESOLUTION_MS[res];
  const rows = db.prepare(
    `SELECT * FROM samples_${res} WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`
  ).all(serverId, fromMs, toMs);

  // Rolled-tail gap: rollups run hourly, so the newest part of the range has
  // no rollup rows yet. Aggregate samples_raw on the fly past the watermark.
  const wm = db.prepare(
    'SELECT watermark_ts FROM rollup_state WHERE server_id = ? AND resolution = ?'
  ).get(serverId, res)?.watermark_ts ?? 0;
  if (toMs > wm) {
    const tail = db.prepare(tailSql(ms)).all({
      serverId, from: Math.max(wm, fromMs - (fromMs % ms)), to: toMs,
    });
    const seen = new Set(rows.map(r => r.ts));
    for (const t of tail) if (!seen.has(t.ts)) rows.push(t);
    rows.sort((a, b) => a.ts - b.ts);
  }
  return { resolution: res, rows };
}

function getWaitHistory(instanceKey, fromMs, toMs) {
  if (!enabled) return { rows: [] };
  const serverId = resolveServerId(instanceKey);
  if (serverId === null) return { rows: [] };
  const rows = db.prepare(
    `SELECT ts, wait_type, wait_time_ms, waiting_tasks_count, signal_wait_time_ms
     FROM waits_samples WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, wait_type`
  ).all(serverId, fromMs, toMs);
  return { rows };
}

function getBlockingHistory(instanceKey, fromMs, toMs) {
  if (!enabled) return { rows: [] };
  const serverId = resolveServerId(instanceKey);
  if (serverId === null) return { rows: [] };
  const rows = db.prepare(
    `SELECT * FROM blocking_events WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, id`
  ).all(serverId, fromMs, toMs);
  return { rows };
}

// ── Alert / baseline wrappers ─────────────────────────────────────────────────

function recomputeBaselines(now = Date.now()) {
  if (!enabled) return 0;
  try {
    const written = baselineCalc.recomputeBaselines(db, now);
    stmts.metaSet.run('last_baseline_at', String(now), now);
    return written;
  } catch (e) {
    console.error('[alerts] baseline recompute failed:', e.message);
    return 0;
  }
}

function getServerIdForKey(instanceKey) {
  if (!enabled) return null;
  try {
    const row = stmts.serverIdByKey.get(instanceKey);
    return row ? row.id : null;
  } catch (e) { console.error('[alerts] getServerIdForKey failed:', e.message); return null; }
}

function getRecentKpiAverages(serverId, now = Date.now()) {
  if (!enabled) return null;
  try { return stmts.recentKpiAvg.get(serverId, now - 60_000); }
  catch (e) { console.error('[alerts] getRecentKpiAverages failed:', e.message); return null; }
}

function getAllBaselines() {
  if (!enabled) return [];
  try { return stmts.allBaselines.all(); }
  catch (e) { console.error('[alerts] getAllBaselines failed:', e.message); return []; }
}

function getBaselines(instanceKey, kpi) {
  if (!enabled) return [];
  try {
    const serverId = getServerIdForKey(instanceKey);
    if (serverId == null) return [];
    return stmts.baselinesByKpi.all(serverId, kpi);
  } catch (e) { console.error('[alerts] getBaselines failed:', e.message); return []; }
}

function getActiveAlerts() {
  if (!enabled) return [];
  try { return stmts.activeAlerts.all(); }
  catch (e) { console.error('[alerts] getActiveAlerts failed:', e.message); return []; }
}

function getAlerts(instanceKey, { activeOnly = false, from = 0, to = Date.now() } = {}) {
  if (!enabled) return [];
  try {
    const serverId = getServerIdForKey(instanceKey);
    if (serverId == null) return [];
    return activeOnly
      ? stmts.alertsActiveByServer.all(serverId)
      : stmts.alertsRangeByServer.all(serverId, from, to);
  } catch (e) { console.error('[alerts] getAlerts failed:', e.message); return []; }
}

function openAlert({ serverId, kpi, startedAt, value, mean, stddev, direction }) {
  if (!enabled) return null;
  try {
    if (stmts.activeAlertForPair.get(serverId, kpi)) return null; // dedupe invariant
    const info = stmts.insertAlert.run({ serverId, kpi, startedAt, value, mean, stddev, direction });
    return Number(info.lastInsertRowid);
  } catch (e) { console.error('[alerts] openAlert failed:', e.message); return null; }
}

function updateAlertPeak(id, value, ts) {
  if (!enabled) return;
  try { stmts.updateAlertPeak.run(value, ts, id); }
  catch (e) { console.error('[alerts] updateAlertPeak failed:', e.message); }
}

function resolveAlert(id, ts) {
  if (!enabled) return;
  try { stmts.resolveAlert.run(ts, id); }
  catch (e) { console.error('[alerts] resolveAlert failed:', e.message); }
}

function ackAlert(instanceKey, alertId, now = Date.now()) {
  if (!enabled) return false;
  try {
    const serverId = getServerIdForKey(instanceKey);
    if (serverId == null) return false;
    return stmts.ackAlert.run(now, alertId, serverId).changes > 0;
  } catch (e) { console.error('[alerts] ackAlert failed:', e.message); return false; }
}

// ─────────────────────────────────────────────────────────────────────────────

const COUNTED_TABLES = ['samples_raw', 'samples_1m', 'samples_15m', 'samples_1h', 'waits_samples', 'blocking_events'];

function health(now = Date.now()) {
  if (!enabled) return { enabled: false };
  try {
    const fileSize = p => { try { return fs.statSync(p).size; } catch { return 0; } };
    const counts = {};
    for (const t of COUNTED_TABLES) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    }
    const servers = db.prepare(`
      SELECT s.id, s.instance_key, s.display_name, s.first_seen, s.last_seen,
        (SELECT MIN(ts) FROM samples_raw WHERE server_id = s.id) AS oldest_raw,
        (SELECT MAX(ts) FROM samples_raw WHERE server_id = s.id) AS newest_raw
      FROM servers s ORDER BY s.instance_key`).all();
    const meta = Object.fromEntries(
      db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
    const recentRows = db.prepare('SELECT COUNT(*) AS n FROM samples_raw WHERE ts > ?').get(now - 60_000).n;
    return {
      enabled: true,
      dbPath: path.basename(db.name),
      dbSizeBytes: fileSize(db.name),
      walSizeBytes: fileSize(db.name + '-wal'),
      freelistCount: db.pragma('freelist_count', { simple: true }),
      pageCount: db.pragma('page_count', { simple: true }),
      schemaVersion: db.pragma('user_version', { simple: true }),
      migrations: db.prepare('SELECT version, applied_at, description FROM schema_migrations ORDER BY version').all(),
      servers, counts, meta,
      insertErrorCount: insertErrors,
      rawInsertRatePerSec: recentRows / 60,
    };
  } catch (err) {
    console.error('[metrics-db] health failed:', err.message);
    return { enabled: true, error: err.message };
  }
}

module.exports = { initialize, insertSnapshot, rollup, prune, vacuum, checkpoint, health,
  getHistory, getWaitHistory, getBlockingHistory, pickResolution, close, _db,
  // alerting / baselines
  recomputeBaselines, getServerIdForKey, getRecentKpiAverages,
  getAllBaselines, getBaselines, getActiveAlerts, getAlerts,
  openAlert, updateAlertPeak, resolveAlert, ackAlert };
