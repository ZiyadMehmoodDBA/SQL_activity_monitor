import React, { useState, useCallback } from 'react'

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])
  return (
    <button
      onClick={copy}
      style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        background: 'var(--badge-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

function FragmentedDetail({ row }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 12 }}>
      {[
        ['Database',      row.database_name],
        ['Schema',        row.schema_name],
        ['Table',         row.table_name],
        ['Index',         row.index_name],
        ['Type',          row.index_type_desc],
        ['Fragmentation', row.avg_fragmentation_in_percent != null ? `${row.avg_fragmentation_in_percent.toFixed(1)}%` : '—'],
        ['Pages',         row.page_count != null ? row.page_count.toLocaleString() : '—'],
        ['Action',        row.recommendation],
      ].map(([k, v]) => [
        <dt key={`k-${k}`} style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{k}</dt>,
        <dd key={`v-${k}`} style={{ color: 'var(--text-primary)', margin: 0 }}>{v ?? '—'}</dd>,
      ])}
    </dl>
  )
}

function MissingDetail({ row }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 12 }}>
        {[
          ['Database',        row.database_name],
          ['Schema',          row.schema_name],
          ['Table',           row.table_name],
          ['Equality Cols',   row.equality_columns   || '—'],
          ['Inequality Cols', row.inequality_columns || '—'],
          ['Impact Score',    `${row.impact_score}%`],
        ].map(([k, v]) => [
          <dt key={`k-${k}`} style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{k}</dt>,
          <dd key={`v-${k}`} style={{ color: 'var(--text-primary)', margin: 0 }}>{v}</dd>,
        ])}
      </dl>
      {row.create_script && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Create Script</span>
            <CopyButton text={row.create_script} />
          </div>
          <pre style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'rgba(0,0,0,.2)', fontSize: 11, color: 'var(--text-primary)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {row.create_script}
          </pre>
        </div>
      )}
    </div>
  )
}

function GenericDetail({ row }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 12 }}>
      {Object.entries(row).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [
        <dt key={`k-${k}`} style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{k}</dt>,
        <dd key={`v-${k}`} style={{ color: 'var(--text-primary)', margin: 0 }}>{String(v ?? '—')}</dd>,
      ])}
    </dl>
  )
}

export default function DetailModal({ row, onClose }) {
  if (!row) return null

  const title = row.index_name || row.table_name || 'Detail'
  const tab   = row._tab || (row.create_script ? 'missing' : row.recommendation ? 'fragmented' : 'unused')

  return (
    <div
      data-backdrop="true"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          borderRadius: 16, overflow: 'hidden', background: 'var(--card-bg)', border: '1px solid var(--input-border)',
          boxShadow: '0 32px 80px rgba(0,0,0,.4)' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--divider)', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{row.schema_name || '?'}.{row.table_name || '?'}</div>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid var(--input-border)', background: 'var(--badge-bg)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', flexGrow: 1 }}>
          {tab === 'fragmented' ? <FragmentedDetail row={row} /> :
           tab === 'missing'    ? <MissingDetail    row={row} /> :
                                  <GenericDetail    row={row} />}
        </div>
      </div>
    </div>
  )
}
