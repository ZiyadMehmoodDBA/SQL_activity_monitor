import React from 'react'
import { useConnections } from '../context/ConnectionContext'

export default function CollapsibleSection({ connId, sectionId, title, children, badge, extra }) {
  const { connections, dispatch } = useConnections()
  const conn = connections[connId]
  const isCollapsed = conn ? conn.collapsedSections.has(sectionId) : false

  function toggle() {
    dispatch({ type: 'TOGGLE_SECTION', connId, sectionId })
  }

  return (
    <div className="mc overflow-hidden" id={`section-anchor-${sectionId}`}>
      <button
        className="section-toggle w-full flex items-center justify-between px-5 py-3 text-left"
        onClick={toggle}
      >
        <div className="flex items-center gap-2.5">
          <svg
            className={`chevron ${isCollapsed ? '' : 'open'} w-3.5 h-3.5 flex-shrink-0`}
            style={{ color: 'var(--text-muted)' }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <span className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{title}</span>
          {badge}
        </div>
        {extra}
      </button>
      <div className={`section-body ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="section-body-inner">{children}</div>
      </div>
    </div>
  )
}
