import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import ScanControls from '../../../components/indexHealth/ScanControls'

const noop = () => {}

describe('ScanControls', () => {
  it('shows Run Scan button when phase is idle', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument()
  })

  it('shows mode selector in idle phase', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('calls onStartScan when Run Scan is clicked', () => {
    const onStart = vi.fn()
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="idle" onStartScan={onStart} onCancelScan={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /run scan/i }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('shows Cancel button and disables mode selector when phase is running', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="running" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('calls onCancelScan when Cancel is clicked', () => {
    const onCancel = vi.fn()
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="running" onStartScan={noop} onCancelScan={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onModeChange when selector changes', () => {
    const onChange = vi.fn()
    render(<ScanControls mode="LIMITED" onModeChange={onChange} phase="idle" onStartScan={noop} onCancelScan={noop} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'SAMPLED' } })
    expect(onChange).toHaveBeenCalledWith('SAMPLED')
  })

  it('shows Run New Scan button when phase is completed', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="completed" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /run new scan/i })).toBeInTheDocument()
  })

  it('shows Run Scan button when phase is failed', () => {
    render(<ScanControls mode="LIMITED" onModeChange={noop} phase="failed" onStartScan={noop} onCancelScan={noop} />)
    expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument()
  })
})
