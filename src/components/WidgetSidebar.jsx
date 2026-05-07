import React, { useState, useRef } from 'react'
import { X, RotateCcw, GripVertical } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { WIDGET_REGISTRY, PANEL_CATEGORIES, REGISTRY_MAP } from '../lib/widgetRegistry'

const SECTION_IDS = WIDGET_REGISTRY.filter(w => w.group === 'section').map(w => w.id)
const PANEL_IDS   = WIDGET_REGISTRY.filter(w => w.group === 'panel').map(w => w.id)

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="relative flex-shrink-0 rounded-full transition-colors duration-200 focus:outline-none"
      style={{
        width: 32, height: 18,
        background: checked ? 'var(--sort-active)' : 'var(--divider)',
        border: '1.5px solid ' + (checked ? 'var(--sort-active)' : 'var(--input-border)'),
      }}
    >
      <span
        className="absolute rounded-full transition-transform duration-200"
        style={{
          width: 12, height: 12,
          top: 1, left: 1,
          background: checked ? '#fff' : 'var(--text-muted)',
          transform: checked ? 'translateX(14px)' : 'translateX(0)',
        }}
      />
    </button>
  )
}

// ── Category group header ─────────────────────────────────────────────────────
function CategoryGroup({ label, children }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left rounded-md transition-colors"
        style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}
      >
        <span
          className="transition-transform"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block', fontSize: 8 }}
        >▾</span>
        {label}
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

// ── Drag-sortable section item ────────────────────────────────────────────────
function SectionItem({ widget, enabled, onToggle, onDragStart, onDragOver, onDrop, isDragging }) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={e => { e.preventDefault(); onDragOver() }}
      onDrop={onDrop}
      className="flex items-center gap-2 px-3 py-2 rounded-md mx-2 mb-0.5 transition-colors select-none"
      style={{
        cursor: 'grab',
        opacity: isDragging ? 0.4 : 1,
        background: isDragging ? 'var(--section-hover)' : 'transparent',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = isDragging ? 'var(--section-hover)' : 'transparent'}
    >
      <GripVertical size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      <span
        className="flex-1 text-xs truncate"
        style={{ color: enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}
      >
        {widget.label}
      </span>
      <Toggle checked={enabled} onChange={onToggle} />
    </div>
  )
}

// ── Main sidebar ──────────────────────────────────────────────────────────────
export default function WidgetSidebar({ open, onClose }) {
  const { state, dispatch } = useApp()
  const layout = state.widgetLayout || []
  const enabledMap = Object.fromEntries(layout.map(w => [w.id, w.enabled]))

  // Build ordered section list from layout
  const sectionLayout = layout.filter(w => SECTION_IDS.includes(w.id))

  // Drag state
  const dragId = useRef(null)
  const [dragOverId, setDragOverId] = useState(null)

  function toggle(widgetId) {
    dispatch({ type: 'TOGGLE_WIDGET', widgetId })
  }

  function resetAll() {
    dispatch({ type: 'RESET_WIDGET_LAYOUT' })
  }

  function handleDragStart(id) {
    dragId.current = id
  }

  function handleDragOver(id) {
    if (dragId.current && dragId.current !== id) setDragOverId(id)
  }

  function handleDrop(targetId) {
    const fromId = dragId.current
    if (!fromId || fromId === targetId) { dragId.current = null; setDragOverId(null); return }
    const arr = [...sectionLayout]
    const fromIdx = arr.findIndex(w => w.id === fromId)
    const toIdx   = arr.findIndex(w => w.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return
    const [item] = arr.splice(fromIdx, 1)
    arr.splice(toIdx, 0, item)
    dispatch({ type: 'REORDER_WIDGETS', sectionIds: SECTION_IDS, sectionLayout: arr })
    dragId.current = null
    setDragOverId(null)
  }

  function handleDragEnd() {
    dragId.current = null
    setDragOverId(null)
  }

  // Panel widgets grouped by category
  const panelsByCategory = PANEL_CATEGORIES.map(cat => ({
    cat,
    widgets: WIDGET_REGISTRY.filter(w => w.group === 'panel' && w.category === cat),
  })).filter(g => g.widgets.length > 0)

  const enabledCount = layout.filter(w => w.enabled).length

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,.35)' }}
          onClick={onClose}
        />
      )}

      {/* Sidebar panel */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col"
        style={{
          width: 288,
          background: 'var(--card-bg)',
          borderLeft: '1px solid var(--input-border)',
          boxShadow: '-8px 0 32px rgba(0,0,0,.25)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform .22s cubic-bezier(.4,0,.2,1)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--divider)' }}
        >
          <div>
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Widgets</span>
            <span className="ml-2 text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {enabledCount}/{layout.length} enabled
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto py-3" style={{ scrollbarWidth: 'thin' }}>

          {/* ── Panels section ── */}
          <div className="px-3 mb-1">
            <span
              className="text-xs font-bold uppercase tracking-widest"
              style={{ color: 'var(--text-muted)', letterSpacing: '.08em', fontSize: 10 }}
            >
              Panels
            </span>
          </div>

          {panelsByCategory.map(({ cat, widgets }) => (
            <CategoryGroup key={cat} label={cat}>
              {widgets.map(w => (
                <div
                  key={w.id}
                  className="flex items-center gap-2 px-3 py-2 mx-2 mb-0.5 rounded-md transition-colors"
                  style={{ cursor: 'default' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span
                    className="flex-1 text-xs truncate"
                    style={{ color: enabledMap[w.id] ? 'var(--text-primary)' : 'var(--text-muted)' }}
                  >
                    {w.label}
                  </span>
                  <Toggle checked={!!enabledMap[w.id]} onChange={() => toggle(w.id)} />
                </div>
              ))}
            </CategoryGroup>
          ))}

          {/* Divider */}
          <div className="my-3 mx-4" style={{ borderTop: '1px solid var(--divider)' }} />

          {/* ── Sections (orderable) ── */}
          <div className="px-3 mb-1 flex items-center gap-2">
            <span
              className="text-xs font-bold uppercase tracking-widest"
              style={{ color: 'var(--text-muted)', letterSpacing: '.08em', fontSize: 10 }}
            >
              Sections
            </span>
            <span
              className="text-xs"
              style={{ color: 'var(--text-muted)', fontSize: 9, fontStyle: 'italic' }}
            >
              drag to reorder
            </span>
          </div>

          <div onDragEnd={handleDragEnd}>
            {sectionLayout.map(w => {
              const reg = REGISTRY_MAP[w.id]
              if (!reg) return null
              return (
                <SectionItem
                  key={w.id}
                  widget={reg}
                  enabled={w.enabled}
                  onToggle={() => toggle(w.id)}
                  onDragStart={() => handleDragStart(w.id)}
                  onDragOver={() => handleDragOver(w.id)}
                  onDrop={() => handleDrop(w.id)}
                  isDragging={dragOverId === w.id && dragId.current !== w.id}
                />
              )
            })}
          </div>
        </div>

        {/* Footer */}
        <div
          className="px-4 py-3 flex-shrink-0"
          style={{ borderTop: '1px solid var(--divider)' }}
        >
          <button
            onClick={resetAll}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'var(--divider)',
              border: '1px solid var(--input-border)',
              color: 'var(--text-secondary)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--divider)'}
          >
            <RotateCcw size={12} />
            Reset to Defaults
          </button>
        </div>
      </div>
    </>
  )
}
