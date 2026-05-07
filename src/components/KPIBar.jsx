import React, { useState } from 'react'
import { metricStatusColor, METRIC_THRESHOLDS, C_WARN, C_CRIT } from '../lib/thresholds'

// ── Compact number formatter ──────────────────────────────────────────────────
// Outputs: 82.9M, 4.3k, 327, 74.5  (no trailing .0)
function cFmt(n, dp = 1) {
  if (n === null || n === undefined || isNaN(n)) return '--'
  const abs = Math.abs(n)
  const trim = v => v.toFixed(dp).replace(/\.0+$/, '')
  if (abs >= 1_000_000_000) return trim(n / 1_000_000_000) + 'B'
  if (abs >= 1_000_000)     return trim(n / 1_000_000) + 'M'
  if (abs >= 10_000)        return trim(n / 1_000) + 'k'
  // Small numbers: up to 1 decimal place
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })
}

// ── PLE smart time formatter ──────────────────────────────────────────────────
function fmtPle(sec) {
  if (!sec && sec !== 0) return { v: '--', u: '' }
  if (sec >= 3600) return { v: (sec / 3600).toFixed(1).replace(/\.0$/, ''), u: 'hr' }
  if (sec >= 60)   return { v: String(Math.round(sec / 60)), u: 'min' }
  return { v: cFmt(sec), u: 's' }
}

// ── Delta from history (30s lookback = 15 readings at 2s each) ───────────────
function getDelta(arr, back = 15) {
  if (!arr || arr.length < back + 1) return null
  const curr = arr[arr.length - 1]
  const prev = arr[arr.length - 1 - back]
  if (curr == null || prev == null) return null
  const d = curr - prev
  return Math.abs(d) < 0.001 ? null : d
}

// ── Status badge label ────────────────────────────────────────────────────────
function getStatusLabel(color) {
  if (color === C_CRIT) return 'CRITICAL'
  if (color === C_WARN) return 'WARNING'
  return null
}

// ── Tooltip popup ─────────────────────────────────────────────────────────────
function TooltipPopup({ lines }) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 7px)',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#0f172a',
        color: '#cbd5e1',
        fontSize: 11,
        lineHeight: 1.65,
        padding: '7px 11px',
        borderRadius: 7,
        whiteSpace: 'nowrap',
        zIndex: 200,
        pointerEvents: 'none',
        boxShadow: '0 6px 20px rgba(0,0,0,.55)',
        border: '1px solid rgba(255,255,255,.08)',
      }}
    >
      {lines.map((ln, i) => (
        <div key={i} style={{ color: ln.muted ? '#64748b' : '#cbd5e1' }}>{ln.text}</div>
      ))}
      {/* Caret */}
      <div style={{
        position: 'absolute',
        top: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 0, height: 0,
        borderLeft: '5px solid transparent',
        borderRight: '5px solid transparent',
        borderTop: '5px solid #0f172a',
      }} />
    </div>
  )
}

