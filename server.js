require('dotenv').config();
const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const sql        = require('mssql');
const { randomUUID } = require('crypto');
const path       = require('path');

const PORT    = parseInt(process.env.PORT)              || 3000;
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS)  || 2000;

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);

app.use(express.json());
const fs = require('fs')
const distDir = path.join(__dirname, 'dist')
const publicDir = path.join(__dirname, 'public')
app.use(express.static(fs.existsSync(distDir) ? distDir : publicDir));

// ─── Connection store ─────────────────────────────────────────────────────────
// Map<id, { pool, label, server, handle, prevIO }>
const connections = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
    requestTimeout: 15000,
    connectionTimeout: 15000,
    options: {
      instanceName,
      encrypt:               encryptVal,
      trustServerCertificate: trustServerCert === true || trustServerCert === 'true',
      hostNameInCertificate: hostNameInCertificate || undefined,
      enableArithAbort:      true,
      readOnlyIntent:        appIntent === 'ReadOnly',   // ApplicationIntent
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
       WHERE counter_name='Batch Requests/sec' AND instance_name='')          AS batch_requests`,

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
      LEFT(ISNULL(SUBSTRING(t.text,
        (ISNULL(r.statement_start_offset,0)/2)+1,
        ((CASE ISNULL(r.statement_end_offset,-1) WHEN -1 THEN DATALENGTH(t.text)
          ELSE r.statement_end_offset END - ISNULL(r.statement_start_offset,0))/2)+1),''),300) AS last_query
    FROM sys.dm_exec_sessions s
    LEFT JOIN sys.dm_exec_requests r ON s.session_id=r.session_id
    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
    WHERE s.is_user_process=1
    ORDER BY s.cpu_time DESC`,

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

  dataFileIO: `
    SELECT
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
      qs.execution_count,
      CAST(qs.total_elapsed_time/qs.execution_count/1000.0 AS FLOAT) AS avg_elapsed_ms,
      CAST(qs.total_worker_time/qs.execution_count/1000.0  AS FLOAT) AS avg_cpu_ms,
      CAST(qs.total_logical_reads/NULLIF(qs.execution_count,0) AS FLOAT) AS avg_logical_reads,
      CONVERT(VARCHAR(23),qs.last_execution_time,121) AS last_executed,
      LEFT(ISNULL(SUBSTRING(st.text,
        (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1),''),300) AS query_text
    FROM sys.dm_exec_query_stats qs
    CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
    WHERE qs.last_execution_time > DATEADD(HOUR,-1,GETDATE()) AND qs.execution_count>0
    ORDER BY qs.total_elapsed_time/qs.execution_count DESC`,

  activeExpensive: `
    SELECT
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
    WHERE r.session_id != @@SPID
    ORDER BY r.total_elapsed_time DESC`,

  blocking: `
    SELECT
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
          ELSE bc.statement_end_offset END - ISNULL(bc.statement_start_offset,0))/2)+1),''),300) AS blocked_query
    FROM sys.dm_exec_requests bc
    JOIN  sys.dm_exec_sessions bc_s ON bc.session_id          = bc_s.session_id
    LEFT JOIN sys.dm_exec_sessions bs  ON bc.blocking_session_id = bs.session_id
    LEFT JOIN sys.dm_exec_requests br  ON bc.blocking_session_id = br.session_id
    OUTER APPLY sys.dm_exec_sql_text(bc.sql_handle) t
    OUTER APPLY sys.dm_exec_sql_text(br.sql_handle) bt
    WHERE bc.blocking_session_id > 0
    ORDER BY bc.wait_time DESC`,

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
      -- SQL Server process memory (from dm_os_process_memory – no sys_info needed)
      CAST(pm.physical_memory_in_use_kb AS FLOAT) / 1048576.0   AS sql_mem_gb,
      -- Committed vs target from perf counters (reliable cross-version)
      (SELECT TOP 1 CAST(cntr_value AS FLOAT) / 1048576.0
       FROM sys.dm_os_performance_counters
       WHERE counter_name = 'Total Server Memory (KB)'
         AND object_name  LIKE '%Memory Manager%')               AS sql_total_mem_gb,
      (SELECT TOP 1 CAST(cntr_value AS FLOAT) / 1048576.0
       FROM sys.dm_os_performance_counters
       WHERE counter_name = 'Target Server Memory (KB)'
         AND object_name  LIKE '%Memory Manager%')               AS sql_target_mem_gb,
      -- Page Life Expectancy
      (SELECT TOP 1 CAST(cntr_value AS FLOAT)
       FROM sys.dm_os_performance_counters
       WHERE counter_name = 'Page life expectancy'
         AND object_name  LIKE '%Buffer Manager%')               AS ple_sec,
      -- Connections / compilations
      (SELECT TOP 1 CAST(cntr_value AS FLOAT)
       FROM sys.dm_os_performance_counters
       WHERE counter_name = 'User Connections'
         AND object_name  LIKE '%General Statistics%')           AS user_connections,
      (SELECT TOP 1 CAST(cntr_value AS FLOAT)
       FROM sys.dm_os_performance_counters
       WHERE counter_name = 'SQL Compilations/sec'
         AND object_name  LIKE '%SQL Statistics%')               AS compilations_sec,
      (SELECT TOP 1 CAST(cntr_value AS FLOAT)
       FROM sys.dm_os_performance_counters
       WHERE counter_name = 'SQL Re-Compilations/sec'
         AND object_name  LIKE '%SQL Statistics%')               AS recompilations_sec,
      -- Buffer Cache Hit Ratio (0-100)
      ISNULL((SELECT TOP 1
         CAST(c.cntr_value AS FLOAT) /
         NULLIF((SELECT TOP 1 CAST(cntr_value AS FLOAT)
                 FROM sys.dm_os_performance_counters
                 WHERE counter_name = 'Buffer cache hit ratio base'
                   AND object_name  LIKE '%Buffer Manager%'), 0) * 100.0
       FROM sys.dm_os_performance_counters c
       WHERE c.counter_name = 'Buffer cache hit ratio'
         AND c.object_name  LIKE '%Buffer Manager%'), 0)         AS buffer_cache_hit_ratio,
      -- Memory Grants Pending
      ISNULL((SELECT TOP 1 CAST(cntr_value AS FLOAT)
       FROM sys.dm_os_performance_counters
       WHERE counter_name = 'Memory Grants Pending'
         AND object_name  LIKE '%Memory Manager%'), 0)           AS memory_grants_pending,
      -- Network: cumulative TDS packet bytes (delta between polls = throughput)
      ISNULL((SELECT CAST(SUM(
         (CAST(num_reads  AS BIGINT) +
          CAST(num_writes AS BIGINT)) *
          CAST(ISNULL(NULLIF(net_packet_size,0), 4096) AS BIGINT)
       ) AS FLOAT) FROM sys.dm_exec_connections), 0)             AS net_bytes_total
    FROM sys.dm_os_process_memory pm`,

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
    ) last_run ON j.job_id = last_run.job_id AND last_run.rn = 1
    ORDER BY
      CASE
        WHEN ja.start_execution_date IS NOT NULL AND ja.stop_execution_date IS NULL THEN 0
        WHEN last_run.run_status = 0 THEN 1
        ELSE 2
      END, j.name`,

  dbSizes: `
    SELECT
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
      CAST(v.total_bytes     AS FLOAT) AS total_bytes,
      CAST(v.available_bytes AS FLOAT) AS available_bytes,
      CAST(v.total_bytes - v.available_bytes AS FLOAT) AS used_bytes,
      CAST(100.0 * (v.total_bytes - v.available_bytes)
           / NULLIF(CAST(v.total_bytes AS FLOAT), 0) AS DECIMAL(5,1)) AS used_pct,
      CAST(100.0 * v.available_bytes
           / NULLIF(CAST(v.total_bytes AS FLOAT), 0) AS DECIMAL(5,1)) AS free_pct,
      MAX(CASE WHEN mf.database_id = 2                              THEN 1 ELSE 0 END) AS has_tempdb,
      MAX(CASE WHEN mf.type_desc   = 'LOG'                          THEN 1 ELSE 0 END) AS has_log,
      MAX(CASE WHEN mf.type_desc   = 'ROWS' AND mf.database_id <> 2 THEN 1 ELSE 0 END) AS has_data,
      COUNT(DISTINCT mf.database_id) AS database_count,
      COUNT(mf.file_id)              AS file_count
    FROM sys.master_files mf
    CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) v
    WHERE mf.state = 0
    GROUP BY v.volume_mount_point, v.total_bytes, v.available_bytes
    ORDER BY v.volume_mount_point`,
};

