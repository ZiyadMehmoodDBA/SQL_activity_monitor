import React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import IndexHealth from '../../components/IndexHealth'

describe('IndexHealth', () => {
  it('renders in idle phase showing Run Scan button', () => {
    render(<IndexHealth connId="conn-1" />)
    expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument()
  })

  it('renders index health heading', () => {
    render(<IndexHealth connId="conn-1" />)
    expect(screen.getByText(/index health/i)).toBeInTheDocument()
  })
})

describe('IndexHealth scan lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('transitions to running after clicking Run Scan', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ scanId: 'scan-1' }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ scanId: 'scan-1', status: 'running', pct: 10, currentDb: 'mydb', completedDbs: 0, totalDbs: 5, timedOutDbs: [], eta: 60 }) })

    render(<IndexHealth connId="conn-1" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
    })

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument()
    })
  })

  it('saves scanId to sessionStorage after start', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ scanId: 'scan-persist' }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ status: 'running', pct: 5, currentDb: null, completedDbs: 0, totalDbs: 0, timedOutDbs: [], eta: null }) })

    render(<IndexHealth connId="conn-1" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
    })

    await waitFor(() => {
      expect(sessionStorage.getItem('index-health-scan-conn-1')).toBe('scan-persist')
    })
  })

  it('shows health score after scan completes', async () => {
    const summary = { score: 87, severity: 'Healthy', totalIndexes: 100, fragmentedCount: 2, missingCount: 1, unusedCount: 3, duplicateCount: 0, disabledCount: 0 }
    const resultsPayload = { status: 'completed', summary, metadata: {}, timedOutDbs: [], fragmented: { rows: [], total: 0, page: 1, pageSize: 50 } }

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({ scanId: 'scan-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ status: 'completed', pct: 100, currentDb: null, completedDbs: 5, totalDbs: 5, timedOutDbs: [], eta: null }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(resultsPayload) })

    render(<IndexHealth connId="conn-1" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
    })

    await waitFor(() => {
      expect(screen.getByText('87')).toBeInTheDocument()
    })
  })

  it('recovers from sessionStorage on mount', async () => {
    sessionStorage.setItem('index-health-scan-conn-1', 'scan-recovered')
    const summary = { score: 72, severity: 'Warning', totalIndexes: 80, fragmentedCount: 10, missingCount: 4, unusedCount: 2, duplicateCount: 1, disabledCount: 0 }

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ status: 'completed', pct: 100, currentDb: null, completedDbs: 3, totalDbs: 3, timedOutDbs: [], eta: null }) })
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ status: 'completed', summary, metadata: {}, timedOutDbs: [], fragmented: { rows: [], total: 0, page: 1, pageSize: 50 } }) })

    render(<IndexHealth connId="conn-1" />)

    await waitFor(() => {
      expect(screen.getByText('72')).toBeInTheDocument()
    })
  })

  it('shows expired banner when progress poll returns 404', async () => {
    sessionStorage.setItem('index-health-scan-conn-1', 'scan-old')

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) })

    render(<IndexHealth connId="conn-1" />)

    await waitFor(() => {
      expect(screen.getByText(/expired/i)).toBeInTheDocument()
    })
  })
})
