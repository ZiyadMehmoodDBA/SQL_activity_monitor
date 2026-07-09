export function normalizeAlertRow(row) {
  return {
    id: row.id,
    kpi: row.kpi,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    peakValue: row.peak_value,
    peakAt: row.peak_at,
    mean: row.baseline_mean,
    stddev: row.baseline_stddev,
    direction: row.direction,
    severity: row.severity,
    ackedAt: row.acked_at,
  };
}

export const KPI_LABELS = {
  cpu_pct: 'CPU',
  waiting_tasks: 'Waiting Tasks',
  io_mb: 'DB I/O',
  batch_req: 'Batch Req',
  ple_sec: 'PLE',
  mem_grants_pending: 'Mem Grants Pending',
};

export function fmtKpi(kpi, v) {
  if (v == null) return '—';
  switch (kpi) {
    case 'cpu_pct': return `${Math.round(v * 10) / 10}%`;
    case 'io_mb': return `${Math.round(v * 10) / 10} MB/s`;
    case 'ple_sec': return `${Math.round(v)}s`;
    case 'batch_req': return `${Math.round(v)}/s`;
    default: return `${Math.round(v)}`;
  }
}

export function alertText(a) {
  const label = KPI_LABELS[a.kpi] || a.kpi;
  const v = a.value ?? a.peakValue;
  return `${label} ${fmtKpi(a.kpi, v)} vs typical ${fmtKpi(a.kpi, a.mean)}±${fmtKpi(a.kpi, a.stddev)}`;
}
