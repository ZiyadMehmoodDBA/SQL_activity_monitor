require('dotenv').config();
const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const sql        = require('mssql');
const { randomUUID } = require('crypto');
const path       = require('path');
const fs         = require('fs');

const { MemoryScanStore }   = require('./server/indexScanStore.js')
const { runScan, calcProgressPct, paginateResults, SCAN_TTL_MS } = require('./server/indexScanOrchestrator.js')
const metricsStore = require('./server/metricsStore');
const { parseHistoryRange, VALID_RESOLUTIONS } = require('./server/historyRange');
const { createAlertEvaluator } = require('./server/alertEvaluator');
const { parseKpi, parseAlertId } = require('./server/alertValidation');

const PORT    = parseInt(process.env.PORT)              || 3000;
// Bind localhost-only by default: every API endpoint is unauthenticated, so
// exposing beyond loopback allows anyone on the network to proxy SQL
// connections, kill sessions, and control Agent jobs. Set HOST=0.0.0.0
// explicitly (behind a trusted network/reverse proxy) to expose.
const HOST    = process.env.HOST                         || '127.0.0.1';
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS)  || 2000;

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);

app.disable('x-powered-by');
app.use(express.json());
const distDir = path.join(__dirname, 'dist')
const publicDir = path.join(__dirname, 'public')
app.use(express.static(fs.existsSync(distDir) ? distDir : publicDir));

// ─── DB size history (file-based, daily snapshots) ───────────────────────────
const DATA_DIR        = path.join(__dirname, 'data')
const DB_HISTORY_FILE = path.join(DATA_DIR, 'db-size-history.json')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

function loadDbHistory() {
  try {
    if (!fs.existsSync(DB_HISTORY_FILE)) return {}
    return JSON.parse(fs.readFileSync(DB_HISTORY_FILE, 'utf8'))
  } catch { return {} }
}

function saveDbHistory(history) {
  try { fs.writeFileSync(DB_HISTORY_FILE, JSON.stringify(history), 'utf8') }
  catch (e) { console.error('[db-history] save failed:', e.message) }
}

function pruneDbHistory(history) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 10)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  for (const serverKey of Object.keys(history)) {
    for (const dateKey of Object.keys(history[serverKey])) {
      if (dateKey < cutoffStr) delete history[serverKey][dateKey]
    }
    if (Object.keys(history[serverKey]).length === 0) delete history[serverKey]
  }
  return history
}

async function takeDbSizeSnapshot(pool, serverKey) {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const history = loadDbHistory()
    if (!history[serverKey]) history[serverKey] = {}
    if (history[serverKey][today]) return  // already captured today

    const result = await pool.request().query(`
      SELECT
        DB_NAME(mf.database_id) AS database_name,
        CAST(SUM(CASE WHEN mf.type_desc='ROWS' THEN CAST(mf.size AS BIGINT)*8192 ELSE 0 END) AS FLOAT) AS data_bytes,
        CAST(SUM(CASE WHEN mf.type_desc='LOG'  THEN CAST(mf.size AS BIGINT)*8192 ELSE 0 END) AS FLOAT) AS log_bytes,
        CAST(SUM(CAST(mf.size AS BIGINT))*8192 AS FLOAT) AS total_bytes
      FROM sys.master_files mf
      WHERE mf.database_id > 0 AND DB_NAME(mf.database_id) IS NOT NULL AND mf.state = 0
      GROUP BY mf.database_id`)

    const snapshot = {}
    for (const row of result.recordset) {
      snapshot[row.database_name] = {
        data_bytes:  row.data_bytes,
        log_bytes:   row.log_bytes,
        total_bytes: row.total_bytes,
      }
    }
    history[serverKey][today] = snapshot
    pruneDbHistory(history)
    saveDbHistory(history)
    console.log(`[db-history] Snapshot: ${serverKey} ${today} (${result.recordset.length} databases)`)
  } catch (err) {
    console.error('[db-history] Snapshot failed:', err.message)
  }
}

// ─── Connection store ─────────────────────────────────────────────────────────
// Map<id, { pool, label, server, handle, prevIO }>
const connections = new Map();

// ─── Missing index cache (per connection, advisory data) ──────────────────────
const missingIndexCache = new Map() // Map<connId, { rows, ts, expiresAt }>
const MISSING_INDEX_CACHE_MS = Math.max(1, parseInt(process.env.MISSING_INDEX_CACHE_MIN || '10') || 10) * 60 * 1000

const scanStore = new MemoryScanStore()
metricsStore.initialize(path.join(__dirname, 'data', 'metrics.db'));

setInterval(() => {
  const n = scanStore.cleanup(Date.now())
  if (n > 0) console.log(`[index-health] Cleaned up ${n} expired scan(s)`)
}, 30 * 60 * 1000)

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireConn(req, res) {
  const conn = connections.get(req.params.id)
  if (!conn) { res.status(404).json({ error: 'Not found.' }); return null }
  return conn
}

function parseServer(str) {
  const idx = str.indexOf('\\');
  return idx < 0
    ? { server: str, instanceName: undefined }
    : { server: str.slice(0, idx), instanceName: str.slice(idx + 1) };
}

function buildConfig({ server: serverStr, database, authType, user, password, encrypt, trustServerCert, hostNameInCertificate, appIntent }) {
  const { server, instanceName } = parseServer(serverStr || '');

  // Encrypt: 'false' | 'true' | 'strict'
  let encryptVal;
  if (encrypt === 'strict') encryptVal = 'strict';
  else if (encrypt === 'true' || encrypt === true) encryptVal = true;
  else encryptVal = false;

  const base = {
    server,
    database: database || 'master',
    requestTimeout:    10000,   // 10s — dashboard never waits on data
    connectionTimeout:  5000,   // 5s  — fail fast on unreachable host
    options: {
      instanceName,
      encrypt:               encryptVal,
      trustServerCertificate: trustServerCert === true || trustServerCert === 'true',
      hostNameInCertificate: hostNameInCertificate || undefined,
      enableArithAbort:      true,
      readOnlyIntent:        appIntent === 'ReadOnly',   // ApplicationIntent
      appName:               'SQL Dashboard',            // visible in dm_exec_sessions.program_name
    },
    pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  };
  if (authType === 'sql') {
    base.user     = user;
    base.password = password;
  } else {
    base.options.trustedConnection = true;
  }
  return base;
}

