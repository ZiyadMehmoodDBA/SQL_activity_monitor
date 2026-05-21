import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import IndexInventory from '../../../components/indexHealth/IndexInventory'

const noop = () => {}

const summary = { fragmentedCount: 5, missingCount: 3, unusedCount: 8, duplicateCount: 2 }

const makeData = (rows = []) => ({ rows, total: rows.length, page: 1, pageSize: 50 })

const fragRow = { database_name: 'db1', schema_name: 'dbo', table_name: 'Orders', index_name: 'IX_Orders_Date', avg_fragmentation_in_percent: 45, page_count: 5000, recommendation: 'REBUILD' }

const baseProps = {
  activeTab: 'fragmented',
  onTabChange: noop,
  data: makeData([fragRow]),
  loading: false,
  filter: { db: 'all', search: '' },
  onFilterChange: noop,
  page: 1,
  onPageChange: noop,
  summary,
  onRowClick: noop,
}

describe('IndexInventory', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  it('renders four tab buttons', () => {
    render(<IndexInventory {...baseProps} />)
    expect(screen.getByRole('button', { name: /fragmented/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /missing/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unused/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /duplicate/i })).toBeInTheDocument()
  })

  it('tab badge shows count from summary', () => {
    render(<IndexInventory {...baseProps} />)
    const fragTab = screen.getByRole('button', { name: /fragmented/i })
    expect(fragTab).toHaveTextContent('5')
  })

  it('calls onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn()
    render(<IndexInventory {...baseProps} onTabChange={onTabChange} />)
    fireEvent.click(screen.getByRole('button', { name: /missing/i }))
    expect(onTabChange).toHaveBeenCalledWith('missing')
  })

  it('shows fragmented row data', () => {
    render(<IndexInventory {...baseProps} />)
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText(/REBUILD/i)).toBeInTheDocument()
  })

  it('calls onRowClick when a row is clicked', () => {
    const onRowClick = vi.fn()
    render(<IndexInventory {...baseProps} onRowClick={onRowClick} />)
    // click the table row containing 'Orders'
    const cell = screen.getByText('Orders')
    const row = cell.closest('tr')
    fireEvent.click(row)
    expect(onRowClick).toHaveBeenCalledWith(fragRow)
  })

  it('shows pagination when total > pageSize', () => {
    render(<IndexInventory {...baseProps} data={{ rows: [fragRow], total: 100, page: 1, pageSize: 50 }} />)
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument()
  })

  it('calls onPageChange when Next is clicked', () => {
    const onPageChange = vi.fn()
    render(<IndexInventory {...baseProps} data={{ rows: [fragRow], total: 100, page: 1, pageSize: 50 }} onPageChange={onPageChange} />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('disables Prev button on page 1', () => {
    render(<IndexInventory {...baseProps} data={{ rows: [fragRow], total: 100, page: 1, pageSize: 50 }} />)
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled()
  })

  it('calls onFilterChange when search input changes', () => {
    const onFilterChange = vi.fn()
    render(<IndexInventory {...baseProps} onFilterChange={onFilterChange} />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'Orders' } })
    act(() => { vi.advanceTimersByTime(400) })
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'Orders' }))
  })

  it('shows loading state', () => {
    render(<IndexInventory {...baseProps} loading={true} data={null} />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows empty state when no rows', () => {
    render(<IndexInventory {...baseProps} data={makeData([])} />)
    expect(screen.getByText(/no.*fragmented/i)).toBeInTheDocument()
  })
})
