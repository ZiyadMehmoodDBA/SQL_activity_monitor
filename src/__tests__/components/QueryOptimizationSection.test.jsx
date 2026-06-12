import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import QueryOptimizationSection from '../../components/QueryOptimizationSection'

afterEach(cleanup)

const blockingRows = Array.from({ length: 12 }, (_, i) => ({
  blocked_session_id: 100 + i,
  blocking_session_id: 55,
  wait_time: (12 - i) * 1000,
  database_name: 'medcare_db_dev',
  blocked_query: `SELECT ${i} FROM dbo.Orders`,
  parent_object: i % 2 ? 'usp_GetOrders' : 'Unknown',
}))

const cpuRows = Array.from({ length: 12 }, (_, i) => ({
  execution_count: 10 + i,
  total_worker_time: (12 - i) * 500,
  avg_cpu_ms: 42.5,
  query_text: `EXEC dbo.CpuProc${i}`,
  query_text_full: `EXEC dbo.CpuProc${i} -- full`,
  parent_object: `CpuProc${i}`,
  database_name: 'medcare_db_dev',
}))

const ioRows = Array.from({ length: 12 }, (_, i) => ({
  total_logical_reads: (12 - i) * 1000,
  total_physical_reads: (12 - i) * 10,
  query_text: `SELECT io ${i}`,
  parent_object: 'Unknown',
  database_name: 'medcare_db_dev',
}))

function renderSection(props = {}) {
  return render(
    <QueryOptimizationSection
      blocking={blockingRows}
      cpuRows={cpuRows}
      ioRows={ioRows}
      {...props}
    />
  )
}

describe('QueryOptimizationSection', () => {
  it('renders the three widget titles and section heading', () => {
    renderSection()
    expect(screen.getByText('Query Optimization')).toBeTruthy()
    expect(screen.getByText('Queries Longest Time Being Blocked')).toBeTruthy()
    expect(screen.getByText('Queries Using the Most CPU')).toBeTruthy()
    expect(screen.getByText('Queries Using the Most I/O')).toBeTruthy()
  })

  it('shows blocked count badge with full row count (not the top-10 slice)', () => {
    renderSection()
    expect(screen.getByTestId('badge-blocked').textContent).toBe('12')
  })

  it('caps each widget at 10 rows', () => {
    renderSection()
    const table = screen.getByTestId('widget-table-blocked')
    expect(table.querySelectorAll('tbody tr').length).toBe(10)
  })

  it('renders empty state when a widget has no rows', () => {
    renderSection({ blocking: [] })
    expect(screen.getByText('No blocked queries')).toBeTruthy()
    expect(screen.getByTestId('badge-blocked').textContent).toBe('0')
  })

  it('converts wait_time ms to seconds in the blocked widget', () => {
    renderSection({ blocking: [{ ...blockingRows[0], wait_time: 12500 }] })
    expect(screen.getByText('12.5')).toBeTruthy()
  })

  it('header click scrolls to the matching section anchor', () => {
    const anchor = document.createElement('div')
    anchor.id = 'section-anchor-blocking'
    anchor.scrollIntoView = vi.fn()
    document.body.appendChild(anchor)
    renderSection()
    fireEvent.click(screen.getByText('Queries Longest Time Being Blocked'))
    expect(anchor.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    anchor.remove()
  })

  it('header click on missing anchor does not throw', () => {
    renderSection()
    expect(() => fireEvent.click(screen.getByText('Queries Using the Most CPU'))).not.toThrow()
  })
})
