import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { render } from '@testing-library/react'
import WhoIsActive from '../../components/WhoIsActive'
import { makeWiaRow } from '../../test/helpers'

function renderWia(connId = 'c1') {
  return render(<WhoIsActive connId={connId} />)
}

function mockFetch(rows, ok = true) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok,
      json: () => Promise.resolve({ rows, ts: Date.now() }),
    })
  )
}

describe('WhoIsActive — initial render', () => {
  it('renders the section heading', () => {
    renderWia()
    // getByRole avoids matching both the button and its child span
    expect(screen.getByRole('button', { name: /sp_whoIsActive/i })).toBeInTheDocument()
  })

  it('renders auto-refresh interval pills', () => {
    renderWia()
    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(screen.getByText('5s')).toBeInTheDocument()
    expect(screen.getByText('30s')).toBeInTheDocument()
  })

  it('renders a Refresh button', () => {
    renderWia()
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
  })
})

describe('WhoIsActive — fetch', () => {
  it('shows rows after fetch', async () => {
    mockFetch([makeWiaRow({ login_name: 'testuser' })])
    renderWia()
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => {
      expect(screen.getByText('testuser')).toBeInTheDocument()
    })
  })

  it('calls correct API endpoint', async () => {
    mockFetch([])
    renderWia('conn42')
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/connections/conn42/whoIsActive')
    })
  })

  it('shows error state on fetch failure', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Server error' }) })
    )
    renderWia()
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => {
      expect(screen.getByText(/server error/i)).toBeInTheDocument()
    })
  })
})

describe('WhoIsActive — search', () => {
  it('renders a search input', () => {
    renderWia()
    // The placeholder is "Filter by login, host, database, wait type, SPID…"
    const input = document.querySelector('input[type="text"]')
    expect(input).toBeInTheDocument()
  })
})

describe('WhoIsActive — collapse', () => {
  it('persists collapsed state to localStorage', () => {
    renderWia('c1')
    const toggleBtn = screen.getByRole('button', { name: /sp_whoIsActive/i })
    fireEvent.click(toggleBtn)
    expect(localStorage.getItem('wia-c1-collapsed')).toBe('1')
  })
})
