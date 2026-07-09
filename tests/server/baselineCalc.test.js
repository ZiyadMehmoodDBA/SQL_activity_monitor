// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../server/metricsSchema.js';
import { hourOfWeek, recomputeBaselines } from '../../server/baselineCalc.js';

// Mon 2026-01-05 00:00 UTC — a Monday, hour_of_week 0
const MON = Date.UTC(2026, 0, 5, 0, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MIN = 60_000;

function freshDb() {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare("INSERT INTO servers (instance_key, display_name, first_seen, last_seen) VALUES ('S1','S1',0,0)").run();
  return db;
}

// Seed `count` consecutive 1-minute rows starting at startTs for one KPI.
function seed1m(db, serverId, startTs, count, kpi, avg, sampleCount = 30) {
  const ins = db.prepare(
    `INSERT INTO samples_1m (server_id, ts, ${kpi}_avg, sample_count) VALUES (?, ?, ?, ?)`
  );
  for (let i = 0; i < count; i++) ins.run(serverId, startTs + i * MIN, avg, sampleCount);
}

describe('hourOfWeek', () => {
  it('Mon 00:00 UTC = 0', () => expect(hourOfWeek(MON)).toBe(0));
  it('Mon 01:30 UTC = 1', () => expect(hourOfWeek(MON + HOUR + 30 * MIN)).toBe(1));
  it('Sun 23:00 UTC = 167', () => expect(hourOfWeek(MON + 6 * DAY + 23 * HOUR)).toBe(167));
  it('next Mon 00:00 UTC wraps to 0', () => expect(hourOfWeek(MON + WEEK)).toBe(0));
});

describe('recomputeBaselines', () => {
  let db;
  beforeEach(() => { db = freshDb(); });

  it('computes weighted mean and population stddev per bucket', () => {
    // Two Mondays, same bucket 0: avg=10 (n=60 raw) and avg=20 (n=60 raw), 60 minutes each
    const now = MON + 2 * WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 60);
    seed1m(db, 1, MON + WEEK, 60, 'cpu_pct', 20, 60);
    recomputeBaselines(db, now);
    const row = db.prepare(
      "SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=0"
    ).get();
    expect(row.mean).toBeCloseTo(15, 6);
    expect(row.stddev).toBeCloseTo(5, 6);   // population stddev of {10×,20×} equal weights
    expect(row.sample_count).toBe(120);     // minute-row count, not summed raw count
    expect(row.computed_at).toBe(now);
  });

  it('excludes NULL avg rows from both sums', () => {
    const now = MON + WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 30);
    // 60 NULL rows in the same bucket must not drag the mean
    const ins = db.prepare('INSERT INTO samples_1m (server_id, ts, cpu_pct_avg, sample_count) VALUES (?, ?, NULL, 30)');
    for (let i = 0; i < 60; i++) ins.run(1, MON + WEEK - DAY + i * MIN); // Sunday rows, different bucket — also add same-bucket NULLs:
    for (let i = 0; i < 5; i++) db.prepare('INSERT INTO samples_1m (server_id, ts, cpu_pct_avg, sample_count) VALUES (?, ?, NULL, 30)').run(1, MON + 60 * MIN + i * MIN);
    recomputeBaselines(db, now);
    const row = db.prepare("SELECT mean FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=0").get();
    expect(row.mean).toBeCloseTo(10, 6);
  });

  it('gates on minute-row count >= 60, not summed sample_count', () => {
    // 59 minute rows with huge sample_count (59×30=1770 raw) must NOT produce an hour-of-week row on its own
    const now = MON + WEEK;
    seed1m(db, 1, MON, 59, 'cpu_pct', 10, 30);
    recomputeBaselines(db, now);
    const row = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=0").get();
    expect(row).toBeUndefined(); // fallback ladder also fails: hour-of-day total is 59 < 60
  });

  it('falls back to hour-of-day aggregate written into hour-of-week rows', () => {
    // 30 minutes at Mon 02:00 + 40 minutes at Thu 02:00 → neither bucket reaches 60,
    // but hour-of-day 02 has 70 minute-rows → both buckets get the aggregated stats
    const now = MON + WEEK;
    seed1m(db, 1, MON + 2 * HOUR, 30, 'cpu_pct', 10, 30);
    seed1m(db, 1, MON + 3 * DAY + 2 * HOUR, 40, 'cpu_pct', 20, 30);
    recomputeBaselines(db, now);
    const monRow = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=2").get();
    const thuRow = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct' AND hour_of_week=?").get(3 * 24 + 2);
    const expectedMean = (10 * 30 * 30 + 20 * 40 * 30) / (30 * 30 + 40 * 30); // weighted by sample_count
    expect(monRow.mean).toBeCloseTo(expectedMean, 6);
    expect(thuRow.mean).toBeCloseTo(expectedMean, 6);
    expect(monRow.sample_count).toBe(70);
  });

  it('ignores samples older than 28 days', () => {
    const now = MON + 5 * WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 99, 30); // 5 weeks old — outside lookback
    recomputeBaselines(db, now);
    const row = db.prepare("SELECT * FROM baselines WHERE server_id=1 AND kpi='cpu_pct'").get();
    expect(row).toBeUndefined();
  });

  it('replaces a server\'s rows transactionally (old rows gone after recompute)', () => {
    const now1 = MON + WEEK;
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 30);
    recomputeBaselines(db, now1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM baselines').get().c).toBeGreaterThan(0);
    // Move time so the old data falls outside lookback → recompute should leave zero rows
    recomputeBaselines(db, MON + 6 * WEEK);
    expect(db.prepare('SELECT COUNT(*) AS c FROM baselines').get().c).toBe(0);
  });

  it('returns number of rows written', () => {
    seed1m(db, 1, MON, 60, 'cpu_pct', 10, 30);
    const n = recomputeBaselines(db, MON + WEEK);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
