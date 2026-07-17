# Sale-Blockers Design — Auth + RBAC, Audit Log, Notifications, Custom Alert Rules

**Date:** 2026-07-17
**Status:** Approved section-by-section in brainstorming; pending whole-spec review.

## 1. Context and goals

The SQL Server Activity Monitor is feature-rich (multi-server live dashboards, 90-day
metrics history, baseline-driven alerting, index health scans, kill/job actions) but
cannot be sold in its current state. Four gaps block any commercial conversation:

1. **No authentication** — anyone with network access can view dashboards, kill
   sessions, and control SQL Agent jobs (when feature gates are enabled).
2. **No audit log** — destructive actions log to console only; no compliance story.
3. **No alert notifications** — alerts are UI-only; a monitoring tool nobody is
   watching delivers no value.
4. **No custom alert rules** — thresholds are hardcoded to 6 KPIs, sigma-baseline
   only; buyers expect "CPU > 80% for 5 minutes".

### Requirements (settled in Q&A)

- **Deployment:** on-prem first; SaaS door kept open (no architectural decision may
  preclude it, but nothing is built for it now).
- **RBAC:** three roles — viewer / operator / admin.
- **Notification channels (v1):** email (SMTP) and generic webhook. Native
  Slack/Teams formatting deferred.
- **Custom rules (v1):** fixed thresholds on the existing 6 KPIs, per connection,
  alongside the existing sigma baselines. No new alert sources, no rule builder.
- **Audit scope:** destructive + admin actions + login events. Not reads.

### Approach decision

Three sequencings were considered:

- **A — Foundation-first serial** (auth → audit → notifications → rules): zero
  rework but slowest.
- **B — Value-first** (notifications/rules before auth): rejected — audit would land
  without identity, notification/rule endpoints would ship unauthenticated, both
  requiring retrofit.