// ─── SQL Queries ──────────────────────────────────────────────────────────────
const Q = {
  cpu: `
    SELECT TOP 1
      record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int') AS cpu_percent,
      record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int')         AS system_idle
    FROM (
      SELECT TOP 1 CONVERT(XML, record) AS record
      FROM sys.dm_os_ring_buffers
      WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
      ORDER BY timestamp DESC
    ) AS x`,

  overview: `
    SELECT
      (SELECT COUNT(*) FROM sys.dm_exec_requests
       WHERE status='suspended' OR (wait_type IS NOT NULL AND wait_type!='')) AS waiting_tasks,
      (SELECT cntr_value FROM sys.dm_os_performance_counters
       WHERE counter_name='Batch Requests/sec' AND instance_name='')          AS batch_requests
    OPTION (FAST 1)`,

  ioSnapshot: `
    SELECT CAST(SUM(num_of_bytes_read+num_of_bytes_written) AS FLOAT) AS total_bytes
    FROM sys.dm_io_virtual_file_stats(NULL,NULL)`,

  processes: `
    SELECT TOP 100
      s.session_id,
      ISNULL(s.login_name,'')                                AS login_name,
      ISNULL(s.host_name,'')                                 AS host_name,
      ISNULL(LEFT(s.program_name,60),'')                     AS program_name,
      s.status, s.cpu_time,
      s.memory_usage*8                                       AS memory_kb,
      s.total_elapsed_time/1000                              AS elapsed_sec,
      ISNULL(r.command,'')                                   AS command,
      ISNULL(r.wait_type,'')                                 AS wait_type,
      ISNULL(r.wait_time,0)                                  AS wait_time,
      ISNULL(r.blocking_session_id,0)                        AS blocking_session_id,
      ISNULL(DB_NAME(s.database_id),'')                      AS database_name,
      LEFT(ISNULL(SUBSTRING(t.text,
        (ISNULL(r.statement_start_offset,0)/2)+1,
        ((CASE ISNULL(r.statement_end_offset,-1) WHEN -1 THEN DATALENGTH(t.text)
          ELSE r.statement_end_offset END - ISNULL(r.statement_start_offset,0))/2)+1),''),300) AS last_query
    FROM sys.dm_exec_sessions s
    LEFT JOIN sys.dm_exec_requests r ON s.session_id=r.session_id
    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
    WHERE s.is_user_process=1 AND s.session_id > 50
    ORDER BY s.cpu_time DESC
    OPTION (FAST 100)`,

  resourceWaits: `
    SELECT TOP 25 wait_type, waiting_tasks_count, wait_time_ms, max_wait_time_ms, signal_wait_time_ms
    FROM sys.dm_os_wait_stats
    WHERE wait_type NOT LIKE 'SLEEP_%' AND wait_type NOT LIKE 'BROKER_%' AND wait_type NOT LIKE 'HADR_%'
      AND wait_type NOT IN (
        'WAITFOR','CLR_AUTO_EVENT','DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT',
        'ONDEMAND_TASK_QUEUE','REQUEST_FOR_DEADLOCK_MONITOR','RESOURCE_QUEUE','SERVER_IDLE_CHECK',
        'SNI_HTTP_ACCEPT','SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_BUFFER_FLUSH',
        'SQLTRACE_INCREMENTAL_FLUSH_SLEEP','XE_DISPATCHER_WAIT','XE_TIMER_EVENT',
        'CHECKPOINT_QUEUE','DBMIRROR_EVENTS_QUEUE','WAIT_XTP_OFFLINE_CKPT_NEW_LOG'
      )
      AND waiting_tasks_count>0
    ORDER BY wait_time_ms DESC`,

  // Real-time snapshot: what are the currently waiting sessions blocked on RIGHT NOW?
  // Groups active waits by type so a spike of 36 waiting tasks shows root cause instantly.
  currentWaits: `
    SELECT TOP 20
      r.wait_type,
      COUNT(*)                                              AS session_count,
      AVG(r.wait_time)                                      AS avg_wait_ms,
      MAX(r.wait_time)                                      AS max_wait_ms,
      SUM(r.wait_time)                                      AS total_wait_ms,
      -- Classify severity so the UI can colour-code without knowing every wait type
      CASE
        WHEN r.wait_type LIKE 'LCK_%'                       THEN 'locking'
        WHEN r.wait_type LIKE 'PAGEIO%' OR r.wait_type LIKE 'IO_%'
          OR r.wait_type IN ('ASYNC_IO_COMPLETION','BACKUPIO','DISKIO')
                                                            THEN 'io'
        WHEN r.wait_type IN ('RESOURCE_SEMAPHORE','RESOURCE_SEMAPHORE_QUERY_COMPILE',
          'CMEMTHREAD','MEMORY_ALLOCATION_EXT')             THEN 'memory'
        WHEN r.wait_type LIKE 'PAGELATCH_%'                 THEN 'latch'
        WHEN r.wait_type LIKE 'LATCH_%'                     THEN 'latch'
        WHEN r.wait_type IN ('CXPACKET','CXCONSUMER','EXECSYNC')
                                                            THEN 'parallelism'
        WHEN r.wait_type LIKE 'NETWORK%' OR r.wait_type IN ('ASYNC_NETWORK_IO')
                                                            THEN 'network'
        WHEN r.wait_type LIKE 'LOG%' OR r.wait_type IN ('WRITELOG','LOGBUFFER')
                                                            THEN 'log_io'
        WHEN r.wait_type IN ('THREADPOOL')                  THEN 'cpu_pressure'
        ELSE                                                     'other'
      END                                                   AS category,
      -- Blocker info: non-zero when a specific session is holding a lock
      MAX(r.blocking_session_id)                            AS sample_blocker_id,
      ISNULL(MAX(DB_NAME(r.database_id)),'')                AS sample_database
    FROM sys.dm_exec_requests r
    WHERE r.session_id > 50
      AND r.wait_type IS NOT NULL AND r.wait_type <> ''
      AND r.wait_type NOT IN ('SLEEP_TASK','WAITFOR','BROKER_TO_FLUSH','SQLTRACE_BUFFER_FLUSH')
    GROUP BY r.wait_type
    ORDER BY session_count DESC, total_wait_ms DESC
    OPTION (FAST 20)`,

  dataFileIO: `
    SELECT TOP 50
      ISNULL(DB_NAME(vfs.database_id),'Unknown')                                                    AS database_name,
      ISNULL(RIGHT(mf.physical_name,CHARINDEX(N'\\',REVERSE(mf.physical_name))-1),'')              AS file_name,
      mf.type_desc AS file_type,
      vfs.io_stall_read_ms, vfs.io_stall_write_ms, vfs.io_stall,
      vfs.num_of_reads, vfs.num_of_writes,
      CAST(vfs.num_of_bytes_read/1024.0   AS FLOAT) AS kb_read,
      CAST(vfs.num_of_bytes_written/1024.0 AS FLOAT) AS kb_written
    FROM sys.dm_io_virtual_file_stats(NULL,NULL) vfs
    JOIN sys.master_files mf ON vfs.database_id=mf.database_id AND vfs.file_id=mf.file_id
    WHERE DB_NAME(vfs.database_id) IS NOT NULL
    ORDER BY vfs.io_stall DESC`,

  recentExpensive: `
    SELECT TOP 25
      ISNULL(DB_NAME(st.dbid),'')                                              AS database_name,
      qs.execution_count,
      CAST(qs.total_elapsed_time/NULLIF(qs.execution_count,0)/1000.0 AS FLOAT) AS avg_elapsed_ms,
      CAST(qs.total_elapsed_time / 1000.0 AS FLOAT)                           AS total_elapsed_ms,
      CAST(qs.total_worker_time /NULLIF(qs.execution_count,0)/1000.0  AS FLOAT) AS avg_cpu_ms,
      CAST(qs.total_worker_time / 1000.0 AS FLOAT)                            AS total_worker_time,
      CAST(qs.total_logical_reads/NULLIF(qs.execution_count,0) AS FLOAT)      AS avg_logical_reads,
      CONVERT(VARCHAR(23),qs.last_execution_time,121)                         AS last_executed,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),300) AS query_text
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count > 0
    ORDER BY qs.total_elapsed_time/qs.execution_count DESC`,

  cpuExpensive: `
    SELECT TOP 50
      ISNULL(DB_NAME(st.dbid),'')                                              AS database_name,
      qs.execution_count,
      CAST(qs.total_worker_time / 1000.0 AS FLOAT)                            AS total_worker_time,
      CAST(qs.total_worker_time / NULLIF(qs.execution_count,0) / 1000.0 AS FLOAT) AS avg_cpu_ms,
      CONVERT(VARCHAR(23),qs.last_execution_time,121)                         AS last_executed,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),150) AS query_text,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),4000) AS query_text_full,
      CASE
        WHEN st.objectid IS NULL THEN 'Unknown'
        ELSE ISNULL(OBJECT_NAME(st.objectid, st.dbid), 'Unknown')
      END                                                                      AS parent_object,
      ISNULL(OBJECT_SCHEMA_NAME(st.objectid, st.dbid),'')                      AS schema_name,
      st.objectid                                                              AS object_id,
      CASE
        WHEN st.objectid IS NULL OR OBJECT_NAME(st.objectid, st.dbid) IS NULL THEN 'Ad Hoc Query'
        WHEN ot.type_desc LIKE '%STORED_PROCEDURE' THEN 'Stored Procedure'
        WHEN ot.type_desc LIKE '%TRIGGER'          THEN 'Trigger'
        WHEN ot.type_desc LIKE '%FUNCTION'         THEN 'Function'
        ELSE 'Unknown'
      END                                                                      AS object_type
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    OUTER APPLY (
      SELECT TOP 1 t.type_desc FROM (
        SELECT type_desc FROM sys.dm_exec_procedure_stats WHERE object_id = st.objectid AND database_id = st.dbid
        UNION ALL
        SELECT type_desc FROM sys.dm_exec_trigger_stats   WHERE object_id = st.objectid AND database_id = st.dbid
        UNION ALL
        SELECT type_desc FROM sys.dm_exec_function_stats  WHERE object_id = st.objectid AND database_id = st.dbid
      ) t
    ) ot
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count > 0
    ORDER BY qs.total_worker_time DESC`,

  ioExpensive: `
    SELECT TOP 50
      ISNULL(DB_NAME(st.dbid),'')                                              AS database_name,
      qs.execution_count,
      qs.total_logical_reads,
      qs.total_physical_reads,
      CAST(qs.total_logical_reads / NULLIF(qs.execution_count,0) AS FLOAT)     AS avg_logical_reads,
      CONVERT(VARCHAR(23),qs.last_execution_time,121)                          AS last_executed,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),150) AS query_text,
      CASE
        WHEN st.objectid IS NULL THEN 'Unknown'
        ELSE ISNULL(OBJECT_NAME(st.objectid, st.dbid), 'Unknown')
      END                                                                      AS parent_object
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count > 0
    ORDER BY qs.total_logical_reads DESC`,

  tempdbUsage: `
    SELECT TOP 50
      s.session_id,
      ISNULL(s.login_name,'')                                                   AS login_name,
      ISNULL(s.host_name,'')                                                    AS host_name,
      su.user_objects_alloc_page_count                                          AS user_objects,
      su.internal_objects_alloc_page_count                                      AS internal_objects,
      (su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count) AS total_pages,
      (su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count) * 8 AS memory_kb
    FROM sys.dm_db_session_space_usage su
    JOIN sys.dm_exec_sessions s ON s.session_id = su.session_id
    WHERE su.user_objects_alloc_page_count + su.internal_objects_alloc_page_count > 0
    ORDER BY total_pages DESC`,

  missingIndexes: `
    SELECT TOP 50
      ISNULL(DB_NAME(d.database_id),'')             AS database_name,
      OBJECT_NAME(d.object_id, d.database_id)       AS table_name,
      d.equality_columns,
      d.inequality_columns,
      d.included_columns,
      gs.user_seeks,
      gs.user_scans,
      CAST(
        gs.avg_total_user_cost * gs.avg_user_impact * (gs.user_seeks + gs.user_scans)
      AS DECIMAL(18,2))                             AS estimated_improvement,
      'CREATE INDEX [' +
        LEFT(
          'IX_' + ISNULL(OBJECT_NAME(d.object_id, d.database_id),'obj') + '_' + CAST(d.index_handle AS VARCHAR(10)),
          128
        ) +
        '] ON ' + ISNULL(d.statement,'[unknown]') + ' (' +
        ISNULL(d.equality_columns, '') +
        CASE
          WHEN d.inequality_columns IS NOT NULL AND d.equality_columns IS NOT NULL THEN ','
          ELSE ''
        END +
        ISNULL(d.inequality_columns, '') + ')' +
        CASE
          WHEN d.included_columns IS NOT NULL
          THEN ' INCLUDE (' + d.included_columns + ')'
          ELSE ''
        END                                         AS create_index_sql
    FROM sys.dm_db_missing_index_details d
    JOIN sys.dm_db_missing_index_groups g
      ON g.index_handle = d.index_handle
    JOIN sys.dm_db_missing_index_group_stats gs
      ON gs.group_handle = g.index_group_handle
    WHERE d.database_id > 4
      AND OBJECTPROPERTY(d.object_id,'IsMsShipped') = 0
    ORDER BY estimated_improvement DESC`,

  activeExpensive: `
    SELECT TOP 50
      r.session_id, r.status, r.command, r.cpu_time,
      r.total_elapsed_time/1000 AS elapsed_sec,
      r.reads, r.writes, r.logical_reads,
      ISNULL(r.wait_type,'')              AS wait_type,
      ISNULL(r.wait_time,0)               AS wait_time,
      ISNULL(r.blocking_session_id,0)     AS blocking_session_id,
      ISNULL(DB_NAME(r.database_id),'')   AS database_name,
      LEFT(ISNULL(SUBSTRING(st.text,
        (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE r.statement_end_offset END - r.statement_start_offset)/2)+1),''),300) AS query_text
    FROM sys.dm_exec_requests r
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
    WHERE r.session_id != @@SPID AND r.session_id > 50
    ORDER BY r.total_elapsed_time DESC
    OPTION (FAST 50)`,

  blocking: `
    SELECT TOP 50
      bc.session_id                                                        AS blocked_session_id,
      bc.blocking_session_id,
      ISNULL(bs.login_name,'')                                             AS blocker_login,
      ISNULL(bs.host_name,'')                                              AS blocker_host,
      ISNULL(bs.program_name,'')                                           AS blocker_program,
      ISNULL(bc_s.login_name,'')                                           AS blocked_login,
      ISNULL(bc_s.host_name,'')                                            AS blocked_host,
      bc.wait_type, bc.wait_time,
      bc.total_elapsed_time/1000                                           AS elapsed_sec,
      ISNULL(DB_NAME(bc.database_id),'')                                   AS database_name,
      LEFT(ISNULL(SUBSTRING(bt.text,
        (ISNULL(br.statement_start_offset,0)/2)+1,
        ((CASE ISNULL(br.statement_end_offset,-1) WHEN -1 THEN DATALENGTH(bt.text)
          ELSE br.statement_end_offset END - ISNULL(br.statement_start_offset,0))/2)+1),''),300) AS blocker_query,
      LEFT(ISNULL(SUBSTRING(t.text,
        (ISNULL(bc.statement_start_offset,0)/2)+1,
        ((CASE ISNULL(bc.statement_end_offset,-1) WHEN -1 THEN DATALENGTH(t.text)
          ELSE bc.statement_end_offset END - ISNULL(bc.statement_start_offset,0))/2)+1),''),300) AS blocked_query,
      CASE
        WHEN t.objectid IS NULL THEN 'Unknown'
        ELSE ISNULL(OBJECT_NAME(t.objectid, t.dbid), 'Unknown')
      END                                                                  AS parent_object
    FROM sys.dm_exec_requests bc
    JOIN  sys.dm_exec_sessions bc_s ON bc.session_id          = bc_s.session_id
    LEFT JOIN sys.dm_exec_sessions bs  ON bc.blocking_session_id = bs.session_id
    LEFT JOIN sys.dm_exec_requests br  ON bc.blocking_session_id = br.session_id
    OUTER APPLY sys.dm_exec_sql_text(bc.sql_handle) t
    OUTER APPLY sys.dm_exec_sql_text(br.sql_handle) bt
    WHERE bc.blocking_session_id > 0 AND bc.session_id > 50
    ORDER BY bc.wait_time DESC
    OPTION (FAST 50)`,

  deadlocks: `
    SELECT TOP 25
      CONVERT(VARCHAR(23), xdr.value('@timestamp','datetime2(0)'),121)         AS deadlock_time,
      dg.value('count(deadlock/process-list/process)','int')                   AS process_count,
      LEFT(ISNULL(dg.value('(deadlock/process-list/process[1]/@spid)[1]','nvarchar(10)'),'')+','+
           ISNULL(dg.value('(deadlock/process-list/process[2]/@spid)[1]','nvarchar(10)'),''),50) AS spids,
      LEFT(ISNULL(dg.value('(deadlock/process-list/process[1]/@loginname)[1]','nvarchar(100)'),''),100) AS login1,
      LEFT(ISNULL(dg.value('(deadlock/process-list/process[1]/@hostname)[1]','nvarchar(100)'),''),100)  AS host1,
      LEFT(ISNULL(dg.value('(deadlock/process-list/process[1]/executionStack/frame[1])[1]','nvarchar(300)'),''),200) AS query1,
      LEFT(ISNULL(dg.value('(deadlock/process-list/process[2]/executionStack/frame[1])[1]','nvarchar(300)'),''),200) AS query2,
      LEFT(ISNULL(dg.value('(deadlock/resource-list/*[1]/@objectname)[1]','nvarchar(200)'),''),150)     AS resource_name,
      LEFT(ISNULL(dg.value('(deadlock/resource-list/*[1]/@mode)[1]','nvarchar(50)'),''),50)             AS lock_mode
    FROM (
      SELECT CAST(target_data AS XML) AS target_data
      FROM sys.dm_xe_session_ring_buffer_targets t
      JOIN sys.dm_xe_sessions s ON t.event_session_address = s.address
      WHERE s.name = 'system_health'
    ) AS data
    CROSS APPLY target_data.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS xe(xdr)
    CROSS APPLY (SELECT xdr.query('data[@name="xml_report"]/value/deadlock')) AS dg_table(dg)
    ORDER BY deadlock_time DESC`,

  serverPerf: `
    SELECT
      CAST(pm.physical_memory_in_use_kb AS FLOAT) / 1048576.0 AS sql_mem_gb,
      -- Single scan of sys.dm_os_performance_counters via MAX(CASE WHEN) pivot
      MAX(CASE WHEN c.counter_name='Total Server Memory (KB)'    AND c.object_name LIKE '%Memory Manager%'   THEN CAST(c.cntr_value AS FLOAT)/1048576.0 END) AS sql_total_mem_gb,
      MAX(CASE WHEN c.counter_name='Target Server Memory (KB)'   AND c.object_name LIKE '%Memory Manager%'   THEN CAST(c.cntr_value AS FLOAT)/1048576.0 END) AS sql_target_mem_gb,
      MAX(CASE WHEN c.counter_name='Page life expectancy'        AND c.object_name LIKE '%Buffer Manager%'   THEN CAST(c.cntr_value AS FLOAT) END)           AS ple_sec,
      MAX(CASE WHEN c.counter_name='User Connections'            AND c.object_name LIKE '%General Statistics%' THEN CAST(c.cntr_value AS FLOAT) END)          AS user_connections,
      MAX(CASE WHEN c.counter_name='SQL Compilations/sec'        AND c.object_name LIKE '%SQL Statistics%'   THEN CAST(c.cntr_value AS FLOAT) END)            AS compilations_sec,
      MAX(CASE WHEN c.counter_name='SQL Re-Compilations/sec'     AND c.object_name LIKE '%SQL Statistics%'   THEN CAST(c.cntr_value AS FLOAT) END)            AS recompilations_sec,
      ISNULL(
        MAX(CASE WHEN c.counter_name='Buffer cache hit ratio'      AND c.object_name LIKE '%Buffer Manager%' THEN CAST(c.cntr_value AS FLOAT) END) /
        NULLIF(MAX(CASE WHEN c.counter_name='Buffer cache hit ratio base' AND c.object_name LIKE '%Buffer Manager%' THEN CAST(c.cntr_value AS FLOAT) END), 0)
        * 100.0, 0)                                                                                                                                            AS buffer_cache_hit_ratio,
      ISNULL(MAX(CASE WHEN c.counter_name='Memory Grants Pending' AND c.object_name LIKE '%Memory Manager%' THEN CAST(c.cntr_value AS FLOAT) END), 0)         AS memory_grants_pending,
      ISNULL((SELECT CAST(SUM(
         (CAST(num_reads AS BIGINT) + CAST(num_writes AS BIGINT)) *
          CAST(ISNULL(NULLIF(net_packet_size,0), 4096) AS BIGINT)
       ) AS FLOAT) FROM sys.dm_exec_connections), 0)                                                                                                           AS net_bytes_total
    FROM sys.dm_os_process_memory pm
    CROSS JOIN sys.dm_os_performance_counters c
    WHERE c.counter_name IN (
      'Total Server Memory (KB)', 'Target Server Memory (KB)',
      'Page life expectancy', 'User Connections',
      'SQL Compilations/sec', 'SQL Re-Compilations/sec',
      'Buffer cache hit ratio', 'Buffer cache hit ratio base',
      'Memory Grants Pending'
    )
    GROUP BY pm.physical_memory_in_use_kb`,

  jobs: `
    SELECT TOP 100
      CAST(j.job_id AS VARCHAR(36))                                       AS job_id_str,
      j.name                                                               AS job_name,
      j.enabled,
      CASE
        WHEN ja.start_execution_date IS NOT NULL
         AND ja.stop_execution_date  IS NULL  THEN 'Running'
        WHEN last_run.run_status = 0           THEN 'Failed'
        WHEN last_run.run_status = 1           THEN 'Succeeded'
        WHEN last_run.run_status = 2           THEN 'Retry'
        WHEN last_run.run_status = 3           THEN 'Cancelled'
        WHEN j.enabled = 0                     THEN 'Disabled'
        ELSE                                        'Idle'
      END                                                                  AS status,
      ISNULL(DATEDIFF(SECOND, ja.start_execution_date, GETDATE()), 0)     AS running_sec,
      ISNULL(last_run.run_duration, 0)                                     AS last_run_duration,
      CASE WHEN last_run.run_date IS NOT NULL THEN
        CONVERT(VARCHAR(23),
          DATEADD(SECOND,
            (last_run.run_time / 10000) * 3600
            + ((last_run.run_time % 10000) / 100) * 60
            + (last_run.run_time % 100),
            CONVERT(DATETIME, CAST(last_run.run_date AS VARCHAR(8)), 112)
          ), 121)
      END                                                                  AS last_run_date,
      CONVERT(VARCHAR(23), ja.next_scheduled_run_date, 121)               AS next_run_date
    FROM msdb.dbo.sysjobs j
    LEFT JOIN msdb.dbo.sysjobactivity ja
      ON j.job_id = ja.job_id
     AND ja.session_id = (SELECT MAX(session_id) FROM msdb.dbo.sysjobactivity)
    LEFT JOIN (
      SELECT job_id, run_status, run_duration, run_date, run_time,
             ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY run_date DESC, run_time DESC) AS rn
      FROM msdb.dbo.sysjobhistory
      WHERE step_id = 0
        AND run_date >= CONVERT(INT, CONVERT(VARCHAR(8), DATEADD(DAY,-30,GETDATE()), 112))
    ) last_run ON j.job_id = last_run.job_id AND last_run.rn = 1
    ORDER BY
      CASE
        WHEN ja.start_execution_date IS NOT NULL AND ja.stop_execution_date IS NULL THEN 0
        WHEN last_run.run_status = 0 THEN 1
        ELSE 2
      END, j.name`,

  dbSizes: `
    SELECT TOP 50
      DB_NAME(mf.database_id)                                      AS database_name,
      CAST(SUM(CAST(mf.size AS BIGINT)) * 8.0 * 1024 AS FLOAT)    AS allocated_bytes,
      CAST(MIN(vs.total_bytes)      AS FLOAT)                      AS volume_total_bytes,
      CAST(MIN(vs.available_bytes)  AS FLOAT)                      AS volume_available_bytes,
      MIN(vs.volume_mount_point)                                   AS volume_mount_point
    FROM sys.master_files mf
    CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs
    WHERE mf.database_id > 0
      AND DB_NAME(mf.database_id) IS NOT NULL
    GROUP BY DB_NAME(mf.database_id)
    ORDER BY MIN(vs.volume_mount_point), allocated_bytes DESC`,

  // ── Drive space monitoring (one row per logical volume hosting SQL files) ──
  diskDrives: `
    SELECT
      v.volume_mount_point,
      -- MAX/MIN aggregate over all files on this volume.
      -- dm_os_volume_stats queries the OS live per file, so available_bytes can
      -- differ by a few bytes between calls on the same volume.  Grouping by
      -- total_bytes + available_bytes would produce duplicate rows for the same
      -- physical volume; grouping by mount_point only gives exactly one row.
      CAST(MAX(v.total_bytes)     AS FLOAT) AS total_bytes,
      CAST(MIN(v.available_bytes) AS FLOAT) AS available_bytes,
      CAST(MAX(v.total_bytes) - MIN(v.available_bytes) AS FLOAT) AS used_bytes,
      CAST(100.0 * (MAX(v.total_bytes) - MIN(v.available_bytes))
           / NULLIF(CAST(MAX(v.total_bytes) AS FLOAT), 0) AS DECIMAL(5,1)) AS used_pct,
      CAST(100.0 * MIN(v.available_bytes)
           / NULLIF(CAST(MAX(v.total_bytes) AS FLOAT), 0) AS DECIMAL(5,1)) AS free_pct,
      MAX(CASE WHEN mf.database_id = 2                              THEN 1 ELSE 0 END) AS has_tempdb,
      MAX(CASE WHEN mf.type_desc   = 'LOG'                          THEN 1 ELSE 0 END) AS has_log,
      MAX(CASE WHEN mf.type_desc   = 'ROWS' AND mf.database_id <> 2 THEN 1 ELSE 0 END) AS has_data,
      COUNT(DISTINCT mf.database_id) AS database_count,
      COUNT(mf.file_id)              AS file_count
    FROM sys.master_files mf
    CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) v
    WHERE mf.state = 0
    GROUP BY v.volume_mount_point
    ORDER BY v.volume_mount_point`,

  backupHealth: `
    SELECT
      d.name                                                        AS database_name,
      d.recovery_model_desc,
      MAX(CASE WHEN bs.type = 'D' THEN bs.backup_finish_date END)  AS last_full,
      MAX(CASE WHEN bs.type = 'I' THEN bs.backup_finish_date END)  AS last_diff,
      MAX(CASE WHEN bs.type = 'L' THEN bs.backup_finish_date END)  AS last_log
    FROM sys.databases d
    LEFT JOIN msdb.dbo.backupset bs
      ON  bs.database_name = d.name
      AND bs.backup_finish_date > DATEADD(DAY, -60, GETDATE())
    WHERE d.database_id > 4
      AND d.state = 0
    GROUP BY d.name, d.recovery_model_desc
    ORDER BY d.name`,
};

