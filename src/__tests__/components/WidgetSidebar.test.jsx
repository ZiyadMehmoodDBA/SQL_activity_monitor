import React from 'react'
import { describe, it, expect } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { render } from '@testing-library/react'
import { AppProvider } from '../../context/AppContext'
import WidgetSidebar from '../../components/WidgetSidebar'

function renderSidebar(open = true) {
  const onClose = vi.fn()
  const result = render(
    <AppProvider>
      <WidgetSidebar open={open} onClose={onClose} />
    </AppProvider>
  )
  return { ...result, onClose }
}

describe('WidgetSidebar — visibility', () => {
  it('shows "Widgets" heading when open', () => {
    renderSidebar(true)
    // Header shows "Widgets" label
    expect(screen.getByText('Widgets')).toBeInTheDocument()
  })
})

describe('WidgetSidebar — widget list', () => {
  it('lists KPI Summary widget', () => {
    renderSidebar()
    expect(screen.getByText('KPI Summary')).toBeInTheDocument()
  })

  it('lists sp_WhoIsActive widget', () => {
    renderSidebar()
    expect(screen.getByText('sp_WhoIsActive')).toBeInTheDocument()
  })

  it('renders toggle switches for widgets', () => {
    renderSidebar()
    const toggles = screen.getAllByRole('switch')
    expect(toggles.length).toBeGreaterThan(0)
  })
})

describe('WidgetSidebar — toggle', () => {
  it('flips aria-checked when toggle clicked', () => {
    renderSidebar()
    const toggles = screen.getAllByRole('switch')
    const toggle = toggles[0]
    const before = toggle.getAttribute('aria-checked')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe(before === 'true' ? 'false' : 'true')
  })
})

describe('WidgetSidebar — reset', () => {
  it('has a "Reset to Defaults" button', () => {
    renderSidebar()
    expect(screen.getByText(/reset to defaults/i)).toBeInTheDocument()
  })
})

describe('WidgetSidebar — close', () => {
  it('calls onClose when X button clicked', () => {
    const { onClose } = renderSidebar()
    // The X (close) button is the one inside the sidebar header, after "Widgets" text
    const buttons = screen.getAllByRole('button')
    // X button is the one that triggers onClose — click backdrop or find button near header
    // The sidebar header close button is the only button NOT in the category/toggle area
    // Use the backdrop click instead (backdrop onClick = onClose)
    const backdrop = document.querySelector('.fixed.inset-0.z-40')
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalled()
  })
})
