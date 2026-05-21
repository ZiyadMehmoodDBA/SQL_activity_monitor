import React from 'react'

const TABS = [
  { id: 'fragmented', label: 'Fragmented', countKey: 'fragmentedCount' },
  { id: 'missing',    label: 'Missing',    countKey: 'missingCount'    },
  { id: 'unused',     label: 'Unused',     countKey: 'unusedCount'     },
  { id: 'duplicate',  label: 'Duplicate',  countKey: 'duplicateCount'  },
]

const COLUMNS = {
  fragmented: [
    { key: 'database_name', label: 'DB' },
    { key: 'schema_name',   label: 'Schema' },
    { key: 'table_name',    label: 'Table' },
    { key: 'index_name',    label: 'Index' },
    { key: 'avg_fragmentation_in_percent', label: 'Frag %', render: v => v != null ? `${v.toFixed(1)}%` : '—' },
    { key: 'page_count',    label: 'Pages',  render: v => v != null ? v.toLocaleString() : '—' },
    { key: 'recommendation', label: 'Action' },
  ],
  missing: [
    { key: 'database_name',      label: 'DB' },
    { key: 'schema_name',        label: 'Schema' },
    { key: 'table_name',         label: 'Table' },
    { key: 'equality_columns',   label: 'Equality Cols' },
    { key: 'inequality_columns', label: 'Inequality Cols' },
    { key: 'impact_score',       label: 'Impact', render: v => v != null ? `${v}%` : '—' },
  ],
  unused: [
    { key: 'database_name', label: 'DB' },
    { key: 'schema_name',   label: 'Schema' },
    { key: 'table_name',    label: 'Table' },
    { key: 'index_name',    label: 'Index' },
  ],
  duplicate: [
    { key: 'database_name', label: 'DB' },
    { key: 'schema_name',   label: 'Schema' },
    { key: 'table_name',    label: 'Table' },
    { key: 'index_name',    label: 'Index' },
    { key: 'duplicate_of',  label: 'Duplicate Of' },
    { key: 'key_columns',   label: 'Key Cols' },
  ],
}

export default function IndexInventory({
  activeTab, onTabChange,
  data, loading,
  filter, onFilterChange,
  page, onPageChange,
  summary, onRowClick,
}) {
  const cols      = COLUMNS[activeTab] || COLUMNS.fragmented
  const rows      = data?.rows     ?? []
  const total     = data?.total    ?? 0
  const pageSize  = data?.pageSize ?? 50
  const totalPages = Math.ceil(total / pageSize)

  return (
    <div style={{ borderTop: '1px solid var(--divider)', marginTop: 8 }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '10px 0 0', borderBottom: '1px solid var(--divider)' }}>
        {TABS.map(t => {
          const count    = summary?.[t.countKey] ?? 0
          const isActive = activeTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '6px 12px', borderRadius: '8px 8px 0 0', fontSize: 12, fontWeight: isActive ? 700 : 500,
                background: isActive ? 'var(--card-bg)' : 'transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                border: 'none', cursor: 'pointer',
                borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
              }}
            >
              {t.label}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 99,
                background: 'var(--badge-bg)', color: 'var(--badge-text)',
              }}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 0', alignItems: 'center' }}>
        <input
          placeholder="Search table or index…"
          value={filter.search}
          onChange={e => onFilterChange({ ...filter, search: e.target.value })}
          style={{
            padding: '4px 10px', borderRadius: 7, fontSize: 12,
            background: 'var(--card-bg)', color: 'var(--text-primary)',
            border: '1px solid var(--input-border)', width: 220,
          }}
        />
      </div>

      {/* Table body */}
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          No {activeTab} indexes found.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.key} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={`${row.database_name}.${row.schema_name}.${row.table_name}.${row.index_name ?? row.equality_columns ?? i}`}
                  onClick={() => onRowClick(row)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--divider)' }}
                >
                  {cols.map(c => (
                    <td key={c.key} style={{ padding: '7px 10px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                      {c.render ? c.render(row[c.key]) : (row[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', justifyContent: 'flex-end', fontSize: 12 }}>
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--input-border)', background: 'var(--card-bg)', color: 'var(--text-primary)', cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.4 : 1 }}
          >
            Prev
          </button>
          <span style={{ color: 'var(--text-muted)' }}>Page {page} of {totalPages}</span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--input-border)', background: 'var(--card-bg)', color: 'var(--text-primary)', cursor: page >= totalPages ? 'not-allowed' : 'pointer', opacity: page >= totalPages ? 0.4 : 1 }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