- **C — Two-track (chosen):** auth + RBAC + audit as one package (audit consumes
  auth's request identity from day one), then notifications and rules. Originally
  planned as parallel tracks; revised during design to **serialized 3-before-4**
  (see §6) because both touch the evaluator's surroundings — the alertBus refactor
  is lowest-risk while rules are still hardcoded, and the rules regression gate then
  runs against an already-stable notification path.

**Dependency spine:** auth gives audit its actor; audit gives notifications and
rules their trail; the alertBus gives rules a delivery path that needs no changes.

## 2. Section 1 — Authentication + RBAC (Release 1)

### Architecture

**Session-based auth, not JWT.** On-prem single server: `express-session` with a
SQLite-backed session store, httpOnly cookie (`SameSite=Lax`; `Secure` when behind
TLS). Sessions are revocable instantly (delete row); no token-refresh machinery.
Session-store writes are throttled (touch at most once per few minutes per session)
so dashboard polling does not hammer SQLite. Socket.io reuses the same session via
handshake middleware — connection rejected without a valid session.

TLS is delegated to a reverse proxy (standard on-prem pattern). A single
`TRUST_PROXY` config flag enables `app.set('trust proxy', ...)` and is shared with
the audit log's IP capture (§3) — without it, `req.ip` behind a proxy is garbage.

**Passwords:** bcrypt (cost 12). Login failures are rate-limited per username+IP;
tripping the limiter locks the account for a cooldown window and writes a
`login.lockout` audit event (brute-force detection evidence).

### Components

- `server/auth/` — routes (`POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/me`), `requireAuth` middleware, `requireRole(role)` middleware,
  bcrypt hashing, rate limiter.
- SQLite tables (same DB as metrics store, see §6 and Appendix A): `users`,
  `sessions`.
- **All `/api/*` routes gated** except `/api/auth/login`. Static assets remain open;
  the React shell redirects to the login screen when `GET /api/auth/me` returns 401.
- Admin can force-disconnect a user (delete their sessions) — `session.revoke`.

### Permission matrix

| Action | viewer | operator | admin |
|---|---|---|---|
| View dashboards / history / alerts | Y | Y | Y |
| Ack alerts, kill sessions, job start/stop | | Y | Y |
| Manage users, connections, alert rules, notification channels, view audit log | | | Y |

Enforced server-side by `requireRole`; the frontend additionally hides/disables
controls based on `/api/auth/me` (UX only, never the security boundary). A 403 on a
role-gated endpoint writes an `authz.denied` audit event (failed privilege
escalation is exactly what an auditor wants to see).

### Bootstrap and recovery

**First run (empty users table):** the server generates a one-time bootstrap token,
prints it to console/log, and writes it to a file next to the SQLite DB. The UI
shows a "create admin account" screen that **requires the token**. This closes the
first-come-first-owned race on upgrades: today's installs are open on the network,
and without the token, whoever visits the bootstrap screen first after an upgrade
would own the system. The token converts "network access = ownership" into "server
access = ownership" — the trust model everything else in R1 assumes. No default
credentials are ever shipped. Successful bootstrap writes an `admin.bootstrap`
audit event (the genesis of the trust chain) and deletes the token file.

**Recovery:** `reset-admin.js` CLI (run on the server host, filesystem access is
the trust boundary) resets an admin password or re-creates the bootstrap state.
Tested as part of the R1 ship gate, not just written.

**Dev escape hatch:** `AUTH_DISABLED=true` disables the gate for local development
only. It logs a loud warning and **refuses to start combined with
`HOST=0.0.0.0`**. Known interaction to resolve at packaging time: inside Docker,
binding 0.0.0.0 is the norm and the container boundary provides isolation — the
Docker image either never honors `AUTH_DISABLED` or requires an explicit
`I_UNDERSTAND_*`-style override. Flagged, not decided here.

### Frontend

Login page; user chip + logout in header; admin-only Users page (create, disable,
enable, reset password, change role). Buttons gated by role.

### Error handling

Failed login returns a generic message (no username enumeration). Session expiry
mid-use surfaces as a 401 → redirect to login with return-to. Socket.io rejection
shows a reconnect-after-login banner.

### Testing

Unit: middleware (401/403 paths), rate limiter, role matrix. Integration: login →
cookie → gated endpoint → logout → 401; Socket.io handshake accept/reject;
bootstrap with/without token (without must fail); recovery CLI flow.

## 3. Section 2 — Audit log (Release 1)

Append-only SQLite table `audit_log` (schema in Appendix A):
`id, ts, user_id, username, ip, action, target, detail (JSON), outcome`.
`ts` is UTC epoch milliseconds everywhere — local time never touches the schema.

### PHI rule (mandatory, healthcare deployment)

**Audit detail stores identifiers, not content.** For `session.kill` and similar:
SPID, login name, host, program, database, connection name, rowcount — **never SQL
text**. Query text in a hospital system contains patient names, MRNs, SSNs in WHERE
clauses; persisting it into an unencrypted SQLite file with year-long retention
turns the monitoring tool into a HIPAA problem for the customer. If query context
is ever needed: first 100 characters truncated, or a query hash. This rule is
written as a module-level comment in `server/auditLog.js` because future
maintainers will be tempted. Corollaries: `login.failure` logs the attempted
username capped at 100 chars, never anything from the password field.

### Recorded actions

- Auth: `login.success`, `login.failure`, `login.lockout`, `logout`,
  `session.revoke`, `authz.denied`, `admin.bootstrap`
- Destructive: `session.kill`, `session.kill_sleeping` (SPIDs, connection,
  rowcount), `job.start`, `job.stop`
- Alerting: `alert.ack`, `rule.change` (R3), `channel.change`, `channel.test` (R2)
- Admin: `user.create`, `user.update`, `user.enable`, `user.disable`,
  `user.password_reset`, `connection.add`, `connection.remove`
- Meta: `audit.export` (exporting the audit log is itself auditable),
  `audit.prune` (summary: rows removed, cutoff date — an append-only log never
  deletes silently)

`user.update` detail records before/after per changed field:
`{field: "role", from: "viewer", to: "admin"}` — role escalation is the single most
interesting event in the log.

### Implementation

Single explicit helper — `audit(req, action, target, detail, outcome)` in
`server/auditLog.js` — called inside each endpoint after the action resolves, so
both success and failure outcomes are recorded with the resolved target. Explicit
calls, not middleware: middleware cannot know the outcome or the resolved target.

**Write-failure policy:** an audit insert failure logs the error and does **not**
block the action (availability over audit completeness — monitoring tool, not
banking). On insert failure the same JSON line is appended to a local fallback file
(`audit-fallback.jsonl` next to the DB), so the record degrades to file-based
logging rather than vanishing.

### Retention, UI, posture

- Prune rows older than `AUDIT_RETENTION_DAYS` (default 365; `0` = keep forever,
  documented — some customers need 6-7 years) inside the existing metricsStore
  prune cycle. Prune emits `audit.prune`.
- Admin-only Audit page: **server-side pagination** with time-range / user / action
  filters pushed into the query (a year on an active system is hundreds of
  thousands of rows). CSV export streams with the same filters, admin-only,
  audited.
- Indexes: `(ts)`, `(user_id, ts)`, `(action, ts)` — required by both the UI
  filters and the prune (without the ts index, prune full-scans inside the metrics
  cycle).
- **No tamper-evidence in v1.** The append-only guarantee is app-level; anyone with
  filesystem access can edit the file. Normal for this product class. Marketing
  copy says "append-only audit trail", never "tamper-proof". Hash-chaining is a
  possible Phase 3 differentiator.

## 4. Section 3 — Notifications (Release 2)

### Decoupling: alertBus

`alertEvaluator` currently calls `io.emit('alert')` directly (via the injected
`emit`). Introduce an internal `alertBus` (Node `EventEmitter`): the evaluator
emits `alert.opened` / `alert.closed`; the Socket.io broadcaster and the notifier
both subscribe. The evaluator stays ignorant of delivery. The existing evaluator
test suite must pass unchanged after this refactor — it is a pure decoupling.

### Module layout and channel abstraction

```
server/notifier/
  index.js            dispatcher: subscribes to alertBus, loads channels,
                      applies filters/pairing, owns the outbox
  channels/smtp.js    nodemailer transport
  channels/webhook.js POST JSON, 10s timeout, maxRedirects: 0
```

One channel interface: `send(payload) → {ok, error}`. Native Slack/Teams later =
new file in `channels/`, zero dispatcher changes.

### Configuration and secrets

- **SMTP transport in `.env` only** (host, port, user, pass, from, STARTTLS vs
  implicit TLS). One relay per install — realistic on-prem; keeps the SMTP password
  out of SQLite. `SMTP_TLS_REJECT_UNAUTHORIZED=false` supported with a logged
  warning (internal relays with self-signed certs are everywhere in the target
  market — Exchange included).
- SQLite `notification_channels` table (Appendix A): type, name, config JSON
  (email: recipients; webhook: URL + optional HMAC secret), enabled, events
  (`open`/`close`/`both`), min_severity, cooldown. Webhook URLs are bearer-ish
  secrets living in the DB — document file-permission expectations on the SQLite
  file.
- `BASE_URL` env drives deep links in every payload; validated at boot with a loud
  warning if unset.

### Delivery semantics — pairing rules

Send on **open** and on **close** (recovery notice), per channel settings, with
these invariants:

1. **Close bypasses cooldown and storm cap.** Recovery notices are how on-call
   stands down; if the cap eats one, the DBA's last email says CRITICAL for an
   alert that resolved hours ago.
2. **Close is sent only if the matching open was sent** on that channel. A
   "recovered" notice for an alert nobody was told about erodes trust. Implemented
   as an outbox lookup on `(alert_id, channel_id)`.
3. **Upward severity transitions bypass cooldown.** A warning at 10:00 must not
   swallow the critical at 10:08. (With R3, warning and critical are separate
   rules, so this is the natural behavior; the invariant is pinned by tests.)

**Flap suppression:** notifier-level cooldown — no repeated open-notification for
the same (rule, connection, channel) within 15 minutes (configurable per channel) —
on top of the evaluator's existing hysteresis.

**Storm cap:** rolling window, per channel (a flapping webhook must not silence
email), default 30 notifications/hour. On trip: one "storm suppressed, see
dashboard" meta-notification sent **directly** (not through the alert path or
outbox) with its own once-per-window guard, then silence until the window drains.

