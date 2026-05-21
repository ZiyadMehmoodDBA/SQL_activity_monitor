import React from 'react'

export default function ScanProgress({ phase, progress }) {
  if (phase !== 'running' && phase !== 'pending') return null

  const pct          = progress?.pct          ?? 0
  const currentDb    = progress?.currentDb    ?? null
  const completedDbs = progress?.completedDbs ?? 0
  const totalDbs     = progress?.totalDbs     ?? 0
  const timedOutDbs  = progress?.timedOutDbs  ?? []
  const eta          = progress?.eta          ?? null

  return (
    <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Progress bar */}
      <div
        role="progressbar"
        aria-label="Scan progress"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 6, borderRadius: 99, background: 'var(--divider)', overflow: 'hidden' }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: '#3b82f6', borderRadius: 99, transition: 'width 0.4s ease' }} />
      </div>

      {/* Status line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
        {currentDb !== null && (
          <span>Scanning <strong style={{ color: 'var(--text-primary)' }}>{currentDb}</strong></span>
        )}
        {totalDbs > 0 && (
          <span>{completedDbs} of {totalDbs} databases</span>
        )}
        {eta !== null && (
          <span>~{eta}s remaining</span>
        )}
        {timedOutDbs.length > 0 && (
          <span style={{ padding: '1px 7px', borderRadius: 99, background: 'rgba(245,158,11,.15)', color: '#f59e0b', fontWeight: 600, fontSize: 10 }}>
            {timedOutDbs.length} timed out
          </span>
        )}
      </div>
    </div>
  )
}
