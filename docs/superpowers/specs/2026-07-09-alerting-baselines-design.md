# Alerting + Baselines — Design Spec

**Date:** 2026-07-09
**Status:** Approved (brainstorming session, all sections user-approved)
**Depends on:** Metrics persistence (docs/superpowers/specs/2026-07-09-metrics-persistence-design.md) — `samples_raw`, `samples_1m`, `servers`, maintenance scheduler, Socket.io infrastructure.

## Goal

Learn each server's normal workload rhythm from persisted history and raise in-dashboard alerts when a core KPI deviates significantly from its learned baseline. Turns the monitor from a viewer into a watchdog.

## Decisions (user-confirmed)

| Decision | Choice |
|----------|--------|
| Delivery | In-dashboard only (bell + panel + toast); alerts persisted in SQLite. Email/webhook out of scope. |
| Trigger types | Baseline deviations only. Static thresholds, blocking/deadlock events, disk space out of scope. |
| Baseline shape | Hour-of-week, 168 buckets (Mon 00:00 UTC = bucket 0). Fallback to hour-of-day, then silence, when data insufficient. |
| Sensitivity | Sustained 3σ: value beyond mean±3×stddev for ≥5 consecutive minutes. |
| KPI set | Core 6: `cpu_pct`, `waiting_tasks`, `io_mb`, `batch_req`, `ple_sec`, `mem_grants_pending`. |
| Direction | `ple_sec` alerts on `below` only; the other five on `above` only. |

## Architecture

Approach chosen: **precomputed baselines + server-side evaluator** (vs on-the-fly SQL per evaluation — wasteful; vs client-side — only works with dashboard open, rejected).

```
samples_1m (28d trailing)
   └─ baselineCalc.js (daily, inside HH:05 maintenance after-03:00 branch)
        └─ baselines table (168 buckets × 6 KPIs × server)
             └─ alertEvaluator.js (every 60s, in-memory baseline cache)
                  ├─ alerts table (open/resolve rows)
                  └─ Socket.io 'alert' emit → bell/toast/panel UI
```

New units:
- `server/baselineCalc.js` — recompute baselines from `samples_1m`. Consumed by maintenance scheduler.
- `server/alertEvaluator.js` — 60s evaluation loop state machine. Consumes baselines cache + `samples_raw`.
- Migration v2 in `server/metricsSchema.js` — two tables below.
- Endpoints in `server.js`; store wrappers in `server/metricsStore.js`.
- Frontend: bell + panel + toasts + chart baseline band.

## Data model (migration v2)

```sql
CREATE TABLE baselines (
  server_id    INTEGER NOT NULL REFERENCES servers(id),
  kpi          TEXT    NOT NULL,
  hour_of_week INTEGER NOT NULL,          -- 0..167, Mon 00:00 UTC = 0
  mean         REAL    NOT NULL,
  stddev       REAL    NOT NULL,
  sample_count INTEGER NOT NULL,
  computed_at  INTEGER NOT NULL,          -- epoch ms
  PRIMARY KEY (server_id, kpi, hour_of_week)
) WITHOUT ROWID;

CREATE TABLE alerts (
  id            INTEGER PRIMARY KEY,
  server_id     INTEGER NOT NULL REFERENCES servers(id),
  kpi           TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,         -- epoch ms
  resolved_at   INTEGER,                  -- NULL = active
  peak_value    REAL,
  baseline_mean REAL,
  baseline_stddev REAL,
  direction     TEXT NOT NULL,            -- 'above' | 'below'
  acked_at      INTEGER
);
CREATE INDEX ix_alerts_server ON alerts (server_id, started_at);
```

All timestamps epoch ms UTC, consistent with persistence tables.

## Baseline computation (`baselineCalc.js`)

- Runs daily inside the existing HH:05 maintenance run, in the after-03:00-local branch (alongside vacuum/checkpoint).
- Source: `samples_1m`, trailing 28 days, `<kpi>_avg` weighted by `sample_count`.
- Bucket: hour-of-week derived from `ts` in UTC.
- Single-pass stats in SQL: weighted mean = `SUM(avg*n)/SUM(n)`; stddev from `SUM(avg*avg*n)/SUM(n) - mean²` (population, clamped ≥0 before sqrt). Rows with NULL avg excluded from both sums.
- Fallback ladder per (kpi, bucket):
  1. Hour-of-week bucket has `sample_count >= 60` (≈1 week of that slot in minutes) → use it.
  2. Else aggregate hour-of-day (same hour across all 7 days); if that reaches ≥60 → use it (written into each of the 7 corresponding hour-of-week rows).
  3. Else no row → evaluator silent for that KPI/hour. No false alarms during learning.
