import React, { memo } from 'react'
import { metricStatusColor, C_OK } from '../lib/thresholds'

function HealthBar({ label, value, displayVal, badgeText, color, pct }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span className="font-bold tabular-nums text-sm" style={{ color }}>{displayVal}</span>
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded"
            style={{ color, background: color + '18' }}
          >
            {badgeText}
          </span>
        </div>
      </div>
      <div style={{ height: 6, background: 'var(--divider)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 99, width: `${Math.min(pct, 100)}%`, background: color, transition: 'width 0.5s ease, background 0.3s' }} />
      </div>
    </div>
  )
}

export default memo(function MemoryHealth({ conn }) {
  const id = conn.id
  const sp = conn.metrics?.serverPerf || {}

  const committed = sp.sqlTotalMemGb  || 0
  const target    = sp.sqlTargetMemGb || 0
  const pct       = sp.sqlMemPct      || 0
  const ple       = sp.pleSec         || 0
  const buf       = sp.bufferCacheHit || 0
  const grants    = sp.memGrantsPending || 0

  const pctColor   = metricStatusColor('sqlmem', pct) || '#3b82f6'
  const pleColor   = metricStatusColor('ple', ple)    || C_OK
  const bufColor   = metricStatusColor('bufcache', buf) || C_OK
  const grantColor = metricStatusColor('grants', grants) || C_OK

  const plePct    = Math.min((ple / 4000) * 100, 100)
  const pleLbl    = ple >= 1000 ? (ple / 1000).toFixed(1) + 'k s' : ple.toLocaleString() + ' s'
  const pleBadge  = ple < 300 ? 'Critical' : ple < 1000 ? 'Warning' : 'Healthy'

  const bufBadge  = buf < 95 ? 'Critical' : buf < 99 ? 'Warning' : 'Healthy'
  const grantBadge= grants === 0 ? 'Healthy' : grants < 5 ? 'Warning' : 'Critical'
  const grantPct  = Math.min((grants / 10) * 100, 100)

  return (
    <div className="mc p-6 mb-6" id={`memhealth-${id}`} style={{ overflow: 'hidden' }}>
      <div className="flex items-center gap-2 mb-4">
        <svg className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          Memory Health
        </span>
      </div>
      <div className="grid gap-6" style={{ gridTemplateColumns: '2fr 3fr' }}>
        {/* Left: Committed vs Target */}
        <div className="flex flex-col justify-center gap-2">
          <div className="flex items-end justify-between">
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Committed vs Target
            </span>
            <span className="font-bold tabular-nums leading-none" style={{ fontSize: 24, color: pctColor }}>
              {pct}%
            </span>
          </div>
          <div style={{ height: 10, background: 'var(--divider)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 99, width: `${Math.min(pct, 100)}%`, background: pctColor, transition: 'width 0.5s ease, background 0.3s' }} />
          </div>
          <div className="flex justify-between tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            <span>{committed.toFixed(1)} GB committed</span>
            <span>{target.toFixed(1)} GB target</span>
          </div>
        </div>
        {/* Right: PLE, Buffer Cache, Grants */}
        <div className="flex flex-col justify-center gap-3 pl-5" style={{ borderLeft: '1px solid var(--divider)' }}>
          <HealthBar label="Page Life Expectancy" displayVal={pleLbl} badgeText={pleBadge} color={pleColor} pct={plePct} />
          <HealthBar label="Buffer Cache Hit Ratio" displayVal={buf.toFixed(1) + '%'} badgeText={bufBadge} color={bufColor} pct={Math.min(buf, 100)} />
          <HealthBar label="Memory Grants Pending" displayVal={String(grants)} badgeText={grantBadge} color={grantColor} pct={grantPct} />
        </div>
      </div>
    </div>
  )
})
