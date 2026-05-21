'use strict'

const { executeDMV } = require('../repository/executeDMV.js')

const VALID_MODES = new Set(['LIMITED', 'SAMPLED', 'DETAILED'])

function mapRecommendation(frag, pages) {
  if (pages < 1000) return 'SKIP_SMALL'
  if (frag >= 30)   return 'REBUILD'
  if (frag >= 5)    return 'REORGANIZE'
  return 'OK'
}

async function getFragmented(pool, db, mode) {
  if (!VALID_MODES.has(mode)) throw new Error(`Invalid scan mode: ${mode}`)
  const rows = await executeDMV(pool, db, `
    SELECT
      s.name                           AS schema_name,
      o.name                           AS table_name,
      i.name                           AS index_name,
      i.type_desc                      AS index_type_desc,
      p.avg_fragmentation_in_percent,
      p.page_count,
      p.partition_number,
      (SELECT COUNT(*) FROM sys.partitions sp2
       WHERE sp2.object_id = i.object_id AND sp2.index_id = i.index_id) AS partition_count,
      par.data_compression_desc
    FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, N'${mode}') p
    JOIN sys.indexes    i   ON i.object_id   = p.object_id AND i.index_id = p.index_id
    JOIN sys.objects    o   ON o.object_id   = i.object_id AND o.type = 'U'
    JOIN sys.schemas    s   ON s.schema_id   = o.schema_id
    JOIN sys.partitions par ON par.object_id = p.object_id
                            AND par.index_id = p.index_id
                            AND par.partition_number = p.partition_number
    WHERE i.type_desc IN (
      N'CLUSTERED', N'NONCLUSTERED',
      N'CLUSTERED COLUMNSTORE', N'NONCLUSTERED COLUMNSTORE'
    )
    AND i.is_disabled = 0
  `)

  return rows.map(r => ({
    database_name:                db,
    schema_name:                  r.schema_name,
    table_name:                   r.table_name,
    index_name:                   r.index_name,
    index_type_desc:              r.index_type_desc,
    avg_fragmentation_in_percent: r.avg_fragmentation_in_percent,
    page_count:                   r.page_count,
    partition_number:             r.partition_number,
    partition_count:              r.partition_count,
    data_compression_desc:        r.data_compression_desc,
    recommendation:               mapRecommendation(r.avg_fragmentation_in_percent, r.page_count),
  }))
}

module.exports = { getFragmented }
