'use strict'

const { executeDMV } = require('../repository/executeDMV.js')

async function getUnused(pool, db) {
  const rows = await executeDMV(pool, db, `
    SELECT
      s.name                      AS schema_name,
      o.name                      AS table_name,
      i.name                      AS index_name,
      i.type_desc                 AS index_type_desc,
      ISNULL(u.user_seeks,   0)  AS user_seeks,
      ISNULL(u.user_scans,   0)  AS user_scans,
      ISNULL(u.user_lookups, 0)  AS user_lookups,
      ISNULL(u.user_updates, 0)  AS user_updates,
      u.last_user_seek
    FROM sys.indexes i
    JOIN sys.objects  o ON o.object_id = i.object_id AND o.type = 'U'
    JOIN sys.schemas  s ON s.schema_id = o.schema_id
    LEFT JOIN sys.dm_db_index_usage_stats u
      ON u.object_id   = i.object_id
     AND u.index_id    = i.index_id
     AND u.database_id = DB_ID()
    WHERE i.type_desc IN (N'CLUSTERED', N'NONCLUSTERED')
      AND i.is_disabled          = 0
      AND i.is_primary_key       = 0
      AND i.is_unique_constraint = 0
      AND ISNULL(u.user_seeks,   0) + ISNULL(u.user_scans,   0)
        + ISNULL(u.user_lookups, 0) = 0
      AND ISNULL(u.user_updates, 0) > 0
  `)

  return rows.map(r => ({
    database_name:   db,
    schema_name:     r.schema_name,
    table_name:      r.table_name,
    index_name:      r.index_name,
    index_type_desc: r.index_type_desc,
    user_seeks:      r.user_seeks,
    user_scans:      r.user_scans,
    user_lookups:    r.user_lookups,
    user_updates:    r.user_updates,
    last_user_seek:  r.last_user_seek ? new Date(r.last_user_seek).toISOString() : null,
    is_duplicate:    false,
  }))
}

async function getDisabledCount(pool, db) {
  const rows = await executeDMV(pool, db, `
    SELECT COUNT(*) AS disabled_count
    FROM sys.indexes i
    JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
    WHERE i.is_disabled = 1
  `)
  return rows[0]?.disabled_count ?? 0
}

module.exports = { getUnused, getDisabledCount }
