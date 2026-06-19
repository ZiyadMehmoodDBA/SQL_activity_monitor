import React from 'react'

const TH = {
  padding: '5px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '.04em', color: 'var(--text-muted)', textAlign: 'left',
  whiteSpace: 'nowrap', borderBottom: '1px solid var(--divider)',
}
const TD = {
  padding: '5px 12px', fontSize: 11.5, color: 'var(--text-primary)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  borderBottom: '1px solid var(--divider)',
}

const fmtInt = v => (v == null ? '' : Number(v).toLocaleString())

const BLOCKED_COLS = [
  { key: 'blocked_query',       label: 'Query Information', width: '40%',
    render: r => r.blocked_query || '', title: r => r.blocked_query || '' },
  { key: 'wait_time',           label: 'Blocked (sec)', num: true,
    render: r => ((r.wait_time || 0) / 1000).toFixed(1) },
  { key: 'blocking_session_id', label: 'Blocker SPID', num: true,
    render: r => r.blocking_session_id },
  { key: 'database_name',       label: 'Database',
    render: r => r.database_name || '' },
  { key: 'parent_object',       label: 'Parent Object',
    render: r => r.parent_object || '' },
]

const CPU_COLS = [
  { key: 'query_text',        label: 'Query Information', width: '40%',
    render: r => r.query_text || '', title: r => r.query_text_full || r.query_text || '' },
  { key: 'execution_count',   label: 'Executions', num: true,
    render: r => fmtInt(r.execution_count) },
  { key: 'total_worker_time', label: 'Total CPU (ms)', num: true,
    render: r => fmtInt(Math.round(r.total_worker_time || 0)) },
  { key: 'avg_cpu_ms',        label: 'Avg CPU (ms)', num: true,
    render: r => (r.avg_cpu_ms == null ? '' : Number(r.avg_cpu_ms).toFixed(1)) },
  { key: 'parent_object',     label: 'Parent Object',
    render: r => r.parent_object || '' },
]

const IO_COLS = [
  { key: 'query_text',           label: 'Query Information', width: '40%',
    render: r => r.query_text || '', title: r => r.query_text || '' },
  { key: 'total_logical_reads',  label: 'Logical Reads', num: true,
    render: r => fmtInt(r.total_logical_reads) },
  { key: 'total_physical_reads', label: 'Physical Reads', num: true,
    render: r => fmtInt(r.total_physical_reads) },
  { key: 'parent_object',        label: 'Parent Object',
    render: r => r.parent_object || '' },
]

function OptimizationWidget({ title, testId, badgeCount, badgeAlert, columns, rows, targetSectionId, emptyText }) {
  const top = rows.slice(0, 10)
  const navigate = () => {
    document.getElementById(`section-anchor-${targetSectionId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const alert = badgeAlert && badgeCount > 0
  return (
    <div className="mc overflow-hidden">
      <button type="button" onClick={navigate} title="Go to detailed section"
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
        style={{ borderBottom: '1px solid var(--divider)', background: 'transparent', cursor: 'pointer' }}>
        <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
          {title}
        </span>
        <span data-testid={`badge-${testId}`}
          className="text-xs px-2 py-0.5 rounded font-semibold tabular-nums ml-1"
          style={alert
            ? { background: 'rgba(239,68,68,.15)', color: '#ef4444' }
            : { background: 'var(--badge-bg)', color: 'var(--badge-text)' }}>
          {badgeCount}
        </span>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)' }}>view details →</span>
      </button>
      {top.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table data-testid={`widget-table-${testId}`}
            style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c.key} style={{ ...TH, width: c.width, textAlign: c.num ? 'right' : 'left' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {top.map((row, i) => (
                <tr key={i}>
                  {columns.map(c => (
                    <td key={c.key}
                      style={{ ...TD, textAlign: c.num ? 'right' : 'left', ...(c.num ? { fontVariantNumeric: 'tabular-nums' } : {}) }}
                      title={c.title ? c.title(row) : undefined}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function LongestBlockedQueriesWidget({ rows }) {
  const sorted = [...rows].sort((a, b) => (b.wait_time || 0) - (a.wait_time || 0))
  return (
    <OptimizationWidget title="Queries Longest Time Being Blocked" testId="blocked"
      badgeCount={rows.length} badgeAlert
      columns={BLOCKED_COLS} rows={sorted}
      targetSectionId="blocking" emptyText="No blocked queries" />
  )
}

export function CpuIntensiveQueriesWidget({ rows }) {
  return (
    <OptimizationWidget title="Queries Using the Most CPU" testId="cpu"
      badgeCount={rows.length}
      columns={CPU_COLS} rows={rows}
      targetSectionId="cpu" emptyText="No query data" />
  )
}

export function IoIntensiveQueriesWidget({ rows }) {
  return (
    <OptimizationWidget title="Queries Using the Most I/O" testId="io"
      badgeCount={rows.length}
      columns={IO_COLS} rows={rows}
      targetSectionId="recent" emptyText="No query data" />
  )
}

export default function QueryOptimizationSection({ blocking, cpuRows, ioRows }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 px-0.5 mb-3">
        <span className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Query Optimization
        </span>
      </div>
      <div className="space-y-6">
        <LongestBlockedQueriesWidget rows={blocking} />
        <CpuIntensiveQueriesWidget rows={cpuRows} />
        <IoIntensiveQueriesWidget rows={ioRows} />
      </div>
    </div>
  )
}