**No digest/batching in v1** — cooldown + cap cover the storm case; digest is v2.

**No cross-channel failure escalation** ("email admins when webhook fails") — it is
a recursion trap. Channel health on the admin page plus a UI-only header banner
when any channel exceeds 5 consecutive failures.

### Reliability — persistent outbox

`notification_outbox` table: payload snapshotted at write time (a retried send must
show the value that triggered it), attempts, next_attempt_ts, status
(`pending`/`sent`/`failed`/`stale`). Retry backoff 30s → 2m → 10m, then `failed`.
Unsent rows resume on boot. Sent rows pruned after 7 days.

**Filters run before the outbox.** min_severity and open/close settings are
evaluated at dispatch decision time; an outbox row means "we intend to deliver
this", so the pending view never lies.

**Staleness check (boot and every dispatch attempt):** if the alert already closed
and the open was never sent, mark the row `stale` and skip. A server that was down
45 minutes must not blast stale CRITICALs at 9am.

### Payload security and content

- **PHI rule applies (§3):** payloads carry KPI numbers and identifiers only —
  never SQL text.
- Webhook JSON: `{event, alert: {id, kpi, severity, value,
  baseline_or_threshold, opened_at}, connection: {name, server}, dashboard_url}`.
  HMAC signature over `timestamp + body`, timestamp in a header, so receivers can
  reject replays (Slack/Stripe pattern).
