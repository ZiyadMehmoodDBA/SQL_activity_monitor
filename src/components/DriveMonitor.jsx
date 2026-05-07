import React, { useState, useMemo, memo, useCallback } from 'react'
import { C_OK, C_WARN, C_CRIT, C_EMERGENCY, driveType, driveStatusLevel, DRIVE_THRESHOLDS } from '../lib/thresholds'

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const gb = bytes / 1073741824
  if (gb >= 1024) return (gb / 1024).toFixed(1) + ' TB'
  if (gb >= 1)    return gb.toFixed(1) + ' GB'
  return (bytes / 1048576).toFixed(0) + ' MB'
}

function fmtEta(hours) {
  if (hours < 1)   return '< 1 hr'
  if (hours < 24)  return Math.round(hours) + ' hr'
  if (hours < 168) return Math.round(hours / 24) + ' d'
  return '> 1 wk'
}

// ── Trend (last 30 readings at 2s each = 60s window) ─────────────────────────
function calcTrend(history) {
  if (!history || history.length < 10) return null
  const recent = history.slice(-30)
  const n      = recent.length
  const slope  = (recent[n - 1] - recent[0]) / n    // % per reading
  const sph    = slope * 1800                        // % per hour
  let etaHours = null
  if (slope < -0.005 && recent[n - 1] > 0) {
    etaHours = (recent[n - 1] / Math.abs(slope)) * 2 / 3600
  }
  return { sph, etaHours }
}

// ── Group metadata ────────────────────────────────────────────────────────────
const GROUP_META = {
  tempdb: { label: 'TempDB', accent: '#8b5cf6' },
  data:   { label: 'Data',   accent: '#3b82f6' },
  log:    { label: 'Log',    accent: '#10b981' },
  system: { label: 'OS',     accent: '#64748b' },
}

// OS (system) first so C:\ appears at top; then by operational risk profile
const GROUP_ORDER = ['system', 'tempdb', 'data', 'log']

function getDriveGroup(drive) {
  if (!drive.total_bytes) return 'system'
  const t = driveType(drive)
  if (t === 'tempdb') return 'tempdb'
  if (t === 'log')    return 'log'
  if (t === 'system') return 'system'
  return 'data'
}

// ── DriveCard — compact fixed 128px card ─────────────────────────────────────
const DriveCard = memo(function DriveCard({ drive, history, selected, onSelect }) {
  const noSql  = !drive.total_bytes
  const gk     = getDriveGroup(drive)
  const status = noSql ? { color: C_OK, label: '', level: 0 } : driveStatusLevel(drive)
  const meta   = GROUP_META[gk] || GROUP_META.data
  const trend  = useMemo(() => calcTrend(history), [history])

  const mount   = (drive.volume_mount_point || '?').replace(/\\*$/, '') + '\\'
  const usedPct = drive.used_pct ?? 0

  let trendText  = null
  let trendColor = 'var(--text-muted)'
  if (!noSql && trend) {
    if (trend.sph < -0.05) {
      trendText  = `↓ ${Math.abs(trend.sph).toFixed(2)}%/hr${trend.etaHours !== null ? ` · full ${fmtEta(trend.etaHours)}` : ''}`
      trendColor = status.level >= 2 ? status.color : C_WARN
    } else if (trend.sph > 0.05) {
      trendText  = `↑ ${trend.sph.toFixed(2)}%/hr`
      trendColor = C_OK
    }
  }

  return (
    <button
      onClick={onSelect}
      style={{
        height: 128,
        width: '100%',
        overflow: 'hidden',
        borderRadius: 8,
        background: 'var(--card-bg)',
        borderTop: `3px solid ${status.color}`,
        border: selected ? `2px solid ${status.color}` : '1px solid var(--card-border)',
        padding: '9px 11px 7px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        textAlign: 'left',
        cursor: 'pointer',
        boxShadow: selected
          ? `0 0 0 3px ${status.color}22, var(--card-shadow)`
          : 'var(--card-shadow)',
        transition: 'box-shadow .15s',
      }}
    >
      {/* Row 1: mount + type badge + alert */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, minWidth: 0, flexShrink: 0 }}>
        <span style={{
          fontFamily: 'monospace', fontWeight: 700, fontSize: 12,
          color: 'var(--text-primary)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
        }}>
          {mount}
        </span>
        <span style={{
          fontSize: 8, fontWeight: 700, letterSpacing: '.07em', flexShrink: 0,
          background: noSql ? 'var(--divider)' : meta.accent + '1a',
          color: noSql ? 'var(--text-muted)' : meta.accent,
          padding: '1px 5px', borderRadius: 3,
        }}>
          {meta.label.toUpperCase()}
        </span>
        {status.level >= 2 && (
          <span style={{
            fontSize: 8, fontWeight: 700, flexShrink: 0,
            color: status.color, background: status.color + '1a',
            border: `1px solid ${status.color}3a`, padding: '1px 5px', borderRadius: 3,
          }}>
            {status.label}
          </span>
        )}
      </div>

      {!noSql ? (
        <>
          {/* Row 2: used% + free */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: status.color, fontVariantNumeric: 'tabular-nums', letterSpacing: '-.01em' }}>
              {usedPct.toFixed(1)}%
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtBytes(drive.available_bytes)} free
            </span>
          </div>

          {/* Row 3: progress bar */}
          <div style={{ height: 4, background: 'var(--divider)', borderRadius: 99, overflow: 'hidden', marginBottom: 6, flexShrink: 0 }}>
            <div style={{
              height: '100%', borderRadius: 99,
              width: `${Math.min(usedPct, 100)}%`,
              background: status.color,
              transition: 'width .4s ease, background .3s',
            }} />
          </div>

          {/* Row 4: total + trend */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 9, flexShrink: 0 }}>
            <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtBytes(drive.total_bytes)}
            </span>
            {trendText
              ? <span style={{ color: trendColor }}>{trendText}</span>
              : <span style={{ color: 'var(--text-muted)', opacity: .4 }}>stable</span>
            }
          </div>
        </>
      ) : (
        /* OS drive with no SQL files */
        <>
          <div style={{ fontSize: 12, marginBottom: 4, flexShrink: 0 }}>
            <span style={{ fontWeight: 600, color: C_OK }}>{fmtBytes(drive.available_bytes)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> free</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', opacity: .6, flexShrink: 0 }}>
            no SQL files
          </div>
        </>
      )}
    </button>
  )
}, (prev, next) => (
  prev.selected           === next.selected           &&
  prev.drive.used_pct     === next.drive.used_pct     &&
  prev.drive.free_pct     === next.drive.free_pct     &&
  prev.drive.available_bytes === next.drive.available_bytes &&
  prev.history            === next.history
))

