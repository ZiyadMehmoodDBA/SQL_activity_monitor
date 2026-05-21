import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIndexHealthApi } from '../../hooks/useIndexHealthApi'

const CONN = 'conn-1'
const SCAN_ID = 'scan-abc'

function mockFetch(status, body) {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })
  )
}

describe('useIndexHealthApi', () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe('startScan', () => {
    it('POSTs correct URL and body, returns scanId', async () => {
      mockFetch(202, { scanId: SCAN_ID })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.startScan({ mode: 'LIMITED', databases: [] })
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/connections/${CONN}/index-health/scan`,
        expect.objectContaining({ method: 'POST' })
      )
      expect(res.scanId).toBe(SCAN_ID)
    })

    it('returns { conflict: true, scanId } on 409', async () => {
      mockFetch(409, { error: 'Scan already in progress.', scanId: SCAN_ID })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.startScan({ mode: 'LIMITED', databases: [] })
      expect(res.conflict).toBe(true)
      expect(res.scanId).toBe(SCAN_ID)
    })

    it('throws on non-202 non-409 status', async () => {
      mockFetch(500, { error: 'Server error' })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await expect(result.current.startScan({ mode: 'LIMITED', databases: [] })).rejects.toThrow('Server error')
    })
  })

  describe('pollProgress', () => {
    it('GETs progress URL and returns payload', async () => {
      const payload = { scanId: SCAN_ID, status: 'running', pct: 40, currentDb: 'dbA', completedDbs: 2, totalDbs: 5, timedOutDbs: [], eta: 30 }
      mockFetch(200, payload)
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.pollProgress(SCAN_ID)
      expect(global.fetch).toHaveBeenCalledWith(`/api/connections/${CONN}/index-health/scan/${SCAN_ID}/progress`)
      expect(res.pct).toBe(40)
    })

    it('throws on non-ok status', async () => {
      mockFetch(404, { error: 'not found' })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await expect(result.current.pollProgress(SCAN_ID)).rejects.toThrow()
    })
  })

  describe('fetchResults', () => {
    it('GETs results URL with correct query params', async () => {
      const payload = { status: 'completed', summary: {}, metadata: {}, timedOutDbs: [], fragmented: { rows: [], total: 0, page: 1, pageSize: 50 } }
      mockFetch(200, payload)
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await result.current.fetchResults(SCAN_ID, 'fragmented', { page: 2, pageSize: 50, db: 'mydb', search: 'idx' })
      const url = global.fetch.mock.calls[0][0]
      expect(url).toContain('tab=fragmented')
      expect(url).toContain('page=2')
      expect(url).toContain('db=mydb')
      expect(url).toContain('search=idx')
    })

    it('returns { expired: true } on 404', async () => {
      mockFetch(404, { error: 'not found' })
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      const res = await result.current.fetchResults(SCAN_ID, 'fragmented')
      expect(res.expired).toBe(true)
    })
  })

  describe('cancelScan', () => {
    it('sends DELETE to correct URL', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 204 }))
      const { result } = renderHook(() => useIndexHealthApi(CONN))
      await result.current.cancelScan(SCAN_ID)
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/connections/${CONN}/index-health/scan/${SCAN_ID}`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })
})