- Email: subject `[SQL Monitor] CRITICAL: cpu_pct 94% on PROD01`; compact HTML
  body; deep link via `BASE_URL`. **All interpolated values are HTML-escaped** and
  the subject is CRLF-sanitized (connection names are admin-entered; R3 makes rule
  names user-entered; a connection named `PROD01\r\nBcc:...` is SMTP header
  injection). Same discipline in the test-send path. Timestamps rendered in UTC
  with an explicit "UTC" label.

### Admin UX

Channels page: per-channel health (last success, last error, consecutive
failures), test-send button (payload clearly marked TEST in subject and body so
nobody pages themselves; raw transport error surfaced to the admin on failure —
not a generic message). Channel changes → `channel.change` audit; test →
`channel.test`.

### Error handling

Fan-out isolated per channel — one channel's failure never blocks others.
Transport errors are captured into the outbox row, never thrown into the dispatch
loop. Malformed channel config disables the channel with an error status, never
crashes.

### Testing

Unit: pairing rules (suppressed-open → close skipped; escalation bypasses cooldown;
close bypasses cap), cooldown/storm-cap logic, backoff scheduler, payload builders
(assert no SQL-text field can exist), HTML/CRLF escaping. Integration: fake SMTP
(nodemailer JSON transport) + local webhook receiver; **outbox restart test** —
kill the process with pending rows, boot, assert retries resume and the staleness
check marks closed-alert rows `stale` instead of sending (ship gate, see §6).
Evaluator regression suite unchanged after the alertBus refactor.

## 5. Section 4 — Custom alert rules (Release 3)

### Evaluator facts (measured, not assumed)

The evaluator ticks every **60s** (`server.js:1286`), each tick evaluating the 60s
average of 2s samples (`getRecentKpiAverages`). Open requires 5 consecutive breach
ticks; close requires 5 consecutive calm ticks; one calm tick resets the breach
counter. Active alerts are keyed `(serverId, kpi)`; severity is hardcoded
`'critical'`; a KPI with no (or stale) baseline is silently skipped.

### Rule model — rules become rows

New `alert_rules` table (Appendix A). Two modes:

