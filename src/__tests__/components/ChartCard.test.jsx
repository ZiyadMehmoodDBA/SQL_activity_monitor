import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChartCard from '../../components/ChartCard.jsx';

vi.mock('react-apexcharts', () => ({
  default: (props) => (
    <div
      data-testid="chart"
      data-series-count={Array.isArray(props.series) ? props.series.length : 0}
      data-first-type={props.series?.[0]?.type || ''}
    />
  ),
}));

const base = { title: 'CPU', value: 50, unit: '%', history: [10, 20, 30], color: '#f00' };
const ts = [1000, 2000, 3000];
const band = [{ x: 1000, y: [20, 40] }, { x: 2000, y: [20, 40] }, { x: 3000, y: [20, 40] }];

describe('ChartCard band prop', () => {
  it('live mode (no timestamps): band ignored, single series', () => {
    render(<ChartCard {...base} band={band} />);
    expect(screen.getByTestId('chart').dataset.seriesCount).toBe('1');
  });
  it('history mode without band: single series', () => {
    render(<ChartCard {...base} timestamps={ts} />);
    expect(screen.getByTestId('chart').dataset.seriesCount).toBe('1');
  });
  it('history mode with band: rangeArea series first + line series', () => {
    render(<ChartCard {...base} timestamps={ts} band={band} />);
    const el = screen.getByTestId('chart');
    expect(el.dataset.seriesCount).toBe('2');
    expect(el.dataset.firstType).toBe('rangeArea');
  });
  it('band of all-null y values is treated as absent', () => {
    render(<ChartCard {...base} timestamps={ts} band={ts.map((x) => ({ x, y: null }))} />);
    expect(screen.getByTestId('chart').dataset.seriesCount).toBe('1');
  });
});