async function collectMetrics(pool, prevIO, prevNet) {
  const req = () => pool.request();
  const [cpuR, ovR, ioR, procR, waitR, curWaitR, fileR, recentR, activeR, dbSizesR, blockingR, deadlocksR, perfR, jobsR, diskR, backupHealthR, cpuExpensiveR, tempdbR, ioExpensiveR] = await Promise.all([
    req().query(Q.cpu),
    req().query(Q.overview),
    req().query(Q.ioSnapshot),
    req().query(Q.processes),
    req().query(Q.resourceWaits),
    req().query(Q.currentWaits).catch(() => ({ recordset: [] })),
    req().query(Q.dataFileIO),
    req().query(Q.recentExpensive),
    req().query(Q.activeExpensive),
    req().query(Q.dbSizes),
    req().query(Q.blocking),
    req().query(Q.deadlocks).catch(() => ({ recordset: [] })),
    req().query(Q.serverPerf).catch(err => { console.error('[serverPerf]', err.message); return { recordset: [] }; }),
    req().query(Q.jobs).catch(err => { console.error('[jobs]', err.message); return { recordset: [] }; }),
    req().query(Q.diskDrives).catch(err => { console.error('[diskDrives]', err.message); return { recordset: [] }; }),
    req().query(Q.backupHealth).catch(err => { console.error('[backupHealth]', err.message); return { recordset: [] }; }),
    req().query(Q.cpuExpensive).catch(err => { console.error('[cpuExpensive]', err.message); return { recordset: [] }; }),
    req().query(Q.tempdbUsage).catch(err => { console.error('[tempdbUsage]', err.message); return { recordset: [] }; }),
    req().query(Q.ioExpensive).catch(err => { console.error('[ioExpensive]', err.message); return { recordset: [] }; }),
  ]);

  // ── Supplement diskDrives with OS drives that have no SQL files ───────────────
  let diskDrives = diskR.recordset.slice()
  try {
    const sqlLetters = new Set(diskR.recordset.map(d =>
      (d.volume_mount_point || '').charAt(0).toUpperCase()
    ))
    let extraRows = null
    try {
      // SQL Server 2019+: sys.dm_os_enumerate_fixed_drives has total + free
      const r = await req().query(`
        SELECT fixed_drive_path AS mp,
               CAST(free_space_in_bytes  AS FLOAT) AS avail,
               CAST(total_space_in_bytes AS FLOAT) AS total
        FROM sys.dm_os_enumerate_fixed_drives WHERE drive_type_desc = N'FIXED'`)
      extraRows = r.recordset.map(d => ({
        letter: (d.mp || '').charAt(0).toUpperCase(),
        mp:     (d.mp || '').replace(/\\*$/, '') + '\\',
        avail:  d.avail || 0,
        total:  d.total || 0,
      }))
    } catch {
      // SQL 2012-2017 fallback: xp_fixeddrives (free MB only, no total)
      try {
        const r2 = await req().query('EXEC xp_fixeddrives')
        extraRows = r2.recordset.map(d => ({
          letter: (d.drive || '').toUpperCase(),
          mp:     (d.drive || '').toUpperCase() + ':\\',
          avail:  (d['MB free'] || 0) * 1048576,
          total:  0,
        }))
      } catch {}
    }
    if (extraRows) {
      for (const v of extraRows) {
        if (sqlLetters.has(v.letter)) continue
        const used = v.total > 0 ? v.total - v.avail : null
        diskDrives.push({
          volume_mount_point: v.mp,
          total_bytes:        v.total,
          available_bytes:    v.avail,
          used_bytes:         used,
          used_pct:           v.total > 0 ? parseFloat((100.0 * (v.total - v.avail) / v.total).toFixed(1)) : null,
          free_pct:           v.total > 0 ? parseFloat((100.0 * v.avail / v.total).toFixed(1)) : null,
          has_tempdb: 0, has_log: 0, has_data: 0, database_count: 0, file_count: 0,
        })
      }
    }
  } catch (err) {
    console.error('[diskDrives extra]', err.message)
  }

  const cpu      = cpuR.recordset[0] || {};
  const ov       = ovR.recordset[0]  || {};
  const currBytes = ioR.recordset[0]?.total_bytes || 0;
  const now      = Date.now();

  let dbIOMb = 0;
  if (prevIO) {
    const delta = currBytes - prevIO.bytes;
    const secs  = (now - prevIO.time) / 1000;
    dbIOMb = secs > 0 ? Math.max(0, delta / secs / (1024 * 1024)) : 0;
  }

  const perf = perfR.recordset[0] || {};
  if (!perfR.recordset[0]) console.warn('[serverPerf] empty recordset – query may have failed silently');

  const currNetBytes  = perf.net_bytes_total  || 0;
  let netMbs = 0;
  if (prevNet) {
    const delta = currNetBytes - prevNet.bytes;
    const secs  = (now - prevNet.time) / 1000;
    netMbs = secs > 0 ? Math.max(0, delta / secs / (1024 * 1024)) : 0;
  }

  const sqlMemGb      = perf.sql_mem_gb       || 0;
  const sqlTotalMemGb = perf.sql_total_mem_gb || 0;
  const sqlTargetMemGb= perf.sql_target_mem_gb|| 0;
  // sqlMemPct: committed / target × 100
  const sqlMemPct = sqlTargetMemGb > 0
    ? parseFloat(((sqlTotalMemGb / sqlTargetMemGb) * 100).toFixed(1))
    : 0;

  return {
    timestamp:       now,
    cpu_percent:     cpu.cpu_percent  || 0,
    waiting_tasks:   ov.waiting_tasks  || 0,
    db_io_mb:        parseFloat(dbIOMb.toFixed(2)),
    batch_requests:  ov.batch_requests || 0,
    processes:       procR.recordset,
    resourceWaits:   waitR.recordset,
    currentWaits:    curWaitR.recordset,
    dataFileIO:      fileR.recordset,
    recentExpensive: recentR.recordset,
    activeExpensive: activeR.recordset,
    dbSizes:         dbSizesR.recordset,
    blocking:        blockingR.recordset,
    deadlocks:       deadlocksR.recordset,
    serverPerf: {
      sqlMemPct,
      sqlMemGb:          parseFloat(sqlMemGb.toFixed(2)),
      sqlTotalMemGb:     parseFloat(sqlTotalMemGb.toFixed(2)),
      sqlTargetMemGb:    parseFloat(sqlTargetMemGb.toFixed(2)),
      pleSec:            Math.round(perf.ple_sec          || 0),
      userConns:         Math.round(perf.user_connections || 0),
      compilationsSec:   Math.round(perf.compilations_sec || 0),
      recompilationsSec: Math.round(perf.recompilations_sec || 0),
      netMbs:            parseFloat(netMbs.toFixed(2)),
      bufferCacheHit:    parseFloat((perf.buffer_cache_hit_ratio || 0).toFixed(1)),
      memGrantsPending:  Math.round(perf.memory_grants_pending || 0),
    },
    jobs:            jobsR.recordset,
    diskDrives:      diskDrives,
    backupHealth:    backupHealthR.recordset,
    cpuExpensive:    cpuExpensiveR.recordset,
    tempdbUsage:     tempdbR.recordset,
    ioExpensive:     ioExpensiveR.recordset,
    _prevIO:  { bytes: currBytes,    time: now },
    _prevNet: { bytes: currNetBytes, time: now },
  };
}

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    defaultServer:   process.env.DB_SERVER   || '',
    defaultAuthType: process.env.AUTH_TYPE   || 'windows',
    defaultDb:       process.env.DB_NAME     || 'master',
  });
});

