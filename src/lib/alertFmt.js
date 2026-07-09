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
