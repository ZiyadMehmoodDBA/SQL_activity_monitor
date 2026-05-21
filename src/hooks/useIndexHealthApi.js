import { useCallback } from 'react'

export function useIndexHealthApi(connId) {
  const startScan = useCallback(async ({ mode, databases }) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, databases }),
    })
    if (res.status === 409) {
      const data = await res.json()
      return { conflict: true, scanId: data.scanId }
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Start scan failed: ${res.status}`)
    }
    return await res.json()
  }, [connId])

  const pollProgress = useCallback(async (scanId) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}/progress`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      const err = new Error(data.error || `Progress poll failed: ${res.status}`)
      err.status = res.status
      throw err
    }
    return await res.json()
  }, [connId])

  const fetchResults = useCallback(async (scanId, tab, opts = {}) => {
    const params = new URLSearchParams({ tab, page: opts.page ?? 1, pageSize: opts.pageSize || 50 })
    if (opts.db && opts.db !== 'all') params.set('db', opts.db)
    if (opts.search) params.set('search', opts.search)
    if (opts.rowType) params.set('rowType', opts.rowType)
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}/results?${params}`)
    if (res.status === 404) return { expired: true }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Results fetch failed: ${res.status}`)
    }
    return await res.json()
  }, [connId])

  const cancelScan = useCallback(async (scanId) => {
    const res = await fetch(`/api/connections/${connId}/index-health/scan/${scanId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Cancel failed: ${res.status}`)
  }, [connId])

  return { startScan, pollProgress, fetchResults, cancelScan }
}
