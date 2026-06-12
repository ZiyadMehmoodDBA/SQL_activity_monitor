import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

function fmtCell(val, type, titleOverride) {
  if (val === null || val === undefined) {
    return <span style={{ color: 'var(--text-muted)', opacity: .5 }}>—</span>
  }
  switch (type) {
    case 'num':
      return <span className="tabular-nums">{Math.round(val).toLocaleString()}</span>
    case 'dec':
      return <span className="tabular-nums">{parseFloat(val).toFixed(1)}</span>
    case 'zero':
      return val && val !== 0
        ? <span style={{ color: 'var(--c-crit)', fontWeight: 500 }} className="tabular-nums">{val}</span>
        : <span style={{ color: 'var(--text-muted)', opacity: .4 }}>—</span>
    case 'badge': {
      const s = String(val).toLowerCase()
      const cls = s === 'running'    ? 'status-running'
                : s === 'suspended'  ? 'status-suspended'
                : s === 'sleeping'   ? 'status-sleeping'
                : s === 'background' ? 'status-background'
                : 'status-other'
      return (
        <span className={`px-1.5 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${cls}`}>
          {val}
        </span>
      )
    }
    case 'query': {
      const text = String(val).replace(/\s+/g, ' ').trim()
      const short = text.length > 60 ? text.slice(0, 60) + '…' : text
      return (
        <span
          title={titleOverride ?? text}
          style={{
            display: 'block',
            maxWidth: 280,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'monospace',
            fontSize: 10,
            color: 'var(--text-secondary)',
          }}
        >
          {short || <span style={{ color: 'var(--text-muted)', opacity: .4 }}>—</span>}
        </span>
      )
    }
    case 'trunc': {
      const s = String(val)
      return (
        <span
          title={titleOverride ?? s}
          style={{ display: 'block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {s || '—'}
        </span>
      )
    }
    default: {
      const s = String(val) || <span style={{ color: 'var(--text-muted)', opacity: .4 }}>—</span>
      return titleOverride ? <span title={titleOverride}>{s}</span> : s
    }
  }
}

export default function VirtualTable({
  rows,
  columns,
  height = 320,
  rowHeight = 32,
  sortCol,
  sortDir,
  onSort,
  rowStyle,
  extraCol,
  renderExtraCell,
}) {
  const parentRef = useRef(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  })

  if (!rows || rows.length === 0) {
    return (
      // overflow:hidden — no scrollbar that could add height to the outer container
      <div style={{ overflow: 'hidden' }}>
        <table className="w-full text-xs">
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} className="vt-th">{c.label}</th>
              ))}
              {extraCol && <th className="vt-th" />}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td
                colSpan={columns.length + (extraCol ? 1 : 0)}
                className="italic text-center py-5 text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                No data
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    )
  }

  return (
    // overflow:hidden on outer wrapper prevents any scrollbar chrome from adding height.
    // The inner scroll container (overflow:auto) handles all scrolling for both axes.
    <div style={{ overflow: 'hidden' }}>
      <table className="w-full" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr>
            {columns.map(c => {
              const active = c.key === sortCol
              return (
                <th
                  key={c.key}
                  className={`vt-th sortable ${active ? 'sort-active' : ''}`}
                  onClick={() => onSort && onSort(c.key)}
                  style={{ width: c.width }}
                >
                  {c.label}
                  <span className="sort-icon">
                    {active ? (sortDir === 'desc' ? '↓' : '↑') : '⇅'}
                  </span>
                </th>
              )
            })}
            {extraCol && <th className="vt-th" style={{ width: 60 }} />}
          </tr>
        </thead>
      </table>
      <div
        ref={parentRef}
        className="op-scroll"
        style={{ overflow: 'auto', height, position: 'relative' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(vItem => {
            const row = rows[vItem.index]
            const style = {
              position: 'absolute',
              top: vItem.start,
              height: vItem.size,
              width: '100%',
              display: 'table',
              tableLayout: 'fixed',
            }
            const rs = rowStyle ? rowStyle(row, vItem.index) : {}
            return (
              <div key={vItem.key} style={style}>
                <table className="w-full" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr
                      className={`dr ${vItem.index % 2 ? 'dr-odd' : ''}`}
                      style={rs}
                    >
                      {columns.map(c => (
                        <td key={c.key} className="vt-td" style={{ width: c.width }}>
                          {fmtCell(row[c.key], c.type, c.titleFn ? (c.titleFn(row) || undefined) : undefined)}
                        </td>
                      ))}
                      {extraCol && renderExtraCell && (
                        <td className="vt-td" style={{ width: 60 }}>
                          {renderExtraCell(row)}
                        </td>
                      )}
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