- Transactional per server (DELETE + INSERT of that server's rows atomic). Failure keeps previous baselines.
- `meta.last_baseline_at` updated on success.

## Alert evaluation (`alertEvaluator.js`)

Runs every 60s from a timer started in server.js next to the maintenance IIFE.

Per server with an active dashboard connection:
1. One SQL: average of last 60s of `samples_raw` per core-6 KPI.
2. Baseline lookup from in-memory cache (Map keyed `serverId|kpi|hourOfWeek`), reloaded after each recompute and at startup.
3. Breach test: `value > mean + 3*stddev` (or `<` mean − 3σ for `ple_sec`). Stddev floor: `stddev = max(stddev, 0.05 * |mean|)` — prevents noise alerts on near-constant metrics.
4. Consecutive-breach counters per (server, kpi) in memory. Counter reaches 5 → open alert (INSERT) unless one already active for the pair. While active, update `peak_value`.
5. Auto-resolve with hysteresis: value inside `mean ± 2σ` for 5 consecutive evaluations → set `resolved_at`. 3σ-open/2σ-close gap prevents flapping.
6. Socket.io `alert` event on open and resolve, to that connection's clients: `{ id, kpi, direction, value, mean, stddev, startedAt, resolvedAt }`.

Lifecycle rules:
- Ack (`acked_at`) silences the UI badge only; alert still auto-resolves on recovery.
- Server restart: counters reset; evaluator loads active (unresolved) alerts from DB at startup so they can still resolve.
- No baseline row for current bucket, store disabled, or no samples → skip silently.
- Alerts pruned at 365 days in the existing retention prune step.

## API

Same `requireConn` + input-validation pattern as history endpoints:

- `GET /api/connections/:id/alerts?active=1` — active alerts; or `?from=&to=` (parseHistoryRange, 90d span cap) for history.
- `POST /api/connections/:id/alerts/:alertId/ack` — sets `acked_at` (idempotent). `alertId` validated integer.
- `GET /api/connections/:id/baselines?kpi=cpu_pct` — 168-bucket curve for that KPI (kpi validated against core-6 allowlist).

Store wrappers: `getAlerts`, `ackAlert`, `getBaselines`, plus internal `openAlert`/`resolveAlert` used by evaluator. Disabled mode → empty results / no-ops.

## UI

- **Bell icon** in header near connection tabs. Badge = active unacked alert count; red pulse when >0. Live updates from socket `alert` events.
- **Toasts**: alert-open toast (red, auto-dismiss 8s), resolve toast (green). Text pattern: "CPU 94% vs typical 31±8%".
- **Alert panel** (existing Dialog primitives, opened from bell): active alerts on top with KPI, start time, duration, peak vs normal, Ack button; below, resolved alerts from last 7 days, muted styling.
- **Deep-link**: clicking an alert row switches history mode (`histRange`) to the alert's time window.
- **Baseline band on charts** (history mode only): translucent `mean±2σ` band behind the series, from `/baselines` endpoint. ChartCard gains optional `band` prop, rendered only in timestamps mode.
- React auto-escaping only; no dangerouslySetInnerHTML.

## Error handling

- Fail-open everywhere, like persistence: evaluator/baseline errors logged with `[alerts]` prefix, counted in `meta` (`alert_eval_errors`), never affect the poll loop or live UI.
- Socket emit wrapped in try/catch; disconnected clients catch up from DB when panel opens.
- No new npm dependencies.

## Testing

Vitest, node env pragma for server tests, in-memory DBs:
- `baselineCalc`: seeded `samples_1m` → exact mean/stddev per bucket; weighted math; NULL exclusion; fallback ladder 168→24→none; UTC bucket boundaries; transactional replace.
- `alertEvaluator`: opens at exactly 5 consecutive breaches (not 4); hysteresis resolve at 2σ×5; PLE below direction; stddev floor; peak_value tracking; restart re-adoption of active alerts; no-baseline silence.
- Endpoint validation tests (allowlist kpi, integer alertId, range parsing).
- Frontend: bell badge count, panel render + ack flow (mocked fetch), toast on socket event, ChartCard band prop guard.

## Out of scope

Email/SMTP, webhooks, browser push, static-threshold alerts, blocking/deadlock event alerts, disk-space alerts, per-metric sensitivity configuration UI, wait-type baselines. All can layer on this foundation later.
