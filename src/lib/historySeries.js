// Maps /api/connections/:id/history rows to the per-chart arrays Dashboard's
// ChartCards consume. Keys match buildCharts / conn.history keys.
const CHART_FIELDS = {
  cpu:          'cpu_pct',
  wait:         'waiting_tasks',
  io:           'io_mb',
  batch:        'batch_req',
  netMb:        'net_mbs',
  compilations: 'compilations_sec',
}

export function buildHistorySeries(rows, resolution) {
  const suffix = resolution === 'raw' ? '' : '_avg'
  const timestamps = rows.map(r => r.ts)
  const series = {}
  for (const [key, col] of Object.entries(CHART_FIELDS)) {
    series[key] = rows.map(r => r[col + suffix] ?? null)
  }
  return { timestamps, series }
}

export function aggregateWaits(rows) {
  const map = new Map()
  for (const r of rows) {
    const cur = map.get(r.wait_type) || {
      wait_type: r.wait_type, wait_time_ms: 0, waiting_tasks_count: 0, signal_wait_time_ms: 0,
    }
    cur.wait_time_ms        += r.wait_time_ms        || 0
    cur.waiting_tasks_count += r.waiting_tasks_count || 0
    cur.signal_wait_time_ms += r.signal_wait_time_ms || 0
    map.set(r.wait_type, cur)
  }
  const out = [...map.values()].sort((a, b) => b.wait_time_ms - a.wait_time_ms)
  const total = out.reduce((s, r) => s + r.wait_time_ms, 0)
  for (const r of out) r.wait_pct = total > 0 ? +((r.wait_time_ms / total) * 100).toFixed(1) : 0
  return out
}

export const RANGE_PRESETS = [
  { key: '1h',  label: '1h',  ms: 3_600_000 },
  { key: '6h',  label: '6h',  ms: 6 * 3_600_000 },
  { key: '24h', label: '24h', ms: 24 * 3_600_000 },
  { key: '7d',  label: '7d',  ms: 7 * 86_400_000 },
  { key: '30d', label: '30d', ms: 30 * 86_400_000 },
]
