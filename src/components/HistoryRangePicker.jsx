import React, { useState } from 'react'
import { RANGE_PRESETS } from '../lib/historySeries'

const btnStyle = (active) => ({
  fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
  border: `1px solid ${active ? 'var(--sort-active)' : 'var(--divider)'}`,
  background: active ? 'var(--sort-active)' : 'var(--input-bg)',
  color: active ? '#fff' : 'var(--text-primary)', cursor: 'pointer',
})

export default function HistoryRangePicker({ value, onChange }) {
  const [customOpen, setCustomOpen] = useState(false)
  const [fromStr, setFromStr] = useState('')
  const [toStr, setToStr] = useState('')
  const activeKey = value?.key ?? 'live'

  const applyCustom = () => {
    const from = fromStr ? new Date(fromStr).getTime() : NaN
    const to = toStr ? new Date(toStr).getTime() : Date.now()
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return
    onChange({ key: 'custom', from, to })
  }

  return (
    <div className="flex items-center gap-2 flex-wrap mb-4">
      <button style={btnStyle(activeKey === 'live')} onClick={() => { setCustomOpen(false); onChange(null) }}>Live</button>
      {RANGE_PRESETS.map(p => (
        <button key={p.key} style={btnStyle(activeKey === p.key)}
          onClick={() => { setCustomOpen(false); const to = Date.now(); onChange({ key: p.key, from: to - p.ms, to }) }}>
          {p.label}
        </button>
      ))}
      <button style={btnStyle(activeKey === 'custom')} onClick={() => setCustomOpen(o => !o)}>Custom</button>
      {customOpen && (
        <span className="flex items-center gap-2" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          <label className="flex items-center gap-1">From
            <input aria-label="From" type="datetime-local" value={fromStr} onChange={e => setFromStr(e.target.value)}
              style={{ fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--divider)', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          </label>
          <label className="flex items-center gap-1">To
            <input aria-label="To" type="datetime-local" value={toStr} onChange={e => setToStr(e.target.value)}
              style={{ fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--divider)', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          </label>
          <button style={btnStyle(false)} onClick={applyCustom}>Apply</button>
        </span>
      )}
    </div>
  )
}
