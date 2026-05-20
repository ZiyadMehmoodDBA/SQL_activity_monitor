import React, { useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useApp } from '../context/AppContext'
import { fmtJobDuration } from '../lib/fmt'
import { Maximize2, Minimize2, X } from 'lucide-react'

const COMPACT_H = 360   // fixed panel height in dashboard grid
const PANEL_CHROME_H = 128  // header + pills + table-header height (approx)

const JOB_STATUS_ORDER = { Running: 0, Failed: 1, Retry: 2, Succeeded: 3, Idle: 4, Cancelled: 5, Disabled: 6 }

function fmtJobStatus(status) {
  const map = {
    'Running':   ['#dcfce7', '#16a34a', '●'],
    'Succeeded': ['#dbeafe', '#1d4ed8', '✓'],
    'Failed':    ['#fef2f2', '#dc2626', '✕'],
    'Retry':     ['#fef3c7', '#d97706', '↺'],
    'Cancelled': ['#f3f4f6', '#6b7280', '○'],
    'Disabled':  ['#f8fafc', '#94a3b8', '—'],
    'Idle':      ['#f1f5f9', '#475569', '·'],
  }
  const [bg, txt, icon] = map[status] || ['#f1f5f9', '#475569', '·']
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: bg, color: txt, padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700, letterSpacing: '.03em', whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 9 }}>{icon}</span>
      {status}
    </span>
  )
}

function sortJobs(jobs, sort) {
  if (!sort.col) {
    return [...jobs].sort((a, b) => {
      const ao = JOB_STATUS_ORDER[a.status] ?? 99
      const bo = JOB_STATUS_ORDER[b.status] ?? 99
      if (ao !== bo) return ao - bo
      return (a.job_name || '').localeCompare(b.job_name || '')
    })
  }
  return [...jobs].sort((a, b) => {
    const m = sort.dir === 'asc' ? 1 : -1
    let av = a[sort.col], bv = b[sort.col]
    if (sort.col === 'status') { av = JOB_STATUS_ORDER[a.status] ?? 99; bv = JOB_STATUS_ORDER[b.status] ?? 99 }
    if (av == null && bv == null) return 0
    if (av == null) return 1; if (bv == null) return -1
    return typeof av === 'string' ? m * av.localeCompare(bv) : m * (av - bv)
  })
}

const GEAR_SVG = (
  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
)

const COLS = [
  { key: 'job_name',          label: 'Job Name',  w: '30%' },
  { key: 'status',            label: 'Status',    w: '14%' },
  { key: 'last_run_date',     label: 'Last Run',  w: '20%' },
  { key: 'last_run_duration', label: 'Duration',  w: '10%' },
  { key: 'next_run_date',     label: 'Next Run',  w: '20%' },
]

const PILLS = [
  { key: 'all',       label: 'All',       dot: null       },
  { key: 'running',   label: 'Running',   dot: '#16a34a'  },
  { key: 'failed',    label: 'Failed',    dot: '#dc2626'  },
  { key: 'succeeded', label: 'Succeeded', dot: '#1d4ed8'  },
  { key: 'idle',      label: 'Idle',      dot: '#94a3b8'  },
]

