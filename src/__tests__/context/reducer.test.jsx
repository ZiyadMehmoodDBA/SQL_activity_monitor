import { describe, it, expect, beforeEach } from 'vitest'
import { renderWithContext } from '../../test/helpers'
import { useApp } from '../../context/AppContext'
import { screen, act } from '@testing-library/react'
import React, { useEffect } from 'react'
import { defaultLayout } from '../../lib/widgetRegistry'

function StateInspector({ onState }) {
  const { state, dispatch } = useApp()
  useEffect(() => { onState(state, dispatch) })
  return null
}

function setup() {
  let captured = { state: null, dispatch: null }
  renderWithContext(
    <StateInspector onState={(s, d) => { captured.state = s; captured.dispatch = d }} />
  )
  return captured
}

describe('TOGGLE_WIDGET', () => {
  beforeEach(() => localStorage.clear())

  it('flips enabled state of a widget', () => {
    const c = setup()
    const before = c.state.widgetLayout.find(w => w.id === 'kpi_bar').enabled
    act(() => c.dispatch({ type: 'TOGGLE_WIDGET', widgetId: 'kpi_bar' }))
    expect(c.state.widgetLayout.find(w => w.id === 'kpi_bar').enabled).toBe(!before)
  })

  it('persists to localStorage', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'TOGGLE_WIDGET', widgetId: 'kpi_bar' }))
    const stored = JSON.parse(localStorage.getItem('sqlmon-widget-layout'))
    const storedItem = stored.find(w => w.id === 'kpi_bar')
    expect(storedItem.enabled).toBe(!defaultLayout().find(w => w.id === 'kpi_bar').enabled)
  })
})

describe('RESET_WIDGET_LAYOUT', () => {
  it('restores default layout', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'TOGGLE_WIDGET', widgetId: 'kpi_bar' }))
    act(() => c.dispatch({ type: 'RESET_WIDGET_LAYOUT' }))
    expect(c.state.widgetLayout).toEqual(defaultLayout())
  })
})
