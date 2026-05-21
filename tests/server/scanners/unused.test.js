// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getUnused, getDisabledCount } from '../../../server/scanners/unused.js'

function makePool(rows) {
  return { request: () => ({ query: async () => ({ recordset: rows }) }) }
}

describe('getUnused', () => {
  it('returns empty array when no rows', async () => {
    expect(await getUnused(makePool([]), 'testdb')).toEqual([])
  })

  it('returns indexes with zero reads and nonzero writes', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Orders', index_name: 'IX_Unused', index_type_desc: 'NONCLUSTERED', user_seeks: 0, user_scans: 0, user_lookups: 0, user_updates: 150, last_user_seek: null }]
    const result = await getUnused(makePool(rows), 'testdb')
    expect(result).toHaveLength(1)
    expect(result[0].database_name).toBe('testdb')
    expect(result[0].user_updates).toBe(150)
    expect(result[0].is_duplicate).toBe(false)
    expect(result[0].last_user_seek).toBeNull()
  })

  it('maps last_user_seek to ISO string when present', async () => {
    const seekDate = new Date('2024-03-15T10:00:00Z')
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'NONCLUSTERED', user_seeks: 0, user_scans: 0, user_lookups: 0, user_updates: 10, last_user_seek: seekDate }]
    expect((await getUnused(makePool(rows), 'testdb'))[0].last_user_seek).toBe(seekDate.toISOString())
  })
})

describe('getDisabledCount', () => {
  it('returns 0 when no disabled indexes', async () => {
    expect(await getDisabledCount(makePool([{ disabled_count: 0 }]), 'testdb')).toBe(0)
  })

  it('returns count from first row', async () => {
    expect(await getDisabledCount(makePool([{ disabled_count: 3 }]), 'testdb')).toBe(3)
  })

  it('returns 0 when recordset is empty', async () => {
    expect(await getDisabledCount(makePool([]), 'testdb')).toBe(0)
  })
})
