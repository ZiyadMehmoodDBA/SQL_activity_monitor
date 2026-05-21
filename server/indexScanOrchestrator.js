'use strict'

async function fetchUserDatabases(pool) {
  const r = await pool.request().query(`
    SELECT DB_NAME(database_id) AS db_name
    FROM sys.databases
    WHERE database_id > 4 AND state = 0
    ORDER BY name
  `)
  return r.recordset.map(row => row.db_name)
}

async function fetchDbWeights(pool, databases) {
  const r = await pool.request().query(`
    SELECT
      DB_NAME(database_id) AS db_name,
      CAST(SUM(CAST(size AS BIGINT)) * 8192 AS FLOAT) AS size_bytes
    FROM sys.master_files
    WHERE state = 0 AND database_id > 4
    GROUP BY database_id
  `)
  const fromQuery = {}
  for (const row of r.recordset) fromQuery[row.db_name] = row.size_bytes
  const weights = {}
  for (const db of databases) weights[db] = fromQuery[db] || 1
  return weights
}

async function fetchServerMeta(pool) {
  const r = await pool.request().query(`
    SELECT
      CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
      CAST(SERVERPROPERTY('Edition') AS NVARCHAR(100))   AS edition,
      sqlserver_start_time
    FROM sys.dm_os_sys_info
  `)
  const row = r.recordset[0] || {}
  return {
    majorVersion: row.major_version || 0,
    edition: row.edition || '',
    serverRestartTime: row.sqlserver_start_time
      ? new Date(row.sqlserver_start_time).toISOString()
      : null,
    supportsOnlineRebuild: /Enterprise|Developer/i.test(row.edition || ''),
  }
}

function calcProgressPct(completedWeight, totalWeight) {
  if (totalWeight === 0) return 0
  return Math.min(100, (completedWeight / totalWeight) * 100)
}

function computeHealthScore(dbResults) {
  if (dbResults.length === 0) {
    return { score: 100, severity: 'Healthy', totalIndexes: 0, fragmentedCount: 0, missingCount: 0, unusedCount: 0, duplicateCount: 0, disabledCount: 0 }
  }

  let totalIndexes = 0, rebuildCount = 0, missingCount = 0
  let duplicateCount = 0, disabledCount = 0, unusedCount = 0, fragmentedCount = 0

  for (const r of dbResults) {
    totalIndexes  += r.totalIndexes
    disabledCount += r.disabledCount
    missingCount  += r.missing.length
    duplicateCount += r.duplicate.length
    unusedCount   += r.unused.filter(u => !u.is_duplicate).length
    for (const f of r.fragmented) {
      if (f.recommendation === 'REBUILD') rebuildCount++
      if (f.recommendation !== 'OK' && f.recommendation !== 'SKIP_SMALL') fragmentedCount++
    }
  }

  if (totalIndexes === 0) {
    return { score: 100, severity: 'Healthy', totalIndexes: 0, fragmentedCount: 0, missingCount: 0, unusedCount: 0, duplicateCount: 0, disabledCount: 0 }
  }

  const fragPenalty    = Math.min((rebuildCount   / totalIndexes) * 100, 100)
  const missingPenalty = Math.min((missingCount   / totalIndexes) * 100, 100)
  const dupPenalty     = Math.min((duplicateCount / totalIndexes) * 100, 100)
  const disablePenalty = Math.min((disabledCount  / totalIndexes) * 100, 100)

  const score = Math.max(0, Math.round(
    100 - (fragPenalty * 0.4 + missingPenalty * 0.3 + dupPenalty * 0.15 + disablePenalty * 0.15)
  ))
  const severity = score > 90 ? 'Healthy' : score >= 70 ? 'Warning' : 'Critical'

  return { score, severity, totalIndexes, fragmentedCount, missingCount, unusedCount, duplicateCount, disabledCount }
}

function paginateResults(rows, { page = 1, pageSize = 50, db, search } = {}) {
  let filtered = rows
  if (db && db !== 'all') {
    filtered = filtered.filter(r => r.database_name === db)
  }
  if (search) {
    const s = search.toLowerCase()
    filtered = filtered.filter(r =>
      (r.table_name  || '').toLowerCase().includes(s) ||
      (r.index_name  || '').toLowerCase().includes(s)
    )
  }
  const total = filtered.length
  const start = (page - 1) * pageSize
  return { total, page, pageSize, rows: filtered.slice(start, start + pageSize) }
}

async function runWithConcurrency(items, limit, processor, shouldStop) {
  const results = []
  const queue = items.slice()

  async function worker() {
    while (queue.length > 0 && !shouldStop()) {
      const item = queue.shift()
      if (item === undefined) break
      results.push(await processor(item))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return results
}

async function scanDatabaseWithTimeout(pool, db, mode, timeoutMs, scanFn) {
  let timerId
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('SCAN_TIMEOUT')), timeoutMs)
  })
  try {
    return await Promise.race([scanFn(pool, db, mode), timeout])
  } catch (err) {
    if (err.message === 'SCAN_TIMEOUT') {
      return { db, timedOut: true, totalIndexes: 0, disabledCount: 0, fragmented: [], missing: [], unused: [], duplicate: [] }
    }
    throw err
  } finally {
    clearTimeout(timerId)
  }
}

module.exports = {
  fetchUserDatabases,
  fetchDbWeights,
  fetchServerMeta,
  calcProgressPct,
  computeHealthScore,
  paginateResults,
  runWithConcurrency,
  scanDatabaseWithTimeout,
}
