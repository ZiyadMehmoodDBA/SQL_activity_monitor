import React, { useState, useMemo, memo } from 'react'
import { C_OK, C_WARN, C_CRIT, C_EMERGENCY, driveType, driveStatusLevel, DRIVE_THRESHOLDS } from '../lib/thresholds'

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const gb = bytes / 1073741824  // 1024^3
  if (gb >= 1024) return (gb / 1024).toFixed(1) + ' TB'
  if (gb >= 1)    return gb.toFixed(1) + ' GB'
  return (bytes / 1048576).toFixed(0) + ' MB'
}

function fmtEta(hours) {
  if (hours < 1)   return '< 1 hr'
  if (hours < 24)  return Math.round(hours) + ' hr'
  if (hours < 168) return Math.round(hours / 24) + ' days'
  return '> 1 week'
}

// ── Trend engine ─────────────────────────────────────────────────────────────
// Computes slope from last N free_pct readings (each reading = 2s interval).
// Returns { slopePerHour, etaHours } or null if insufficient data.
function calcTrend(history) {
  if (!history || history.length < 10) return null
  const recent = history.slice(-30)   // last 60s of readings
  const n = recent.length
  // Simple regression: slope = (last - first) / count (readings)
  const slope = (recent[n - 1] - recent[0]) / n
  // Convert: 1800 readings/hr at 2s per reading
  const slopePerHour = slope * 1800
  const currentFree  = recent[n - 1]
  // Only project ETA when losing space at meaningful rate (>0.005% per reading)
  let etaHours = null
  if (slope < -0.005 && currentFree > 0) {
    etaHours = (currentFree / Math.abs(slope)) * 2 / 3600
  }
  return { slopePerHour, etaHours }
}

// ── Drive type labels ─────────────────────────────────────────────────────────
const TYPE_LABELS = { system: 'SYSTEM', data: 'DATA', log: 'LOG', tempdb: 'TEMPDB', default: 'DATA' }

// ── Individual drive card ─────────────────────────────────────────────────────
const DriveCard = memo(function DriveCard({ drive, history }) {
  const [expanded, setExpanded] = useState(false)

  const type   = driveType(drive)
  const status = driveStatusLevel(drive)
  const trend  = useMemo(() => calcTrend(history), [history])

  const mountPoint = drive.volume_mount_point || '?'
  const usedPct    = drive.used_pct  ?? 0
  const freePct    = drive.free_pct  ?? 0
  const barColor   = status.color
  const thresholds = DRIVE_THRESHOLDS[type] || DRIVE_THRESHOLDS.default

  return (
    <div
      className="mc"
      style={{ borderTop: `3px solid ${barColor}`, padding: '14px 16px 12px' }}
    >
      {/* ── Row 1: mount point + badges ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <span style={{
          fontFamily: 'monospace', fontWeight: 700, fontSize: 14,
          color: 'var(--text-primary)', flexShrink: 0,
        }}>
          {mountPoint}
        </span>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.05em',
          background: 'var(--divider)', color: 'var(--text-muted)',
          padding: '1px 5px', borderRadius: 3, flexShrink: 0,
        }}>
          {TYPE_LABELS[type] || 'DATA'}
        </span>
        <span style={{ flex: 1 }} />
        {status.level > 0 && (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '.04em',
            color: barColor, background: barColor + '18',
            border: `1px solid ${barColor}3a`,
            padding: '1px 6px', borderRadius: 99, flexShrink: 0,
          }}>
            {status.label}
          </span>
        )}
      </div>

      {/* ── Row 2: utilization percentage + bar ── */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
          <span style={{
            fontSize: 24, fontWeight: 700, lineHeight: 1,
            color: barColor, fontVariantNumeric: 'tabular-nums',
          }}>
            {usedPct.toFixed(1)}%
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {freePct.toFixed(1)}% free
          </span>
        </div>
        <div style={{ height: 7, background: 'var(--divider)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 99,
            width: `${Math.min(usedPct, 100)}%`,
            background: barColor,
            transition: 'width .4s ease, background .3s',
          }} />
        </div>
      </div>

      {/* ── Row 3: Total / Used / Free ── */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 10 }}>
        {[
          { label: 'Total', val: fmtBytes(drive.total_bytes),     color: 'var(--text-primary)' },
          { label: 'Used',  val: fmtBytes(drive.used_bytes),      color: 'var(--text-secondary)' },
          { label: 'Free',  val: fmtBytes(drive.available_bytes), color: barColor },
        ].map(({ label, val, color }) => (
          <div key={label}>
            <div style={{
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '.06em', color: 'var(--text-muted)', marginBottom: 2,
            }}>
              {label}
            </div>
            <div style={{
              fontSize: 12, fontWeight: 600, color,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* ── Row 4: trend + detail toggle ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 16 }}>
        <div style={{ flex: 1, fontSize: 10 }}>
          {trend ? (
            trend.slopePerHour < -0.05 ? (
              <span>
                <span style={{ color: status.level >= 2 ? barColor : C_WARN }}>↓ </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {Math.abs(trend.slopePerHour).toFixed(2)}%/hr
                </span>
                {trend.etaHours !== null && (
                  <span style={{ color: status.level >= 2 ? barColor : 'var(--text-muted)' }}>
                    {' '}· full in <strong>{fmtEta(trend.etaHours)}</strong>
                  </span>
                )}
              </span>
            ) : trend.slopePerHour > 0.05 ? (
              <span style={{ color: C_OK }}>↑ {trend.slopePerHour.toFixed(2)}%/hr reclaiming</span>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Stable · {drive.database_count} DB · {drive.file_count} files</span>
            )
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>{drive.database_count} DB · {drive.file_count} files</span>
          )}
        </div>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            fontSize: 9, color: 'var(--text-muted)', padding: '2px 7px',
            borderRadius: 4, background: 'var(--divider)', border: 'none',
            cursor: 'pointer', flexShrink: 0,
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
        >
          {expanded ? '▲ less' : '▼ details'}
        </button>
      </div>

      {/* ── Expanded detail panel ── */}
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--divider)' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 16px',
            fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8,
          }}>
            <div><span style={{ color: 'var(--text-muted)' }}>Databases: </span>{drive.database_count}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>Files: </span>{drive.file_count}</div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>TempDB: </span>
              <span style={{ color: drive.has_tempdb ? C_WARN : 'var(--text-muted)' }}>
                {drive.has_tempdb ? '✓ Yes' : '—'}
              </span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Log files: </span>
              {drive.has_log ? '✓ Yes' : '—'}
            </div>
          </div>
          <div style={{
            fontSize: 10, color: 'var(--text-muted)',
            background: 'var(--divider)', borderRadius: 6, padding: '6px 9px',
            lineHeight: 1.7,
          }}>
            <strong style={{ color: 'var(--text-secondary)' }}>{TYPE_LABELS[type] || 'DATA'} thresholds</strong>
            {' — '}
            Warn &lt; {thresholds.warn}% free
            {' · '}
            Crit &lt; {thresholds.crit}% free
            {thresholds.emergency !== undefined && ` · Emergency < ${thresholds.emergency}% free`}
          </div>
        </div>
      )}
    </div>
  )
})

