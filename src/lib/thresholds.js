export const C_OK        = '#16a34a'
export const C_WARN      = '#ea580c'
export const C_CRIT      = '#dc2626'
export const C_EMERGENCY = '#7f1d1d'  // deep crimson, below critical

export const METRIC_THRESHOLDS = {
  cpu:      { warn: 70,   crit: 90  },
  wait:     { warn: 10,   crit: 50  },
  sqlmem:   { warn: 90,   crit: 98  },
  ple:      { warn: 1000, crit: 300, inverse: true },
  bufcache: { warn: 99,   crit: 95,  inverse: true },
  grants:   { warn: 1,    crit: 5   },
}

// ── Drive space thresholds (free% boundaries) ──────────────────────────────
// Each drive type has its own thresholds based on operational risk profile.
// All values are free-space percentages (lower = more full).
export const DRIVE_THRESHOLDS = {
  system:  { warn: 20, crit: 10, emergency: 5  },  // C:\ — OS + page file risk
  data:    { warn: 15, crit: 8                 },  // SQL data files
  log:     { warn: 25, crit: 15                },  // Transaction logs grow fast
  tempdb:  { warn: 25, crit: 15                },  // TempDB spills fill drives rapidly
  default: { warn: 15, crit: 8                 },
}

// Classify a drive row (from diskDrives query) into a threshold category
export function driveType(drive) {
  const mp = (drive.volume_mount_point || '').toLowerCase().replace(/\//g, '\\')
  if (mp === 'c:\\' || mp === 'c:') return 'system'
  if (drive.has_tempdb) return 'tempdb'
  if (drive.has_log && !drive.has_data) return 'log'
  return 'data'
}

// Returns { color, label, level } where level: 0=ok 1=warn 2=crit 3=emergency
export function driveStatusLevel(drive) {
  const type = driveType(drive)
  const t    = DRIVE_THRESHOLDS[type] || DRIVE_THRESHOLDS.default
  const free = drive.free_pct ?? 100
  if (t.emergency !== undefined && free <= t.emergency) return { color: C_EMERGENCY, label: 'EMERGENCY', level: 3 }
  if (free <= t.crit) return { color: C_CRIT, label: 'CRITICAL', level: 2 }
  if (free <= t.warn) return { color: C_WARN, label: 'WARNING',  level: 1 }
  return { color: C_OK, label: 'HEALTHY', level: 0 }
}

export function metricStatusColor(key, val) {
  const t = METRIC_THRESHOLDS[key]
  if (!t || val === null || val === undefined || isNaN(val)) return null
  if (t.inverse) {
    if (val < t.crit) return C_CRIT
    if (val < t.warn) return C_WARN
    return C_OK
  } else {
    if (val >= t.crit) return C_CRIT
    if (val >= t.warn) return C_WARN
    return null
  }
}
