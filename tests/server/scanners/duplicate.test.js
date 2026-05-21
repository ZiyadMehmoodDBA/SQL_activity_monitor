// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getDuplicates } from '../../../server/scanners/duplicate.js'

// Two-call pool: first returns index list, second returns column list
function makePool(indexRows, columnRows) {
  let callCount = 0
  return {
    request: () => ({
      query: async () => {
        const result = callCount === 0 ? indexRows : columnRows
        callCount++
        return { recordset: result }
      },
    }),
  }
}

describe('getDuplicates', () => {
  it('returns empty array when no indexes', async () => {
    expect(await getDuplicates(makePool([], []), 'testdb')).toEqual([])
  })

  it('detects exact duplicate key columns (same order, same ASC/DESC)', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
    ]
    const result = await getDuplicates(makePool(indexes, columns), 'testdb')
    expect(result).toHaveLength(2)
    const names = result.map(r => r.index_name)
    expect(names).toContain('IX_A')
    expect(names).toContain('IX_B')
    expect(result[0].duplicate_of).toBeDefined()
    expect(result[0].database_name).toBe('testdb')
  })

  it('does not flag indexes with different key columns', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId',    key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'OrderDate', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })

  it('excludes primary key indexes from duplicate candidates', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'Id', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })

  it('does not flag indexes with same key but different include columns', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 2, column_name: 'Name',   key_ordinal: 0, is_descending_key: 0, is_included_column: 1 },
      { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'Email',  key_ordinal: 0, is_descending_key: 0, is_included_column: 1 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })

  it('respects ASC/DESC direction — different direction is not a duplicate', async () => {
    const indexes = [
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_A', index_id: 2, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
      { schema_name: 'dbo', table_name: 'T', index_name: 'IX_B', index_id: 3, object_id: 100, has_filter: false, filter_definition: null, is_primary_key: 0, is_unique_constraint: 0 },
    ]
    const columns = [
      { object_id: 100, index_id: 2, column_name: 'UserId', key_ordinal: 1, is_descending_key: 0, is_included_column: 0 },
      { object_id: 100, index_id: 3, column_name: 'UserId', key_ordinal: 1, is_descending_key: 1, is_included_column: 0 },
    ]
    expect(await getDuplicates(makePool(indexes, columns), 'testdb')).toEqual([])
  })
})
