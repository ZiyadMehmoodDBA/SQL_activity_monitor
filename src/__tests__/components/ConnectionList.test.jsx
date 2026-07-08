import { describe, it, expect, vi } from 'vitest'
import { screen, act } from '@testing-library/react'
import React, { useEffect } from 'react'
import { renderWithContext, makeProfileFixture } from '../../test/helpers'
import { useConnections } from '../../context/ConnectionContext'
import ConnectionList from '../../components/ConnectionList'

function Harness({ seed = [], onCtx }) {
  const ctx = useConnections()
  const seededRef = React.useRef(false)
  useEffect(() => {
    // Wait for INIT to complete before seeding so ADD_PROFILE isn't overwritten by INIT
    if (ctx.isInitializing || seededRef.current) return
    seededRef.current = true
    seed.forEach(p => ctx.dispatch({ type: 'ADD_PROFILE', profile: p }))
    onCtx?.(ctx)
  }, [ctx.isInitializing]) // eslint-disable-line react-hooks/exhaustive-deps
  return <ConnectionList onAddConnection={() => {}} onRequestPassword={() => {}} />
}

describe('ConnectionList', () => {
  it('shows empty state with call-to-action when no profiles', async () => {
    renderWithContext(<Harness />)
    expect(await screen.findByText(/no saved connections/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add connection/i })).toBeInTheDocument()
  })

  it('renders one row per profile with server name', async () => {
    renderWithContext(<Harness seed={[
      makeProfileFixture({ id: 'a', displayName: 'Prod', serverName: 'HCMPSDB01' }),
      makeProfileFixture({ id: 'b', displayName: 'Dev', serverName: 'DEVBOX', displayOrder: 1 }),
    ]} />)
    expect(await screen.findByText('Prod')).toBeInTheDocument()
    expect(screen.getByText('Dev')).toBeInTheDocument()
    expect(screen.getByText('HCMPSDB01')).toBeInTheDocument()
  })

  it('marks the selected row with aria-current', async () => {
    renderWithContext(<Harness seed={[makeProfileFixture({ id: 'a', displayName: 'Prod' })]} />)
    const row = (await screen.findByText('Prod')).closest('[role="button"], button')
    expect(row).toHaveAttribute('aria-current', 'true')
  })

  it('status indicator has an accessible label, not color alone', async () => {
    renderWithContext(<Harness seed={[makeProfileFixture({ id: 'a', displayName: 'Prod' })]} />)
    await screen.findByText('Prod')
    // ADD_PROFILE creates status 'connected'
    expect(screen.getByLabelText(/connected/i)).toBeInTheDocument()
  })
})
