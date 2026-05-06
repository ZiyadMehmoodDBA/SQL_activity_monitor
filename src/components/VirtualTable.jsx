import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

const TH = 'px-3 py-2 text-left font-semibold whitespace-nowrap border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500'
const TD = 'px-3 py-1.5 border-b border-slate-50 whitespace-nowrap text-xs text-slate-700'

function fmtCell(val, type) {
  if (val === null || val === undefined) {
    return <span className="text-slate-300">—</span>
  }
  switch (type) {
    case 'num':
      return <span className="tabular-nums">{Math.round(val).toLocaleString()}</span>
    case 'dec':
      return <span className="tabular-nums">{parseFloat(val).toFixed(1)}</span>
    case 'zero':
      return val && val !== 0
        ? <span className="text-red-600 font-medium tabular-nums">{val}</span>
        : <span className="text-slate-300">—</span>
    case 'badge': {
      const s = String(val).toLowerCase()
      const cls = s === 'running' ? 'status-running'
        : s === 'suspended' ? 'status-suspended'
        : s === 'sleeping'  ? 'status-sleeping'
        : s === 'background'? 'status-background'
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
          className="query-cell block"
          title={text}
          style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 10 }}
        >
          {short || <span className="text-slate-300">—</span>}
        </span>
      )
    }
    case 'trunc': {
      const s = String(val)
      return (
        <span
          className="trunc-cell block"
          title={s}
          style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {s || '—'}
        </span>
      )
    }
    default:
      return String(val) || <span className="text-slate-300">—</span>
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
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} className={TH}>{c.label}</th>
              ))}
              {extraCol && <th className={TH}></th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={columns.length + (extraCol ? 1 : 0)} className="text-slate-400 italic text-center py-5 text-xs">
                No data
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr>
            {columns.map(c => {
              const active = c.key === sortCol
              return (
                <th
                  key={c.key}
                  className={`${TH} sortable ${active ? 'sort-active' : ''}`}
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
            {extraCol && <th className={TH} style={{ width: 60 }}></th>}
          </tr>
        </thead>
      </table>
      <div
        ref={parentRef}
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
                        <td key={c.key} className={TD} style={{ width: c.width }}>
                          {fmtCell(row[c.key], c.type)}
                        </td>
                      ))}
                      {extraCol && renderExtraCell && (
                        <td className={TD} style={{ width: 60 }}>
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
