import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import ScanProgress from '../../../components/indexHealth/ScanProgress'

const baseProgress = { pct: 45, currentDb: 'Northwind', completedDbs: 3, totalDbs: 7, timedOutDbs: [], eta: 20 }

describe('ScanProgress', () => {
  it('renders nothing when phase is idle', () => {
    const { container } = render(<ScanProgress phase="idle" progress={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders progress bar when phase is running', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('fills progress bar to correct percentage', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('45')
  })

  it('shows current database name', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByText(/Northwind/)).toBeInTheDocument()
  })

  it('shows completed/total counter', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByText(/3.*of.*7/i)).toBeInTheDocument()
  })

  it('shows ETA when eta is set', () => {
    render(<ScanProgress phase="running" progress={baseProgress} />)
    expect(screen.getByText(/~20s/i)).toBeInTheDocument()
  })

  it('hides ETA when eta is null', () => {
    render(<ScanProgress phase="running" progress={{ ...baseProgress, eta: null }} />)
    expect(screen.queryByText(/~.*s/i)).not.toBeInTheDocument()
  })

  it('shows timed-out badge when timedOutDbs is non-empty', () => {
    render(<ScanProgress phase="running" progress={{ ...baseProgress, timedOutDbs: ['dbA', 'dbB'] }} />)
    expect(screen.getByText(/2.*timed out/i)).toBeInTheDocument()
  })

  it('renders during pending phase too', () => {
    render(<ScanProgress phase="pending" progress={{ pct: 0, currentDb: null, completedDbs: 0, totalDbs: 0, timedOutDbs: [], eta: null }} />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })
})
