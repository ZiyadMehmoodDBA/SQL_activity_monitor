import React from 'react'
import { metricStatusColor } from '../lib/thresholds'

function KPICard({ id, label, value, baseColor, statusKey, statusVal, onClick }) {
  const overrideColor = statusKey ? metricStatusColor(statusKey, statusVal) : null
  const color = overrideColor || baseColor || 'var(--val-cpu)'
  return (
    <div
      className="mc mc-click flex flex-col gap-2.5"
      onClick={onClick}
      style={{ padding: '16px 18px', borderLeft: `3px solid ${color}`, cursor: 'pointer' }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
        {label}
      </div>
      <div className="font-bold tabular-nums leading-none" style={{ fontSize: 24, color }}>
        {value ?? '--'}
      </div>
    </div>
  )
}

export default function KPIBar({ conn }) {
  const m = conn?.metrics
  const sp = m?.serverPerf || {}

  function scrollTo(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="grid grid-cols-6 gap-5 mb-6">
      <KPICard
        label="CPU Usage"
        value={m ? m.cpu_percent + '%' : '--'}
        baseColor="var(--val-cpu)"
        statusKey="cpu"
        statusVal={m?.cpu_percent}
        onClick={() => scrollTo(`chart-cpu-${conn.id}`)}
      />
      <KPICard
        label="Waiting Tasks"
        value={m ? m.waiting_tasks?.toLocaleString() : '--'}
        baseColor="var(--val-wait)"
        statusKey="wait"
        statusVal={m?.waiting_tasks}
        onClick={() => scrollTo(`chart-wait-${conn.id}`)}
      />
      <KPICard
        label="Sessions"
        value={m ? m.processes?.length?.toLocaleString() : '--'}
        baseColor="var(--val-batch)"
        onClick={() => scrollTo(`sessions-panel-${conn.id}`)}
      />
      <KPICard
        label="Database I/O"
        value={m ? m.db_io_mb + ' MB/s' : '--'}
        baseColor="var(--val-io)"
        onClick={() => scrollTo(`chart-io-${conn.id}`)}
      />
      <KPICard
        label="SQL Memory"
        value={m ? (sp.sqlTotalMemGb || 0).toFixed(1) + ' GB' : '--'}
        baseColor="var(--val-wait)"
        statusKey="sqlmem"
        statusVal={sp.sqlMemPct}
        onClick={() => scrollTo(`memhealth-${conn.id}`)}
      />
      <KPICard
        label="Page Life Exp."
        value={m ? (sp.pleSec || 0).toLocaleString() + 's' : '--'}
        baseColor="var(--val-batch)"
        statusKey="ple"
        statusVal={sp.pleSec}
        onClick={() => scrollTo(`memhealth-${conn.id}`)}
      />
    </div>
  )
}
