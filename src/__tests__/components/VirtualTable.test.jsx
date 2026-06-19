import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import VirtualTable from '../../components/VirtualTable'

// jsdom has no layout, so the virtualizer would return zero items. Mock it
// to emit one virtual row per data row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, key: i, start: i * 32, size: 32 })),
  }),
}))

const rows = [
  { parent_object: 'usp_ImportClaims', schema_name: 'dbo', object_id: 245575913, database_name: 'Medcare_DB', query_text: 'INSERT INTO #T SELECT 1', query_text_full: 'INSERT INTO #T\nSELECT 1' },
]

describe('VirtualTable titleFn', () => {
  it('uses titleFn result as tooltip on a default (str) cell', () => {
    const columns = [
      { key: 'parent_object', label: 'Parent Object', type: 'str',
        titleFn: r => `Schema: ${r.schema_name}\nObject Id: ${r.object_id}\nDatabase: ${r.database_name}` },
    ]
    render(<VirtualTable rows={rows} columns={columns} />)
    expect(screen.getByText('usp_ImportClaims'))
      .toHaveAttribute('title', 'Schema: dbo\nObject Id: 245575913\nDatabase: Medcare_DB')
  })

  it('overrides the built-in title on a query cell with titleFn result', () => {
    const columns = [
      { key: 'query_text', label: 'Query Information', type: 'query', titleFn: r => r.query_text_full },
    ]
    render(<VirtualTable rows={rows} columns={columns} />)
    expect(screen.getByText('INSERT INTO #T SELECT 1'))
      .toHaveAttribute('title', 'INSERT INTO #T\nSELECT 1')
  })

  it('keeps default behavior when titleFn absent', () => {
    const columns = [{ key: 'parent_object', label: 'Parent Object', type: 'str' }]
    render(<VirtualTable rows={rows} columns={columns} />)
    const el = screen.getByText('usp_ImportClaims')
    expect(el).not.toHaveAttribute('title')
  })
})
