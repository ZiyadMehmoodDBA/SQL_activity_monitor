import { describe, it, expect } from 'vitest';
import { KPI_LABELS, fmtKpi, alertText } from '../../lib/alertFmt.js';

describe('fmtKpi', () => {
  it('formats each KPI with its unit', () => {
    expect(fmtKpi('cpu_pct', 94.26)).toBe('94.3%');
    expect(fmtKpi('io_mb', 12.34)).toBe('12.3 MB/s');
    expect(fmtKpi('ple_sec', 2954.7)).toBe('2955s');
    expect(fmtKpi('batch_req', 1520.4)).toBe('1520/s');
    expect(fmtKpi('waiting_tasks', 7.8)).toBe('8');
    expect(fmtKpi('mem_grants_pending', 3.2)).toBe('3');
  });
  it('null-safe', () => expect(fmtKpi('cpu_pct', null)).toBe('—'));
});

describe('alertText', () => {
  it('matches the spec toast pattern', () => {
    expect(alertText({ kpi: 'cpu_pct', value: 94, mean: 31, stddev: 8 })).toBe('CPU 94% vs typical 31%±8%');
  });
  it('falls back to peakValue when value absent (DB rows)', () => {
    expect(alertText({ kpi: 'cpu_pct', peakValue: 97, mean: 31, stddev: 8 })).toBe('CPU 97% vs typical 31%±8%');
  });
  it('has a label for all core-6', () => {
    expect(Object.keys(KPI_LABELS).sort()).toEqual(
      ['batch_req', 'cpu_pct', 'io_mb', 'mem_grants_pending', 'ple_sec', 'waiting_tasks']
    );
  });
});