app.get('/api/connections', (_req, res) => {
  const list = [...connections.entries()].map(([id, c]) => ({
    id, label: c.label, server: c.server, database: c.database,
    color: c.color, appIntent: c.appIntent,
  }));
  res.json(list);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

app.post('/api/connect', async (req, res) => {
  try {
    const { server, label, database, color, appIntent, _clientId } = req.body;
    if (!server) return res.status(400).json({ error: 'Server is required.' });

    const config = buildConfig(req.body);
    const pool   = await new sql.ConnectionPool(config).connect();
    // Set session-level guardrails: dashboard is lowest-priority loser in deadlock graph,
    // never waits >2s on a lock, and aborts immediately on error.
    await pool.request().batch(
      'SET DEADLOCK_PRIORITY LOW; SET LOCK_TIMEOUT 2000; SET XACT_ABORT ON;'
    ).catch(e => console.warn('[session-init]', e.message));

    // History identity: @@SERVERNAME survives IP/DNS/connection-string changes.
    let instanceKey = server;
    try {
      const r = await pool.request().query('SELECT @@SERVERNAME AS name');
      if (r.recordset?.[0]?.name) instanceKey = r.recordset[0].name;
    } catch (e) {
      console.warn('[metrics-db] @@SERVERNAME failed, using profile server string:', e.message);
    }

    // Honour client-supplied stable ID so the browser can reconnect without
    // Dashboard remounting (key stays the same). Validate UUID format to be safe.
    // If an old connection with this ID is still alive, evict it first.
    let id = (typeof _clientId === 'string' && UUID_RE.test(_clientId)) ? _clientId : randomUUID();
    if (connections.has(id)) {
      const old = connections.get(id);
      clearInterval(old.handle);
      clearInterval(old.snapshotHandle);
      try { await old.pool.close(); } catch {}
      connections.delete(id);
    }

    pool.on('error', err => {
      io.to(`conn:${id}`).emit('connectionStatusChanged', {
        connectionId: id, status: 'disconnected', error: err.message,
      });
    });

    const displayLabel = label?.trim() || server;

    const conn = {
      pool, label: displayLabel, server, instanceKey,
      database:  database  || 'master',
      color:     color     || '#3b82f6',
      appIntent: appIntent || 'ReadWrite',
      handle: null, prevIO: null, prevNet: null,
    };
    connections.set(id, conn);

    // Start polling
    const poll = async (refreshRequestId = null) => {
      const c = connections.get(id);
      if (!c) return;
      try {
        const metrics = await collectMetrics(c.pool, c.prevIO, c.prevNet);
        c.prevIO  = metrics._prevIO;  delete metrics._prevIO;
        c.prevNet = metrics._prevNet; delete metrics._prevNet;
        metricsStore.insertSnapshot(c.instanceKey, c.label, metrics);
        io.to(`conn:${id}`).emit('metricsUpdated', {
          connectionId: id, refreshRequestId, metrics, timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`[${displayLabel}] Poll error:`, err.message);
        io.to(`conn:${id}`).emit('refreshFailed', {
          connectionId: id, refreshRequestId, reason: err.message,
        });
      }
    };

    await poll();
    conn.poll   = poll;
    conn.handle = setInterval(poll, POLL_MS);

    // Take initial DB size snapshot and schedule daily re-check
    const serverKey = server;
    takeDbSizeSnapshot(pool, serverKey).catch(() => {});
    conn.snapshotHandle = setInterval(() => {
      const c = connections.get(id);
      if (!c) { clearInterval(conn.snapshotHandle); return; }
      takeDbSizeSnapshot(c.pool, serverKey).catch(() => {});
    }, 60 * 60 * 1000);   // check hourly — actually snapshots once per day

    console.log(`+ Connected: ${displayLabel} [${id.slice(0,8)}] ${appIntent||'ReadWrite'}`);
    res.json({ id, label: displayLabel, server, database: database || 'master', color: color || '#3b82f6', appIntent: appIntent || 'ReadWrite' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/disconnect/:id', async (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  clearInterval(conn.handle);
  clearInterval(conn.snapshotHandle);
  try { await conn.pool.close(); } catch {}
  connections.delete(req.params.id);
  missingIndexCache.delete(req.params.id);
  io.to(`conn:${req.params.id}`).emit('serverRemoved', { connectionId: req.params.id });
  console.log(`- Disconnected: ${conn.label} [${req.params.id.slice(0,8)}]`);
  res.json({ ok: true });
});

app.post('/api/refresh/all', (req, res) => {
  const refreshRequestId = typeof req.body?.refreshRequestId === 'string'
    ? req.body.refreshRequestId : null;
  for (const [, c] of connections) {
    if (c.poll) c.poll(refreshRequestId);
  }
  res.status(204).end();
});

app.post('/api/refresh/:id', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const refreshRequestId = typeof req.body?.refreshRequestId === 'string'
    ? req.body.refreshRequestId : null;
  if (conn.poll) conn.poll(refreshRequestId);
  res.status(204).end();
});

app.post('/api/connections/:id/kill-sleeping', async (req, res) => {
  if (process.env.ALLOW_KILL !== 'true') {
    return res.status(403).json({ error: 'Kill disabled. Set ALLOW_KILL=true in .env to enable.' });
  }
  const conn = requireConn(req, res);
  if (!conn) return;
  try {
    const result = await conn.pool.request().query(`
      SELECT session_id FROM sys.dm_exec_sessions
      WHERE is_user_process=1 AND status='sleeping' AND session_id > 50`);
    const ids = result.recordset.map(r => r.session_id);
    if (ids.length === 0) return res.json({ killed: 0 });
    await Promise.allSettled(ids.map(sid =>
      conn.pool.request().query(`KILL ${sid}`)
    ));
    console.log(`[${conn.label}] Killed ${ids.length} sleeping sessions`);
    res.json({ killed: ids.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/connections/:id/kill', async (req, res) => {
  if (process.env.ALLOW_KILL !== 'true') {
    return res.status(403).json({ error: 'Kill disabled. Set ALLOW_KILL=true in .env to enable.' });
  }
  const conn = requireConn(req, res);
  if (!conn) return;
  const sessionId = parseInt(req.body.sessionId, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0 || sessionId > 32767) {
    return res.status(400).json({ error: 'Invalid session ID.' });
  }
  try {
    await conn.pool.request().query(`KILL ${sessionId}`);
    console.log(`[${conn.label}] Killed session ${sessionId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/connections/:id/whoIsActive', async (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  try {
    const req30 = conn.pool.request()
    req30.timeout = 30000
    const result = await req30.query(`
      EXEC sp_WhoIsActive
        @filter = '', @filter_type = 'session', @not_filter = '', @not_filter_type = 'session',
        @show_own_spid = 0, @show_system_spids = 0, @show_sleeping_spids = 1,
        @get_full_inner_text = 1, @get_plans = 0, @get_outer_command = 1,
        @get_transaction_info = 0, @get_task_info = 1, @get_locks = 0,
        @get_avg_time = 0, @get_additional_info = 0, @find_block_leaders = 0,
        @delta_interval = 0,
        @output_column_list = '[dd%][session_id][block%][sql_text][sql_command][login_name][wait_info][tasks][tran_log%][cpu%][temp%][block%][reads%][writes%][context%][physical%][locks][%]',
        @sort_order = '[start_time] ASC', @format_output = 1,
        @destination_table = '', @return_schema = 0, @schema = NULL, @help = 0
    `);
    const rows = (result.recordset || []).map(r => {
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        if (Buffer.isBuffer(v)) {
          out[k] = v.toString('utf8');
        } else if (v !== null && v !== undefined && typeof v === 'object' && !(v instanceof Date)) {
          out[k] = String(v);
        } else {
          out[k] = v;
        }
      }
      return out;
    });
    res.json({ rows, ts: Date.now() });
  } catch (err) {
    console.error('[WhoIsActive]', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/connections/:id/jobs/:action', async (req, res) => {
  if (process.env.ALLOW_JOB_CONTROL !== 'true') {
    return res.status(403).json({ error: 'Job control disabled. Set ALLOW_JOB_CONTROL=true in .env to enable.' });
  }
  const conn = requireConn(req, res);
  if (!conn) return;
  const { action } = req.params;
  if (action !== 'start' && action !== 'stop')
    return res.status(400).json({ error: 'Invalid action. Must be start or stop.' });
  const { jobName } = req.body;
  if (!jobName || typeof jobName !== 'string' || jobName.length > 256)
    return res.status(400).json({ error: 'Invalid job name.' });
  try {
    const proc = action === 'start' ? 'sp_start_job' : 'sp_stop_job';
    await conn.pool.request()
      .input('jn', sql.NVarChar(256), jobName)
      .query(`EXEC msdb.dbo.${proc} @job_name = @jn`);
    console.log(`[${conn.label}] ${action === 'start' ? 'Started' : 'Stopped'} job: ${jobName}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/connections/:id/db-size-history', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const history = loadDbHistory();
  const serverData = history[conn.server] || {};
  res.json(serverData);
});

// ─── Metrics history (SQLite persistence) ─────────────────────────────────────
const MAX_HISTORY_SPAN_MS = 90 * 24 * 3600 * 1000;

app.get('/api/connections/:id/history', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const range = parseHistoryRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid from/to — positive epoch-ms integers with from < to.' });
  if (range.to - range.from > MAX_HISTORY_SPAN_MS) {
    return res.status(400).json({ error: 'range too large (max 90 days)' });
  }
  const resolution = req.query.resolution || 'auto';
  if (!VALID_RESOLUTIONS.includes(resolution)) return res.status(400).json({ error: 'Invalid resolution.' });
  res.json(metricsStore.getHistory(conn.instanceKey || conn.server, range.from, range.to, resolution));
});

app.get('/api/connections/:id/history/waits', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const range = parseHistoryRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid from/to — positive epoch-ms integers with from < to.' });
  if (range.to - range.from > MAX_HISTORY_SPAN_MS) {
    return res.status(400).json({ error: 'range too large (max 90 days)' });
  }
  res.json(metricsStore.getWaitHistory(conn.instanceKey || conn.server, range.from, range.to));
});

app.get('/api/connections/:id/history/blocking', (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  const range = parseHistoryRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid from/to — positive epoch-ms integers with from < to.' });
  if (range.to - range.from > MAX_HISTORY_SPAN_MS) {
    return res.status(400).json({ error: 'range too large (max 90 days)' });
  }
  res.json(metricsStore.getBlockingHistory(conn.instanceKey || conn.server, range.from, range.to));
});

// ─── Alerts + baselines API ───────────────────────────────────────────────────
app.get('/api/connections/:id/alerts', (req, res) => {
  const c = requireConn(req, res);
  if (!c) return;
  if (req.query.active === '1') {
    return res.json({ alerts: metricsStore.getAlerts(c.instanceKey || c.server, { activeOnly: true }) });
  }
  const range = parseHistoryRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid from/to — positive epoch-ms integers with from < to.' });
  if (range.to - range.from > MAX_HISTORY_SPAN_MS) {
    return res.status(400).json({ error: 'range too large (max 90 days)' });
  }
  res.json({ alerts: metricsStore.getAlerts(c.instanceKey || c.server, { from: range.from, to: range.to }) });
});

app.post('/api/connections/:id/alerts/:alertId/ack', (req, res) => {
  const c = requireConn(req, res);
  if (!c) return;
  const alertId = parseAlertId(req.params.alertId);
  if (alertId == null) return res.status(400).json({ error: 'Invalid alert id' });
  const ok = metricsStore.ackAlert(c.instanceKey || c.server, alertId, Date.now());
  if (!ok) return res.status(404).json({ error: 'Alert not found' });
  res.json({ ok: true });
});

app.get('/api/connections/:id/baselines', (req, res) => {
  const c = requireConn(req, res);
  if (!c) return;
  const kpi = parseKpi(req.query.kpi);
  if (!kpi) return res.status(400).json({ error: 'Invalid kpi' });
  res.json({ kpi, baselines: metricsStore.getBaselines(c.instanceKey || c.server, kpi) });
});

app.get('/api/persistence/status', (_req, res) => {
  res.json(metricsStore.health());
});

app.get('/api/connections/:id/error-log', async (req, res) => {
  const conn = requireConn(req, res);
  if (!conn) return;
  try {
    const r = await conn.pool.request().query(`
      SELECT TOP 50
        DATEADD(ms, -1 * (osi.ms_ticks - rbf.timestamp), GETDATE())            AS event_time,
        rbf.record.value('(./Record/Exception/Error)[1]',     'int')            AS error_number,
        rbf.record.value('(./Record/Exception/Severity)[1]',  'int')            AS severity,
        rbf.record.value('(./Record/Exception/State)[1]',     'int')            AS state,
        COALESCE(
          NULLIF(rbf.record.value('(./Record/Exception/Message)[1]', 'nvarchar(4000)'), ''),
          (SELECT TOP 1 text FROM sys.messages
           WHERE message_id = rbf.record.value('(./Record/Exception/Error)[1]', 'int')
             AND language_id = 1033)
        )                                                                        AS message
      FROM (
        SELECT timestamp, CAST(record AS XML) AS record
        FROM sys.dm_os_ring_buffers
        WHERE ring_buffer_type = N'RING_BUFFER_EXCEPTION'
      ) rbf
      CROSS JOIN (SELECT ms_ticks FROM sys.dm_os_sys_info) osi
      WHERE rbf.record.value('(./Record/Exception/Severity)[1]', 'int') >= 17
        AND DATEADD(ms, -1 * (osi.ms_ticks - rbf.timestamp), GETDATE())
            > DATEADD(HOUR, -24, GETDATE())
      ORDER BY event_time DESC
    `);
    res.json({ rows: r.recordset || [], ts: Date.now() });
  } catch (err) {
    console.error('[error-log]', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/connections/:id/missing-indexes', async (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return
  const force = req.query.force === '1'
  const ttlMinutes = Math.round(MISSING_INDEX_CACHE_MS / 60000)
  const cached = missingIndexCache.get(req.params.id)
  if (!force && cached && Date.now() < cached.expiresAt) {
    return res.json({ rows: cached.rows, count: cached.rows.length, ts: cached.ts, cached: true, ttlMinutes })
  }
  try {
    const result = await conn.pool.request().query(Q.missingIndexes)
    const rows = result.recordset
    const ts = new Date().toISOString()
    missingIndexCache.set(req.params.id, { rows, ts, expiresAt: Date.now() + MISSING_INDEX_CACHE_MS })
    res.json({ rows, count: rows.length, ts, cached: false, ttlMinutes })
  } catch (err) {
    console.error('[missing-indexes]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Index Health API ─────────────────────────────────────────────────────────
const VALID_SCAN_MODES = new Set(['LIMITED', 'SAMPLED', 'DETAILED'])

app.post('/api/connections/:id/index-health/scan', async (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const { mode = 'LIMITED', databases = [] } = req.body
  if (!VALID_SCAN_MODES.has(mode)) {
    return res.status(400).json({ error: 'Invalid mode. Must be LIMITED, SAMPLED, or DETAILED.' })
  }

  const existing = scanStore.getActiveScanByConn(req.params.id)
  if (existing) {
    return res.status(409).json({ error: 'Scan already in progress.', scanId: existing.scanId })
  }

  const scanId = randomUUID()
  const dbs    = Array.isArray(databases) && databases.length > 0 ? databases : []
  scanStore.create(scanId, req.params.id, mode, dbs)

  runScan(conn.pool, scanId, scanStore)
    .catch(err => console.error(`[index-health] runScan error ${scanId.slice(0, 8)}:`, err.message))

  res.status(202).json({ scanId })
})

app.get('/api/connections/:id/index-health/scan/:scanId/progress', (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const scan = scanStore.get(req.params.scanId)
  if (!scan || scan.connId !== req.params.id) {
    return res.status(404).json({ error: 'Scan not found.' })
  }

  const pct = calcProgressPct(scan.completedWeight, scan.totalWeight)

  let eta = null
  if (pct > 5 && pct < 100) {
    const elapsed = Date.now() - scan.createdAt
    eta = Math.round((elapsed / pct) * (100 - pct) / 1000)
  }

  res.json({
    scanId:       scan.scanId,
    status:       scan.status,
    pct:          Math.round(pct),
    currentDb:    scan.currentDb,
    completedDbs: scan.completedDbs.length,
    totalDbs:     scan.totalDbs,
    timedOutDbs:  scan.timedOutDbs,
    eta,
  })
})

app.get('/api/connections/:id/index-health/scan/:scanId/results', (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const scan = scanStore.get(req.params.scanId)
  if (!scan || scan.connId !== req.params.id) {
    return res.status(404).json({ error: 'Scan not found or expired.' })
  }

  if (scan.status === 'pending' || scan.status === 'running') {
    return res.status(202).json({ error: 'Scan still in progress.', status: scan.status })
  }

  if (scan.status === 'failed') {
    return res.status(400).json({ error: scan.error || 'Scan failed.', status: 'failed' })
  }

  const { tab = 'fragmented', page = '1', pageSize = '50', db, search, rowType } = req.query
  const pgOpts = { page: parseInt(page, 10) || 1, pageSize: parseInt(pageSize, 10) || 50, db, search, rowType }
  const results = scan.results || { fragmented: [], missing: [], unused: [], duplicate: [], summary: {} }

  const unusedAndDuplicate = [
    ...results.unused.map(r => ({ ...r, _rowType: 'unused' })),
    ...results.duplicate.map(r => ({ ...r, _rowType: 'duplicate' })),
  ]

  res.json({
    status:      scan.status,
    metadata:    scan.metadata,
    summary:     results.summary,
    timedOutDbs: scan.timedOutDbs,
    fragmented:  tab === 'fragmented'           ? paginateResults(results.fragmented, pgOpts)       : undefined,
    missing:     tab === 'missing'              ? paginateResults(results.missing, pgOpts)           : undefined,
    unusedAndDuplicate: tab === 'unusedAndDuplicate' ? paginateResults(unusedAndDuplicate, pgOpts)  : undefined,
  })
})

app.delete('/api/connections/:id/index-health/scan/:scanId', (req, res) => {
  const conn = requireConn(req, res)
  if (!conn) return

  const scan = scanStore.get(req.params.scanId)
  if (!scan || scan.connId !== req.params.id) {
    return res.status(404).json({ error: 'Scan not found.' })
  }

  const cancelled = scanStore.cancel(req.params.scanId)
  if (!cancelled) {
    return res.status(400).json({ error: `Cannot cancel scan with status: ${scan.status}` })
  }

  console.log(`[index-health] Scan cancelled: ${req.params.scanId.slice(0, 8)} (${conn.label})`)
  res.status(204).end()
})

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const dir = fs.existsSync(distDir) ? distDir : publicDir
  res.sendFile(path.join(dir, 'index.html'))
})

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('subscribe',   connId => {
    if (typeof connId === 'string' && UUID_RE.test(connId)) socket.join(`conn:${connId}`);
  });
  socket.on('unsubscribe', connId => {
    if (typeof connId === 'string' && UUID_RE.test(connId)) socket.leave(`conn:${connId}`);
  });
});

// --- alert evaluator: runs for every monitored server, independent of dashboard clients ---
const alertEvaluator = createAlertEvaluator({
  listServers: () =>
    [...connections.entries()].map(([id, c]) => ({
      connectionId: id,
      instanceKey: c.instanceKey || c.server,
    })),
  emit: (connectionId, payload) => {
    io.to(`conn:${connectionId}`).emit('alert', { connectionId, ...payload });
  },
});
alertEvaluator.start();
setInterval(() => alertEvaluator.evaluate(), 60_000);

// ─── Metrics persistence maintenance — clock-aligned at HH:05 ────────────────
function runMetricsMaintenance() {
  try {
    metricsStore.rollup();
    metricsStore.prune();
    const h = metricsStore.health();
    if (h.enabled && !h.error) {
      // Daily housekeeping on the first HH:05 run after 03:00 local.
      const today3am = new Date(); today3am.setHours(3, 0, 0, 0);
      const lastCheckpoint = Number(h.meta.last_checkpoint_at || 0);
      if (Date.now() >= today3am.getTime() && lastCheckpoint < today3am.getTime()) {
        metricsStore.vacuum();
        metricsStore.checkpoint();
        const baselineRows = metricsStore.recomputeBaselines(Date.now());
        if (baselineRows > 0) alertEvaluator.reloadCache();
      }
    }
  } catch (e) {
    console.error('[metrics-db] maintenance failed:', e.message);
  }
}

(function scheduleMetricsMaintenance() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(5, 0, 0);
  if (next <= now) next.setHours(next.getHours() + 1);
  setTimeout(function run() {
    runMetricsMaintenance();
    const next = new Date();
    next.setMinutes(5, 0, 0);
    if (next <= new Date()) next.setHours(next.getHours() + 1);
    setTimeout(run, next.getTime() - Date.now());
  }, next - now);
})();

process.on('SIGINT', () => {
  metricsStore.close();
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, HOST, () => {
  console.log(`\nSQL Activity Monitor → http://localhost:${PORT} (bound to ${HOST})\n`);
});
