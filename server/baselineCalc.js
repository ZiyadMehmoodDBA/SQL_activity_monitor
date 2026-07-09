'use strict';

const { CORE_KPIS } = require('./alertConfig');

const DAY_MS = 86_400_000;
const LOOKBACK_MS = 28 * DAY_MS;
// Deviation from spec wording (documented in plan header): gate on the COUNT of
// contributing 1-minute rows (>= 60 minutes), not on summed sample_count —
// sample_count counts raw 2s rows (~30/min), so a summed 60 would be ~2 minutes.
const MIN_MINUTES = 60;
// Epoch 1970-01-01 was a Thursday; Monday 00:00 UTC alignment needs a 4-day shift.
const MONDAY_OFFSET_S = 4 * 86_400;
const WEEK_S = 7 * 86_400;

function hourOfWeek(tsMs) {
  const s = Math.floor(tsMs / 1000);
  return Math.floor(((((s - MONDAY_OFFSET_S) % WEEK_S) + WEEK_S) % WEEK_S) / 3600);
}

// Recompute all baselines from samples_1m (trailing 28d). Transactional per
// server: DELETE + INSERT atomic, so failure keeps previous baselines.
// Returns total rows written. Throws on SQL failure (caller catches).
function recomputeBaselines(db, now = Date.now()) {
  const since = now - LOOKBACK_MS;
  const servers = db.prepare('SELECT id FROM servers').all();
  const del = db.prepare('DELETE FROM baselines WHERE server_id = ?');
  const ins = db.prepare(`
    INSERT INTO baselines (server_id, kpi, hour_of_week, mean, stddev, sample_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // KPI names come from the CORE_KPIS constant, never user input — safe to interpolate.
  const statStmts = {};
  for (const kpi of CORE_KPIS) {
    statStmts[kpi] = db.prepare(`
      SELECT
        CAST((((ts / 1000 - ${MONDAY_OFFSET_S}) % ${WEEK_S} + ${WEEK_S}) % ${WEEK_S}) / 3600 AS INTEGER) AS how,
        SUM(${kpi}_avg * sample_count)              AS wsum,
        SUM(${kpi}_avg * ${kpi}_avg * sample_count) AS wsq,
        SUM(sample_count)                           AS n,
        COUNT(*)                                    AS mins
      FROM samples_1m
      WHERE server_id = ? AND ts >= ? AND ${kpi}_avg IS NOT NULL
      GROUP BY how
    `);
  }

  let written = 0;
  const recomputeServer = db.transaction((serverId) => {
    del.run(serverId);
    for (const kpi of CORE_KPIS) {
      const buckets = new Map(); // how -> {wsum, wsq, n, mins}
      for (const r of statStmts[kpi].all(serverId, since)) buckets.set(r.how, r);

      // Precompute hour-of-day aggregates for the fallback ladder.
      const hod = new Map(); // 0..23 -> {wsum, wsq, n, mins}
      for (const [how, s] of buckets) {
        const h = how % 24;
        const agg = hod.get(h) || { wsum: 0, wsq: 0, n: 0, mins: 0 };
        agg.wsum += s.wsum; agg.wsq += s.wsq; agg.n += s.n; agg.mins += s.mins;
        hod.set(h, agg);
      }

      for (let how = 0; how < 168; how++) {
        const direct = buckets.get(how);
        let src = null;
        if (direct && direct.mins >= MIN_MINUTES) src = direct;
        else {
          const agg = hod.get(how % 24);
          if (agg && agg.mins >= MIN_MINUTES) src = agg;
        }
        if (!src || !src.n) continue; // ladder exhausted → silence for this bucket
        const mean = src.wsum / src.n;
        const variance = Math.max(0, src.wsq / src.n - mean * mean);
        ins.run(serverId, kpi, how, mean, Math.sqrt(variance), src.mins, now);
        written++;
      }
    }
  });

  for (const s of servers) recomputeServer(s.id);
  return written;
}

module.exports = { hourOfWeek, recomputeBaselines, LOOKBACK_MS, MIN_MINUTES };
