import React from 'react'

function scoreColor(severity) {
  if (severity === 'Critical') return '#ef4444'
  if (severity === 'Warning')  return '#f59e0b'
  return '#22c55e'
}

export default function HealthScore({ summary }) {
  if (!summary) return null
  const { score, severity, totalIndexes } = summary
  const color = scoreColor(severity)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0' }}>
      <div style={{
        width: 64, height: 64, borderRadius: '50%',
        border: `4px solid ${color}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 20, fontWeight: 800, lineHeight: 1, color: 'var(--text-primary)' }}>{score}</span>
        <span style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)', marginTop: 1 }}>/100</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color }}>{severity}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{totalIndexes.toLocaleString()} total indexes monitored</span>
      </div>
    </div>
  )
}
