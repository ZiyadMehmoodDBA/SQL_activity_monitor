// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getMissing } from '../../../server/scanners/missing.js'

function makePool(rows) {
  return { request: () => ({ query: async () => ({ recordset: rows }) }) }
}

describe('getMissing', () => {
  it('returns empty array when no rows', async () => {
    expect(await getMissing(makePool([]), 'testdb')).toEqual([])
  })

  it('normalizes impact score — max row gets 100, others proportional', async () => {
    const rows = [
      { schema_name: 'dbo', table_name: 'Orders', equality_columns: 'CustomerId', inequality_columns: null, included_columns: 'OrderDate', raw_impact: 800, user_seeks: 1000, user_scans: 0, last_user_seek: new Date('2024-01-01') },
      { schema_name: 'dbo', table_name: 'Items',  equality_columns: 'SKU',        inequality_columns: null, included_columns: null,        raw_impact: 400, user_seeks: 500,  user_scans: 0, last_user_seek: null },
    ]
    const result = await getMissing(makePool(rows), 'testdb')
    expect(result[0].impact_score).toBe(100)
    expect(result[1].impact_score).toBe(50)
    result.forEach(r => {
      expect(r.impact_score).toBeGreaterThanOrEqual(0)
      expect(r.impact_score).toBeLessThanOrEqual(100)
    })
  })

  it('caps include columns at 16 and sets truncated_include_list=true', async () => {
    const manyIncludes = Array.from({ length: 20 }, (_, i) => `Col${i}`).join(',')
    const rows = [{ schema_name: 'dbo', table_name: 'T', equality_columns: 'Id', inequality_columns: null, included_columns: manyIncludes, raw_impact: 100, user_seeks: 10, user_scans: 0, last_user_seek: null }]
    const result = await getMissing(makePool(rows), 'testdb')
    expect(result[0].truncated_include_list).toBe(true)
    expect(result[0].include_columns.split(',').length).toBe(16)
  })

  it('sets truncated_include_list=false when <= 16 includes', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', equality_columns: 'Id', inequality_columns: null, included_columns: 'A,B,C', raw_impact: 100, user_seeks: 10, user_scans: 0, last_user_seek: null }]
    expect((await getMissing(makePool(rows), 'testdb'))[0].truncated_include_list).toBe(false)
  })

  it('generates CREATE INDEX script containing table and key columns', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Orders', equality_columns: 'CustomerId', inequality_columns: 'OrderDate', included_columns: 'Amount', raw_impact: 100, user_seeks: 10, user_scans: 0, last_user_seek: null }]
    const result = await getMissing(makePool(rows), 'testdb')
    expect(result[0].create_script).toContain('CREATE INDEX')
    expect(result[0].create_script).toContain('[dbo].[Orders]')
    expect(result[0].create_script).toContain('[CustomerId]')
    expect(result[0].create_script).toContain('[OrderDate]')
    expect(result[0].create_script).toContain('INCLUDE')
    expect(result[0].create_script).toContain('[Amount]')
  })

  it('sets last_user_seek to null when absent', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', equality_columns: 'Id', inequality_columns: null, included_columns: null, raw_impact: 50, user_seeks: 5, user_scans: 0, last_user_seek: null }]
    expect((await getMissing(makePool(rows), 'testdb'))[0].last_user_seek).toBeNull()
  })
})
