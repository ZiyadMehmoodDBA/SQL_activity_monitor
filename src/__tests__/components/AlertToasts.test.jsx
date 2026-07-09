import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import AlertToasts from '../../components/AlertToasts.jsx';

let mockLastAlertEvent = null;
vi.mock('../../context/ConnectionContext.jsx', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    useConnections: () => ({ lastAlertEvent: mockLastAlertEvent, connections: {} }),
  };
});

describe('AlertToasts', () => {
  beforeEach(() => { vi.useFakeTimers(); mockLastAlertEvent = null; });
  afterEach(() => { vi.useRealTimers(); });

  it('shows an open toast with spec text and auto-dismisses after 8s', () => {
    const { rerender } = render(<AlertToasts />);
    mockLastAlertEvent = { connId: 'c1', seq: 1, alert: { id: 1, kpi: 'cpu_pct', value: 94, mean: 31, stddev: 8, startedAt: 1, resolvedAt: null } };
    rerender(<AlertToasts />);
    expect(screen.getByText(/CPU 94% vs typical 31%±8%/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(8100); });
    expect(screen.queryByText(/CPU 94%/)).not.toBeInTheDocument();
  });

  it('resolve event renders a green resolve toast', () => {
    const { rerender } = render(<AlertToasts />);
    mockLastAlertEvent = { connId: 'c1', seq: 1, alert: { id: 1, kpi: 'cpu_pct', value: 33, mean: 31, stddev: 8, startedAt: 1, resolvedAt: 999 } };
    rerender(<AlertToasts />);
    expect(screen.getByText(/resolved/i)).toBeInTheDocument();
  });

  it('same seq does not duplicate a toast on re-render', () => {
    mockLastAlertEvent = { connId: 'c1', seq: 1, alert: { id: 1, kpi: 'cpu_pct', value: 94, mean: 31, stddev: 8, startedAt: 1, resolvedAt: null } };
    const { rerender } = render(<AlertToasts />);
    rerender(<AlertToasts />);
    expect(screen.getAllByText(/CPU 94%/)).toHaveLength(1);
  });
});
