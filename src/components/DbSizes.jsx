import React from 'react'
import { fmtBytes } from '../lib/fmt'

// Color helpers using CSS vars / semantic colors
function severityColor(isCrit, isWarn) {
  if (isCrit) return 'var(--c-crit)'
  if (isWarn) return 'var(--c-warn)'
  return 'var(--c-ok)'
}

export default function DbSizes({ data }) {
  if (!data || data.length === 0) {
    return (
      <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        No data
      </span>
    )
  }

  // Group by volume_mount_point
  const volumes = new Map()
  for (const row of data) {
    const vKey = row.volume_mount_point || String(row.volume_total_bytes)
    if (!volumes.has(vKey)) {
      volumes.set(vKey, {
        total: row.volume_total_bytes,
        avail: row.volume_available_bytes,
        mount: row.volume_mount_point || vKey,
        dbs: [],
      })
    } else {
      volumes.get(vKey).avail = row.volume_available_bytes
    }
    volumes.get(vKey).dbs.push(row)
  }

  const sortedVols = [...volumes.values()].sort((a, b) => a.mount.localeCompare(b.mount))

  return (
    <div className="space-y-5">
      {sortedVols.map((vol, vi) => {
        const freePct = vol.total > 0 ? (vol.avail / vol.total) * 100 : 100
        const usedPct = 100 - freePct
        const isCrit  = freePct < 20
        const isWarn  = freePct < 35 && !isCrit
        const barCls  = isCrit ? 'bar-crit' : isWarn ? 'bar-warn' : 'bar-ok'
        const color   = severityColor(isCrit, isWarn)
        const mountLabel = (vol.mount || '').replace(/\\+$/, '')

        return (
          <div key={vi}>
            {/* Volume header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: color }}>
                  {mountLabel}
                </span>
                {isCrit && (
                  <span style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(220,38,38,.1)',
                    color: 'var(--c-crit)',
                    border: '1px solid rgba(220,38,38,.2)',
                    letterSpacing: '.04em',
                  }}>
                    LOW DISK
                  </span>
                )}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>
                <span style={{ color, fontWeight: isCrit || isWarn ? 600 : 400 }}>
                  {fmtBytes(vol.avail)} free
                </span>
                {' / '}{fmtBytes(vol.total)}
                {' · '}
                <span style={{ color, fontWeight: isCrit || isWarn ? 600 : 400 }}>
                  {freePct.toFixed(1)}% free
                </span>
              </span>
            </div>

            {/* Volume usage bar */}
            <div className="db-bar-track" style={{ marginBottom: 10 }}>
              <div className={`db-bar-fill ${barCls}`} style={{ width: `${usedPct.toFixed(2)}%` }} />
            </div>

            {/* Database cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              {vol.dbs.map((row, di) => {
                const dbPct = vol.total > 0 ? Math.min(100, (row.allocated_bytes / vol.total) * 100) : 0
                return (
                  <div
                    key={di}
                    style={{
                      background: 'var(--divider)',
                      borderRadius: 8,
                      padding: '8px 12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                      <span
                        style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={row.database_name}
                      >
                        {row.database_name}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {fmtBytes(row.allocated_bytes)}
                      </span>
                    </div>
                    <div className="db-bar-track">
                      <div
                        className="db-bar-fill"
                        style={{ width: `${dbPct.toFixed(2)}%`, background: 'var(--sort-active)', opacity: 0.65 }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
