import { describe, it, expect } from 'vitest';
import { hourOfWeek, bandData } from '../../lib/baselineBand.js';

const MON = Date.UTC(2026, 0, 5); // Monday 00:00 UTC → 0
const HOUR = 3_600_000;

describe('hourOfWeek (client)', () => {
  it('matches server bucket math', () => {
    expect(hourOfWeek(MON)).toBe(0);
    expect(hourOfWeek(MON + HOUR)).toBe(1);
    expect(hourOfWeek(MON + 6 * 86_400_000 + 23 * HOUR)).toBe(167);
  });
});

describe('bandData', () => {
  const rows = [
    { hour_of_week: 0, mean: 30, stddev: 5 },
    { hour_of_week: 1, mean: 40, stddev: 25 }, // lo would be −10 → clamp 0
  ];
  it('maps timestamps to mean±2σ ranges', () => {
    const out = bandData(rows, [MON, MON + HOUR]);
    expect(out[0]).toEqual({ x: MON, y: [20, 40] });
    expect(out[1]).toEqual({ x: MON + HOUR, y: [0, 90] }); // clamped at 0
  });
  it('null band for missing buckets', () => {
    const out = bandData(rows, [MON + 2 * HOUR]);
    expect(out[0]).toEqual({ x: MON + 2 * HOUR, y: null });
  });
  it('empty rows → all null', () => {
    expect(bandData([], [MON])[0].y).toBeNull();
  });
});
