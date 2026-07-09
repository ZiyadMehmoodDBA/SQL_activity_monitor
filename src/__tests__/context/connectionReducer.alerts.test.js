import { describe, it, expect } from 'vitest';
import { connectionReducer, initialConnectionState } from '../../context/connectionReducer.js';
import { normalizeAlertRow } from '../../lib/alertFmt.js';

const CONN = 'c1';

function stateWithConn() {
  // Build a state containing one live connection the way the reducer itself does.
  // If the reducer has a CONNECTED/ADD_CONNECTION action, use it; otherwise construct minimally:
  return {
    ...initialConnectionState,
    connections: {
      [CONN]: { id: CONN, alerts: [] },
    },
  };
}

const openAlert = { id: 1, kpi: 'cpu_pct', direction: 'above', severity: 'critical', value: 90, mean: 30, stddev: 5, startedAt: 1000, resolvedAt: null };

describe('ALERT_EVENT', () => {
  it('adds an open alert to the connection', () => {
    const s = connectionReducer(stateWithConn(), { type: 'ALERT_EVENT', connId: CONN, alert: openAlert });
    expect(s.connections[CONN].alerts).toHaveLength(1);
    expect(s.lastAlertEvent.alert.id).toBe(1);
    expect(s.lastAlertEvent.seq).toBe(1);
  });

  it('removes the alert on resolve event and bumps seq', () => {
    let s = connectionReducer(stateWithConn(), { type: 'ALERT_EVENT', connId: CONN, alert: openAlert });
    s = connectionReducer(s, { type: 'ALERT_EVENT', connId: CONN, alert: { ...openAlert, resolvedAt: 2000 } });
    expect(s.connections[CONN].alerts).toHaveLength(0);
    expect(s.lastAlertEvent.seq).toBe(2);
    expect(s.lastAlertEvent.alert.resolvedAt).toBe(2000);
  });

  it('replaces rather than duplicates the same alert id', () => {
    let s = connectionReducer(stateWithConn(), { type: 'ALERT_EVENT', connId: CONN, alert: openAlert });
    s = connectionReducer(s, { type: 'ALERT_EVENT', connId: CONN, alert: { ...openAlert, value: 95 } });
    expect(s.connections[CONN].alerts).toHaveLength(1);
    expect(s.connections[CONN].alerts[0].value).toBe(95);
  });

  it('ignores events for unknown connections', () => {
    const s0 = stateWithConn();
    const s = connectionReducer(s0, { type: 'ALERT_EVENT', connId: 'nope', alert: openAlert });
    expect(s).toBe(s0);
  });
});

describe('ALERTS_LOADED / ALERT_ACKED', () => {
  it('replaces the alert list', () => {
    const s = connectionReducer(stateWithConn(), { type: 'ALERTS_LOADED', connId: CONN, alerts: [openAlert, { ...openAlert, id: 2 }] });
    expect(s.connections[CONN].alerts).toHaveLength(2);
  });

  it('marks a single alert acked', () => {
    let s = connectionReducer(stateWithConn(), { type: 'ALERTS_LOADED', connId: CONN, alerts: [openAlert, { ...openAlert, id: 2 }] });
    s = connectionReducer(s, { type: 'ALERT_ACKED', connId: CONN, alertId: 2, ackedAt: 5000 });
    expect(s.connections[CONN].alerts.find((a) => a.id === 2).ackedAt).toBe(5000);
    expect(s.connections[CONN].alerts.find((a) => a.id === 1).ackedAt).toBeUndefined();
  });
});

describe('deep link', () => {
  it('SET_DEEP_LINK / CLEAR_DEEP_LINK round-trip', () => {
    let s = connectionReducer(stateWithConn(), { type: 'SET_DEEP_LINK', connId: CONN, from: 100, to: 200 });
    expect(s.deepLink).toEqual({ connId: CONN, from: 100, to: 200 });
    s = connectionReducer(s, { type: 'CLEAR_DEEP_LINK' });
    expect(s.deepLink).toBeNull();
  });
});

describe('normalizeAlertRow', () => {
  it('maps snake_case DB row to camelCase', () => {
    const row = {
      id: 3, server_id: 1, kpi: 'io_mb', started_at: 10, resolved_at: null,
      peak_value: 200, peak_at: 12, baseline_mean: 20, baseline_stddev: 4,
      direction: 'above', severity: 'critical', acked_at: null,
    };
    expect(normalizeAlertRow(row)).toEqual({
      id: 3, kpi: 'io_mb', startedAt: 10, resolvedAt: null,
      peakValue: 200, peakAt: 12, mean: 20, stddev: 4,
      direction: 'above', severity: 'critical', ackedAt: null,
    });
  });
});
