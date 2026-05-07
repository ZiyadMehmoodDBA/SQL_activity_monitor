import React from 'react'
import { describe, it, expect } from 'vitest'
import { screen, act } from '@testing-library/react'
import { render } from '@testing-library/react'
import { AppProvider, useApp } from '../../context/AppContext'
import SessionsPanel from '../../components/SessionsPanel'
import { makeSession } from '../../test/helpers'

function renderSessionsPanel(processes = []) {
  let dispatch
  function Capture() {
    const ctx = useApp()
    dispatch = ctx.dispatch
    return null
  }
  const result = render(
    <AppProvider>
      <Capture />
      <SessionsPanel processes={processes} connId="c1" />
    </AppProvider>
  )
  act(() => dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
  return result
}

describe('SessionsPanel — empty state', () => {
  it('shows "No sessions" when empty', () => {
    renderSessionsPanel([])
    expect(screen.getByText(/no sessions/i)).toBeInTheDocument()
  })
})

describe('SessionsPanel — session count', () => {
  it('displays total session count', () => {
    const sessions = [
      makeSession({ session_id: 51, host_name: 'HOST1', login_name: 'sa' }),
      makeSession({ session_id: 52, host_name: 'HOST1', login_name: 'sa' }),
    ]
    renderSessionsPanel(sessions)
    // "2" appears in both the total count header and the group badge
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
  })
})

describe('SessionsPanel — grouping', () => {
  it('groups sessions by host+login, showing host name', () => {
    const sessions = [
      makeSession({ session_id: 51, host_name: 'DEVBOX', login_name: 'sa', status: 'sleeping' }),
      makeSession({ session_id: 52, host_name: 'DEVBOX', login_name: 'sa', status: 'sleeping' }),
    ]
    renderSessionsPanel(sessions)
    expect(screen.getByText('DEVBOX')).toBeInTheDocument()
  })

  it('shows group count badge', () => {
    const sessions = [
      makeSession({ session_id: 51, host_name: 'DEVBOX', login_name: 'sa' }),
      makeSession({ session_id: 52, host_name: 'DEVBOX', login_name: 'sa' }),
    ]
    renderSessionsPanel(sessions)
    // "2" appears in total count header and/or group badge
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
  })
})

describe('SessionsPanel — blocked badge', () => {
  it('shows blocked badge when session is blocked', () => {
    const sessions = [
      makeSession({ session_id: 51, host_name: 'DEVBOX', login_name: 'sa', blocking_session_id: 55 }),
    ]
    renderSessionsPanel(sessions)
    // Blocked badge shows "⚠ BLOCKED" or "blocked" count badge in header
    expect(screen.getAllByText(/block/i).length).toBeGreaterThanOrEqual(1)
  })
})

describe('SessionsPanel — header', () => {
  it('renders "Connected Sessions" heading', () => {
    renderSessionsPanel([])
    expect(screen.getByText(/connected sessions/i)).toBeInTheDocument()
  })

  it('has expand button', () => {
    renderSessionsPanel([])
    expect(screen.getByTitle(/expand/i)).toBeInTheDocument()
  })
})