// ── Drive Monitor panel ───────────────────────────────────────────────────────
export default memo(function DriveMonitor({ conn }) {
  const [sortBy, setSortBy] = useState('free_pct')  // most critical first by default

  const drives      = conn.metrics?.diskDrives || []
  const diskHistory = conn.diskHistory || {}

  // Memoized sorted list
  const sorted = useMemo(() => {
    const list = [...drives]
    if (sortBy === 'free_pct') list.sort((a, b) => (a.free_pct ?? 100) - (b.free_pct ?? 100))
    else if (sortBy === 'mount') list.sort((a, b) => (a.volume_mount_point || '').localeCompare(b.volume_mount_point || ''))
    else if (sortBy === 'total') list.sort((a, b) => (b.total_bytes || 0) - (a.total_bytes || 0))
    return list
  }, [drives, sortBy])

  // Overall worst status for header indicator
  const summary = useMemo(() => {
    let worstLevel = 0
    let critCount  = 0
    let warnCount  = 0
    for (const d of drives) {
      const s = driveStatusLevel(d)
      if (s.level > worstLevel) worstLevel = s.level
      if (s.level >= 2) critCount++
      else if (s.level === 1) warnCount++
    }
    return { worstLevel, critCount, warnCount }
  }, [drives])

  if (drives.length === 0) return null

  const headerColor = summary.worstLevel >= 3 ? C_EMERGENCY
    : summary.worstLevel >= 2 ? C_CRIT
    : summary.worstLevel >= 1 ? C_WARN
    : C_OK

  return (
    <div className="mc mb-6" id={`drive-monitor-${conn.id}`}>
      {/* ── Header ── */}
      <div style={{ padding: '13px 18px 11px', borderBottom: '1px solid var(--divider)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Icon */}
          <svg style={{ width: 14, height: 14, color: 'var(--text-muted)', flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.58 4 8 4s8-1.79 8-4M4 7c0-2.21 3.58-4 8-4s8 1.79 8 4" />
          </svg>

          <span style={{
            fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.06em', color: 'var(--text-secondary)',
          }}>
            Drive Space Monitor
          </span>

          {/* Drive count */}
          <span style={{ fontSize: 12, fontWeight: 700, color: headerColor }}>
            {drives.length} {drives.length === 1 ? 'drive' : 'drives'}
          </span>

          {/* Alert badges */}
          {summary.critCount > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: C_CRIT, background: C_CRIT + '18', border: `1px solid ${C_CRIT}3a`,
              padding: '1px 7px', borderRadius: 99,
            }}>
              {summary.critCount} critical
            </span>
          )}
          {summary.warnCount > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: C_WARN, background: C_WARN + '18', border: `1px solid ${C_WARN}3a`,
              padding: '1px 7px', borderRadius: 99,
            }}>
              {summary.warnCount} warning
            </span>
          )}

          {/* Sort controls */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Sort:</span>
            {[['free_pct', '% Free'], ['mount', 'Drive'], ['total', 'Size']].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSortBy(k)}
                style={{
                  fontSize: 10, fontWeight: sortBy === k ? 700 : 500,
                  padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                  background: sortBy === k ? 'var(--sort-active)' : 'var(--divider)',
                  color:      sortBy === k ? '#fff' : 'var(--text-secondary)',
                  transition: 'all .15s',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Drive grid ── */}
      <div style={{
        padding: '14px 16px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
        gap: 12,
      }}>
        {sorted.map(d => (
          <DriveCard
            key={d.volume_mount_point}
            drive={d}
            history={diskHistory[d.volume_mount_point]}
          />
        ))}
      </div>
    </div>
  )
})