// ── DriveDetail — inline detail panel shown below a group ────────────────────
function DriveDetail({ drive, history, onClose }) {
  const noSql      = !drive.total_bytes
  const type       = noSql ? 'system' : driveType(drive)
  const status     = noSql ? { color: C_OK } : driveStatusLevel(drive)
  const trend      = useMemo(() => calcTrend(history), [history])
  const thresholds = DRIVE_THRESHOLDS[type] || DRIVE_THRESHOLDS.default
  const mount      = (drive.volume_mount_point || '?').replace(/\\*$/, '') + '\\'

  const stats = [
    { label: 'Total',     val: fmtBytes(drive.total_bytes)     },
    { label: 'Used',      val: fmtBytes(drive.used_bytes)      },
    { label: 'Free',      val: fmtBytes(drive.available_bytes) },
    { label: 'Used %',    val: noSql ? '—' : `${(drive.used_pct ?? 0).toFixed(2)}%` },
    { label: 'Databases', val: drive.database_count ?? '—'     },
    { label: 'Files',     val: drive.file_count ?? '—'         },
    { label: 'TempDB',    val: drive.has_tempdb ? 'Yes' : '—'  },
    { label: 'Log files', val: drive.has_log    ? 'Yes' : '—'  },
  ]

  return (
    <div style={{
      marginTop: 8, padding: '12px 14px',
      background: 'var(--divider)', borderRadius: 8,
      border: '1px solid var(--card-border)', position: 'relative',
    }}>
      <button
        onClick={onClose}
        aria-label="Close"
        style={{
          position: 'absolute', top: 8, right: 10,
          width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 15, lineHeight: 1, color: 'var(--text-muted)',
          background: 'none', border: 'none', cursor: 'pointer', borderRadius: 3,
        }}
      >
        ×
      </button>

      <div style={{ fontSize: 11, fontWeight: 700, color: status.color, marginBottom: 10, paddingRight: 24 }}>
        {mount}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '6px 14px', marginBottom: 8 }}>
        {stats.map(({ label, val }) => (
          <div key={label}>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-muted)', marginBottom: 2 }}>
              {label}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {!noSql && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--card-bg)', borderRadius: 5, padding: '5px 9px', lineHeight: 1.7 }}>
          <strong style={{ color: 'var(--text-secondary)' }}>Thresholds — </strong>
          Warn &lt; {thresholds.warn}% free · Crit &lt; {thresholds.crit}% free
          {thresholds.emergency !== undefined && ` · Emergency < ${thresholds.emergency}% free`}
          {trend && trend.sph < -0.05 && (
            <span style={{ color: C_WARN }}>
              {' · '}Consuming {Math.abs(trend.sph).toFixed(2)}%/hr
              {trend.etaHours !== null && ` · Full in ~${fmtEta(trend.etaHours)}`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── DriveGroup — collapsible section per type category ────────────────────────
// Stable key prop ensures React preserves component instance (and collapsed state)
// across the parent's 2s re-render cycle.
function DriveGroup({ groupKey: gk, drives, diskHistory, selectedMount, onSelectMount }) {
  const [collapsed, setCollapsed] = useState(true)
  const meta     = GROUP_META[gk] || GROUP_META.data
  const selDrive = selectedMount ? drives.find(d => d.volume_mount_point === selectedMount) : null

  const worstLevel = useMemo(
    () => drives.reduce((max, d) => Math.max(max, d.total_bytes ? driveStatusLevel(d).level : 0), 0),
    [drives]
  )

  const groupColor = worstLevel >= 3 ? C_EMERGENCY
    : worstLevel >= 2 ? C_CRIT
    : worstLevel >= 1 ? C_WARN
    : meta.accent

  const alertLabel = worstLevel >= 3 ? 'EMERGENCY'
    : worstLevel >= 2 ? 'CRITICAL'
    : worstLevel >= 1 ? 'WARNING'
    : null

  return (
    <div>
      {/* Group header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 7,
          padding: '3px 2px 8px', background: 'none', border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 2, background: groupColor, flexShrink: 0, display: 'inline-block' }} />
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-secondary)' }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({drives.length})</span>
        {alertLabel && (
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: groupColor, background: groupColor + '18', border: `1px solid ${groupColor}3a`,
            padding: '1px 6px', borderRadius: 99,
          }}>
            {alertLabel}
          </span>
        )}
        <span style={{
          marginLeft: 'auto', width: 16, height: 16, borderRadius: 3,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, lineHeight: 1, fontWeight: 400,
          color: 'var(--text-muted)', background: 'var(--divider)',
          flexShrink: 0,
        }}>
          {collapsed ? '+' : '−'}
        </span>
      </button>

      {!collapsed && (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
            gap: 8,
            marginBottom: selDrive ? 0 : 12,
          }}>
            {drives.map(d => (
              <DriveCard
                key={d.volume_mount_point}
                drive={d}
                history={diskHistory[d.volume_mount_point]}
                selected={selectedMount === d.volume_mount_point}
                onSelect={() => onSelectMount(
                  selectedMount === d.volume_mount_point ? null : d.volume_mount_point
                )}
              />
            ))}
          </div>

          {selDrive && (
            <div style={{ marginBottom: 12 }}>
              <DriveDetail
                drive={selDrive}
                history={diskHistory[selDrive.volume_mount_point]}
                onClose={() => onSelectMount(null)}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Drive Space Monitor ────────────────────────────────────────────────────────
export default memo(function DriveMonitor({ conn }) {
  const [selectedMount, setSelectedMount] = useState(null)

  const drives      = conn.metrics?.diskDrives || []
  const diskHistory = conn.diskHistory || {}

  const handleSelect = useCallback(mount => setSelectedMount(mount), [])

  const { groups, critCount, warnCount } = useMemo(() => {
    const byGroup = {}
    let critCount = 0, warnCount = 0

    // Deduplicate by volume_mount_point — server query fix prevents duplicates
    // but guard here in case dm_os_volume_stats still returns split rows
    const seen = new Set()
    const deduped = drives.filter(d => {
      const k = d.volume_mount_point
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    for (const d of deduped) {
      const gk = getDriveGroup(d)
      if (!byGroup[gk]) byGroup[gk] = []
      byGroup[gk].push(d)
      if (d.total_bytes) {
        const lv = driveStatusLevel(d).level
        if (lv >= 2) critCount++
        else if (lv === 1) warnCount++
      }
    }

    // Within each group: alphabetical by drive letter / mount path (C first)
    for (const gk of Object.keys(byGroup)) {
      byGroup[gk].sort((a, b) =>
        (a.volume_mount_point || '').localeCompare(b.volume_mount_point || '')
      )
    }

    return { groups: byGroup, critCount, warnCount }
  }, [drives])

  if (drives.length === 0) return null

  const orderedKeys  = GROUP_ORDER.filter(k => groups[k])
  const headerStatus = critCount > 0 ? C_CRIT : warnCount > 0 ? C_WARN : C_OK

  return (
    <div className="mc mb-6" id={`drive-monitor-${conn.id}`} style={{ overflow: 'hidden' }}>
      {/* ── Header ── */}
      <div style={{ padding: '12px 18px 10px', borderBottom: '1px solid var(--divider)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <svg style={{ width: 14, height: 14, color: 'var(--text-muted)', flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.58 4 8 4s8-1.79 8-4M4 7c0-2.21 3.58-4 8-4s8 1.79 8 4" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-secondary)' }}>
            Drive Space Monitor
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: headerStatus, display: 'inline-block', flexShrink: 0 }} />
            {drives.length} {drives.length === 1 ? 'drive' : 'drives'}
          </span>
          {critCount > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, color: C_CRIT, background: C_CRIT + '18', border: `1px solid ${C_CRIT}3a`, padding: '1px 7px', borderRadius: 99 }}>
              {critCount} critical
            </span>
          )}
          {warnCount > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, color: C_WARN, background: C_WARN + '18', border: `1px solid ${C_WARN}3a`, padding: '1px 7px', borderRadius: 99 }}>
              {warnCount} warning
            </span>
          )}
        </div>
      </div>

      {/* ── Groups — scroll-contained ── */}
      <div style={{ padding: '12px 18px 14px', maxHeight: 600, overflowY: 'auto' }}>
        {orderedKeys.map(gk => (
          <DriveGroup
            key={gk}
            groupKey={gk}
            drives={groups[gk]}
            diskHistory={diskHistory}
            selectedMount={selectedMount}
            onSelectMount={handleSelect}
          />
        ))}
      </div>
    </div>
  )
})
