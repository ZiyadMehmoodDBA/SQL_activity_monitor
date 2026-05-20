import React from 'react'

export const FULL_WARN_MS = 7  * 86_400_000
export const FULL_CRIT_MS = 14 * 86_400_000
export const LOG_WARN_MS  = 2  * 3_600_000
export const LOG_CRIT_MS  = 24 * 3_600_000

export function ageMs(dateStr) {
  if (!dateStr) return Infinity
  return Date.now() - new Date(dateStr).getTime()
}

function BackupBadge({ dateStr, warnMs, critMs, na }) {
  if (na) return (
    <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>N/A</span>
  )
  const age    = ageMs(dateStr)
  const label  = dateStr
    ? new Date(dateStr).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never'
  const isCrit = !dateStr || age > critMs
  const isWarn = !isCrit && age > warnMs
  const color  = isCrit ? '#ef4444' : isWarn ? '#f59e0b' : '#22c55e'
  const bg     = isCrit ? 'rgba(239,68,68,.1)' : isWarn ? 'rgba(245,158,11,.1)' : 'rgba(34,197,94,.08)'
  const ring   = isCrit ? 'rgba(239,68,68,.25)' : isWarn ? 'rgba(245,158,11,.25)' : 'rgba(34,197,94,.2)'
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
      background: bg, color, border: `1px solid ${ring}`, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function RecoveryBadge({ model }) {
  const map = {
    FULL:        { bg: 'rgba(59,130,246,.08)',  color: '#3b82f6', ring: 'rgba(59,130,246,.2)' },
    SIMPLE:      { bg: 'rgba(100,116,139,.08)', color: '#64748b', ring: 'rgba(100,116,139,.2)' },
    BULK_LOGGED: { bg: 'rgba(245,158,11,.08)',  color: '#f59e0b', ring: 'rgba(245,158,11,.2)' },
  }
  const s = map[model] || map.SIMPLE
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
      background: s.bg, color: s.color, border: `1px solid ${s.ring}`,
      letterSpacing: '.03em', textTransform: 'uppercase',
    }}>
      {model}
    </span>
  )
}

export default function BackupHealth({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2">
        <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
          No user databases found
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)', opacity: .6 }}>
          Databases with ID &gt; 4 and state = online appear here
        </span>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
      <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
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
          {rows.map((r) => {
            const isFullRec = r.recovery_model_desc !== 'SIMPLE'
            const fullCrit  = !r.last_full || ageMs(r.last_full) > FULL_CRIT_MS
            const logCrit   = isFullRec && (!r.last_log || ageMs(r.last_log) > LOG_CRIT_MS)
            const rowAlert  = fullCrit || logCrit
            return (
              <tr key={r.database_name} className="wia-row"
                style={rowAlert ? { borderLeft: '2px solid rgba(239,68,68,.45)' } : undefined}>
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
                    ? <span className="tabular-nums text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {new Date(r.last_diff).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    : <span style={{ color: 'var(--text-muted)', opacity: .5 }}>—</span>}
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
