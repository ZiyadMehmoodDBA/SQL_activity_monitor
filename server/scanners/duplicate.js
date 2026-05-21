'use strict'

const { executeDMV } = require('../repository/executeDMV.js')

function keySignature(cols) {
  return cols
    .filter(c => !c.is_included_column)
    .sort((a, b) => a.key_ordinal - b.key_ordinal)
    .map(c => `${c.column_name}:${c.is_descending_key ? 'desc' : 'asc'}`)
    .join('|')
}

function includeSignature(cols) {
  return cols
    .filter(c => c.is_included_column)
    .map(c => c.column_name)
    .sort()
    .join(',')
}

function colDisplay(cols, includeOnly) {
  return cols
    .filter(c => Boolean(c.is_included_column) === includeOnly)
    .sort((a, b) => includeOnly ? a.column_name.localeCompare(b.column_name) : a.key_ordinal - b.key_ordinal)
    .map(c => c.column_name)
    .join(', ')
}

async function getDuplicates(pool, db) {
  const indexes = await executeDMV(pool, db, `
    SELECT
      s.name                AS schema_name,
      o.name                AS table_name,
      i.name                AS index_name,
      i.index_id,
      i.object_id,
      i.has_filter,
      i.filter_definition,
      i.is_primary_key,
      i.is_unique_constraint
    FROM sys.indexes  i
    JOIN sys.objects  o ON o.object_id = i.object_id AND o.type = 'U'
    JOIN sys.schemas  s ON s.schema_id = o.schema_id
    WHERE i.type_desc IN (N'CLUSTERED', N'NONCLUSTERED')
      AND i.is_primary_key       = 0
      AND i.is_unique_constraint = 0
      AND i.is_disabled          = 0
  `)

  if (indexes.length === 0) return []

  const columns = await executeDMV(pool, db, `
    SELECT
      ic.object_id,
      ic.index_id,
      c.name            AS column_name,
      ic.key_ordinal,
      ic.is_descending_key,
      ic.is_included_column
    FROM sys.index_columns ic
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id IN (
      SELECT DISTINCT object_id FROM sys.indexes
      WHERE type_desc IN (N'CLUSTERED', N'NONCLUSTERED')
        AND is_primary_key = 0 AND is_unique_constraint = 0 AND is_disabled = 0
    )
  `)

  const colMap = new Map()
  for (const c of columns) {
    const key = `${c.object_id}|${c.index_id}`
    if (!colMap.has(key)) colMap.set(key, [])
    colMap.get(key).push(c)
  }

  const byTable = new Map()
  for (const ix of indexes) {
    if (!byTable.has(ix.object_id)) byTable.set(ix.object_id, [])
    byTable.get(ix.object_id).push(ix)
  }

  const duplicates = []
  const seen = new Set()

  for (const tableIndexes of byTable.values()) {
    if (tableIndexes.length < 2) continue

    const fps = tableIndexes.map(ix => {
      const cols = colMap.get(`${ix.object_id}|${ix.index_id}`) || []
      return {
        ix,
        keySig:      keySignature(cols),
        inclSig:     includeSignature(cols),
        keyDisplay:  colDisplay(cols, false),
        inclDisplay: colDisplay(cols, true),
      }
    })

    for (let a = 0; a < fps.length; a++) {
      for (let b = a + 1; b < fps.length; b++) {
        const fa = fps[a], fb = fps[b]
        if (
          fa.keySig  === fb.keySig &&
          fa.inclSig === fb.inclSig &&
          (fa.ix.filter_definition || null) === (fb.ix.filter_definition || null) &&
          Boolean(fa.ix.has_filter) === Boolean(fb.ix.has_filter)
        ) {
          const keyA = `${fa.ix.object_id}|${fa.ix.index_id}`
          const keyB = `${fb.ix.object_id}|${fb.ix.index_id}`
          if (!seen.has(keyA)) {
            seen.add(keyA)
            duplicates.push({ database_name: db, schema_name: fa.ix.schema_name, table_name: fa.ix.table_name, index_name: fa.ix.index_name, duplicate_of: fb.ix.index_name, key_columns: fa.keyDisplay, include_columns: fa.inclDisplay })
          }
          if (!seen.has(keyB)) {
            seen.add(keyB)
            duplicates.push({ database_name: db, schema_name: fb.ix.schema_name, table_name: fb.ix.table_name, index_name: fb.ix.index_name, duplicate_of: fa.ix.index_name, key_columns: fb.keyDisplay, include_columns: fb.inclDisplay })
          }
        }
      }
    }
  }

  return duplicates
}

module.exports = { getDuplicates }
