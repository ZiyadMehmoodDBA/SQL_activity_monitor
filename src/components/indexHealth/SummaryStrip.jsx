import React from 'react'

function Pill({ label, count, alertColor }) {
  const isAlert = alertColor && count > 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      padding: '6px 14px', borderRadius: 10, background: 'var(--badge-bg)',
      border: `1px solid ${isAlert ? alertColor + '44' : 'var(--divider)'}`,
      minWidth: 72 }}>
      <span style={{ fontSize: 18, fontWeight: 800, lineHeight: 1,
        color: isAlert ? alertColor : 'var(--text-primary)' }}>{count}</span>
      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '.06em', color: 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}

export default function SummaryStrip({ summary, timedOutDbs }) {
  if (!summary) return null
  const { fragmentedCount, missingCount, unusedCount, duplicateCount, disabledCount } = summary

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 0 12px' }}>
      <Pill label="Fragmented" count={fragmentedCount} alertColor="#f97316" />
      <Pill label="Missing"    count={missingCount}    alertColor="#3b82f6" />
      <Pill label="Unused"     count={unusedCount}     alertColor={null}    />
      <Pill label="Duplicate"  count={duplicateCount}  alertColor={null}    />
      <Pill label="Disabled"   count={disabledCount}   alertColor="#ef4444" />
      {timedOutDbs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px', borderRadius: 10,
          background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.3)',
          fontSize: 11, fontWeight: 600, color: '#f59e0b', gap: 4 }}>
          ⚠ {timedOutDbs.length} db timed out
        </div>
      )}
    </div>
  )
}
