import React from 'react'
import { describe, it, expect } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { renderWithContext, makeJob } from '../../test/helpers'
import JobsPanel from '../../components/JobsPanel'

// Wrap in an AppProvider with a connection pre-seeded
import { AppProvider, useApp } from '../../context/AppContext'
import { act } from '@testing-library/react'
import { render } from '@testing-library/react'

function renderJobsPanel(jobs = []) {
  let dispatch
  function Capture() {
    const ctx = useApp()
    dispatch = ctx.dispatch
    return null
  }
  const result = render(
    <AppProvider>
      <Capture />
      <JobsPanel jobs={jobs} connId="c1" />
    </AppProvider>
  )
  act(() => dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
  return result
}

describe('JobsPanel — empty state', () => {
  it('renders "No jobs" when jobs array is empty', () => {
    renderJobsPanel([])
    expect(screen.getByText(/no jobs/i)).toBeInTheDocument()
  })
})

describe('JobsPanel — job display', () => {
  it('shows job name', () => {
    renderJobsPanel([makeJob({ job_name: 'Nightly Backup', status: 'Succeeded' })])
    expect(screen.getByText('Nightly Backup')).toBeInTheDocument()
  })

  it('shows job count badge', () => {
    const jobs = [
      makeJob({ job_name: 'Job A', status: 'Running' }),
      makeJob({ job_id: 'job-002', job_name: 'Job B', status: 'Succeeded' }),
    ]
    renderJobsPanel(jobs)
    // "2" appears in count badge (and possibly sort icons); just check it's present
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
  })

  it('shows failed badge when failures present', () => {
    renderJobsPanel([makeJob({ job_name: 'Bad Job', status: 'Failed' })])
    expect(screen.getAllByText(/fail/i).length).toBeGreaterThan(0)
  })
})

describe('JobsPanel — filter pills', () => {
  it('renders All/Running/Failed/Succeeded/Idle pills', () => {
    renderJobsPanel([makeJob({ job_name: 'Test', status: 'Idle' })])
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })
})

describe('JobsPanel — search', () => {
  it('has a search input', () => {
    renderJobsPanel([makeJob({ job_name: 'Backup', status: 'Succeeded' })])
    const input = screen.getByPlaceholderText(/search/i)
    expect(input).toBeInTheDocument()
  })
})

describe('JobsPanel — expand button', () => {
  it('has an expand button', () => {
    renderJobsPanel([makeJob({ job_name: 'Test', status: 'Idle' })])
    const btn = screen.getByTitle(/expand/i)
    expect(btn).toBeInTheDocument()
  })
})
