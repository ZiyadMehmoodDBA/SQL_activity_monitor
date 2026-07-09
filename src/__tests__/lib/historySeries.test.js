import { describe, it, expect } from 'vitest'
import { buildHistorySeries, RANGE_PRESETS } from '../../lib/historySeries'

describe('buildHistorySeries', () => {
  it('maps raw rows to chart keys', () => {
    const rows = [
      { ts: 1000, cpu_pct: 10, waiting_tasks: 2, io_mb: 1.5, batch_req: 100, net_mbs: 0.5, compilations_sec: 7 },
      { ts: 3000, cpu_pct: 20, waiting_tasks: 4, io_mb: 2.5, batch_req: 200, net_mbs: 1.5, compilations_sec: 9 },
    ]
    const { timestamps, series } = buildHistorySeries(rows, 'raw')
    expect(timestamps).toEqual([1000, 3000])
    expect(series.cpu).toEqual([10, 20])
    expect(series.wait).toEqual([2, 4])
    expect(series.io).toEqual([1.5, 2.5])
    expect(series.batch).toEqual([100, 200])
    expect(series.netMb).toEqual([0.5, 1.5])
    expect(series.compilations).toEqual([7, 9])
  })

  it('maps rollup rows via *_avg columns', () => {
    const rows = [{ ts: 60000, cpu_pct_avg: 33.3, waiting_tasks_avg: 1, io_mb_avg: 0.1, batch_req_avg: 50, net_mbs_avg: 0.2, compilations_sec_avg: 3, sample_count: 30 }]
    const { series } = buildHistorySeries(rows, '1m')
    expect(series.cpu).toEqual([33.3])
    expect(series.batch).toEqual([50])
  })

  it('missing values become null, not 0', () => {
    const { series } = buildHistorySeries([{ ts: 1000, cpu_pct: null }], 'raw')
    expect(series.cpu).toEqual([null])
    expect(series.io).toEqual([null])
  })

  it('presets cover 1h/6h/24h/7d/30d', () => {
    expect(RANGE_PRESETS.map(p => p.key)).toEqual(['1h', '6h', '24h', '7d', '30d'])
    expect(RANGE_PRESETS[0].ms).toBe(3_600_000)
    expect(RANGE_PRESETS[4].ms).toBe(30 * 86_400_000)
  })
})
