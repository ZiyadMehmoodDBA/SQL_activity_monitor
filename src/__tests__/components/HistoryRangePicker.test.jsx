import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import HistoryRangePicker from '../../components/HistoryRangePicker'

describe('HistoryRangePicker', () => {
  it('renders Live + presets + Custom', () => {
    render(<HistoryRangePicker value={null} onChange={() => {}} />)
    for (const label of ['Live', '1h', '6h', '24h', '7d', '30d', 'Custom']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('clicking a preset emits { key, from, to } spanning that preset', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '6h' }))
    const arg = onChange.mock.calls[0][0]
    expect(arg.key).toBe('6h')
    expect(arg.to - arg.from).toBe(6 * 3_600_000)
    expect(arg.to).toBeLessThanOrEqual(Date.now())
  })

  it('clicking Live emits null', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={{ key: '1h', from: 1, to: 2 }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('Custom shows from/to inputs and Apply emits the parsed range', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-08T10:00' } })
    fireEvent.change(screen.getByLabelText('To'),   { target: { value: '2026-07-08T12:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const arg = onChange.mock.calls[0][0]
    expect(arg.key).toBe('custom')
    expect(arg.to - arg.from).toBe(2 * 3_600_000)
  })

  it('Apply with reversed range does not emit', () => {
    const onChange = vi.fn()
    render(<HistoryRangePicker value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-08T12:00' } })
    fireEvent.change(screen.getByLabelText('To'),   { target: { value: '2026-07-08T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
