'use strict';

const { KPI_COLUMNS } = require('./metricsSchema');

const LADDER = [
  { resolution: '1m',  ms: 60_000,    source: 'samples_raw', target: 'samples_1m',  fromRaw: true  },
  { resolution: '15m', ms: 900_000,   source: 'samples_1m',  target: 'samples_15m', fromRaw: false },
  { resolution: '1h',  ms: 3_600_000, source: 'samples_15m', target: 'samples_1h',  fromRaw: false },
];

function targetColumns() {
  return KPI_COLUMNS.map(c => `${c.name}_avg, ${c.name}_min, ${c.name}_max`).join(', ');
}

// SQL AVG/MIN/MAX/SUM ignore NULLs — NULL KPI values never count as zero, and
// an all-NULL bucket yields NULL for the triplet.
function tripletSelect(fromRaw) {
  if (fromRaw) {
    return KPI_COLUMNS.map(c => `AVG(${c.name}), MIN(${c.name}), MAX(${c.name})`).join(', ');
  }
  // avg-of-avgs weighted by sample_count; denominator counts only rows where
  // the column is non-NULL so NULL buckets don't dilute the weighted average.
  return KPI_COLUMNS.map(c =>
    `SUM(${c.name}_avg * sample_count) / ` +
    `CAST(SUM(CASE WHEN ${c.name}_avg IS NOT NULL THEN sample_count END) AS REAL), ` +
    `MIN(${c.name}_min), MAX(${c.name}_max)`
  ).join(', ');
}

function rollupSql(step) {
  const countExpr = step.fromRaw ? 'COUNT(*)' : 'SUM(sample_count)';
  return `INSERT OR REPLACE INTO ${step.target} (server_id, ts, ${targetColumns()}, sample_count)
    SELECT server_id, ts - ts % ${step.ms} AS bucket, ${tripletSelect(step.fromRaw)}, ${countExpr}
    FROM ${step.source}
    WHERE server_id = @serverId AND ts >= @from AND ts < @to
    GROUP BY bucket`;
}

function runRollup(db, now = Date.now()) {
  const servers = db.prepare('SELECT id FROM servers').all();
  const getWm = db.prepare('SELECT watermark_ts FROM rollup_state WHERE server_id = ? AND resolution = ?');
  const setWm = db.prepare(`INSERT INTO rollup_state (server_id, resolution, watermark_ts) VALUES (?, ?, ?)
    ON CONFLICT(server_id, resolution) DO UPDATE SET watermark_ts = excluded.watermark_ts`);
  const stepStmts = LADDER.map(step => ({ step, stmt: db.prepare(rollupSql(step)) }));

  for (const { id } of servers) {
    for (const { step, stmt } of stepStmts) {
      const wm = getWm.get(id, step.resolution)?.watermark_ts ?? 0;
      const to = now - (now % step.ms); // current (incomplete) bucket start — exclusive
      if (to <= wm) continue;
      db.transaction(() => {
        stmt.run({ serverId: id, from: wm, to });
        setWm.run(id, step.resolution, to);
      })();
    }
  }
}

module.exports = { LADDER, runRollup, rollupSql, tripletSelect, targetColumns };
