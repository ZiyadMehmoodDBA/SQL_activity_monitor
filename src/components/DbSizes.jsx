import React from 'react'
import { fmtBytes } from '../lib/fmt'

export default function DbSizes({ data }) {
  if (!data || data.length === 0) {
    return <span className="text-slate-400 italic text-xs">No data</span>
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
    <div className="space-y-4">
      {sortedVols.map((vol, vi) => {
        const freePct = vol.total > 0 ? (vol.avail / vol.total) * 100 : 100
        const usedPct = 100 - freePct
        const isCrit  = freePct < 20
        const isWarn  = freePct < 35 && !isCrit
        const barCls  = isCrit ? 'bar-crit' : isWarn ? 'bar-warn' : 'bar-ok'
        const mountLabel = (vol.mount || '').replace(/\\+$/, '')

        return (
          <div key={vi}>
            <div className="flex items-center justify-between mb-1 gap-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: isCrit ? '#ef4444' : isWarn ? '#f59e0b' : '#22c55e' }} />
                <span className={`text-xs font-bold ${isCrit ? 'text-red-700' : isWarn ? 'text-amber-700' : 'text-slate-700'}`}>
                  {mountLabel}
                </span>
                {isCrit && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: '#fef2f2', color: '#dc2626' }}>
                    LOW DISK
                  </span>
                )}
              </div>
              <span className="text-xs text-slate-500 flex-shrink-0">
                <span className={isCrit ? 'text-red-600 font-bold' : isWarn ? 'text-amber-600 font-semibold' : 'text-green-600'}>
                  {fmtBytes(vol.avail)} free
                </span>
                {' / '}{fmtBytes(vol.total)}
                {' · '}
                <span className={isCrit ? 'text-red-600 font-bold' : isWarn ? 'text-amber-600 font-semibold' : 'text-green-600'}>
                  {freePct.toFixed(1)}% free
                </span>
              </span>
            </div>
            <div className="db-bar-track mb-2">
              <div className={`db-bar-fill ${barCls}`} style={{ width: `${usedPct.toFixed(2)}%` }} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              {vol.dbs.map((row, di) => {
                const dbPct = vol.total > 0 ? Math.min(100, (row.allocated_bytes / vol.total) * 100) : 0
                return (
                  <div key={di} className="bg-slate-50 rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-xs font-semibold text-slate-700 truncate" title={row.database_name}>
                        {row.database_name}
                      </span>
                      <span className="text-xs text-slate-500 flex-shrink-0">{fmtBytes(row.allocated_bytes)}</span>
                    </div>
                    <div className="db-bar-track">
                      <div className="db-bar-fill bar-ok" style={{ width: `${dbPct.toFixed(2)}%`, background: 'var(--sort-active)', opacity: 0.7 }} />
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
