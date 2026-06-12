// Widget registry — defines all available dashboard widgets
// Two groups:
//   panel  = structural top section (toggle only, fixed position)
//   section = collapsible data tables (toggle + drag-to-reorder)

export const WIDGET_REGISTRY = [
  // ── Panels ──────────────────────────────────────────────
  { id: 'kpi_bar',            label: 'KPI Summary',              group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'chart_cpu',          label: 'CPU %',                    group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'chart_wait',         label: 'Waiting Tasks',            group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'chart_io',           label: 'Database I/O',             group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'chart_batch',        label: 'Batch Requests',           group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'chart_net',          label: 'Network I/O',              group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'chart_compilations', label: 'Compilations/sec',         group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'memory_health',      label: 'Memory Health',            group: 'panel',   category: 'Memory',      defaultEnabled: true },
  { id: 'drive_monitor',      label: 'Drive Space Monitor',      group: 'panel',   category: 'Storage',     defaultEnabled: true },
  { id: 'query_optimization', label: 'Query Optimization',       group: 'panel',   category: 'Performance', defaultEnabled: true },
  { id: 'jobs_panel',         label: 'SQL Agent Jobs',           group: 'panel',   category: 'SQL Agent',   defaultEnabled: true },
  { id: 'sessions_panel',     label: 'Connected Sessions',       group: 'panel',   category: 'Sessions',    defaultEnabled: true },
  // ── Sections (orderable) ────────────────────────────────
  { id: 'db_sizes',           label: 'Database Sizes',           group: 'section', category: 'Database',    defaultEnabled: true },
  { id: 'db_size_trend',     label: 'Database Size Trends',     group: 'section', category: 'Database',    defaultEnabled: true },
  { id: 'processes',          label: 'Active Processes',         group: 'section', category: 'Sessions',    defaultEnabled: true },
  { id: 'resource_waits',     label: 'Resource Waits',           group: 'section', category: 'Waits & I/O', defaultEnabled: true },
  { id: 'file_io',            label: 'Data File I/O',            group: 'section', category: 'Waits & I/O', defaultEnabled: true },
  { id: 'recent_expensive',   label: 'Recent Expensive Queries', group: 'section', category: 'Queries',     defaultEnabled: true },
  { id: 'active_expensive',   label: 'Active Expensive Queries', group: 'section', category: 'Queries',     defaultEnabled: true },
  { id: 'who_is_active',      label: 'sp_WhoIsActive',           group: 'section', category: 'Queries',     defaultEnabled: true },
  { id: 'blocking',           label: 'Blocking Chains',          group: 'section', category: 'Blocking',    defaultEnabled: true },
  { id: 'deadlocks',          label: 'Deadlock History',         group: 'section', category: 'Blocking',    defaultEnabled: true },
  { id: 'backup_health',       label: 'Backup Health',            group: 'section', category: 'Queries',     defaultEnabled: true },
  { id: 'error_log',           label: 'SQL Error Log',            group: 'section', category: 'Queries',     defaultEnabled: true },
  { id: 'index_health',        label: 'Index Health',             group: 'section', category: 'Maintenance', defaultEnabled: false },
  { id: 'cpu_intensive',       label: 'CPU Intensive Queries',    group: 'section', category: 'Queries',     defaultEnabled: true  },
  { id: 'missing_indexes',     label: 'Missing Indexes',          group: 'section', category: 'Maintenance', defaultEnabled: true  },
  { id: 'tempdb_usage',        label: 'TempDB Usage',             group: 'section', category: 'Database',    defaultEnabled: true  },
]

export const PANEL_CATEGORIES = ['Performance', 'Memory', 'SQL Agent', 'Sessions']

export function defaultLayout() {
  return WIDGET_REGISTRY.map(w => ({ id: w.id, enabled: w.defaultEnabled }))
}

export function loadLayout() {
  try {
    const stored = localStorage.getItem('sqlmon-widget-layout')
    if (!stored) return defaultLayout()
    const parsed = JSON.parse(stored)
    const storedMap = new Map(parsed.map(w => [w.id, w]))
    // Keep stored order for known IDs, append new registry additions at end
    const out = parsed.filter(w => WIDGET_REGISTRY.find(r => r.id === w.id))
    for (const r of WIDGET_REGISTRY) {
      if (!storedMap.has(r.id)) out.push({ id: r.id, enabled: r.defaultEnabled })
    }
    return out
  } catch {
    return defaultLayout()
  }
}

export function saveLayout(layout) {
  try { localStorage.setItem('sqlmon-widget-layout', JSON.stringify(layout)) } catch {}
}

/** Quick lookup: registry meta by id */
export const REGISTRY_MAP = Object.fromEntries(WIDGET_REGISTRY.map(w => [w.id, w]))
