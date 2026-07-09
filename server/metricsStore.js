'use strict';

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./metricsSchema');

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

module.exports = { initialize, insertSnapshot, close, _db };