- `baseline`: sigma_open, sigma_close, min_stddev (today's behavior).
- `threshold`: threshold_open, threshold_close, duration_sec.

Common: kpi, direction, severity (`warning`/`critical`), enabled, server_id.

**Scope split:** baseline rules are global (editable); threshold rules are
per-server. This avoids global-vs-override resolution logic in v1.

**Seeded migration = regression gate.** The migration inserts the 6 current
`KPI_ALERT_CONFIG` entries as global baseline rules; `alertConfig.js` becomes seed
data. The existing test suite must pass unchanged against seeded rules — a provable
claim of zero behavior change on upgrade. Old behavior becomes data you can diff,
not code you hope you replicated.

### Duration semantics

`duration_sec` maps to consecutive ticks: `ceil(duration_sec / 60)`, evaluated
against the 60s average. "CPU > 80% for 5 min" = 5 consecutive ticks averaging
above 80. Stated honestly in UI and docs:

- Granularity is 1 minute; minimum 60s; default 300s (matches today's 5-tick
  behavior).
- One calm tick resets the counter — identical to existing sigma semantics.
- Missed ticks (no fresh samples) preserve counters — existing behavior, kept.
- **Rejected:** evaluating raw 2s samples for sustained conditions —
  noise-sensitive and complex; 60s averages are the evaluator's established
  currency. Sub-minute detection is v2 if ever.

**Close hysteresis is intentionally asymmetric:** open duration is rule-configured
ticks; close is the fixed 5-calm-tick count, consistent with sigma rules. A test
pins this so nobody "helpfully" symmetrizes it later and changes recovery timing.

### Keying and coexistence

Active-alert key changes `(serverId, kpi)` → `(serverId, ruleId)`. `alerts` gains
nullable `rule_id`, `severity`, `resolution_reason` columns (historical rows stay
null). Multiple alerts per KPI become legal — a baseline anomaly and a fixed
threshold can be open simultaneously; warning + critical rules on one KPI are two
rules, and warning→critical is exactly the §4 escalation case, already handled by
the pairing rules. UI groups alert chips by KPI with a rule label.

**Alerts snapshot what fired them:** baseline alerts store mean/stddev at open
(already true); threshold alerts store threshold_open at open. History display
never depends on current rule config — including displayed severity: if an admin
edits a rule's severity while its alert is open, the open alert shows the
**snapshot** severity, applied deliberately per this principle.

### Rule edit / delete / disable with open alerts

- **Edit:** the open alert survives and is evaluated against the *new* config from
  the next tick; if now calm, it closes via normal 5-tick hysteresis. No instant
  retro-resolution — avoids flapping while an admin tunes thresholds.
- **Delete:** open alert auto-resolved with `resolution_reason = 'rule_deleted'`;
  the close notification follows pairing rule 2 (sent only if the open was sent).
  `rule.change` audit records the rule snapshot and affected alert ids.
- **Disable:** same auto-resolution (`'rule_disabled'`) — an orphaned alert nothing
  can ever close is the worst outcome. The rule row remains for re-enable.

The evaluator gets `reloadRules()` mirroring the existing `reloadCache()` pattern;
admin endpoints call it after writes. The rules cache swaps **atomically between
ticks** — a mid-tick reload must never evaluate half old, half new config
(implementation watch item, verified against how `reloadCache()` behaves).

### Selling point

Threshold rules need **no baseline** — new installs alert on day one, whereas sigma
rules need weeks of history. This fixes the current "silent until baseline exists"
gap and is a trial-saving demo point.

### Validation (server-side, admin-only, audited)

kpi via existing `parseKpi`; direction-consistent hysteresis (above:
`threshold_close ≤ threshold_open`; below: reversed); `duration_sec ≥ 60`; severity
enum. Reject invalid input; never clamp silently.

### UI

Admin → Alert Rules page. Per-connection table of effective rules; add/edit modal:
KPI, mode, thresholds, duration (minute steps), severity, direction pre-filled per
KPI (e.g., PLE alerts `below`). Inline enable toggle.

### Error handling and testing

Rules-cache load failure → evaluator keeps last good cache (baseline-cache
pattern); invalid rows skipped with a log line, never a crashed tick.
Tests: golden regression (seeded rules ≡ current behavior); duration counting incl.
reset; close-hysteresis-asymmetry pin; edit/delete/disable mid-alert incl.
notification pairing; dual open alerts per KPI; threshold-without-baseline;
validation rejects.

## 6. Section 5 — Phase assembly, migrations, rollout

### Releases — serialized, each independently shippable

| Release | Contents | Migration | Size | Ship gate |
|---|---|---|---|---|
| **R1 "Secure"** | Auth + RBAC + audit log + Users/Audit UIs + bootstrap + recovery CLI | #1: `users`, `sessions`, `audit_log` | L | All endpoints 401 without session; permission-matrix tests; audit rows for every destructive action; bootstrap **without token must fail**; recovery CLI flow tested (lock out admin → `reset-admin.js` → log back in) |
| **R2 "Notify"** | alertBus refactor + notifier + outbox + Channels UI + test-send | #2: `notification_channels`, `notification_outbox` | M | Evaluator suite unchanged post-alertBus; pairing-rule units green; fake-SMTP + local-webhook integration; **outbox restart test** (pending rows resume; closed-alert rows marked stale, not sent) |
| **R3 "Rules"** | `alert_rules` seeded migration + evaluator generalization + Rules UI | #3: `alert_rules`, `alerts` columns | M | Golden regression: seeded rules ≡ current behavior with existing tests untouched; mid-alert edit/delete/disable units green |

**Why 3 before 4 (R2 before R3):** both touch the evaluator's surroundings. The
alertBus refactor is a pure decoupling, lowest-risk while rules are still
hardcoded; R3's regression gate then runs against an already-stable notification
path. Running them in parallel worktrees would mean merging two evaluator-adjacent
changes.

**Salvaged parallelism:** while R2 backend is in review, R3's non-evaluator work
(rules table schema, validation module, Rules UI against a mocked API) can start —
it provably touches neither evaluator nor notifier. Within each release,
frontend/backend tracks run as parallel subagent tasks where files don't overlap.

**Demo milestone:** after R1+R2 the product demos fully — hardcoded rules still
feed the alertBus, so auth + audit + email/webhook alerting is a sellable demo. R3
closes the deal.

### Migration discipline

- **One SQLite DB, one version counter, one backup file.** No separate auth DB:
  `PRAGMA user_version` is per-file, and a multi-file backup must copy a consistent
  set — not worth it. Write contention is handled by WAL mode plus session-touch
  throttling; split later only if it measurably bites.
- Versioned, forward-only migrations keyed on `PRAGMA user_version`; each release
  ships exactly one migration, so "test the upgrade against a copy of a customer
  DB" means something. (Verify metricsStore's current schema-init mechanism at plan
  time; if no version mechanism exists, R1 introduces the runner.)
