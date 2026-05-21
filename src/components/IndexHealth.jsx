import React, { useState, useRef } from 'react'

export default function IndexHealth({ connId }) {
  const [phase, setPhase]               = useState('idle')
  // idle | pending | running | completed | completed_with_warnings | failed | cancelled | expired
  const [scanId, setScanId]             = useState(null)
  const [mode, setMode]                 = useState('LIMITED')
  const [progress, setProgress]         = useState(null)
  const [summary, setSummary]           = useState(null)
  const [metadata, setMetadata]         = useState(null)
  const [timedOutDbs, setTimedOutDbs]   = useState([])
  const [error, setError]               = useState(null)
  const [activeTab, setActiveTab]       = useState('fragmented')
  const [inventoryPage, setInventoryPage] = useState(1)
  const [inventoryFilter, setInventoryFilter] = useState({ db: 'all', search: '' })
  const [inventoryData, setInventoryData]     = useState(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [selectedRow, setSelectedRow]   = useState(null)
  const pollRef = useRef(null)

  return (
    <div style={{ background: 'var(--card-bg)', borderRadius: 16, border: '1px solid var(--divider)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Index Health</span>
      </div>
      <div style={{ padding: 16 }}>
        <button
          onClick={() => {}}
          style={{ padding: '6px 16px', borderRadius: 8, background: 'var(--badge-bg)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, border: '1px solid var(--input-border)', cursor: 'pointer' }}
        >
          Run Scan
        </button>
      </div>
    </div>
  )
}
