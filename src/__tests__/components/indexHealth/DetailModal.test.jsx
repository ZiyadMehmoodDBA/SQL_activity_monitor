import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import DetailModal from '../../../components/indexHealth/DetailModal'

const fragRow = {
  _tab: 'fragmented',
  database_name: 'mydb', schema_name: 'dbo', table_name: 'Orders',
  index_name: 'IX_Orders_Date',
  avg_fragmentation_in_percent: 67.3,
  page_count: 12500,
  recommendation: 'REBUILD',
  index_type_desc: 'NONCLUSTERED',
}

const missingRow = {
  _tab: 'missing',
  database_name: 'mydb', schema_name: 'dbo', table_name: 'Orders',
  equality_columns: 'OrderDate',
  inequality_columns: null,
  impact_score: 82,
  create_script: 'CREATE INDEX [IX_missing_Orders_OrderDate]\nON dbo.Orders ([OrderDate]);',
}

describe('DetailModal', () => {
  it('renders nothing when row is null', () => {
    const { container } = render(<DetailModal row={null} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows table and index name for fragmented row', () => {
    render(<DetailModal row={fragRow} onClose={() => {}} />)
    // "Orders" appears in the header subtitle (dbo.Orders) and the Table row;
    // the index name appears in both the header title and the Index row.
    expect(screen.getAllByText(/Orders/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/IX_Orders_Date/).length).toBeGreaterThan(0)
  })

  it('shows recommendation for fragmented row', () => {
    render(<DetailModal row={fragRow} onClose={() => {}} />)
    expect(screen.getByText(/REBUILD/i)).toBeInTheDocument()
  })

  it('shows create script for missing row', () => {
    render(<DetailModal row={missingRow} onClose={() => {}} />)
    expect(screen.getByText(/CREATE INDEX/i)).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<DetailModal row={fragRow} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<DetailModal row={fragRow} onClose={onClose} />)
    const backdrop = container.querySelector('[data-backdrop]')
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows impact score for missing row', () => {
    render(<DetailModal row={missingRow} onClose={() => {}} />)
    expect(screen.getByText(/82/)).toBeInTheDocument()
  })
})