async function collectMetrics(pool, prevIO, prevNet) {
  const req = () => pool.request();
  const [cpuR, ovR, ioR, procR, waitR, fileR, recentR, activeR, dbSizesR, blockingR, deadlocksR, perfR, jobsR, diskR] = await Promise.all([
    req().query(Q.cpu),
    req().query(Q.overview),
    req().query(Q.ioSnapshot),
    req().query(Q.processes),
    req().query(Q.resourceWaits),
    req().query(Q.dataFileIO),
    req().query(Q.recentExpensive),
    req().query(Q.activeExpensive),
    req().query(Q.dbSizes),
    req().query(Q.blocking),
    req().query(Q.deadlocks).catch(() => ({ recordset: [] })),
    req().query(Q.serverPerf).catch(err => { console.error('[serverPerf]', err.message); return { recordset: [] }; }),
    req().query(Q.jobs).catch(err => { console.error('[jobs]', err.message); return { recordset: [] }; }),
    req().query(Q.diskDrives).catch(err => { console.error('[diskDrives]', err.message); return { recordset: [] }; }),
  ]);

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
    diskDrives:      diskR.recordset,
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

app.post('/api/connect', async (req, res) => {
  try {
    const { server, label, database, color, appIntent } = req.body;
    if (!server) return res.status(400).json({ error: 'Server is required.' });

    const config = buildConfig(req.body);
    const pool   = await new sql.ConnectionPool(config).connect();
    const id     = randomUUID();
    const displayLabel = label?.trim() || server;

    const conn = {
      pool, label: displayLabel, server,
      database:  database  || 'master',
      color:     color     || '#3b82f6',
      appIntent: appIntent || 'ReadWrite',
      handle: null, prevIO: null, prevNet: null,
    };
    connections.set(id, conn);

    // Start polling
    const poll = async () => {
      const c = connections.get(id);
      if (!c) return;
      try {
        const metrics = await collectMetrics(c.pool, c.prevIO, c.prevNet);
        c.prevIO  = metrics._prevIO;  delete metrics._prevIO;
        c.prevNet = metrics._prevNet; delete metrics._prevNet;
        io.to(`conn:${id}`).emit('metrics', { connId: id, ...metrics });
      } catch (err) {
        console.error(`[${displayLabel}] Poll error:`, err.message);
        io.to(`conn:${id}`).emit('poll_error', { connId: id, message: err.message });
      }
    };

    await poll();
    conn.handle = setInterval(poll, POLL_MS);

    console.log(`+ Connected: ${displayLabel} [${id.slice(0,8)}] ${appIntent||'ReadWrite'}`);
    res.json({ id, label: displayLabel, server, database: database || 'master', color: color || '#3b82f6', appIntent: appIntent || 'ReadWrite' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/disconnect/:id', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found.' });
  clearInterval(conn.handle);
  try { await conn.pool.close(); } catch {}
  connections.delete(req.params.id);
  console.log(`- Disconnected: ${conn.label} [${req.params.id.slice(0,8)}]`);
  res.json({ ok: true });
});

app.post('/api/connections/:id/kill-sleeping', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found.' });
  try {
    const result = await conn.pool.request().query(`
      SELECT session_id FROM sys.dm_exec_sessions
      WHERE is_user_process=1 AND status='sleeping'`);
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
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found.' });
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
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found.' });
  try {
    const result = await conn.pool.request().query(`
      EXEC sp_WhoIsActive
        @filter = '', @filter_type = 'session', @not_filter = '', @not_filter_type = 'session',
        @show_own_spid = 0, @show_system_spids = 0, @show_sleeping_spids = 1,
        @get_full_inner_text = 1, @get_plans = 1, @get_outer_command = 1,
        @get_transaction_info = 0, @get_task_info = 1, @get_locks = 0,
        @get_avg_time = 0, @get_additional_info = 0, @find_block_leaders = 0,
        @delta_interval = 0,
        @output_column_list = '[dd%][session_id][block%][query_plan][sql_text][sql_command][login_name][wait_info][tasks][tran_log%][cpu%][temp%][block%][reads%][writes%][context%][physical%][locks][%]',
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

app.post('/api/connections/:id/jobs/start', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found.' });
  const { jobName } = req.body;
  if (!jobName || typeof jobName !== 'string' || jobName.length > 256)
    return res.status(400).json({ error: 'Invalid job name.' });
  try {
    await conn.pool.request()
      .input('jn', sql.NVarChar(256), jobName)
      .query('EXEC msdb.dbo.sp_start_job @job_name = @jn');
    console.log(`[${conn.label}] Started job: ${jobName}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/connections/:id/jobs/stop', async (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found.' });
  const { jobName } = req.body;
  if (!jobName || typeof jobName !== 'string' || jobName.length > 256)
    return res.status(400).json({ error: 'Invalid job name.' });
  try {
    await conn.pool.request()
      .input('jn', sql.NVarChar(256), jobName)
      .query('EXEC msdb.dbo.sp_stop_job @job_name = @jn');
    console.log(`[${conn.label}] Stopped job: ${jobName}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const dir = fs.existsSync(distDir) ? distDir : publicDir
  res.sendFile(path.join(dir, 'index.html'))
})

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('subscribe',   connId => socket.join(`conn:${connId}`));
  socket.on('unsubscribe', connId => socket.leave(`conn:${connId}`));
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\nSQL Activity Monitor → http://localhost:${PORT}\n`);
});
