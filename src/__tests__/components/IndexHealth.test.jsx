import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
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
