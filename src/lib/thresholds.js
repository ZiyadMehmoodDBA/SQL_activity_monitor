export const C_OK = '#16a34a'
export const C_WARN = '#ea580c'
export const C_CRIT = '#dc2626'

export const METRIC_THRESHOLDS = {
  cpu:      { warn: 70,   crit: 90  },
  wait:     { warn: 10,   crit: 50  },
  sqlmem:   { warn: 90,   crit: 98  },
  ple:      { warn: 1000, crit: 300, inverse: true },
  bufcache: { warn: 99,   crit: 95,  inverse: true },
  grants:   { warn: 1,    crit: 5   },
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
