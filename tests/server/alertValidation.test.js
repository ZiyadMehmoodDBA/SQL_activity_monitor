// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseKpi, parseAlertId } from '../../server/alertValidation.js';

describe('parseKpi', () => {
  it('accepts each core-6 KPI', () => {
    for (const k of ['cpu_pct', 'waiting_tasks', 'io_mb', 'batch_req', 'ple_sec', 'mem_grants_pending']) {
      expect(parseKpi(k)).toBe(k);
    }
  });
  it('rejects unknown, empty, injection-ish input', () => {
    expect(parseKpi('cpu_pct; DROP TABLE alerts')).toBeNull();
    expect(parseKpi('')).toBeNull();
    expect(parseKpi(undefined)).toBeNull();
    expect(parseKpi('CPU_PCT')).toBeNull(); // case-sensitive allowlist
  });
});

describe('parseAlertId', () => {
  it('accepts positive integers', () => {
    expect(parseAlertId('42')).toBe(42);
    expect(parseAlertId(7)).toBe(7);
  });
  it('rejects non-integers, zero, negatives, NaN', () => {
    expect(parseAlertId('1.5')).toBeNull();
    expect(parseAlertId('0')).toBeNull();
    expect(parseAlertId('-3')).toBeNull();
    expect(parseAlertId('abc')).toBeNull();
    expect(parseAlertId('')).toBeNull();
    expect(parseAlertId(undefined)).toBeNull();
  });
});
