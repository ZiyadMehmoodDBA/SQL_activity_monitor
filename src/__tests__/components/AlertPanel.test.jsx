import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AlertPanel from '../../components/AlertPanel.jsx';

const activeAlert = { id: 1, kpi: 'cpu_pct', startedAt: Date.now() - 600_000, resolvedAt: null, peakValue: 97, peakAt: Date.now() - 300_000, mean: 31, stddev: 8, direction: 'above', severity: 'critical', ackedAt: null };
const mockDispatch = vi.fn();
const CONN = 'c1';

// Mock adapted to real hook shape: fields exposed at top level (no { state } wrapper).
vi.mock('../../context/ConnectionContext.jsx', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    useConnections: () => ({
      connections: { [CONN]: { id: CONN, alerts: [activeAlert] } },
      selectedConnectionId: CONN,
      dispatch: mockDispatch,
    }),
  };
});

beforeEach(() => {
  mockDispatch.mockClear();
  global.fetch = vi.fn((url, opts) => {
    if (opts?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ alerts: [
      { id: 9, kpi: 'io_mb', started_at: Date.now() - 86_400_000, resolved_at: Date.now() - 86_000_000, peak_value: 120, peak_at: 0, baseline_mean: 20, baseline_stddev: 4, direction: 'above', severity: 'critical', acked_at: null },
    ] }) });
  });
});

describe('AlertPanel', () => {
  it('renders active alerts with Ack button and resolved history', async () => {
    render(<AlertPanel open onClose={() => {}} />);
    expect(screen.getByText(/CPU/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ack/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/DB I\/O/)).toBeInTheDocument()); // resolved row fetched
  });

  it('Ack POSTs and dispatches ALERT_ACKED', async () => {
    render(<AlertPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /ack/i }));
    await waitFor(() =>
      expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'ALERT_ACKED', connId: CONN, alertId: 1 }))
    );
    expect(global.fetch).toHaveBeenCalledWith(`/api/connections/${CONN}/alerts/1/ack`, expect.objectContaining({ method: 'POST' }));
  });

  it('row click dispatches SET_DEEP_LINK with ±15min padding and closes', async () => {
    const onClose = vi.fn();
    render(<AlertPanel open onClose={onClose} />);
    fireEvent.click(screen.getByText(/CPU/));
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_DEEP_LINK', connId: CONN })));
    const call = mockDispatch.mock.calls.find((c) => c[0].type === 'SET_DEEP_LINK')[0];
    expect(call.from).toBe(activeAlert.startedAt - 15 * 60_000);
    expect(call.to).toBeGreaterThan(Date.now() - 5000); // unresolved → now + 15min
    expect(onClose).toHaveBeenCalled();
  });
});