// ── Inner panel (shared between compact + expanded) ───────────────────────────
function JobsPanelInner({ jobs, connId, expanded, onExpand, onClose, scrollRef, failedCount = 0 }) {
  const { state, dispatch } = useApp()
  const conn = state.connections[connId]

  const jobsFilter = conn?.jobsFilter || 'all'
  const jobsSearch = conn?.jobsSearch || ''
  const jobsSort   = conn?.jobsSort   || { col: null, dir: 'asc' }

  // Memoize counts — avoids 5 separate .filter() passes per render
  const counts = useMemo(() => ({
    all:       (jobs || []).length,
    running:   (jobs || []).filter(j => j.status === 'Running').length,
    failed:    (jobs || []).filter(j => j.status === 'Failed').length,
    succeeded: (jobs || []).filter(j => j.status === 'Succeeded').length,
    idle:      (jobs || []).filter(j => ['Idle','Cancelled','Disabled'].includes(j.status)).length,
  }), [jobs])

  // Memoize filter+sort — only reruns when jobs data or filter/search/sort state changes
  const filtered = useMemo(() => {
    let list = jobs || []
    if (jobsFilter !== 'all') {
      list = list.filter(j => {
        if (jobsFilter === 'running')   return j.status === 'Running'
        if (jobsFilter === 'failed')    return j.status === 'Failed'
        if (jobsFilter === 'succeeded') return j.status === 'Succeeded'
        if (jobsFilter === 'idle')      return ['Idle','Cancelled','Disabled'].includes(j.status)
        return true
      })
    }
    if (jobsSearch) {
      const q = jobsSearch.toLowerCase()
      list = list.filter(j => (j.job_name || '').toLowerCase().includes(q))
    }
    return sortJobs(list, jobsSort)
  }, [jobs, jobsFilter, jobsSearch, jobsSort])

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 12,
  })

  function handleSort(col) {
    const newDir = jobsSort.col === col ? (jobsSort.dir === 'asc' ? 'desc' : 'asc') : (col === 'job_name' ? 'asc' : 'desc')
    dispatch({ type: 'SET_JOBS_SORT', connId, sort: { col, dir: newDir } })
  }

  async function startJob(jobName) {
    if (!window.confirm(`Start job: ${jobName}?`)) return
    try {
      const res = await fetch(`/api/connections/${connId}/jobs/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobName }) })
      const data = await res.json()
      if (!res.ok) alert('Start failed: ' + (data.error || 'Unknown error'))
    } catch (err) { alert('Start failed: ' + err.message) }
  }

  async function stopJob(jobName) {
    if (!window.confirm(`Stop job: ${jobName}?`)) return
    try {
      const res = await fetch(`/api/connections/${connId}/jobs/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobName }) })
      const data = await res.json()
      if (!res.ok) alert('Stop failed: ' + (data.error || 'Unknown error'))
    } catch (err) { alert('Stop failed: ' + err.message) }
  }

  const TH = {
    padding: '6px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700,
    color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.05em',
    whiteSpace: 'nowrap', borderBottom: '2px solid var(--input-border)',
    background: 'var(--card-bg)', cursor: 'pointer', userSelect: 'none',
    position: 'sticky', top: 0, zIndex: 1,
  }
  const TD = { padding: '5px 12px', borderBottom: '1px solid var(--divider)', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text-primary)' }

  return (
    <>
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--divider)' }}>
        <span style={{ color: 'var(--val-batch)' }}>{GEAR_SVG}</span>
        <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>SQL Agent Jobs</span>
        {failedCount > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: 'rgba(239,68,68,.15)', color: '#ef4444',
          }}>
            {failedCount} failed 24h
          </span>
        )}
        <span className="text-xs px-2 py-0.5 rounded font-semibold tabular-nums ml-1" style={{ background: 'var(--badge-bg)', color: 'var(--badge-text)' }}>
          {(jobs || []).length}
        </span>
        <div className="flex items-center gap-3 text-xs font-medium ml-2 flex-1">
          {counts.running > 0 && <><span style={{ color: '#16a34a', fontSize: 9 }}>●</span><span style={{ color: 'var(--text-secondary)' }}>{counts.running} Running</span></>}
          {counts.failed  > 0 && <><span style={{ color: '#dc2626', fontSize: 9 }}>●</span><span style={{ color: '#dc2626', fontWeight: 600 }}>{counts.failed} Failed</span></>}
          {counts.running === 0 && counts.failed === 0 && <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>All idle</span>}
        </div>
        <input
          type="search"
          value={jobsSearch}
          onChange={e => dispatch({ type: 'SET_JOBS_SEARCH', connId, search: e.target.value })}
          placeholder="Search…"
          style={{ fontSize: 11, border: '1.5px solid var(--input-border)', borderRadius: 7, padding: '3px 8px', width: 120, outline: 'none', background: 'var(--input-bg)', color: 'var(--text-primary)', flexShrink: 0 }}
          onFocus={e => e.target.style.borderColor = '#3b82f6'}
          onBlur={e => e.target.style.borderColor = 'var(--input-border)'}
        />
        <button
          onClick={expanded ? onClose : onExpand}
          className="p-1 rounded-md transition-colors flex-shrink-0"
          style={{ color: 'var(--text-muted)' }}
          title={expanded ? 'Minimize' : 'Expand'}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        {expanded && (
          <button
            onClick={onClose}
            className="p-1 rounded-md transition-colors flex-shrink-0 ml-0.5"
            style={{ color: 'var(--text-muted)' }}
            title="Close"
            onMouseEnter={e => e.currentTarget.style.background = 'var(--section-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── Filter pills ── */}
      <div className="flex items-center gap-1.5 px-4 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--divider)' }}>
        {PILLS.map(p => {
          const active = jobsFilter === p.key
          return (
            <button
              key={p.key}
              onClick={() => dispatch({ type: 'SET_JOBS_FILTER', connId, filter: p.key })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px', fontSize: 11, fontWeight: active ? 700 : 500, borderRadius: 99, border: `1.5px solid ${active ? '#3b82f6' : 'var(--input-border)'}`, background: active ? 'var(--badge-bg)' : 'var(--card-bg)', color: active ? 'var(--sort-active)' : 'var(--text-secondary)', cursor: 'pointer', transition: 'all .12s', whiteSpace: 'nowrap' }}
            >
              {p.dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.dot, flexShrink: 0, display: 'inline-block' }} />}
              {p.label}
              <span style={{ fontSize: 10, marginLeft: 2, opacity: .65 }}>{counts[p.key]}</span>
            </button>
          )
        })}
      </div>

      {/* ── Scroll area with sticky thead ── */}
      <div ref={scrollRef} className="flex-1 overflow-auto op-scroll" style={{ minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 }}>
            {(jobs || []).length === 0 ? 'No jobs found — user may lack msdb read permission' : 'No jobs match filter'}
          </div>
        ) : (
          <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                {COLS.map(c => {
                  const active = c.key === jobsSort.col
                  return (
                    <th key={c.key} style={{ ...TH, width: c.w, color: active ? 'var(--sort-active)' : 'var(--text-secondary)' }} onClick={() => handleSort(c.key)}>
                      {c.label}
                      <span style={{ opacity: active ? 1 : .3, fontSize: 10, marginLeft: 2 }}>
                        {active ? (jobsSort.dir === 'asc' ? ' ↑' : ' ↓') : ' ⇅'}
                      </span>
                    </th>
                  )
                })}
                <th style={{ ...TH, cursor: 'default', width: '6%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Spacer for virtual scroll */}
              {virtualizer.getVirtualItems().length > 0 && (
                <tr style={{ height: virtualizer.getVirtualItems()[0].start }}>
                  <td colSpan={COLS.length + 1} />
                </tr>
              )}
              {virtualizer.getVirtualItems().map(vItem => {
                const j = filtered[vItem.index]
                const isRunning = j.status === 'Running'
                const isFailed  = j.status === 'Failed'
                const canStart  = !isRunning && j.enabled === 1
                return (
                  <tr
                    key={vItem.key}
                    style={{ background: isRunning ? 'rgba(22,163,74,.06)' : isFailed ? 'rgba(220,38,38,.04)' : '' }}
                  >
                    <td style={{ ...TD, maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isRunning || isFailed ? 600 : 400 }} title={j.job_name}>
                      {j.job_name}
                      {isRunning && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> ({j.running_sec}s)</span>}
                    </td>
                    <td style={TD}>{fmtJobStatus(j.status)}</td>
                    <td style={{ ...TD, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontSize: 10 }}>
                      {j.last_run_date ? j.last_run_date.replace('T', ' ') : '—'}
                    </td>
                    <td style={{ ...TD, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtJobDuration(j.last_run_duration)}
                    </td>
                    <td style={{ ...TD, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontSize: 10 }}>
                      {j.next_run_date ? j.next_run_date.replace('T', ' ') : '—'}
                    </td>
                    <td style={TD}>
                      {canStart && (
                        <button
                          onClick={() => startJob(j.job_name)}
                          style={{ padding: '2px 7px', fontSize: 10, fontWeight: 600, borderRadius: 5, background: '#dcfce7', color: '#16a34a', border: '1px solid #bbf7d0', cursor: 'pointer', marginRight: 4 }}
                          onMouseOver={e => { e.target.style.background = '#16a34a'; e.target.style.color = '#fff' }}
                          onMouseOut={e => { e.target.style.background = '#dcfce7'; e.target.style.color = '#16a34a' }}
                        >▶ Start</button>
                      )}
                      {isRunning && (
                        <button
                          onClick={() => stopJob(j.job_name)}
                          style={{ padding: '2px 7px', fontSize: 10, fontWeight: 600, borderRadius: 5, background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', cursor: 'pointer' }}
                          onMouseOver={e => { e.target.style.background = '#dc2626'; e.target.style.color = '#fff' }}
                          onMouseOut={e => { e.target.style.background = '#fef2f2'; e.target.style.color = '#dc2626' }}
                        >■ Stop</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {/* Bottom spacer */}
              {virtualizer.getVirtualItems().length > 0 && (() => {
                const items = virtualizer.getVirtualItems()
                const last = items[items.length - 1]
                const remaining = virtualizer.getTotalSize() - last.end
                return remaining > 0 ? <tr style={{ height: remaining }}><td colSpan={COLS.length + 1} /></tr> : null
              })()}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function JobsPanel({ jobs, connId, failedCount = 0 }) {
  const [expanded, setExpanded] = useState(false)
  const compactRef  = useRef(null)
  const expandedRef = useRef(null)

  return (
    <>
      {/* ── Compact panel (always in grid) ── */}
      <div className="col-span-8 mc flex flex-col" style={{ height: COMPACT_H, overflow: 'hidden' }}>
        <JobsPanelInner
          jobs={jobs}
          connId={connId}
          expanded={false}
          onExpand={() => setExpanded(true)}
          onClose={() => setExpanded(false)}
          scrollRef={compactRef}
          failedCount={failedCount}
        />
      </div>

      {/* ── Expanded overlay (portal, no grid shift) ── */}
      {expanded && createPortal(
        <>
          <div
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)' }}
            onClick={() => setExpanded(false)}
          />
          <div
            className="fixed z-50 mc flex flex-col"
            style={{
              top: 20, bottom: 20, left: 20, right: 20,
              maxWidth: 1400, margin: '0 auto',
              overflow: 'hidden',
              boxShadow: 'var(--card-shadow), 0 32px 64px rgba(0,0,0,.45)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <JobsPanelInner
              jobs={jobs}
              connId={connId}
              expanded={true}
              onExpand={() => {}}
              onClose={() => setExpanded(false)}
              scrollRef={expandedRef}
              failedCount={failedCount}
            />
          </div>
        </>,
        document.body
      )}
    </>
  )
}
