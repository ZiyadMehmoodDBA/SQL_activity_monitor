'use strict'

const { executeDMV }                  = require('./repository/executeDMV.js')
const { getFragmented }               = require('./scanners/fragmented.js')
const { getMissing }                  = require('./scanners/missing.js')
const { getUnused, getDisabledCount } = require('./scanners/unused.js')
const { getDuplicates }               = require('./scanners/duplicate.js')

async function getTotalIndexCount(pool, db) {
  const rows = await executeDMV(pool, db, `
    SELECT COUNT(*) AS total_count
    FROM sys.indexes i
    JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
    WHERE i.type_desc IN (
      N'CLUSTERED', N'NONCLUSTERED',
      N'CLUSTERED COLUMNSTORE', N'NONCLUSTERED COLUMNSTORE'
    )
    AND i.is_disabled = 0
  `)
  return rows[0]?.total_count ?? 0
}

async function scanDatabase(pool, db, mode, serverMeta = {}) {
  const startedAt = new Date().toISOString()
  const startMs   = Date.now()

  const [fragmented, missing, unused, duplicate, disabledCount, totalIndexes] = await Promise.all([
    getFragmented(pool, db, mode),
    getMissing(pool, db, serverMeta.supportsOnlineRebuild || false),
    getUnused(pool, db),
    getDuplicates(pool, db),
    getDisabledCount(pool, db),
    getTotalIndexCount(pool, db),
  ])

  const dupSet = new Set(duplicate.map(d => `${d.schema_name}|${d.table_name}|${d.index_name}`))
  const unusedTagged = unused.map(u => ({
    ...u,
    is_duplicate: dupSet.has(`${u.schema_name}|${u.table_name}|${u.index_name}`),
  }))

  return {
    database:     db,
    totalIndexes,
    disabledCount,
    fragmented,
    missing,
    unused: unusedTagged,
    duplicate,
    metadata: {
      durationMs:  Date.now() - startMs,
      startedAt,
      completedAt: new Date().toISOString(),
      timeout:     false,
    },
  }
}

module.exports = { scanDatabase }
