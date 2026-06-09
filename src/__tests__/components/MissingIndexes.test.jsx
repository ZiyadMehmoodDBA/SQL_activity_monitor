import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import MissingIndexes from '../../components/MissingIndexes'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

const mockRows = [
  {
    database_name: 'TestDB',
    table_name: 'Orders',
    equality_columns: '[CustomerID]',
    inequality_columns: null,
    included_columns: '[OrderDate]',
    user_seeks: 1500,
    estimated_improvement: 9876.54,
    create_index_sql: 'CREATE INDEX [IX_Orders_1] ON dbo.Orders ([CustomerID]) INCLUDE ([OrderDate])',
  },
]

const defaultProps = { connId: 'conn-1', topN: 10, dbFilter: '' }

beforeEach(() => {
  mockFetch.mockReset()
})

describe('MissingIndexes', () => {
  it('renders idle state with Analyse button before any fetch', () => {
    render(<MissingIndexes {...defaultProps} />)
    expect(screen.getByRole('button', { name: /analyse/i })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows loading state while fetching', async () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // never resolves
    render(<MissingIndexes {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    expect(screen.getByText(/analysing/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /analysing/i })).toBeDisabled()
  })

  it('renders results table after successful fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: mockRows, count: 1, ts: '2026-06-09T10:00:00.000Z', cached: false, ttlMinutes: 10 }),
    })
    render(<MissingIndexes {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => expect(screen.getByText('TestDB')).toBeInTheDocument())
    expect(screen.getByText('Orders')).toBeInTheDocument()
  })

  it('shows error state on fetch failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 })
    render(<MissingIndexes {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument())
  })

  it('shows cache badge when result is cached', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: mockRows, count: 1, ts: '2026-06-09T10:00:00.000Z', cached: true, ttlMinutes: 10 }),
    })
    render(<MissingIndexes {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => expect(screen.getByText(/cached/i)).toBeInTheDocument())
  })

  it('Copy INDEX button writes create_index_sql to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: mockRows, count: 1, ts: '2026-06-09T10:00:00.000Z', cached: false, ttlMinutes: 10 }),
    })
    render(<MissingIndexes {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => screen.getByText('TestDB'))
    fireEvent.click(screen.getByRole('button', { name: /copy index/i }))
    expect(writeText).toHaveBeenCalledWith(mockRows[0].create_index_sql)
  })

  it('force refresh calls fetch with ?force=1', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: mockRows, count: 1, ts: '2026-06-09T10:00:00.000Z', cached: true, ttlMinutes: 10 }),
    })
    render(<MissingIndexes {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => screen.getByText(/cached/i))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: mockRows, count: 1, ts: '2026-06-09T10:01:00.000Z', cached: false, ttlMinutes: 10 }),
    })
    fireEvent.click(screen.getByRole('button', { name: /force refresh/i }))
    await waitFor(() => {
      const calls = mockFetch.mock.calls
      expect(calls[calls.length - 1][0]).toMatch(/\?force=1/)
    })
  })

  it('applies topN prop to limit displayed rows', async () => {
    const manyRows = Array.from({ length: 20 }, (_, i) => ({ ...mockRows[0], table_name: `Table${i}`, estimated_improvement: 100 - i }))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: manyRows, count: 20, ts: '2026-06-09T10:00:00.000Z', cached: false, ttlMinutes: 10 }),
    })
    render(<MissingIndexes connId="conn-1" topN={5} dbFilter="" />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => screen.getByText('Table0'))
    expect(screen.queryByText('Table5')).not.toBeInTheDocument()
  })

  it('applies dbFilter prop to filter by database_name', async () => {
    const twoDbRows = [
      { ...mockRows[0], database_name: 'DB_A', table_name: 'TableA' },
      { ...mockRows[0], database_name: 'DB_B', table_name: 'TableB' },
    ]
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: twoDbRows, count: 2, ts: '2026-06-09T10:00:00.000Z', cached: false, ttlMinutes: 10 }),
    })
    render(<MissingIndexes connId="conn-1" topN={10} dbFilter="DB_A" />)
    fireEvent.click(screen.getByRole('button', { name: /analyse/i }))
    await waitFor(() => screen.getByText('TableA'))
    expect(screen.queryByText('TableB')).not.toBeInTheDocument()
  })
})
