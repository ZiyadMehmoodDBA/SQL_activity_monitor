import { describe, it, expect, beforeEach } from 'vitest'
import { defaultLayout, loadLayout, saveLayout, WIDGET_REGISTRY } from '../../lib/widgetRegistry'

describe('Widget layout persistence', () => {
  beforeEach(() => localStorage.clear())

  it('loadLayout returns full default when localStorage empty', () => {
    const layout = loadLayout()
    expect(layout).toHaveLength(WIDGET_REGISTRY.length)
    expect(layout.every(w => typeof w.enabled === 'boolean')).toBe(true)
  })

  it('saveLayout + loadLayout preserves enabled states', () => {
    const layout = defaultLayout()
    layout[0].enabled = false
    layout[3].enabled = false
    saveLayout(layout)

    const loaded = loadLayout()
    expect(loaded[0].enabled).toBe(false)
    expect(loaded[3].enabled).toBe(false)
    // others unchanged
    expect(loaded[1].enabled).toBe(true)
  })

  it('saveLayout + loadLayout preserves custom section order', () => {
    const layout = defaultLayout()
    const sections = layout.filter(w => {
      const reg = WIDGET_REGISTRY.find(r => r.id === w.id)
      return reg?.group === 'section'
    })
    // Reverse section order
    const panels = layout.filter(w => {
      const reg = WIDGET_REGISTRY.find(r => r.id === w.id)
      return reg?.group === 'panel'
    })
    const reordered = [...panels, ...sections.reverse()]
    saveLayout(reordered)

    const loaded = loadLayout()
    const loadedSectionIds = loaded
      .filter(w => WIDGET_REGISTRY.find(r => r.id === w.id)?.group === 'section')
      .map(w => w.id)
    const expectedSectionIds = sections.map(w => w.id)
    expect(loadedSectionIds).toEqual(expectedSectionIds)
  })

  it('loadLayout handles corrupted localStorage gracefully', () => {
    localStorage.setItem('sqlmon-widget-layout', 'not-json')
    expect(() => loadLayout()).not.toThrow()
    const loaded = loadLayout()
    expect(loaded).toHaveLength(WIDGET_REGISTRY.length)
  })

  it('loadLayout adds new registry widgets missing from stored layout', () => {
    // Store incomplete layout (first 10 items)
    saveLayout(defaultLayout().slice(0, 10))
    const loaded = loadLayout()
    expect(loaded).toHaveLength(WIDGET_REGISTRY.length)
  })
})

describe('Palette persistence', () => {
  beforeEach(() => localStorage.clear())

  it('palette is stored and retrieved', () => {
    localStorage.setItem('palette', 'Dark')
    expect(localStorage.getItem('palette')).toBe('Dark')
  })

  it('missing palette returns null', () => {
    expect(localStorage.getItem('palette')).toBeNull()
  })
})
