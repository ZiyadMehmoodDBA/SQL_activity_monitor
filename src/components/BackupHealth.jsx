import React from 'react'

export const FULL_WARN_MS = 7  * 86_400_000   // 7 days
export const FULL_CRIT_MS = 14 * 86_400_000   // 14 days
export const LOG_WARN_MS  = 2  * 3_600_000    // 2 hours
export const LOG_CRIT_MS  = 24 * 3_600_000    // 24 hours

export function ageMs(dateStr) {
  if (!dateStr) return Infinity
  return Date.now() - new Date(dateStr).getTime()
}

function BackupBadge({ dateStr, warnMs, critMs, na }) {
  if (na) return <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>N/A</span>
  const age   = ageMs(dateStr)
  const label = dateStr
    ? new Date(dateStr).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never'
  const isCrit = !dateStr || age > critMs
  const isWarn = !isCrit && age > warnMs
  const color  = isCrit ? '#ef4444' : isWarn ? '#f59e0b' : '#22c55e'
  const bg     = isCrit ? 'rgba(239,68,68,.12)' : isWarn ? 'rgba(245,158,11,.12)' : 'rgba(34,197,94,.10)'
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: bg, color, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function RecoveryBadge({ model }) {
  const styles = {
    FULL:        { bg: 'rgba(59,130,246,.12)',  color: '#3b82f6' },
    SIMPLE:      { bg: 'rgba(100,116,139,.12)', color: '#64748b' },
    BULK_LOGGED: { bg: 'rgba(245,158,11,.12)',  color: '#f59e0b' },
  }
  const s = styles[model] || styles.SIMPLE
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: s.bg, color: s.color }}>
      {model}
    </span>
  )
}

export default function BackupHealth({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        No user databases found
      </div>
    )
  }
  return (
    <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
      <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th className="wia-th">Database</th>
            <th className="wia-th">Recovery</th>
            <th className="wia-th">Last Full</th>
            <th className="wia-th">Last Diff</th>
            <th className="wia-th">Last Log</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isFullRec = r.recovery_model_desc !== 'SIMPLE'
            const fullCrit  = !r.last_full || ageMs(r.last_full) > FULL_CRIT_MS
            const logCrit   = isFullRec && (!r.last_log || ageMs(r.last_log) > LOG_CRIT_MS)
            const rowAlert  = fullCrit || logCrit
            return (
              <tr key={i} className="wia-row"
                style={rowAlert ? { borderLeft: '2px solid rgba(239,68,68,.4)' } : undefined}>
                <td className="wia-td" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {r.database_name}
                </td>
                <td className="wia-td">
                  <RecoveryBadge model={r.recovery_model_desc} />
                </td>
                <td className="wia-td">
                  <BackupBadge dateStr={r.last_full} warnMs={FULL_WARN_MS} critMs={FULL_CRIT_MS} />
                </td>
                <td className="wia-td">
                  {r.last_diff
                    ? <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {new Date(r.last_diff).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    : <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td className="wia-td">
                  <BackupBadge
                    dateStr={r.last_log}
                    warnMs={LOG_WARN_MS}
                    critMs={LOG_CRIT_MS}
                    na={!isFullRec}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
