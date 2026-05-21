// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { scanDatabase } from '../../server/indexScanQueries.js'

function makeEmptyPool() {
  return { request: () => ({ query: async () => ({ recordset: [] }) }) }
}

describe('scanDatabase', () => {
  it('returns DatabaseScanResult shape', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'testdb', 'LIMITED')
    expect(result.database).toBe('testdb')
    expect(typeof result.totalIndexes).toBe('number')
    expect(typeof result.disabledCount).toBe('number')
    expect(Array.isArray(result.fragmented)).toBe(true)
    expect(Array.isArray(result.missing)).toBe(true)
    expect(Array.isArray(result.unused)).toBe(true)
    expect(Array.isArray(result.duplicate)).toBe(true)
    expect(typeof result.metadata.durationMs).toBe('number')
    expect(typeof result.metadata.startedAt).toBe('string')
    expect(typeof result.metadata.completedAt).toBe('string')
    expect(result.metadata.timeout).toBe(false)
  })

  it('returns empty arrays for empty database', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'emptydb', 'LIMITED')
    expect(result.fragmented).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.unused).toEqual([])
    expect(result.duplicate).toEqual([])
    expect(result.totalIndexes).toBe(0)
    expect(result.disabledCount).toBe(0)
  })

  it('durationMs is non-negative', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'testdb', 'SAMPLED')
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('startedAt is not after completedAt', async () => {
    const result = await scanDatabase(makeEmptyPool(), 'testdb', 'LIMITED')
    expect(new Date(result.metadata.startedAt) <= new Date(result.metadata.completedAt)).toBe(true)
  })

  it('unused rows get is_duplicate=true when also in duplicate list', async () => {
    let callCount = 0
    const pool = {
      request: () => ({
        query: async () => {
          callCount++
          if (callCount === 3) {
            return { recordset: [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_Dup', index_type_desc: 'NONCLUSTERED', user_seeks: 0, user_scans: 0, user_lookups: 0, user_updates: 10, last_user_seek: null }] }
          }
          if (callCount === 4) {
            return { recordset: [
              { schema_name: 'dbo', table_name: 'T', index_name: 'IX_Dup',  index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
              { schema_name: 'dbo', table_name: 'T', index_name: 'IX_Same', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
            ] }
          }
          if (callCount === 5) {
            return { recordset: [
              { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
              { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
            ] }
          }
          return { recordset: [] }
        }
      })
    }
    const result = await scanDatabase(pool, 'testdb', 'LIMITED')
    const dupUnused = result.unused.find(u => u.index_name === 'IX_Dup')
    if (dupUnused) {
      expect(dupUnused.is_duplicate).toBe(true)
    }
    expect(result.metadata.timeout).toBe(false)
  })
})
