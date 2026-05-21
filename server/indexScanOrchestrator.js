'use strict'

const { scanDatabase } = require('./indexScanQueries.js')

async function fetchUserDatabases(pool) {
  const r = await pool.request().query(`
    SELECT DB_NAME(database_id) AS db_name
    FROM sys.databases
    WHERE database_id > 4 AND state = 0 AND is_read_only = 0
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

function paginateResults(rows, { page = 1, pageSize = 50, db, search, rowType } = {}) {
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
  if (rowType) {
    filtered = filtered.filter(r => r._rowType === rowType)
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
      const nowMs = Date.now()
      return {
        database:     db,
        totalIndexes: 0,
        disabledCount: 0,
        fragmented:   [],
        missing:      [],
        unused:       [],
        duplicate:    [],
        metadata: {
          durationMs:  timeoutMs,
          startedAt:   new Date(nowMs - timeoutMs).toISOString(),
          completedAt: new Date(nowMs).toISOString(),
          timeout:     true,
        },
      }
    }
    throw err
  } finally {
    clearTimeout(timerId)
  }
}

const SCAN_TTL_MS = 2 * 60 * 60 * 1000
const DEFAULT_TIMEOUT = parseInt(process.env.INDEX_TIMEOUT_PER_DB_MS) || 120_000
const DEFAULT_CONCURRENCY = Math.min(parseInt(process.env.INDEX_SCAN_CONCURRENCY) || 3, 5)

async function runScan(pool, scanId, store, opts = {}) {
  const scan = store.get(scanId)
  if (!scan || scan.status === 'cancelled') return

  const timeoutPerDbMs = opts.timeoutPerDbMs || DEFAULT_TIMEOUT
  const maxConcurrent  = opts.maxConcurrent  || DEFAULT_CONCURRENCY

  store.update(scanId, { status: 'running' })

  try {
    const serverMeta = await fetchServerMeta(pool)

    let databases = scan.databases
    if (databases.length === 0 || (databases.length === 1 && databases[0] === 'ALL')) {
      databases = await fetchUserDatabases(pool)
      store.update(scanId, { databases, totalDbs: databases.length })
    }

    if (databases.length === 0) {
      store.update(scanId, {
        status: 'completed',
        currentDb: null,
        results: {
          fragmented: [], missing: [], unused: [], duplicate: [],
          summary: computeHealthScore([]),
        },
        metadata: {
          scanMode: scan.scanMode, serverVersion: serverMeta.majorVersion,
          serverRestartTime: serverMeta.serverRestartTime,
          supportsOnlineRebuild: serverMeta.supportsOnlineRebuild,
          scanDurationMs: 0, scanStartedAt: new Date(scan.createdAt).toISOString(),
          totalDbs: 0, completedDbs: 0,
        },
        completedAt: Date.now(),
        expiresAt: Date.now() + SCAN_TTL_MS,
      })
      return
    }

    const weights = await fetchDbWeights(pool, databases)
    const totalWeight = databases.reduce((sum, db) => sum + (weights[db] || 1), 0)
    store.update(scanId, { totalWeight })

    const allDbResults = []

    await runWithConcurrency(
      databases,
      maxConcurrent,
      async (db) => {
        const current = store.get(scanId)
        if (!current || current.status === 'cancelled') return

        store.update(scanId, { currentDb: db })

        const dbResult = await scanDatabaseWithTimeout(
          pool, db, scan.scanMode, timeoutPerDbMs,
          (p, d, scanMode) => scanDatabase(p, d, scanMode, serverMeta)
        )
        allDbResults.push(dbResult)

        const freshScan    = store.get(scanId)
        const completedDbs = [...(freshScan?.completedDbs || []), db]
        const timedOutDbs  = dbResult.metadata?.timeout
          ? [...(freshScan?.timedOutDbs || []), db]
          : (freshScan?.timedOutDbs || [])
        const completedWeight = completedDbs.reduce((s, d) => s + (weights[d] || 1), 0)

        store.update(scanId, { completedDbs, timedOutDbs, completedWeight })
      },
      () => (store.get(scanId)?.status === 'cancelled')
    )

    const finalScan = store.get(scanId)
    if (finalScan?.status === 'cancelled') return

    const summary = computeHealthScore(allDbResults)
    const scanDurationMs = Date.now() - scan.createdAt
    const completedAt = Date.now()
    const timedOutDbs = finalScan?.timedOutDbs || []

    store.update(scanId, {
      status: timedOutDbs.length > 0 ? 'completed_with_warnings' : 'completed',
      currentDb: null,
      results: {
        databases:  allDbResults,
        fragmented: allDbResults.flatMap(r => r.fragmented),
        missing:    allDbResults.flatMap(r => r.missing),
        unused:     allDbResults.flatMap(r => r.unused),
        duplicate:  allDbResults.flatMap(r => r.duplicate),
        summary,
      },
      metadata: {
        scanMode:              scan.scanMode,
        serverVersion:         serverMeta.majorVersion,
        serverRestartTime:     serverMeta.serverRestartTime,
        supportsOnlineRebuild: serverMeta.supportsOnlineRebuild,
        scanDurationMs,
        scanStartedAt:         new Date(scan.createdAt).toISOString(),
        totalDbs:              databases.length,
        completedDbs:          finalScan?.completedDbs?.length || 0,
      },
      completedAt,
      expiresAt: completedAt + SCAN_TTL_MS,
    })
  } catch (err) {
    store.update(scanId, { status: 'failed', error: err.message, completedAt: Date.now() })
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
  runScan,
  SCAN_TTL_MS,
}
