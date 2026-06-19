import { describe, it, expect } from 'vitest'
import { TABLE_COLS, DEFAULT_SORT } from '../../lib/tableCols'

describe('TABLE_COLS.cpu', () => {
  it('matches the spec grid layout order', () => {
    expect(TABLE_COLS.cpu.map(c => c.key)).toEqual([
      'database_name', 'execution_count', 'total_worker_time', 'avg_cpu_ms',
      'last_executed', 'query_text', 'parent_object', 'object_type',
    ])
  })

  it('query_text tooltip shows the full statement', () => {
    const col = TABLE_COLS.cpu.find(c => c.key === 'query_text')
    expect(col.titleFn({ query_text: 'short', query_text_full: 'SELECT 1\nFROM t' })).toBe('SELECT 1\nFROM t')
    expect(col.titleFn({ query_text: 'short' })).toBe('short')
  })

  it('parent_object tooltip shows schema, object id, database when resolved', () => {
    const col = TABLE_COLS.cpu.find(c => c.key === 'parent_object')
    expect(col.titleFn({ schema_name: 'dbo', object_id: 245575913, database_name: 'Medcare_DB' }))
      .toBe('Schema: dbo\nObject Id: 245575913\nDatabase: Medcare_DB')
    expect(col.titleFn({ object_id: null })).toBe('')
  })

  it('cpu default sort unchanged', () => {
    expect(DEFAULT_SORT.cpu).toEqual({ col: 'total_worker_time', dir: 'desc' })
  })
})
