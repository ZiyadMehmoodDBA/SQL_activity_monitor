import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QueryTextModal from '../../components/QueryTextModal'

const row = {
  parent_object: 'usp_ImportClaims',
  object_type: 'Stored Procedure',
  query_text: 'INSERT INTO #TempHoldClaimsNo SELECT *',
  query_text_full: 'INSERT INTO #TempHoldClaimsNo\nSELECT *\nFROM Max_Claims\nWHERE 1 = 1',
}

describe('QueryTextModal', () => {
  it('renders nothing when row is null', () => {
    render(<QueryTextModal row={null} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows full query text with formatting preserved', () => {
    render(<QueryTextModal row={row} onClose={() => {}} />)
    const pre = screen.getByTestId('query-full-text')
    expect(pre.textContent).toBe(row.query_text_full)
    expect(pre.tagName).toBe('PRE')
  })

  it('shows parent object and type in the title', () => {
    render(<QueryTextModal row={row} onClose={() => {}} />)
    expect(screen.getByText(/usp_ImportClaims/)).toBeInTheDocument()
    expect(screen.getByText(/Stored Procedure/)).toBeInTheDocument()
  })

  it('falls back to query_text when query_text_full missing', () => {
    render(<QueryTextModal row={{ ...row, query_text_full: undefined }} onClose={() => {}} />)
    expect(screen.getByTestId('query-full-text').textContent).toBe(row.query_text)
  })

  it('calls onClose when dialog dismissed', () => {
    const onClose = vi.fn()
    render(<QueryTextModal row={row} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
