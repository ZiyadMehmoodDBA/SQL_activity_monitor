import { describe, it, expect, beforeEach } from 'vitest'
import { renderWithContext } from '../../test/helpers'
import { useApp } from '../../context/AppContext'
import { screen, act } from '@testing-library/react'
import React, { useEffect } from 'react'
import { defaultLayout } from '../../lib/widgetRegistry'

// Helper: render a component that exposes dispatch & state
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

describe('ADD_CONN / REMOVE_CONN', () => {
  it('adds a connection and sets it active', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    expect(c.state.connections['c1']).toBeDefined()
    expect(c.state.activeConnId).toBe('c1')
  })

  it('removes a connection and updates activeConnId', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c2', label: 'Prod', server: 'PROD' } }))
    act(() => c.dispatch({ type: 'REMOVE_CONN', connId: 'c1' }))
    expect(c.state.connections['c1']).toBeUndefined()
    expect(c.state.activeConnId).toBeTruthy()
  })

  it('sets activeConnId to null when last connection removed', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    act(() => c.dispatch({ type: 'REMOVE_CONN', connId: 'c1' }))
    expect(c.state.activeConnId).toBeNull()
  })
})

describe('UPDATE_METRICS', () => {
  it('updates metrics and appends history', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    act(() => c.dispatch({
      type: 'UPDATE_METRICS',
      connId: 'c1',
      metrics: {
        cpu_percent: 55, waiting_tasks: 2, db_io_mb: 1, batch_requests: 100,
        serverPerf: { netMbs: 0.2, compilationsSec: 10 },
      },
    }))
    const conn = c.state.connections['c1']
    expect(conn.metrics.cpu_percent).toBe(55)
    expect(conn.history.cpu).toEqual([55])
    expect(conn.history.wait).toEqual([2])
  })

  it('caps history at 60 entries', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    for (let i = 0; i < 65; i++) {
      act(() => c.dispatch({
        type: 'UPDATE_METRICS',
        connId: 'c1',
        metrics: { cpu_percent: i, waiting_tasks: 0, db_io_mb: 0, batch_requests: 0, serverPerf: {} },
      }))
    }
    expect(c.state.connections['c1'].history.cpu).toHaveLength(60)
  })
})

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

describe('TOGGLE_SESSION_GROUP', () => {
  it('adds key to expandedSessionGroups', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    act(() => c.dispatch({ type: 'TOGGLE_SESSION_GROUP', connId: 'c1', key: 'sa||DEVBOX' }))
    expect(c.state.connections['c1'].expandedSessionGroups.has('sa||DEVBOX')).toBe(true)
  })

  it('removes key if already expanded', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    act(() => c.dispatch({ type: 'TOGGLE_SESSION_GROUP', connId: 'c1', key: 'sa||DEVBOX' }))
    act(() => c.dispatch({ type: 'TOGGLE_SESSION_GROUP', connId: 'c1', key: 'sa||DEVBOX' }))
    expect(c.state.connections['c1'].expandedSessionGroups.has('sa||DEVBOX')).toBe(false)
  })
})

describe('SET_JOBS_FILTER / SET_JOBS_SEARCH', () => {
  it('updates jobsFilter on connection', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    act(() => c.dispatch({ type: 'SET_JOBS_FILTER', connId: 'c1', filter: 'failed' }))
    expect(c.state.connections['c1'].jobsFilter).toBe('failed')
  })

  it('updates jobsSearch on connection', () => {
    const c = setup()
    act(() => c.dispatch({ type: 'ADD_CONN', conn: { id: 'c1', label: 'Dev', server: 'DEV' } }))
    act(() => c.dispatch({ type: 'SET_JOBS_SEARCH', connId: 'c1', search: 'backup' }))
    expect(c.state.connections['c1'].jobsSearch).toBe('backup')
  })
})
