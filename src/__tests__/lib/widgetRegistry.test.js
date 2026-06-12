import { describe, it, expect, beforeEach } from 'vitest'
import {
  WIDGET_REGISTRY,
  REGISTRY_MAP,
  defaultLayout,
  loadLayout,
  saveLayout,
} from '../../lib/widgetRegistry'

describe('WIDGET_REGISTRY', () => {
  it('has 28 widgets', () => expect(WIDGET_REGISTRY).toHaveLength(28))

  it('all widgets have required fields', () => {
    for (const w of WIDGET_REGISTRY) {
      expect(w).toHaveProperty('id')
      expect(w).toHaveProperty('label')
      expect(['panel', 'section']).toContain(w.group)
      expect(typeof w.defaultEnabled).toBe('boolean')
    }
  })

  it('all ids are unique', () => {
    const ids = WIDGET_REGISTRY.map(w => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('REGISTRY_MAP', () => {
  it('indexes all widgets by id', () => {
    expect(Object.keys(REGISTRY_MAP)).toHaveLength(WIDGET_REGISTRY.length)
    expect(REGISTRY_MAP['kpi_bar'].label).toBe('KPI Summary')
  })
})

describe('defaultLayout', () => {
  it('returns entry for every registry widget', () => {
    const layout = defaultLayout()
    expect(layout).toHaveLength(WIDGET_REGISTRY.length)
  })

  it('all items have id and enabled fields', () => {
    for (const item of defaultLayout()) {
      expect(item).toHaveProperty('id')
      expect(typeof item.enabled).toBe('boolean')
    }
  })
})

describe('saveLayout / loadLayout', () => {
  beforeEach(() => localStorage.clear())

  it('loadLayout returns defaultLayout when nothing stored', () => {
    const layout = loadLayout()
    expect(layout).toHaveLength(WIDGET_REGISTRY.length)
  })

  it('round-trips saved layout', () => {
    const custom = defaultLayout().map((w, i) =>
      i === 0 ? { ...w, enabled: false } : w
    )
    saveLayout(custom)
    const loaded = loadLayout()
    expect(loaded[0].enabled).toBe(false)
  })

  it('appends new registry entries not in stored layout', () => {
    // Store a layout missing the last widget
    const partial = defaultLayout().slice(0, -1)
    saveLayout(partial)
    const loaded = loadLayout()
    expect(loaded).toHaveLength(WIDGET_REGISTRY.length)
  })

  it('strips stored entries that no longer exist in registry', () => {
    const withGhost = [...defaultLayout(), { id: 'ghost_widget', enabled: true }]
    saveLayout(withGhost)
    const loaded = loadLayout()
    expect(loaded.find(w => w.id === 'ghost_widget')).toBeUndefined()
  })

  it('returns defaultLayout on malformed JSON', () => {
    localStorage.setItem('sqlmon-widget-layout', '{bad json}')
    const loaded = loadLayout()
    expect(loaded).toHaveLength(WIDGET_REGISTRY.length)
  })
})
