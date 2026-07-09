import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AlertBell from '../../components/AlertBell.jsx';

// Mock the context hook — adapted to the real hook shape (fields exposed directly, not via state).
const mockConnections = {
  c1: { id: 'c1', alerts: [
    { id: 1, kpi: 'cpu_pct', startedAt: 1, resolvedAt: null, ackedAt: null },
    { id: 2, kpi: 'io_mb', startedAt: 2, resolvedAt: null, ackedAt: 999 }, // acked → not counted
  ] },
  c2: { id: 'c2', alerts: [
    { id: 3, kpi: 'ple_sec', startedAt: 3, resolvedAt: null, ackedAt: null },
  ] },
};
vi.mock('../../context/ConnectionContext.jsx', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useConnections: () => ({ connections: mockConnections }) };
});

describe('AlertBell', () => {
  it('badge shows active unacked count across all connections', () => {
    render(<AlertBell onClick={() => {}} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });
  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<AlertBell onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /alerts/i }));
    expect(onClick).toHaveBeenCalled();
  });
});