// ── Micro sparkline ───────────────────────────────────────────────────────────
function Sparkline({ data, color, width = 54, height = 22 }) {
  if (!data || data.length < 3) return <div style={{ width, height, flexShrink: 0 }} />
  const valid = data.filter(v => v != null)
  if (valid.length < 2) return <div style={{ width, height, flexShrink: 0 }} />

  const min = Math.min(...valid)
  const max = Math.max(...valid)
  const range = max - min

  const pad = 2
  const norm = v => range === 0
    ? height / 2
    : height - pad - ((v - min) / range) * (height - pad * 2)

  const step = width / (data.length - 1)
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(norm(v ?? min)).toFixed(1)}`)
    .join(' ')

  const lastIdx = data.length - 1
  const lastV = data[lastIdx]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: 'visible', flexShrink: 0 }}
      aria-hidden
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.55}
      />
      {lastV != null && (
        <circle
          cx={(lastIdx * step).toFixed(1)}
          cy={norm(lastV).toFixed(1)}
          r={2}
          fill={color}
          opacity={0.85}
        />
      )}
    </svg>
  )
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KPICard({
  label,
  primary,       // formatted primary value string
  unit,          // unit shown after value (smaller font)
  history,       // number[] for sparkline + delta
  deltaUnit,     // unit suffix for delta text
  statusKey,     // key into METRIC_THRESHOLDS
  statusVal,     // raw numeric value for threshold check
  subtitle,      // fallback bottom row text when no delta
  tooltipLines,  // [{ text, muted? }]
  onClick,
}) {
  const [hovered, setHovered] = useState(false)

  const statusColor  = statusKey ? metricStatusColor(statusKey, statusVal) : null
  const statusLabel  = getStatusLabel(statusColor)
  const valueColor   = statusColor || 'var(--text-primary)'
  const accentColor  = statusColor || 'var(--divider)'
  const sparkColor   = statusColor || 'var(--sort-active)'

  const delta = getDelta(history)
  const showDelta = delta !== null && history != null

  return (
    <div
      className="mc mc-click"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '10px 14px 8px',
        borderTop: `2px solid ${accentColor}`,
        cursor: onClick ? 'pointer' : 'default',
        position: 'relative',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {/* ── Row 1: label + status badge ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        marginBottom: 7,
        minWidth: 0,
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.065em',
          color: 'var(--text-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          lineHeight: 1,
        }}>
          {label}
        </span>
        {statusLabel && (
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            color: statusColor,
            background: statusColor + '18',
            border: `1px solid ${statusColor}3a`,
            padding: '1px 5px',
            borderRadius: 99,
            letterSpacing: '.04em',
            flexShrink: 0,
            lineHeight: 1.4,
          }}>
            {statusLabel}
          </span>
        )}
      </div>

      {/* ── Row 2: value + sparkline ── */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 6,
      }}>
        {/* Value */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, minWidth: 0, overflow: 'hidden' }}>
          <span style={{
            fontSize: 26,
            fontWeight: 700,
            lineHeight: 1,
            color: valueColor,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-.015em',
            whiteSpace: 'nowrap',
          }}>
            {primary ?? '--'}
          </span>
          {unit && (
            <span style={{
              fontSize: 11,
              fontWeight: 500,
              color: statusColor ? statusColor : 'var(--text-secondary)',
              letterSpacing: 0,
              paddingBottom: 1,
              opacity: 0.8,
            }}>
              {unit}
            </span>
          )}
        </div>

        {/* Sparkline */}
        {history && history.length >= 3 && (
          <Sparkline
            data={history.slice(-20)}
            color={sparkColor}
            width={54}
            height={22}
          />
        )}
      </div>

      {/* ── Row 3: delta or subtitle ── */}
      <div style={{
        fontSize: 10,
        color: 'var(--text-muted)',
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        lineHeight: 1,
        minHeight: 12,
      }}>
        {showDelta ? (
          <>
            <span style={{ color: 'var(--text-secondary)', fontSize: 9, lineHeight: 1 }}>
              {delta > 0 ? '▲' : '▼'}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {delta > 0 ? '+' : ''}
              {cFmt(delta)}{deltaUnit ? '\u202F' + deltaUnit : ''} <span style={{ color: 'var(--text-muted)' }}>30s</span>
            </span>
          </>
        ) : subtitle ? (
          <span style={{ color: 'var(--text-muted)' }}>{subtitle}</span>
        ) : (
          <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>—</span>
        )}
      </div>

      {/* ── Hover tooltip ── */}
      {hovered && tooltipLines && tooltipLines.length > 0 && (
        <TooltipPopup lines={tooltipLines} />
      )}
    </div>
  )
}

// ── KPI bar ───────────────────────────────────────────────────────────────────
export default function KPIBar({ conn }) {
  const m    = conn?.metrics
  const sp   = m?.serverPerf || {}
  const hist = conn?.history || {}

  function scrollTo(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const ple    = sp.pleSec ?? 0
  const pleFmt = fmtPle(m ? ple : null)

  const sessions = m?.processes?.length ?? 0
  const memPct   = sp.sqlMemPct ?? 0
  const memGb    = sp.sqlTotalMemGb ?? 0
  const tgtGb    = sp.sqlTargetMemGb ?? 0

  return (
    <div className="grid grid-cols-6 gap-4 mb-6">

      {/* CPU */}
      <KPICard
        label="CPU Usage"
        primary={m ? cFmt(m.cpu_percent) : null}
        unit="%"
        history={hist.cpu}
        deltaUnit="%"
        statusKey="cpu"
        statusVal={m?.cpu_percent}
        tooltipLines={[
          { text: 'CPU Utilization (SQL Server)' },
          { text: 'Warn ≥ 70% · Critical ≥ 90%', muted: true },
        ]}
        onClick={() => scrollTo(`chart-cpu-${conn.id}`)}
      />

      {/* Waiting Tasks */}
      <KPICard
        label="Wait Tasks"
        primary={m ? cFmt(m.waiting_tasks) : null}
        history={hist.wait}
        statusKey="wait"
        statusVal={m?.waiting_tasks}
        subtitle="suspended / waiting"
        tooltipLines={[
          { text: 'Suspended + waiting requests' },
          { text: 'Warn ≥ 10 · Critical ≥ 50', muted: true },
        ]}
        onClick={() => scrollTo(`chart-wait-${conn.id}`)}
      />

      {/* Sessions */}
      <KPICard
        label="Sessions"
        primary={m ? cFmt(sessions) : null}
        subtitle="connected processes"
        tooltipLines={[
          { text: 'Active connected sessions' },
          { text: 'No threshold configured', muted: true },
        ]}
        onClick={() => scrollTo(`sessions-panel-${conn.id}`)}
      />

      {/* Database I/O */}
      <KPICard
        label="Database I/O"
        primary={m ? cFmt(m.db_io_mb) : null}
        unit="MB/s"
        history={hist.io}
        deltaUnit="MB/s"
        subtitle="read + write throughput"
        tooltipLines={[
          { text: 'Cumulative read + write MB/s' },
          { text: 'No threshold configured', muted: true },
        ]}
        onClick={() => scrollTo(`chart-io-${conn.id}`)}
      />

      {/* SQL Memory */}
      <KPICard
        label="SQL Memory"
        primary={m ? memGb.toFixed(1) : null}
        unit="GB"
        statusKey="sqlmem"
        statusVal={memPct}
        subtitle={m ? `${memPct}% of ${tgtGb.toFixed(1)} GB target` : undefined}
        tooltipLines={[
          { text: 'Committed vs target memory' },
          { text: `${memPct}% utilized · Warn ≥ 90% · Crit ≥ 98%`, muted: true },
        ]}
        onClick={() => scrollTo(`memhealth-${conn.id}`)}
      />

      {/* Page Life Expectancy */}
      <KPICard
        label="Page Life Exp."
        primary={m ? pleFmt.v : null}
        unit={m ? pleFmt.u : ''}
        statusKey="ple"
        statusVal={ple}
        subtitle="Warn < 1000s · Crit < 300s"
        tooltipLines={[
          { text: 'Page Life Expectancy (buffer pool)' },
          { text: 'Warn < 1000s · Critical < 300s', muted: true },
        ]}
        onClick={() => scrollTo(`memhealth-${conn.id}`)}
      />

    </div>
  )
}
