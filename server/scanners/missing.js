'use strict'

const { executeDMV, quoteName } = require('../repository/executeDMV.js')

const MAX_INCLUDE_COLS = 16

function capIncludes(colStr) {
  if (!colStr) return { columns: null, truncated: false }
  const cols = colStr.split(',').map(c => c.trim())
  if (cols.length <= MAX_INCLUDE_COLS) return { columns: colStr, truncated: false }
  return { columns: cols.slice(0, MAX_INCLUDE_COLS).join(', '), truncated: true }
}

function buildScript(schema, table, equality, inequality, includes, supportsOnline) {
  const keyCols = [
    ...(equality   ? equality.split(',').map(c => quoteName(c.trim()))   : []),
    ...(inequality ? inequality.split(',').map(c => quoteName(c.trim())) : []),
  ]
  const inclCols  = includes ? includes.split(',').map(c => quoteName(c.trim())) : []
  const inclPart  = inclCols.length > 0 ? `\nINCLUDE (${inclCols.join(', ')})` : ''
  const onlinePart = supportsOnline ? '\nWITH (ONLINE = ON)' : ''
  const baseName  = keyCols[0] ? keyCols[0].replace(/[\[\]]/g, '') : 'idx'
  const safeTable = table.replace(/[\[\]]/g, '')
  return (
    `CREATE INDEX [IX_missing_${safeTable}_${baseName}]\n` +
    `ON ${quoteName(schema)}.${quoteName(table)} (${keyCols.join(', ')})${inclPart}${onlinePart};`
  )
}

function normalizeImpact(rows) {
  const maxRaw = Math.max(...rows.map(r => r.raw_impact), 1)
  return rows.map(r => Math.min(Math.round((r.raw_impact / maxRaw) * 100), 100))
}

async function getMissing(pool, db, supportsOnline = false) {
  const rows = await executeDMV(pool, db, `
    SELECT
      s.name                                                                    AS schema_name,
      OBJECT_NAME(mid.object_id)                                                AS table_name,
      mid.equality_columns,
      mid.inequality_columns,
      mid.included_columns,
      migs.avg_total_user_cost * (migs.avg_user_impact / 100.0)
        * (migs.user_seeks + migs.user_scans)                                  AS raw_impact,
      migs.user_seeks,
      migs.user_scans,
      migs.last_user_seek
    FROM sys.dm_db_missing_index_details     mid
    JOIN sys.dm_db_missing_index_groups      mig  ON mig.index_handle   = mid.index_handle
    JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle  = mig.index_group_handle
    JOIN sys.objects                         o    ON o.object_id        = mid.object_id
    JOIN sys.schemas                         s    ON s.schema_id        = o.schema_id
    WHERE mid.database_id = DB_ID()
    ORDER BY raw_impact DESC
  `)

  if (rows.length === 0) return []

  const scores = normalizeImpact(rows)
  return rows.map((r, i) => {
    const { columns: cappedIncludes, truncated } = capIncludes(r.included_columns)
    return {
      database_name:          db,
      schema_name:            r.schema_name,
      table_name:             r.table_name,
      equality_columns:       r.equality_columns   || null,
      inequality_columns:     r.inequality_columns || null,
      include_columns:        cappedIncludes,
      truncated_include_list: truncated,
      impact_score:           scores[i],
      user_seeks:             r.user_seeks,
      user_scans:             r.user_scans,
      last_user_seek:         r.last_user_seek ? new Date(r.last_user_seek).toISOString() : null,
      create_script:          buildScript(r.schema_name, r.table_name, r.equality_columns, r.inequality_columns, cappedIncludes, supportsOnline),
    }
  })
}

module.exports = { getMissing }
