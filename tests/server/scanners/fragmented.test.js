// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getFragmented } from '../../../server/scanners/fragmented.js'

function makePool(rows) {
  return { request: () => ({ query: async () => ({ recordset: rows }) }) }
}

describe('getFragmented', () => {
  it('returns empty array when no rows', async () => {
    expect(await getFragmented(makePool([]), 'testdb', 'LIMITED')).toEqual([])
  })

  it('maps REBUILD for frag >= 30 and page_count >= 1000', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Orders', index_name: 'IX_Date', index_type_desc: 'NONCLUSTERED', avg_fragmentation_in_percent: 45, page_count: 5000, partition_number: 1, partition_count: 1, data_compression_desc: 'NONE' }]
    const result = await getFragmented(makePool(rows), 'testdb', 'LIMITED')
    expect(result).toHaveLength(1)
    expect(result[0].recommendation).toBe('REBUILD')
    expect(result[0].database_name).toBe('testdb')
    expect(result[0].schema_name).toBe('dbo')
    expect(result[0].avg_fragmentation_in_percent).toBe(45)
    expect(result[0].page_count).toBe(5000)
  })

  it('maps REORGANIZE for frag 5–30 and page_count >= 1000', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'CLUSTERED', avg_fragmentation_in_percent: 15, page_count: 2000, partition_number: 1, partition_count: 1, data_compression_desc: 'ROW' }]
    expect((await getFragmented(makePool(rows), 'testdb', 'LIMITED'))[0].recommendation).toBe('REORGANIZE')
  })

  it('maps OK for frag < 5', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'CLUSTERED', avg_fragmentation_in_percent: 2, page_count: 5000, partition_number: 1, partition_count: 1, data_compression_desc: 'NONE' }]
    expect((await getFragmented(makePool(rows), 'testdb', 'LIMITED'))[0].recommendation).toBe('OK')
  })

  it('maps SKIP_SMALL for page_count < 1000 regardless of frag', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'Small', index_name: 'IX_S', index_type_desc: 'NONCLUSTERED', avg_fragmentation_in_percent: 99, page_count: 500, partition_number: 1, partition_count: 1, data_compression_desc: 'NONE' }]
    expect((await getFragmented(makePool(rows), 'testdb', 'LIMITED'))[0].recommendation).toBe('SKIP_SMALL')
  })

  it('includes partition_number and partition_count', async () => {
    const rows = [{ schema_name: 'dbo', table_name: 'T', index_name: 'IX_T', index_type_desc: 'CLUSTERED', avg_fragmentation_in_percent: 35, page_count: 2000, partition_number: 2, partition_count: 4, data_compression_desc: 'PAGE' }]
    const result = await getFragmented(makePool(rows), 'testdb', 'LIMITED')
    expect(result[0].partition_number).toBe(2)
    expect(result[0].partition_count).toBe(4)
  })
})
