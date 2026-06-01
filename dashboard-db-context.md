# Dashboard DB Access Context (SQL Server)

## Mission
Read-heavy dashboard. Every query must be lightweight, non-blocking, and incapable of blocking other workloads. Stale data is acceptable; locking the server is not.

## Isolation & Locking
- Database has RCSI on (`ALTER DATABASE ... SET READ_COMMITTED_SNAPSHOT ON`). All dashboard reads use default isolation — non-blocking via row versioning, no `NOLOCK` hints needed.
- If RCSI is not possible, session-level `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` (not table hints). Dashboard tolerates dirty reads.
- Every dashboard session opens with:
  ```sql
  SET DEADLOCK_PRIORITY LOW;
  SET LOCK_TIMEOUT 2000;   -- 2s; never hang on a lock
  SET XACT_ABORT ON;
  ```
- `WITH (READPAST)` only on queue/work-table reads where skipping locked rows is acceptable.

## Query Design
- No `SELECT *`. Project only the columns the widget renders.
- Every dashboard query must hit a covering or seek-friendly index — verified from the actual plan, not assumed.
- Aggregations over large tables go through pre-aggregated summary tables refreshed by SQL Agent (1–5 min cadence). Never `SUM`/`COUNT` millions of rows on each refresh.
- `TOP n` everywhere. `OPTION (FAST n)` for above-the-fold widgets.
- DMV queries filter early — `sys.dm_exec_requests`, `sys.dm_exec_sessions`, `sys.dm_exec_query_stats` all scan broadly by default. Apply `WHERE session_id > 50`, database filter, or `CROSS APPLY` only after narrowing.
- No cross-database joins on hot paths. Stage or replicate.

## Connection & Pooling
- Dedicated connection string for the dashboard, separate from transactional paths.
- `Connect Timeout=5; Command Timeout=10` — dashboard never waits on data.
- `ApplicationIntent=ReadOnly` to route to AG readable secondary if available.
- `Application Name=Dashboard` so the DBA can identify, trace, and govern this workload via `sys.dm_exec_sessions.program_name`.
- Connection pooling on; one logical pool per dashboard service.
- No explicit transactions on the read path — single statement, auto-commit.

## Caching & Polling
- Server-side cache (in-memory or Redis) in front of every dashboard endpoint. Default TTL 30s, tunable per widget.
- Frontend polling: minimum 15s for live widgets, 60s+ for trend widgets. Nothing polls faster than its data changes.
- Stagger widget refresh — no thundering herd on the same second.
- ETag / `If-None-Match` on the API so unchanged data costs nothing beyond the cache check.

## Resource Governor
- Workload group for the dashboard login: capped CPU (~20%), `MAX_DOP = 1`, low `REQUEST_MAX_MEMORY_GRANT_PERCENT`. Dashboard load cannot starve OLTP.

## Monitoring & Guardrails
- Log duration of every dashboard query in the app. Alert when p95 > 500ms.
- XEvent session capturing queries from `Application Name=Dashboard` running > 1s.
- Periodic review of `sys.dm_exec_query_stats` filtered by the dashboard's `query_hash` set to catch plan regressions.

## Anti-Patterns (Never)
- String-concatenated SQL — parameterize everything.
- `COUNT(*)` over a fact table on page load.
- Joining `dm_exec_requests` with `dm_exec_sql_text` / `dm_exec_query_plan` without filtering first.
- Any transaction (even read-only) held open across multiple statements.
- Sharing connection or transaction scope with write paths.
