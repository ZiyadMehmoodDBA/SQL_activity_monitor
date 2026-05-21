import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import HealthScore from '../../../components/indexHealth/HealthScore'
import SummaryStrip from '../../../components/indexHealth/SummaryStrip'

const healthySummary  = { score: 95, severity: 'Healthy',  totalIndexes: 200, fragmentedCount: 2,  missingCount: 1, unusedCount: 4,  duplicateCount: 0, disabledCount: 0 }
const warningSummary  = { score: 75, severity: 'Warning',  totalIndexes: 150, fragmentedCount: 15, missingCount: 8, unusedCount: 10, duplicateCount: 3, disabledCount: 1 }
const criticalSummary = { score: 42, severity: 'Critical', totalIndexes: 100, fragmentedCount: 40, missingCount: 20, unusedCount: 15, duplicateCount: 8, disabledCount: 5 }

describe('HealthScore', () => {
  it('displays the numeric score', () => {
    render(<HealthScore summary={healthySummary} />)
    expect(screen.getByText('95')).toBeInTheDocument()
  })

  it('displays severity label', () => {
    render(<HealthScore summary={healthySummary} />)
    expect(screen.getByText(/Healthy/i)).toBeInTheDocument()
  })

  it('shows Warning severity for score 75', () => {
    render(<HealthScore summary={warningSummary} />)
    expect(screen.getByText(/Warning/i)).toBeInTheDocument()
  })

  it('shows Critical severity for score 42', () => {
    render(<HealthScore summary={criticalSummary} />)
    expect(screen.getByText(/Critical/i)).toBeInTheDocument()
  })

  it('displays total index count', () => {
    render(<HealthScore summary={healthySummary} />)
    expect(screen.getByText(/200/)).toBeInTheDocument()
  })

  it('returns null when summary is null', () => {
    const { container } = render(<HealthScore summary={null} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('SummaryStrip', () => {
  it('shows fragmented count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('15')).toBeInTheDocument()
  })

  it('shows missing count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('shows unused count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('shows duplicate count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows disabled count', () => {
    render(<SummaryStrip summary={warningSummary} timedOutDbs={[]} />)
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('shows timed-out warning when timedOutDbs is non-empty', () => {
    render(<SummaryStrip summary={healthySummary} timedOutDbs={['dbA']} />)
    expect(screen.getByText(/1.*db.*timed out/i)).toBeInTheDocument()
  })

  it('does not show timed-out warning when timedOutDbs is empty', () => {
    render(<SummaryStrip summary={healthySummary} timedOutDbs={[]} />)
    expect(screen.queryByText(/timed out/i)).not.toBeInTheDocument()
  })
})
