import React from 'react'

const MODES = [
  { value: 'LIMITED',  label: 'LIMITED — fastest, page count only' },
  { value: 'SAMPLED',  label: 'SAMPLED — sample fragmentation' },
  { value: 'DETAILED', label: 'DETAILED — full scan, slowest' },
]

const ACTIVE_PHASES = new Set(['pending', 'running'])
const TERMINAL_DONE = new Set(['completed', 'completed_with_warnings'])

export default function ScanControls({ mode, onModeChange, phase, onStartScan, onCancelScan }) {
  const isActive  = ACTIVE_PHASES.has(phase)
  const isDone    = TERMINAL_DONE.has(phase)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <select
        value={mode}
        disabled={isActive}
        onChange={e => onModeChange(e.target.value)}
        style={{
          padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 500,
          background: 'var(--card-bg)', color: 'var(--text-primary)',
          border: '1px solid var(--input-border)', cursor: isActive ? 'not-allowed' : 'pointer',
          opacity: isActive ? 0.5 : 1,
        }}
      >
        {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>

      {isActive ? (
        <button
          aria-label="Cancel scan"
          onClick={onCancelScan}
          style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            background: 'rgba(239,68,68,.12)', color: '#ef4444',
            border: '1px solid rgba(239,68,68,.3)', cursor: 'pointer' }}
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={onStartScan}
          style={{ padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            background: 'var(--badge-bg)', color: 'var(--text-primary)',
            border: '1px solid var(--input-border)', cursor: 'pointer' }}
        >
          {isDone ? 'Run New Scan' : 'Run Scan'}
        </button>
      )}
    </div>
  )
}