- **WAL-safe backup before every migration:** `VACUUM INTO` (online, produces a
  consistent single file; a bare file-copy misses committed data in the `-wal`
  file). The runner prints where the backup landed and the one-line restore
  procedure.
- **Rollback = restore.** Forward-only migrations mean the rollback path is: stop
  the service, restore the printed backup file, reinstall the previous version.
  Stated explicitly — "forward-only" without a rollback story reads as "no
  rollback".
- **Version mismatch, two directions:** DB older than code → migrate (the normal
  path). DB **newer** than code → refuse to start with "this database was created
  by a newer version; downgrade is not supported; restore a backup".

### R1 internal order (dependency chain)

migration → auth module + session store → gate REST → gate Socket.io handshake →
login UI + bootstrap screen → audit helper + hooks into existing endpoints →
Users/Audit admin pages. Backend is curl-testable before any UI exists.

### Breaking-change handling (R1)

Upgrading turns on login. Release notes state it; first boot with an empty users
table shows the token-protected bootstrap screen and nothing else. Dev escape
hatch and Docker interaction per §2.

### Process per release

This spec → `superpowers:writing-plans` per release (three plan docs in
`docs/superpowers/plans/`) → subagent-driven execution → code review → merge.
Progress tracked via task lists per plan.

## 7. Cross-cutting rules

- **PHI rule (§3) applies to every persistence and delivery surface:** audit
  detail, notification payloads, exports. Identifiers, never SQL text.
- All timestamps stored as UTC epoch ms; rendered with explicit UTC label.
- Every new admin surface writes audit events.
- Security-review posture: "append-only audit trail" (true), never "tamper-proof"
  (false).

## Appendix A — Migration inventory (full DDL)

### Migration 1 (R1) — user_version → 1

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('viewer','operator','admin')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_user    ON sessions(user_id);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,            -- UTC epoch ms
  user_id  INTEGER,                     -- NULL for pre-auth events (login.failure)
  username TEXT,                        -- capped at 100 chars at write time
  ip       TEXT,
  action   TEXT NOT NULL,
  target   TEXT,
  detail   TEXT,                        -- JSON; identifiers only, never SQL text
  outcome  TEXT NOT NULL                -- 'success' | 'failure'
);
CREATE INDEX idx_audit_ts        ON audit_log(ts);
CREATE INDEX idx_audit_user_ts   ON audit_log(user_id, ts);
CREATE INDEX idx_audit_action_ts ON audit_log(action, ts);
```

### Migration 2 (R2) — user_version → 2

```sql
CREATE TABLE notification_channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL CHECK (type IN ('email','webhook')),
  name         TEXT NOT NULL,
  config       TEXT NOT NULL,           -- JSON: email {recipients[]},
                                        --       webhook {url, hmac_secret?}
  enabled      INTEGER NOT NULL DEFAULT 1,
  events       TEXT NOT NULL DEFAULT 'both'
               CHECK (events IN ('open','close','both')),
  min_severity TEXT NOT NULL DEFAULT 'warning'
               CHECK (min_severity IN ('warning','critical')),
  cooldown_sec INTEGER NOT NULL DEFAULT 900,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE notification_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      INTEGER NOT NULL REFERENCES notification_channels(id),
  alert_id        INTEGER NOT NULL,
  event           TEXT NOT NULL CHECK (event IN ('open','close')),
                  -- storm meta-notifications and test-sends go direct,
                  -- never through the outbox
  payload         TEXT NOT NULL,        -- snapshotted at write time
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_ts INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','failed','stale')),
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX idx_outbox_status_next   ON notification_outbox(status, next_attempt_ts);
CREATE INDEX idx_outbox_alert_channel ON notification_outbox(alert_id, channel_id);
```

### Migration 3 (R3) — user_version → 3

```sql
CREATE TABLE alert_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id      INTEGER,               -- NULL = global (baseline rules);
                                        -- threshold rules are per-server
  kpi            TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('baseline','threshold')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  direction      TEXT NOT NULL CHECK (direction IN ('above','below')),
  severity       TEXT NOT NULL DEFAULT 'critical'
                 CHECK (severity IN ('warning','critical')),
  -- baseline mode
  sigma_open     REAL,
  sigma_close    REAL,
  min_stddev     REAL,
  -- threshold mode
  threshold_open  REAL,
  threshold_close REAL,
  duration_sec    INTEGER,              -- >= 60; ticks = ceil(duration_sec/60)
  created_by     INTEGER,               -- users.id
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_rules_server_kpi ON alert_rules(server_id, kpi);

ALTER TABLE alerts ADD COLUMN rule_id INTEGER;           -- NULL for historical rows
ALTER TABLE alerts ADD COLUMN severity TEXT;             -- snapshot at open
ALTER TABLE alerts ADD COLUMN resolution_reason TEXT;    -- 'rule_deleted' |
                                                         -- 'rule_disabled' | NULL

-- Seed: insert the 6 KPI_ALERT_CONFIG entries as global baseline rules
-- (cpu_pct, waiting_tasks, io_mb, batch_req: above; ple_sec: below;
--  mem_grants_pending: above), sigma_open=3, sigma_close=2, minStddev per
--  alertConfig.js, severity='critical'. Existing tests must pass unchanged.
```

## Appendix B — Implementation watch items

1. Close-hysteresis asymmetry pinned by a test (R3).
2. Displayed severity of an open alert = snapshot at open, not live rule config (R3).
3. Rules cache swaps atomically between evaluator ticks (R3).
4. `TRUST_PROXY` flag shared between session security and audit IP capture (R1).
5. Docker × `AUTH_DISABLED` × `HOST=0.0.0.0` interaction — decide at packaging time.
6. Verify metricsStore schema-init mechanism before writing the R1 migration runner.
