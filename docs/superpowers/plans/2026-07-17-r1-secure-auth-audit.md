# R1 "Secure" — Auth + RBAC + Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-based authentication with three roles (viewer/operator/admin), a token-protected bootstrap flow, a recovery CLI, and an append-only audit log to the SQL Server Activity Monitor — per frozen spec `docs/superpowers/specs/2026-07-17-sale-blockers-design.md` §2, §3, §6.

**Architecture:** `express-session` with a small custom SQLite session store (same DB as the metrics store, `server/data/metrics.db`, migration v3). All `/api/*` routes gated by `requireAuth` except `/api/auth/*`; role checks via `requireRole`. Socket.io reuses the session via `io.engine.use()`. Audit is an explicit helper `audit(req, action, target, detail, outcome)` called inside endpoints. Backend is fully curl-testable before any UI exists (Tasks 1–8), then frontend (Task 9), then audit (Tasks 10–11), then admin APIs + pages (Tasks 12–13).

**Tech Stack:** Node.js + Express 4 + Socket.io 4, better-sqlite3 (existing), `express-session` (new), `bcryptjs` (new), React 18 + Vite frontend, Vitest (+ jsdom + @testing-library/react for frontend tests).

## Global Constraints

- **PHI rule (spec §3, §7):** audit `detail` stores identifiers only — SPID, login, host, program, database, connection name, rowcount. **Never SQL text**, never query parameters, never password-field content. Attempted usernames capped at 100 chars.
- All timestamps are UTC epoch **milliseconds**. UI renders with explicit "UTC" label.
- Roles are exactly `viewer`, `operator`, `admin` (spec §2 permission matrix). Frontend role-gating is UX only — never the security boundary.
- bcrypt cost **12** in production code (tests may inject a lower cost).
- Marketing/UI copy: "append-only audit trail", **never** "tamper-proof".
- `AUTH_DISABLED=true` is a dev-only hatch; it must refuse to start with a non-loopback `HOST`.
- Migrations are forward-only, keyed on `PRAGMA user_version`; R1 is version **3**. `VACUUM INTO` backup before pending migrations on an existing DB; DB newer than code → refuse to start.
- Git: stage files **by name** (never `git add .` / `git add -A`); never commit `.env` or any credentials file.
- Server tests live in `tests/server/*.test.js`, frontend tests in `src/**/*.test.jsx`. Run with `npx vitest run <path>`.
- Existing behavior must not regress: full suite (`npx vitest run`) green at every commit.

---

### Task 1: Migration v3 (users, sessions, audit_log) + backup + newer-version refusal

**Files:**
- Modify: `server/metricsSchema.js` (MIGRATIONS array ends at version 2; `migrate()` at bottom)
- Test: `tests/server/metricsSchema.test.js` (append a new `describe`)

**Interfaces:**
- Consumes: existing `migrate(db)`, `applyPragmas(db)` from `server/metricsSchema.js`.
- Produces: tables `users`, `sessions`, `audit_log` (DDL below — spec Appendix A); `migrate(db)` now throws `Error` containing `"newer"` when `user_version` exceeds the latest migration; exported `_backupBeforeMigration(db, fromVersion)` returning backup path or `null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/metricsSchema.test.js` (follow the existing imports at the top of that file — it already requires `better-sqlite3` and the schema module; add `fs`, `os`, `path` requires if not present):

```js
describe('migration v3: auth + audit', () => {
  it('creates users, sessions, audit_log with indexes', () => {
    const db = new Database(':memory:');
    schema.applyPragmas(db);
    schema.migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'sessions', 'audit_log']));
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(r => r.name);
    expect(idx).toEqual(expect.arrayContaining([
      'idx_sessions_expires', 'idx_sessions_user',
      'idx_audit_ts', 'idx_audit_user_ts', 'idx_audit_action_ts',
    ]));
    db.close();
  });

  it('enforces role CHECK constraint on users', () => {
    const db = new Database(':memory:');
    schema.applyPragmas(db);
    schema.migrate(db);
    const ins = db.prepare(`INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
    expect(() => ins.run('a', 'h', 'superuser', 1, 1)).toThrow();
    expect(() => ins.run('a', 'h', 'admin', 1, 1)).not.toThrow();
    db.close();
  });

  it('refuses to run against a DB newer than the code', () => {
    const db = new Database(':memory:');
    schema.applyPragmas(db);
    db.pragma('user_version = 99');
    expect(() => schema.migrate(db)).toThrow(/newer/);
    db.close();
  });

  it('skips backup for a brand-new DB, creates one when upgrading a file-backed DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-bk-'));
    const file = path.join(dir, 'm.db');
    const db1 = new Database(file);
    schema.applyPragmas(db1);
    schema.migrate(db1);            // fresh DB: no backup expected
    db1.close();
    expect(fs.readdirSync(dir).filter(f => f.includes('.backup'))).toHaveLength(0);

    const db2 = new Database(file);
    const dest = schema._backupBeforeMigration(db2, 3);   // direct call: simulates a pending upgrade
    db2.close();
    expect(dest).toMatch(/\.v3\.\d+\.backup$/);
    expect(fs.existsSync(dest)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null (no backup) for in-memory DBs', () => {
    const db = new Database(':memory:');
    expect(schema._backupBeforeMigration(db, 2)).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/metricsSchema.test.js`
Expected: FAIL — `user_version` is 2 not 3, `_backupBeforeMigration` undefined, no "newer" throw.

- [ ] **Step 3: Implement migration v3, backup, refusal**

In `server/metricsSchema.js`, add at the top (after `'use strict';`):

```js
const fs = require('fs');
const path = require('path');
```

Append to the `MIGRATIONS` array (after the version-2 entry):

```js
  {
    version: 3,
    description: 'auth + audit: users, sessions, audit_log tables',
    up(db) {
      db.exec(`
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
      `);
    },
  },
```

Replace the existing `migrate(db)` function with:

```js
function _backupBeforeMigration(db, fromVersion) {
  if (db.memory || !db.name || db.name === ':memory:') return null;
  const dbSize = fs.statSync(db.name).size;
  try {
    const st = fs.statfsSync(path.dirname(path.resolve(db.name)));
    if (st.bavail * st.bsize < dbSize * 1.5) {
      throw new Error(
        `[metrics-db] not enough free disk space for pre-migration backup ` +
        `(need ~${Math.ceil((dbSize * 1.5) / 1e6)} MB free). Migration aborted.`);
    }
  } catch (err) {
    if (/not enough free disk space/.test(err.message)) throw err;
    // statfs unavailable on this platform/Node build — proceed without the check
  }
  const dest = `${db.name}.v${fromVersion}.${Date.now()}.backup`;
  db.prepare('VACUUM INTO ?').run(dest);
  console.log(`[metrics-db] pre-migration backup written: ${dest}`);
  console.log(`[metrics-db] rollback procedure: stop the service, delete ${db.name} plus its -wal/-shm files, copy the backup file to ${db.name}, reinstall the previous application version.`);
  return dest;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT NOT NULL
  )`);
  let current = db.pragma('user_version', { simple: true });
  const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
  if (current > latest) {
    throw new Error(
      `[metrics-db] database schema version ${current} is newer than this build supports (${latest}); ` +
      `downgrade is not supported — restore a pre-migration backup or upgrade the application`);
  }
  const pending = MIGRATIONS.filter(m => m.version > current);
  if (pending.length > 0 && current > 0) _backupBeforeMigration(db, current);
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)')
        .run(m.version, Date.now(), m.description);
      db.pragma(`user_version = ${m.version}`);
    })();
    current = m.version;
  }
}
```

Update the module exports line to include `_backupBeforeMigration`:

```js
module.exports = { KPI_COLUMNS, MIGRATIONS, applyPragmas, migrate, _backupBeforeMigration, rawTableDDL, rollupTableDDL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/metricsSchema.test.js` — expected PASS.
Then run: `npx vitest run` — full suite must stay green (metricsStore tests migrate to v3 transparently).

- [ ] **Step 5: Commit**

```bash
git add server/metricsSchema.js tests/server/metricsSchema.test.js
git commit -m "feat(auth): migration v3 (users/sessions/audit_log), pre-migration backup, newer-DB refusal"
```

---

### Task 2: Auth store (users + bcrypt)

**Files:**
- Create: `server/auth/authStore.js`
- Test: `tests/server/authStore.test.js`
- Modify: `package.json` (via `npm install bcryptjs`)

**Interfaces:**
- Consumes: a `better-sqlite3` `db` already migrated to v3.
- Produces: `createAuthStore(db, { bcryptCost = 12 } = {})` returning:
  - `async createUser({ username, password, role })` → `{ id, username, role, disabled, created_at, updated_at }` (never `password_hash`)
  - `async verifyPassword(username, password)` → user object or `null` (null for wrong password, unknown user, or disabled user)
  - `getUserById(id)`, `getUserByUsername(username)` → user or `null`
  - `listUsers()` → array (no hashes)
  - `countUsers()` → number
  - `async setPassword(id, password)`, `setRole(id, role)`, `setDisabled(id, disabled)`
  - Exported constants: `ROLES = ['viewer','operator','admin']`, `BCRYPT_COST = 12`

- [ ] **Step 1: Install dependency**

Run: `npm install bcryptjs`
Then: `git add package.json package-lock.json` (stage now, commit with the task).

- [ ] **Step 2: Write the failing tests**

Create `tests/server/authStore.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const Database = require('better-sqlite3');
const schema = require('../../server/metricsSchema');
const { createAuthStore, ROLES } = require('../../server/auth/authStore');

function freshStore() {
  const db = new Database(':memory:');
  schema.applyPragmas(db);
  schema.migrate(db);
  return createAuthStore(db, { bcryptCost: 4 });   // low cost: keep tests fast
}

describe('authStore', () => {
  let store;
  beforeEach(() => { store = freshStore(); });

  it('creates a user and never exposes password_hash', async () => {
    const u = await store.createUser({ username: 'alice', password: 'longenough1', role: 'admin' });
    expect(u).toMatchObject({ username: 'alice', role: 'admin', disabled: 0 });
    expect(u.password_hash).toBeUndefined();
    expect(store.countUsers()).toBe(1);
  });

  it('rejects invalid roles and short passwords', async () => {
    await expect(store.createUser({ username: 'x', password: 'longenough1', role: 'root' })).rejects.toThrow(/role/);
    await expect(store.createUser({ username: 'x', password: 'short', role: 'viewer' })).rejects.toThrow(/8 characters/);
  });

  it('rejects duplicate usernames case-insensitively', async () => {
    await store.createUser({ username: 'Bob', password: 'longenough1', role: 'viewer' });
    await expect(store.createUser({ username: 'bob', password: 'longenough1', role: 'viewer' })).rejects.toThrow();
  });

  it('verifyPassword: correct → user, wrong/unknown/disabled → null', async () => {
    const u = await store.createUser({ username: 'carol', password: 'longenough1', role: 'operator' });
    expect((await store.verifyPassword('carol', 'longenough1')).id).toBe(u.id);
    expect(await store.verifyPassword('carol', 'wrongpass99')).toBeNull();
    expect(await store.verifyPassword('nobody', 'longenough1')).toBeNull();
    store.setDisabled(u.id, true);
    expect(await store.verifyPassword('carol', 'longenough1')).toBeNull();
  });

  it('setPassword replaces the credential', async () => {
    const u = await store.createUser({ username: 'dave', password: 'longenough1', role: 'viewer' });
    await store.setPassword(u.id, 'newpassword2');
    expect(await store.verifyPassword('dave', 'longenough1')).toBeNull();
    expect((await store.verifyPassword('dave', 'newpassword2')).id).toBe(u.id);
  });

  it('setRole validates against ROLES', async () => {
    const u = await store.createUser({ username: 'erin', password: 'longenough1', role: 'viewer' });
    store.setRole(u.id, 'admin');
    expect(store.getUserById(u.id).role).toBe('admin');
    expect(() => store.setRole(u.id, 'god')).toThrow(/role/);
    expect(ROLES).toEqual(['viewer', 'operator', 'admin']);
  });

  it('listUsers returns no hashes', async () => {
    await store.createUser({ username: 'f', password: 'longenough1', role: 'viewer' });
    expect(store.listUsers()[0].password_hash).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/authStore.test.js`
Expected: FAIL — `Cannot find module '../../server/auth/authStore'`.

- [ ] **Step 4: Implement `server/auth/authStore.js`**

```js
'use strict';
const bcrypt = require('bcryptjs');

const BCRYPT_COST = 12;
const ROLES = ['viewer', 'operator', 'admin'];

function createAuthStore(db, { bcryptCost = BCRYPT_COST } = {}) {
  const stmts = {
    insert: db.prepare(`INSERT INTO users (username, password_hash, role, disabled, created_at, updated_at)
                        VALUES (?, ?, ?, 0, ?, ?)`),
    byName: db.prepare(`SELECT * FROM users WHERE username = ?`),
    byId: db.prepare(`SELECT * FROM users WHERE id = ?`),
    list: db.prepare(`SELECT id, username, role, disabled, created_at, updated_at FROM users ORDER BY username`),
    count: db.prepare(`SELECT COUNT(*) AS n FROM users`),
    setPassword: db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`),
    setRole: db.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`),
    setDisabled: db.prepare(`UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?`),
  };

  function sanitize(u) {
    if (!u) return null;
    const { password_hash, ...rest } = u;
    return rest;
  }

  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('password must be at least 8 characters');
    }
  }

  return {
    async createUser({ username, password, role }) {
      if (!ROLES.includes(role)) throw new Error(`invalid role: ${String(role)}`);
      if (typeof username !== 'string' || !username.trim() || username.length > 100) {
        throw new Error('invalid username (1-100 characters required)');
      }
      validatePassword(password);
      const hash = await bcrypt.hash(password, bcryptCost);
      const now = Date.now();
      const info = stmts.insert.run(username.trim(), hash, role, now, now);
      return sanitize(stmts.byId.get(info.lastInsertRowid));
    },

    async verifyPassword(username, password) {
      const u = stmts.byName.get(String(username ?? ''));
      // Hash even for unknown users so response timing does not reveal existence.
      const hash = u ? u.password_hash : '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalids';
      const ok = await bcrypt.compare(String(password ?? ''), hash);
      if (!u || u.disabled || !ok) return null;
      return sanitize(u);
    },

    getUserById(id) { return sanitize(stmts.byId.get(id)); },
    getUserByUsername(username) { return sanitize(stmts.byName.get(String(username ?? ''))); },
    listUsers() { return stmts.list.all(); },
    countUsers() { return stmts.count.get().n; },

    async setPassword(id, password) {
      validatePassword(password);
      const hash = await bcrypt.hash(password, bcryptCost);
      stmts.setPassword.run(hash, Date.now(), id);
    },
    setRole(id, role) {
      if (!ROLES.includes(role)) throw new Error(`invalid role: ${String(role)}`);
      stmts.setRole.run(role, Date.now(), id);
    },
    setDisabled(id, disabled) { stmts.setDisabled.run(disabled ? 1 : 0, Date.now(), id); },
  };
}

module.exports = { createAuthStore, ROLES, BCRYPT_COST };
```

(The `users.username` column is `COLLATE NOCASE`, so `WHERE username = ?` is already case-insensitive — no extra collation needed in the query.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/authStore.test.js` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/auth/authStore.js tests/server/authStore.test.js
git commit -m "feat(auth): user store with bcrypt hashing and role validation"
```

---

### Task 3: Custom SQLite session store

**Files:**
- Create: `server/auth/sessionStore.js`
- Test: `tests/server/sessionStore.test.js`
- Modify: `package.json` (via `npm install express-session`)

**Interfaces:**
- Consumes: migrated `db` (needs `sessions` table from Task 1); `Store` base class from `express-session`.
- Produces: `class SQLiteSessionStore extends Store` with express-session contract methods `get(sid, cb)`, `set(sid, session, cb)`, `touch(sid, session, cb)`, `destroy(sid, cb)` plus custom `destroyByUserId(userId)` → number of sessions removed, and `pruneExpired(now?)` → number pruned. Constructor: `new SQLiteSessionStore(db, { ttlMs = 12*60*60*1000, touchIntervalMs = 5*60*1000 } = {})`. Sessions without `session.userId` are **never persisted** (no anonymous rows; `user_id` is NOT NULL).
- Exported constants: `DEFAULT_TTL_MS`, `TOUCH_INTERVAL_MS`.

- [ ] **Step 1: Install dependency**

Run: `npm install express-session`

- [ ] **Step 2: Write the failing tests**

Create `tests/server/sessionStore.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, vi } = require('vitest');
const Database = require('better-sqlite3');
const schema = require('../../server/metricsSchema');
const { SQLiteSessionStore } = require('../../server/auth/sessionStore');

function fresh() {
  const db = new Database(':memory:');
  schema.applyPragmas(db);
  schema.migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
              VALUES (1, 'u', 'h', 'admin', 1, 1)`).run();
  return { db, store: new SQLiteSessionStore(db, { ttlMs: 60_000, touchIntervalMs: 10_000 }) };
}

const sess = (userId, maxAge) => ({ userId, cookie: maxAge ? { maxAge } : {} });

function getAsync(store, sid) {
  return new Promise((res, rej) => store.get(sid, (e, s) => (e ? rej(e) : res(s))));
}
function setAsync(store, sid, s) {
  return new Promise((res, rej) => store.set(sid, s, e => (e ? rej(e) : res())));
}

describe('SQLiteSessionStore', () => {
  let db, store;
  beforeEach(() => { ({ db, store } = fresh()); });

  it('set then get round-trips a session', async () => {
    await setAsync(store, 'sid1', sess(1));
    const got = await getAsync(store, 'sid1');
    expect(got.userId).toBe(1);
  });

  it('never persists sessions without a userId', async () => {
    await setAsync(store, 'anon', { cookie: {} });
    expect(await getAsync(store, 'anon')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it('get returns null for expired sessions', async () => {
    vi.useFakeTimers();
    await setAsync(store, 'sid1', sess(1, 1000));
    vi.advanceTimersByTime(2000);
    expect(await getAsync(store, 'sid1')).toBeNull();
    vi.useRealTimers();
  });

  it('destroy removes the session', async () => {
    await setAsync(store, 'sid1', sess(1));
    await new Promise(res => store.destroy('sid1', res));
    expect(await getAsync(store, 'sid1')).toBeNull();
  });

  it('destroyByUserId revokes all of a user\'s sessions in one call', async () => {
    await setAsync(store, 'a', sess(1));
    await setAsync(store, 'b', sess(1));
    expect(store.destroyByUserId(1)).toBe(2);
    expect(await getAsync(store, 'a')).toBeNull();
  });

  it('touch is throttled: no expiry write within touchIntervalMs', async () => {
    vi.useFakeTimers();
    await setAsync(store, 'sid1', sess(1, 60_000));
    const before = db.prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('sid1').expires_at;
    vi.advanceTimersByTime(5_000);   // < touchIntervalMs (10s)
    await new Promise(res => store.touch('sid1', sess(1, 60_000), res));
    expect(db.prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('sid1').expires_at).toBe(before);
    vi.advanceTimersByTime(6_000);   // now past the throttle window
    await new Promise(res => store.touch('sid1', sess(1, 60_000), res));
    expect(db.prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('sid1').expires_at).toBeGreaterThan(before);
    vi.useRealTimers();
  });

  it('pruneExpired deletes only expired rows', async () => {
    vi.useFakeTimers();
    await setAsync(store, 'old', sess(1, 1000));
    await setAsync(store, 'new', sess(1, 100_000));
    vi.advanceTimersByTime(2000);
    expect(store.pruneExpired()).toBe(1);
    expect(await getAsync(store, 'new')).not.toBeNull();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/sessionStore.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `server/auth/sessionStore.js`**

```js
'use strict';
const { Store } = require('express-session');

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;   // 12h sliding window
// Throttle expiry refreshes so 2s dashboard polling does not hammer SQLite.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

class SQLiteSessionStore extends Store {
  constructor(db, { ttlMs = DEFAULT_TTL_MS, touchIntervalMs = TOUCH_INTERVAL_MS } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.touchIntervalMs = touchIntervalMs;
    this.lastTouch = new Map();
    this.stmts = {
      get: db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?'),
      set: db.prepare(`INSERT INTO sessions (sid, user_id, expires_at, data) VALUES (?, ?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id,
                         expires_at = excluded.expires_at, data = excluded.data`),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      destroyByUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
      pruneExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    };
  }

  _expiry(session) {
    const maxAge = session?.cookie?.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : this.ttlMs);
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) { cb(err); }
  }

  set(sid, session, cb = () => {}) {
    try {
      if (!session?.userId) return cb(null);   // sessions.user_id is NOT NULL: only logged-in sessions persist
      this.stmts.set.run(sid, session.userId, this._expiry(session), JSON.stringify(session));
      this.lastTouch.set(sid, Date.now());
      cb(null);
    } catch (err) { cb(err); }
  }

  touch(sid, session, cb = () => {}) {
    const last = this.lastTouch.get(sid) || 0;
    if (Date.now() - last < this.touchIntervalMs) return cb(null);
    try {
      this.stmts.touch.run(this._expiry(session), sid);
      this.lastTouch.set(sid, Date.now());
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.stmts.destroy.run(sid);
      this.lastTouch.delete(sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  destroyByUserId(userId) { return this.stmts.destroyByUser.run(userId).changes; }

  pruneExpired(now = Date.now()) {
    const changes = this.stmts.pruneExpired.run(now).changes;
    if (changes > 0) {
      for (const [sid, t] of this.lastTouch) {
        if (now - t > this.ttlMs * 2) this.lastTouch.delete(sid);
      }
    }
    return changes;
  }
}

module.exports = { SQLiteSessionStore, DEFAULT_TTL_MS, TOUCH_INTERVAL_MS };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/sessionStore.test.js` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/auth/sessionStore.js tests/server/sessionStore.test.js
git commit -m "feat(auth): custom SQLite session store with throttled touch and revoke-by-user"
```

---

### Task 4: Auth middleware + login rate limiter

**Files:**
- Create: `server/auth/middleware.js`
- Create: `server/auth/rateLimiter.js`
- Test: `tests/server/authMiddleware.test.js`

**Interfaces:**
- Consumes: `getUserById(id)` (Task 2 shape: `{ id, username, role, disabled }` or `null`).
- Produces:
  - `createAuthMiddleware({ getUserById, authDisabled = false, onAuthzDenied = () => {} })` → `{ requireAuth, requireRole }`. `requireAuth` sets `req.user`; with `authDisabled` it injects `{ id: 0, username: 'dev', role: 'admin' }`. `requireRole(role)` is hierarchical (admin ≥ operator ≥ viewer); on 403 it calls `onAuthzDenied(req, role)` (Task 11 wires this to the audit log).
  - `ROLE_RANK = { viewer: 1, operator: 2, admin: 3 }`
  - `createRateLimiter({ maxFailures = 5, windowMs = 15*60*1000, lockoutMs = 15*60*1000, now = Date.now })` → `{ isLocked(username, ip), recordFailure(username, ip) → boolean (true when this failure trips the lockout), recordSuccess(username, ip) }`. Keyed on lowercased-username + IP. In-memory (restart clears it — acceptable per spec).

- [ ] **Step 1: Write the failing tests**

Create `tests/server/authMiddleware.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createAuthMiddleware, ROLE_RANK } = require('../../server/auth/middleware');
const { createRateLimiter } = require('../../server/auth/rateLimiter');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}
const users = {
  1: { id: 1, username: 'v', role: 'viewer', disabled: 0 },
  2: { id: 2, username: 'o', role: 'operator', disabled: 0 },
  3: { id: 3, username: 'a', role: 'admin', disabled: 0 },
  4: { id: 4, username: 'd', role: 'admin', disabled: 1 },
};
const getUserById = id => users[id] || null;

describe('requireAuth', () => {
  const { requireAuth } = createAuthMiddleware({ getUserById });

  it('401 without a session', () => {
    const res = mockRes(); const next = vi.fn();
    requireAuth({ session: undefined }, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches req.user for a valid session', () => {
    const req = { session: { userId: 2 } }; const next = vi.fn();
    requireAuth(req, mockRes(), next);
    expect(req.user.role).toBe('operator');
    expect(next).toHaveBeenCalled();
  });

  it('401 + destroys session for disabled or deleted users', () => {
    const destroy = vi.fn(cb => cb && cb());
    const res = mockRes();
    requireAuth({ session: { userId: 4, destroy } }, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(destroy).toHaveBeenCalled();
  });

  it('authDisabled injects a dev admin', () => {
    const { requireAuth: open } = createAuthMiddleware({ getUserById, authDisabled: true });
    const req = {}; const next = vi.fn();
    open(req, mockRes(), next);
    expect(req.user.role).toBe('admin');
    expect(next).toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  it('enforces the full permission matrix hierarchically', () => {
    const { requireRole } = createAuthMiddleware({ getUserById });
    const cases = [
      // [userRole, requiredRole, allowed]
      ['viewer', 'viewer', true], ['viewer', 'operator', false], ['viewer', 'admin', false],
      ['operator', 'viewer', true], ['operator', 'operator', true], ['operator', 'admin', false],
      ['admin', 'viewer', true], ['admin', 'operator', true], ['admin', 'admin', true],
    ];
    for (const [userRole, required, allowed] of cases) {
      const res = mockRes(); const next = vi.fn();
      requireRole(required)({ user: { id: 9, role: userRole } }, res, next);
      expect(next.mock.calls.length > 0, `${userRole} vs ${required}`).toBe(allowed);
      if (!allowed) expect(res.statusCode).toBe(403);
    }
    expect(ROLE_RANK).toEqual({ viewer: 1, operator: 2, admin: 3 });
  });

  it('calls onAuthzDenied on 403', () => {
    const onAuthzDenied = vi.fn();
    const { requireRole } = createAuthMiddleware({ getUserById, onAuthzDenied });
    const req = { user: { id: 1, role: 'viewer' } };
    requireRole('admin')(req, mockRes(), vi.fn());
    expect(onAuthzDenied).toHaveBeenCalledWith(req, 'admin');
  });
});

describe('rate limiter', () => {
  it('locks after maxFailures within the window and reports the tripping failure', () => {
    let t = 0;
    const rl = createRateLimiter({ maxFailures: 3, windowMs: 1000, lockoutMs: 5000, now: () => t });
    expect(rl.recordFailure('U', 'ip')).toBe(false);
    expect(rl.recordFailure('u', 'ip')).toBe(false);      // case-insensitive key
    expect(rl.recordFailure('u', 'ip')).toBe(true);       // trips
    expect(rl.isLocked('U', 'ip')).toBe(true);
    t = 6000;
    expect(rl.isLocked('u', 'ip')).toBe(false);           // lockout expired
  });

  it('window slides: old failures do not count', () => {
    let t = 0;
    const rl = createRateLimiter({ maxFailures: 2, windowMs: 1000, lockoutMs: 5000, now: () => t });
    rl.recordFailure('u', 'ip');
    t = 2000;
    expect(rl.recordFailure('u', 'ip')).toBe(false);
  });

  it('success clears the counter; separate IPs are separate keys', () => {
    const rl = createRateLimiter({ maxFailures: 2, windowMs: 60_000, lockoutMs: 60_000 });
    rl.recordFailure('u', 'ip1');
    rl.recordSuccess('u', 'ip1');
    expect(rl.recordFailure('u', 'ip1')).toBe(false);
    rl.recordFailure('u', 'ip2');
    expect(rl.isLocked('u', 'ip1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/authMiddleware.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both modules**

Create `server/auth/rateLimiter.js`:

```js
'use strict';

function createRateLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000,
                             lockoutMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();   // key -> { failures: [ts], lockedUntil }
  const key = (username, ip) => `${String(username ?? '').toLowerCase()}|${ip ?? ''}`;

  return {
    isLocked(username, ip) {
      const e = entries.get(key(username, ip));
      return !!(e && e.lockedUntil > now());
    },
    recordFailure(username, ip) {
      const k = key(username, ip);
      const t = now();
      const e = entries.get(k) || { failures: [], lockedUntil: 0 };
      e.failures = e.failures.filter(ts => t - ts < windowMs);
      e.failures.push(t);
      let tripped = false;
      if (e.failures.length >= maxFailures && e.lockedUntil <= t) {
        e.lockedUntil = t + lockoutMs;
        e.failures = [];
        tripped = true;
      }
      entries.set(k, e);
      return tripped;
    },
    recordSuccess(username, ip) { entries.delete(key(username, ip)); },
  };
}

module.exports = { createRateLimiter };
```

Create `server/auth/middleware.js`:

```js
'use strict';

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

function createAuthMiddleware({ getUserById, authDisabled = false, onAuthzDenied = () => {} }) {
  function requireAuth(req, res, next) {
    if (authDisabled) {
      req.user = { id: 0, username: 'dev', role: 'admin' };
      return next();
    }
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });
    const user = getUserById(userId);
    if (!user || user.disabled) {
      req.session.destroy?.(() => {});
      return res.status(401).json({ error: 'Authentication required.' });
    }
    req.user = user;
    next();
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
      if ((ROLE_RANK[req.user.role] || 0) >= (ROLE_RANK[role] || Infinity)) return next();
      onAuthzDenied(req, role);
      res.status(403).json({ error: 'Insufficient permissions.' });
    };
  }

  return { requireAuth, requireRole };
}

module.exports = { createAuthMiddleware, ROLE_RANK };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/authMiddleware.test.js` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth/middleware.js server/auth/rateLimiter.js tests/server/authMiddleware.test.js
git commit -m "feat(auth): requireAuth/requireRole middleware and per-username+IP login rate limiter"
```

---

### Task 5: Bootstrap token + auth routes

**Files:**
- Create: `server/auth/bootstrap.js`
- Create: `server/auth/routes.js`
- Test: `tests/server/authBootstrap.test.js`

**Interfaces:**
- Consumes: `authStore` (Task 2), `rateLimiter` (Task 4).
- Produces:
  - `createBootstrap({ authStore, dataDir })` → `{ required(), ensureToken(), verifyToken(candidate), clearToken(), async complete({ token, username, password }), _tokenFile }`. `ensureToken()` generates a fresh token **only while the users table is empty** (regenerates every restart — stale tokens from rotated logs are never live), writes it to `bootstrap-token.txt` in `dataDir`, prints a console banner. `complete()` throws `{ status: 409 }` if users exist, `{ status: 403 }` on bad token; on success creates the admin, deletes the token file, clears the token.
  - `createAuthRouter({ authStore, bootstrap, rateLimiter, authDisabled = false, audit = () => {} })` → Express router with `GET /status`, `POST /bootstrap`, `POST /login`, `POST /logout`, `GET /me`. The `audit` parameter is a no-op until Task 11 wires the real helper. Login regenerates the session (fixation defense) and stores `req.session.userId`. Failed login is a generic 401 (no username enumeration); locked-out login is 429.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/authBootstrap.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const schema = require('../../server/metricsSchema');
const { createAuthStore } = require('../../server/auth/authStore');
const { createBootstrap } = require('../../server/auth/bootstrap');

describe('bootstrap', () => {
  let dir, db, authStore, bootstrap;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));
    db = new Database(':memory:');
    schema.applyPragmas(db);
    schema.migrate(db);
    authStore = createAuthStore(db, { bcryptCost: 4 });
    bootstrap = createBootstrap({ authStore, dataDir: dir });
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('required() is true only while users table is empty', async () => {
    expect(bootstrap.required()).toBe(true);
    await authStore.createUser({ username: 'a', password: 'longenough1', role: 'admin' });
    expect(bootstrap.required()).toBe(false);
  });

  it('ensureToken writes the token file and returns the token', () => {
    const token = bootstrap.ensureToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(fs.readFileSync(bootstrap._tokenFile, 'utf8').trim()).toBe(token);
  });

  it('ensureToken is a no-op (and clears any file) once users exist', async () => {
    bootstrap.ensureToken();
    await authStore.createUser({ username: 'a', password: 'longenough1', role: 'admin' });
    expect(bootstrap.ensureToken()).toBeNull();
    expect(fs.existsSync(bootstrap._tokenFile)).toBe(false);
  });

  it('complete() without a valid token fails with 403 and creates no user', async () => {
    bootstrap.ensureToken();
    await expect(bootstrap.complete({ token: 'wrong', username: 'a', password: 'longenough1' }))
      .rejects.toMatchObject({ status: 403 });
    expect(authStore.countUsers()).toBe(0);
  });

  it('complete() with the token creates the admin, deletes the file, one-shot only', async () => {
    const token = bootstrap.ensureToken();
    const user = await bootstrap.complete({ token, username: 'root', password: 'longenough1' });
    expect(user.role).toBe('admin');
    expect(fs.existsSync(bootstrap._tokenFile)).toBe(false);
    await expect(bootstrap.complete({ token, username: 'x', password: 'longenough1' }))
      .rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/authBootstrap.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/auth/bootstrap.js`**

```js
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createBootstrap({ authStore, dataDir }) {
  const tokenFile = path.join(dataDir, 'bootstrap-token.txt');
  let token = null;

  function required() { return authStore.countUsers() === 0; }

  function clearToken() {
    token = null;
    try { fs.rmSync(tokenFile, { force: true }); } catch { /* ignore */ }
  }

  function ensureToken() {
    if (!required()) { clearToken(); return null; }
    token = crypto.randomBytes(24).toString('base64url');
    try {
      fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    } catch (err) {
      console.warn('[auth] could not write bootstrap token file:', err.message);
    }
    console.log('='.repeat(72));
    console.log('[auth] No users exist yet. Create the first admin account in the UI');
    console.log(`[auth] using this ONE-TIME bootstrap token (also in ${tokenFile}):`);
    console.log(`[auth]     ${token}`);
    console.log('[auth] The token regenerates on every restart until an admin exists.');
    console.log('='.repeat(72));
    return token;
  }

  function verifyToken(candidate) {
    if (!token || typeof candidate !== 'string' || !candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function complete({ token: candidate, username, password }) {
    if (!required()) throw Object.assign(new Error('Bootstrap already completed.'), { status: 409 });
    if (!verifyToken(candidate)) throw Object.assign(new Error('Invalid bootstrap token.'), { status: 403 });
    const user = await authStore.createUser({ username, password, role: 'admin' });
    clearToken();
    return user;
  }

  return { required, ensureToken, verifyToken, clearToken, complete, _tokenFile: tokenFile };
}

module.exports = { createBootstrap };
```

- [ ] **Step 4: Run bootstrap tests**

Run: `npx vitest run tests/server/authBootstrap.test.js` — expected PASS.

- [ ] **Step 5: Implement `server/auth/routes.js`** (route-level tests come in Task 6's HTTP harness — this module is exercised there)

```js
'use strict';
const express = require('express');

function publicUser(u) { return { id: u.id, username: u.username, role: u.role }; }

function createAuthRouter({ authStore, bootstrap, rateLimiter, authDisabled = false, audit = () => {} }) {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    if (authDisabled) return res.json({ bootstrapRequired: false, authDisabled: true });
    res.json({ bootstrapRequired: bootstrap.required(), authDisabled: false });
  });

  router.get('/me', (req, res) => {
    if (authDisabled) return res.json({ user: { id: 0, username: 'dev', role: 'admin' } });
    const userId = req.session?.userId;
    const user = userId ? authStore.getUserById(userId) : null;
    if (!user || user.disabled) return res.status(401).json({ error: 'Authentication required.' });
    res.json({ user: publicUser(user) });
  });

  if (authDisabled) return router;   // login/logout/bootstrap meaningless without auth

  router.post('/bootstrap', async (req, res) => {
    const { token, username, password } = req.body || {};
    const uname = String(username ?? '').slice(0, 100);
    // The token is the only secret protecting first-admin creation: rate-limit guesses per IP.
    if (rateLimiter.isLocked('__bootstrap__', req.ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    try {
      const user = await bootstrap.complete({ token, username: uname, password });
      req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'Session error.' });
        req.session.userId = user.id;
        req.user = user;
        audit(req, 'admin.bootstrap', user.username, {}, 'success');
        res.json({ user: publicUser(user) });
      });
    } catch (err) {
      rateLimiter.recordFailure('__bootstrap__', req.ip);
      audit(req, 'admin.bootstrap', uname, { reason: err.message }, 'failure');
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    const uname = String(username ?? '').slice(0, 100);
    if (rateLimiter.isLocked(uname, req.ip)) {
      audit(req, 'login.failure', uname, { reason: 'locked' }, 'failure');
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }
    const user = await authStore.verifyPassword(uname, String(password ?? ''));
    if (!user) {
      const tripped = rateLimiter.recordFailure(uname, req.ip);
      audit(req, 'login.failure', uname, {}, 'failure');
      if (tripped) audit(req, 'login.lockout', uname, {}, 'failure');
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    rateLimiter.recordSuccess(uname, req.ip);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Session error.' });
      req.session.userId = user.id;
      req.user = user;
      audit(req, 'login.success', user.username, {}, 'success');
      res.json({ user: publicUser(user) });
    });
  });

  router.post('/logout', (req, res) => {
    const userId = req.session?.userId;
    const user = userId ? authStore.getUserById(userId) : null;
    if (user) {
      req.user = user;
      audit(req, 'logout', user.username, {}, 'success');
    }
    req.session?.destroy(() => {
      res.clearCookie('sam.sid');
      res.json({ ok: true });
    });
  });

  return router;
}

module.exports = { createAuthRouter };
```

- [ ] **Step 6: Full suite check + commit**

Run: `npx vitest run` — green.

```bash
git add server/auth/bootstrap.js server/auth/routes.js tests/server/authBootstrap.test.js
git commit -m "feat(auth): one-time bootstrap token flow and auth routes (login/logout/me/status/bootstrap)"
```

---

### Task 6: Wire auth into server.js — gate all REST routes + role gates

**Files:**
- Create: `server/auth/wire.js` (assembly helper so the integration test and server.js share one code path)
- Modify: `server.js` (auth block after `metricsStore.initialize` at ~line 108; role gates on route definitions at lines ~786–1240 — **search by route path, line numbers shift**)
- Test: `tests/server/authHttp.test.js` (real HTTP integration via ephemeral port + global `fetch`)

**Interfaces:**
- Consumes: everything from Tasks 2–5; `metricsStore._db()` (already exported from `server/metricsStore.js`); `meta` table (migration v1) for the generated session secret.
- Produces: `wireAuth({ app, db, dataDir, authDisabled, sessionSecret?, bcryptCost?, audit? })` → `{ authStore, sessionStore, bootstrap, rateLimiter, sessionMiddleware, requireAuth, requireRole, setOnAuthzDenied(fn) }`. It registers, in order: session middleware → `/api/auth` router → `app.use('/api', requireAuth)`. Everything registered on `app` **after** the call is gated. `server.js` exposes `requireRole` for per-route gates.

**Role gate assignment (spec §2 permission matrix):**

| Route (server.js) | Gate |
|---|---|
| `POST /api/connect` | `requireRole('admin')` |
| `DELETE /api/disconnect/:id` | `requireRole('admin')` |
| `POST /api/connections/:id/kill-sleeping` | `requireRole('operator')` |
| `POST /api/connections/:id/kill` | `requireRole('operator')` |
| `POST /api/connections/:id/jobs/:action` | `requireRole('operator')` |
| `POST /api/connections/:id/alerts/:alertId/ack` | `requireRole('operator')` |
| `POST /api/connections/:id/index-health/scan` | `requireRole('operator')` |
| `DELETE /api/connections/:id/index-health/scan/:scanId` | `requireRole('operator')` |
| everything else under `/api` (all GETs, `POST /api/refresh/*`) | `requireAuth` only (viewer) |

- [ ] **Step 1: Write the failing integration tests**

Create `tests/server/authHttp.test.js`:

```js
'use strict';
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('../../server/metricsSchema');
const { wireAuth } = require('../../server/auth/wire');

let server, base, ctx, dir;

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}
async function post(url, body, cookie) {
  return fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}
async function get(url, cookie) {
  return fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} });
}
async function loginAs(username, password) {
  const res = await post('/api/auth/login', { username, password });
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authhttp-'));
  const db = new Database(':memory:');
  schema.applyPragmas(db);
  schema.migrate(db);
  const app = express();
  app.use(express.json());
  ctx = wireAuth({ app, db, dataDir: dir, authDisabled: false, sessionSecret: 'test-secret', bcryptCost: 4 });
  // Representative gated routes mirroring server.js gate assignments:
  app.get('/api/viewer-thing', (_req, res) => res.json({ ok: true }));
  app.post('/api/op-thing', ctx.requireRole('operator'), (_req, res) => res.json({ ok: true }));
  app.post('/api/admin-thing', ctx.requireRole('admin'), (_req, res) => res.json({ ok: true }));
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(res => { server.close(res); fs.rmSync(dir, { recursive: true, force: true }); }));

describe('auth HTTP integration', () => {
  it('every /api route is 401 before bootstrap; /api/auth/status is open', async () => {
    expect((await get('/api/viewer-thing')).status).toBe(401);
    const st = await get('/api/auth/status');
    expect(st.status).toBe(200);
    expect((await st.json()).bootstrapRequired).toBe(true);
  });

  it('bootstrap WITHOUT the token must fail; with it, creates admin + session', async () => {
    const bad = await post('/api/auth/bootstrap', { token: 'nope', username: 'root', password: 'longenough1' });
    expect(bad.status).toBe(403);

    const token = ctx.bootstrap.ensureToken();
    const good = await post('/api/auth/bootstrap', { token, username: 'root', password: 'longenough1' });
    expect(good.status).toBe(200);
    const cookie = cookieFrom(good);
    expect(cookie).toMatch(/^sam\.sid=/);
    const me = await get('/api/auth/me', cookie);
    expect((await me.json()).user).toMatchObject({ username: 'root', role: 'admin' });
  });

  it('login → cookie → gated endpoint → logout → 401 (full session lifecycle)', async () => {
    const cookie = await loginAs('root', 'longenough1');
    expect((await get('/api/viewer-thing', cookie)).status).toBe(200);
    await post('/api/auth/logout', {}, cookie);
    expect((await get('/api/viewer-thing', cookie)).status).toBe(401);
  });

  it('failed login is a generic 401; repeated failures lock out with 429', async () => {
    const res = await post('/api/auth/login', { username: 'root', password: 'wrongwrong' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).not.toMatch(/user|name/i);   // no enumeration hint
    for (let i = 0; i < 5; i++) await post('/api/auth/login', { username: 'lockme', password: 'wrongwrong' });
    const locked = await post('/api/auth/login', { username: 'lockme', password: 'wrongwrong' });
    expect(locked.status).toBe(429);
  });

  it('enforces the permission matrix over HTTP', async () => {
    const admin = await loginAs('root', 'longenough1');
    await ctx.authStore.createUser({ username: 'op', password: 'longenough1', role: 'operator' });
    await ctx.authStore.createUser({ username: 'vw', password: 'longenough1', role: 'viewer' });
    const op = await loginAs('op', 'longenough1');
    const vw = await loginAs('vw', 'longenough1');

    expect((await post('/api/op-thing', {}, vw)).status).toBe(403);
    expect((await post('/api/op-thing', {}, op)).status).toBe(200);
    expect((await post('/api/admin-thing', {}, op)).status).toBe(403);
    expect((await post('/api/admin-thing', {}, admin)).status).toBe(200);
    expect((await get('/api/viewer-thing', vw)).status).toBe(200);
  });

  it('session revoke: destroyByUserId kills a live session immediately', async () => {
    const vw = await loginAs('vw', 'longenough1');
    const user = ctx.authStore.getUserByUsername('vw');
    ctx.sessionStore.destroyByUserId(user.id);
    expect((await get('/api/viewer-thing', vw)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/authHttp.test.js`
Expected: FAIL — `server/auth/wire` not found.

- [ ] **Step 3: Implement `server/auth/wire.js`**

```js
'use strict';
const crypto = require('crypto');
const session = require('express-session');
const { createAuthStore } = require('./authStore');
const { SQLiteSessionStore } = require('./sessionStore');
const { createAuthMiddleware } = require('./middleware');
const { createRateLimiter } = require('./rateLimiter');
const { createBootstrap } = require('./bootstrap');
const { createAuthRouter } = require('./routes');

function getOrCreateSessionSecret(db) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'session_secret'`).get();
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO meta (key, value, updated_at) VALUES ('session_secret', ?, ?)`)
    .run(secret, Date.now());
  return secret;
}

function wireAuth({ app, db, dataDir, authDisabled = false, sessionSecret, bcryptCost, audit = () => {} }) {
  let onAuthzDenied = () => {};
  const rateLimiter = createRateLimiter();

  if (authDisabled) {
    const { requireAuth, requireRole } = createAuthMiddleware({
      getUserById: () => null, authDisabled: true,
      onAuthzDenied: (req, role) => onAuthzDenied(req, role),
    });
    app.use('/api/auth', createAuthRouter({ authDisabled: true }));
    app.use('/api', requireAuth);
    return { authStore: null, sessionStore: null, bootstrap: null, rateLimiter,
             sessionMiddleware: null, requireAuth, requireRole,
             setOnAuthzDenied(fn) { onAuthzDenied = fn; } };
  }

  const authStore = createAuthStore(db, bcryptCost ? { bcryptCost } : {});
  const sessionStore = new SQLiteSessionStore(db);
  const bootstrap = createBootstrap({ authStore, dataDir });
  bootstrap.ensureToken();

  const sessionMiddleware = session({
    store: sessionStore,
    secret: sessionSecret || getOrCreateSessionSecret(db),
    name: 'sam.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: sessionStore.ttlMs },
  });

  const { requireAuth, requireRole } = createAuthMiddleware({
    getUserById: id => authStore.getUserById(id),
    onAuthzDenied: (req, role) => onAuthzDenied(req, role),
  });

  app.use(sessionMiddleware);
  app.use('/api/auth', createAuthRouter({
    authStore, bootstrap, rateLimiter,
    audit: (...args) => audit(...args),
  }));
  app.use('/api', requireAuth);

  return { authStore, sessionStore, bootstrap, rateLimiter, sessionMiddleware,
           requireAuth, requireRole,
           setOnAuthzDenied(fn) { onAuthzDenied = fn; } };
}

module.exports = { wireAuth, getOrCreateSessionSecret };
```

(`audit` and `setOnAuthzDenied` are late-binding hooks — Task 11 points them at the real audit helper without re-wiring.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/authHttp.test.js` — expected PASS.

- [ ] **Step 5: Wire into `server.js`**

5a. After the `HOST` constant (~line 22), add the startup guards and trust-proxy flag:

```js
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
if (AUTH_DISABLED && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
  console.error('[auth] AUTH_DISABLED=true cannot be combined with a non-loopback HOST. Refusing to start.');
  process.exit(1);
}
if (AUTH_DISABLED) {
  console.warn('[auth] *****************************************************************');
  console.warn('[auth] * AUTH_DISABLED=true — every request runs as admin.            *');
  console.warn('[auth] * LOCAL DEVELOPMENT ONLY. Never set this in production.        *');
  console.warn('[auth] *****************************************************************');
}
```

5b. After `app.disable('x-powered-by')` (~line 29), add:

```js
// Behind a TLS-terminating reverse proxy, TRUST_PROXY makes req.ip (audit log)
// and secure-cookie detection correct. Value: 'true' → 1 hop, or an express
// trust-proxy expression (e.g. 'loopback').
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
}
```

5c. Immediately after `metricsStore.initialize(...)` (~line 108), add:

```js
const { wireAuth } = require('./server/auth/wire');   // (move require to the top import block)

if (!metricsStore._db() && !AUTH_DISABLED) {
  console.error('[auth] SQLite persistence is unavailable and authentication requires it.');
  console.error('[auth] Fix the data directory (see errors above) or set AUTH_DISABLED=true for local dev.');
  process.exit(1);
}
const auth = wireAuth({ app, db: metricsStore._db(), dataDir: DATA_DIR, authDisabled: AUTH_DISABLED });
const { requireRole } = auth;
if (auth.sessionStore) setInterval(() => auth.sessionStore.pruneExpired(), 60 * 60 * 1000);
```

Note: `wireAuth` registers `app.use('/api', requireAuth)` here — **before** any `/api` route definition (they start at ~line 768) — so every existing route is gated with no further edits. Keep the `require` statement in the import block at the top of the file with the others.

5d. Add role gates to the eight routes in the table above by inserting the middleware argument, e.g.:

```js
app.post('/api/connect', requireRole('admin'), async (req, res) => {
```

```js
app.delete('/api/disconnect/:id', requireRole('admin'), async (req, res) => {
```

```js
app.post('/api/connections/:id/kill-sleeping', requireRole('operator'), async (req, res) => {
```

```js
app.post('/api/connections/:id/kill', requireRole('operator'), async (req, res) => {
```

```js
app.post('/api/connections/:id/jobs/:action', requireRole('operator'), async (req, res) => {
```

```js
app.post('/api/connections/:id/alerts/:alertId/ack', requireRole('operator'), (req, res) => {
```

```js
app.post('/api/connections/:id/index-health/scan', requireRole('operator'), async (req, res) => {
```

```js
app.delete('/api/connections/:id/index-health/scan/:scanId', requireRole('operator'), (req, res) => {
```

5e. Update the stale comment above `const HOST` (lines 18–21): it says "every API endpoint is unauthenticated". Replace with:

```js
// Bind localhost-only by default. API endpoints require a session (see
// server/auth/); set HOST=0.0.0.0 to expose beyond loopback, ideally behind
// a TLS-terminating reverse proxy with TRUST_PROXY set.
```

- [ ] **Step 6: Manual curl smoke (backend is now curl-testable)**

Start: `npm start` (needs a valid `.env`; no SQL Server connection required for this check). Verify:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/connections          # 401
curl -s http://localhost:3000/api/auth/status                                          # {"bootstrapRequired":true,...}
# console shows the bootstrap token banner; then:
curl -s -c cookies.txt -H "Content-Type: application/json" \
  -d '{"token":"<TOKEN-FROM-CONSOLE>","username":"admin","password":"changeme123"}' \
  http://localhost:3000/api/connect http://localhost:3000/api/auth/bootstrap           # user json
curl -s -b cookies.txt http://localhost:3000/api/connections                           # 200 []
```

Delete `cookies.txt` afterwards. Stop the server. If a `data/metrics.db` existed, confirm the migration banner + backup path printed.

- [ ] **Step 7: Full suite + commit**

Run: `npx vitest run` — green.

```bash
git add server/auth/wire.js server.js tests/server/authHttp.test.js
git commit -m "feat(auth): gate all REST endpoints, role-gate destructive/admin routes, startup guards"
```

---

### Task 7: Gate the Socket.io handshake

**Files:**
- Create: `server/auth/socketAuth.js`
- Modify: `server.js` (Socket.io setup at `io.on('connection', ...)` ~line 1265; add the two `io.*` lines right after the `wireAuth` block from Task 6)
- Test: `tests/server/socketAuth.test.js`

**Interfaces:**
- Consumes: `sessionMiddleware` (Task 6), `getUserById` (Task 2), `authDisabled` flag.
- Produces: `createSocketAuth({ authDisabled, getUserById })` → Socket.io middleware `(socket, next)`; accepts when `socket.request.session.userId` resolves to an enabled user (sets `socket.data.user`), rejects with `next(new Error('unauthorized'))` otherwise. With `authDisabled`, always accepts.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/socketAuth.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { createSocketAuth } = require('../../server/auth/socketAuth');

const users = { 1: { id: 1, username: 'u', role: 'viewer', disabled: 0 },
                2: { id: 2, username: 'd', role: 'viewer', disabled: 1 } };
const getUserById = id => users[id] || null;
const fakeSocket = session => ({ request: { session }, data: {} });

describe('socket handshake auth', () => {
  it('rejects without a session', () => {
    const mw = createSocketAuth({ getUserById });
    const next = vi.fn();
    mw(fakeSocket(undefined), next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('rejects a disabled user', () => {
    const mw = createSocketAuth({ getUserById });
    const next = vi.fn();
    mw(fakeSocket({ userId: 2 }), next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('accepts a valid session and attaches the user', () => {
    const mw = createSocketAuth({ getUserById });
    const next = vi.fn();
    const socket = fakeSocket({ userId: 1 });
    mw(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user.username).toBe('u');
  });

  it('authDisabled accepts everything', () => {
    const mw = createSocketAuth({ authDisabled: true, getUserById });
    const next = vi.fn();
    mw(fakeSocket(undefined), next);
    expect(next).toHaveBeenCalledWith();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/socketAuth.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/auth/socketAuth.js`**

```js
'use strict';

function createSocketAuth({ authDisabled = false, getUserById }) {
  return (socket, next) => {
    if (authDisabled) return next();
    const sess = socket.request.session;
    const user = sess?.userId ? getUserById(sess.userId) : null;
    if (!user || user.disabled) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  };
}

module.exports = { createSocketAuth };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/socketAuth.test.js` — expected PASS.

- [ ] **Step 5: Wire into `server.js`**

Directly after the `wireAuth` block from Task 6 Step 5c, add (and move the `require` to the top import block):

```js
const { createSocketAuth } = require('./server/auth/socketAuth');

// Socket.io shares the HTTP session: run the session middleware on the
// polling/upgrade request, then verify the user on handshake.
if (auth.sessionMiddleware) io.engine.use(auth.sessionMiddleware);
io.use(createSocketAuth({
  authDisabled: AUTH_DISABLED,
  getUserById: id => (auth.authStore ? auth.authStore.getUserById(id) : null),
}));
```

- [ ] **Step 6: Manual check + commit**

`npm start`, open `http://localhost:3000` in a browser with no session: the browser console shows the Socket.io connection error `unauthorized` (UI handling comes in Task 9). `npx vitest run` — green.

```bash
git add server/auth/socketAuth.js server.js tests/server/socketAuth.test.js
git commit -m "feat(auth): reject Socket.io handshakes without a valid session"
```

---

### Task 8: Recovery CLI (`reset-admin.js`)

**Files:**
- Create: `server/auth/recovery.js` (logic, testable)
- Create: `reset-admin.js` (thin CLI at repo root, next to `server.js`)
- Test: `tests/server/recovery.test.js`

**Interfaces:**
- Consumes: `authStore` (Task 2), `SQLiteSessionStore.destroyByUserId` (Task 3).
- Produces:
  - `async resetPassword({ authStore, sessionStore, username })` → `{ username, password }` (new random password; re-enables a disabled account; revokes all of the user's sessions). Throws `no such user: <name>` for unknown users.
  - `async createAdmin({ authStore, username })` → `{ username, password }` (new admin with random password).
  - CLI usage: `node reset-admin.js <username>` (reset) | `node reset-admin.js --create-admin <username>` (new admin). Runs on the server host against `data/metrics.db` — filesystem access is the trust boundary (spec §2). Audit events for both paths are added in Task 11.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/recovery.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const Database = require('better-sqlite3');
const schema = require('../../server/metricsSchema');
const { createAuthStore } = require('../../server/auth/authStore');
const { SQLiteSessionStore } = require('../../server/auth/sessionStore');
const { resetPassword, createAdmin } = require('../../server/auth/recovery');

describe('recovery', () => {
  let db, authStore, sessionStore;
  beforeEach(() => {
    db = new Database(':memory:');
    schema.applyPragmas(db);
    schema.migrate(db);
    authStore = createAuthStore(db, { bcryptCost: 4 });
    sessionStore = new SQLiteSessionStore(db);
  });

  it('resetPassword issues a working password, re-enables, revokes sessions', async () => {
    const u = await authStore.createUser({ username: 'admin', password: 'oldpassword1', role: 'admin' });
    authStore.setDisabled(u.id, true);
    await new Promise(res => sessionStore.set('s1', { userId: u.id, cookie: {} }, res));

    const { username, password } = await resetPassword({ authStore, sessionStore, username: 'admin' });
    expect(username).toBe('admin');
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(await authStore.verifyPassword('admin', 'oldpassword1')).toBeNull();
    expect((await authStore.verifyPassword('admin', password)).id).toBe(u.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(u.id).n).toBe(0);
  });

  it('resetPassword rejects unknown users', async () => {
    await expect(resetPassword({ authStore, sessionStore, username: 'ghost' }))
      .rejects.toThrow(/no such user/);
  });

  it('createAdmin creates an enabled admin with a random password', async () => {
    const { username, password } = await createAdmin({ authStore, username: 'rescue' });
    const u = await authStore.verifyPassword(username, password);
    expect(u.role).toBe('admin');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/recovery.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/auth/recovery.js`**

```js
'use strict';
const crypto = require('crypto');

function randomPassword() { return crypto.randomBytes(12).toString('base64url'); }

async function resetPassword({ authStore, sessionStore, username }) {
  const user = authStore.getUserByUsername(username);
  if (!user) throw new Error(`no such user: ${username}`);
  const password = randomPassword();
  await authStore.setPassword(user.id, password);
  if (user.disabled) authStore.setDisabled(user.id, false);
  sessionStore.destroyByUserId(user.id);
  return { username: user.username, password };
}

async function createAdmin({ authStore, username }) {
  const password = randomPassword();
  const user = await authStore.createUser({ username, password, role: 'admin' });
  return { username: user.username, password };
}

module.exports = { resetPassword, createAdmin, randomPassword };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/recovery.test.js` — expected PASS.

- [ ] **Step 5: Implement the CLI `reset-admin.js`** (repo root)

```js
#!/usr/bin/env node
'use strict';
// Recovery CLI. Run on the server host — filesystem access to data/metrics.db
// is the trust boundary. Safe while the server is running (WAL mode).
//   node reset-admin.js <username>                 reset password + re-enable + revoke sessions
//   node reset-admin.js --create-admin <username>  create a new admin account
const path = require('path');
const Database = require('better-sqlite3');
const schema = require('./server/metricsSchema');
const { createAuthStore } = require('./server/auth/authStore');
const { SQLiteSessionStore } = require('./server/auth/sessionStore');
const { resetPassword, createAdmin } = require('./server/auth/recovery');

async function main() {
  const args = process.argv.slice(2);
  const createMode = args[0] === '--create-admin';
  const username = createMode ? args[1] : args[0];
  if (!username) {
    console.error('Usage: node reset-admin.js <username> | node reset-admin.js --create-admin <username>');
    process.exit(2);
  }
  const dbPath = path.join(__dirname, 'data', 'metrics.db');
  const db = new Database(dbPath);
  schema.applyPragmas(db);
  schema.migrate(db);
  const authStore = createAuthStore(db);
  const sessionStore = new SQLiteSessionStore(db);
  try {
    const result = createMode
      ? await createAdmin({ authStore, username })
      : await resetPassword({ authStore, sessionStore, username });
    console.log(`\n  ${createMode ? 'Created admin' : 'Password reset for'}: ${result.username}`);
    console.log(`  New password: ${result.password}`);
    console.log('\n  Log in and change this password immediately.\n');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
```

- [ ] **Step 6: Manual CLI check + commit**

With the server stopped or running: `node reset-admin.js admin` → prints a new password; log in with it via curl to confirm. Then:

```bash
git add server/auth/recovery.js reset-admin.js tests/server/recovery.test.js
git commit -m "feat(auth): reset-admin recovery CLI (password reset + emergency admin creation)"
```

---

### Task 9: Frontend — AuthContext, login screen, bootstrap screen, header user chip

**Files:**
- Create: `src/auth/AuthContext.jsx`
- Create: `src/auth/LoginScreen.jsx`
- Create: `src/auth/BootstrapScreen.jsx`
- Create: `src/auth/AuthGate.jsx`
- Modify: `src/main.jsx` (wrap providers)
- Modify: `src/components/Header.jsx` (user chip + logout, before the palette picker)
- Test: `src/auth/AuthGate.test.jsx`

**Interfaces:**
- Consumes: backend routes `GET /api/auth/status`, `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/bootstrap`, `POST /api/auth/logout` (Tasks 5–6).
- Produces: `useAuth()` → `{ status: 'loading'|'bootstrap'|'login'|'ready', user: {id,username,role}|null, login(username,password), bootstrap(token,username,password), logout(), hasRole(role) }`. `<AuthGate>` renders `null` / `<BootstrapScreen>` / `<LoginScreen>` / children by status. After login/bootstrap/logout the app does `window.location.reload()` — this re-runs the Socket.io handshake with the new session (no socket re-auth plumbing needed) and doubles as the "reconnect after login" behavior from the spec.

- [ ] **Step 1: Write the failing test**

Create `src/auth/AuthGate.test.jsx`:

```jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { AuthProvider } from './AuthContext'
import AuthGate from './AuthGate'

function mockFetchRoutes(routes) {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const hit = routes[url]
    if (!hit) throw new Error(`unmocked fetch: ${url}`)
    return { ok: hit.status === 200, status: hit.status, json: async () => hit.body }
  }))
}
afterEach(() => vi.unstubAllGlobals())

const app = <AuthProvider><AuthGate><div>THE APP</div></AuthGate></AuthProvider>

describe('AuthGate', () => {
  it('shows the bootstrap screen when bootstrapRequired', async () => {
    mockFetchRoutes({ '/api/auth/status': { status: 200, body: { bootstrapRequired: true } } })
    render(app)
    await waitFor(() => expect(screen.getByText(/create admin account/i)).toBeInTheDocument())
    expect(screen.getByLabelText(/bootstrap token/i)).toBeInTheDocument()
  })

  it('shows the login screen on 401', async () => {
    mockFetchRoutes({
      '/api/auth/status': { status: 200, body: { bootstrapRequired: false } },
      '/api/auth/me': { status: 401, body: { error: 'Authentication required.' } },
    })
    render(app)
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument())
  })

  it('renders children when authenticated', async () => {
    mockFetchRoutes({
      '/api/auth/status': { status: 200, body: { bootstrapRequired: false } },
      '/api/auth/me': { status: 200, body: { user: { id: 1, username: 'z', role: 'admin' } } },
    })
    render(app)
    await waitFor(() => expect(screen.getByText('THE APP')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/AuthGate.test.jsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/auth/AuthContext.jsx`**

```jsx
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 }

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading') // loading | bootstrap | login | ready
  const [user, setUser] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const st = await fetch('/api/auth/status').then(r => r.json())
        if (cancelled) return
        if (st.bootstrapRequired) { setStatus('bootstrap'); return }
        const res = await fetch('/api/auth/me')
        if (cancelled) return
        if (res.ok) {
          const { user } = await res.json()
          setUser(user)
          setStatus('ready')
        } else {
          setStatus('login')
        }
      } catch {
        if (!cancelled) setStatus('login')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const login = useCallback(async (username, password) => {
    await postJson('/api/auth/login', { username, password })
    window.location.reload()   // fresh Socket.io handshake with the new session
  }, [])

  const bootstrap = useCallback(async (token, username, password) => {
    await postJson('/api/auth/bootstrap', { token, username, password })
    window.location.reload()
  }, [])

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    window.location.reload()
  }, [])

  const hasRole = useCallback(
    role => !!user && (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[role] || Infinity),
    [user],
  )

  return (
    <AuthContext.Provider value={{ status, user, login, bootstrap, logout, hasRole }}>
      {children}
    </AuthContext.Provider>
  )
}
```

- [ ] **Step 4: Implement `src/auth/LoginScreen.jsx`**

```jsx
import React, { useState } from 'react'
import { useAuth } from './AuthContext'

export function AuthShell({ title, subtitle, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--body-bg)' }}>
      <div className="w-full max-w-sm rounded-2xl p-8"
           style={{ background: 'var(--card-bg)', boxShadow: 'var(--card-shadow)', border: '1px solid var(--input-border)' }}>
        <div className="mb-6 text-center">
          <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>SQL Activity Monitor</div>
          <h1 className="mt-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h1>
          {subtitle && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, ...props }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <input
        {...props}
        className="w-full rounded-xl px-3 py-2 text-sm outline-none"
        style={{ background: 'var(--body-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
      />
    </label>
  )
}

export default function LoginScreen() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try { await login(username, password) }
    catch (err) { setError(err.message); setBusy(false) }
  }

  return (
    <AuthShell title="Sign in" subtitle="Enter your credentials to continue">
      <form onSubmit={onSubmit}>
        <Field label="Username" value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="username" />
        <Field label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
        {error && <p className="text-xs text-red-500 mb-3" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !username || !password}
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--header-bg)' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  )
}
```

- [ ] **Step 5: Implement `src/auth/BootstrapScreen.jsx`**

```jsx
import React, { useState } from 'react'
import { useAuth } from './AuthContext'
import { AuthShell, Field } from './LoginScreen'

export default function BootstrapScreen() {
  const { bootstrap } = useAuth()
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true); setError(null)
    try { await bootstrap(token, username, password) }
    catch (err) { setError(err.message); setBusy(false) }
  }

  return (
    <AuthShell
      title="Create admin account"
      subtitle="First-time setup. The bootstrap token is printed in the server console and written to bootstrap-token.txt next to the database."
    >
      <form onSubmit={onSubmit}>
        <Field label="Bootstrap token" id="bs-token" value={token} onChange={e => setToken(e.target.value)} autoFocus />
        <Field label="Admin username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
        <Field label="Password (min 8 characters)" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        <Field label="Confirm password" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
        {error && <p className="text-xs text-red-500 mb-3" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !token || !username || password.length < 8}
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--header-bg)' }}>
          {busy ? 'Creating…' : 'Create admin account'}
        </button>
      </form>
    </AuthShell>
  )
}
```

Note: `Field` renders `<input>` inside `<label>`, so `getByLabelText(/bootstrap token/i)` in the test resolves without explicit `htmlFor`.

- [ ] **Step 6: Implement `src/auth/AuthGate.jsx`**

```jsx
import React from 'react'
import { useAuth } from './AuthContext'
import LoginScreen from './LoginScreen'
import BootstrapScreen from './BootstrapScreen'

export default function AuthGate({ children }) {
  const { status } = useAuth()
  if (status === 'loading') return null
  if (status === 'bootstrap') return <BootstrapScreen />
  if (status === 'login') return <LoginScreen />
  return children
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/auth/AuthGate.test.jsx` — expected PASS.

- [ ] **Step 8: Wire into `src/main.jsx`**

Replace the render tree (AuthGate sits OUTSIDE AppProvider/ConnectionProvider so no data fetching or socket connection happens before login):

```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { AppProvider } from './context/AppContext'
import { ConnectionProvider } from './context/ConnectionContext'
import { AuthProvider } from './auth/AuthContext'
import AuthGate from './auth/AuthGate'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <AppProvider>
          <ConnectionProvider>
            <App />
          </ConnectionProvider>
        </AppProvider>
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>
)
```

- [ ] **Step 9: User chip + logout in `src/components/Header.jsx`**

Add imports at the top:

```jsx
import { LayoutDashboard, RefreshCw, LogOut, UserRound } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
```

Inside the `Header` component add `const { user, logout } = useAuth()`, and insert this block **after** the Alert bell (`<AlertBell onClick={onOpenAlerts} />`) and before the palette picker:

```jsx
        {/* User chip + logout */}
        {user && (
          <div className="flex items-center gap-1.5">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium"
                  style={{ color: 'var(--header-icon)', background: 'rgba(255,255,255,.08)' }}
                  title={`Signed in as ${user.username} (${user.role})`}>
              <UserRound size={14} />
              <span>{user.username}</span>
              <span className="opacity-60">· {user.role}</span>
            </span>
            <button onClick={logout} aria-label="Sign out" title="Sign out"
                    className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--header-icon)' }}>
              <LogOut size={14} />
            </button>
          </div>
        )}
```

(`useAuth()` returns `{ user: null }`-safe values only inside an `AuthProvider`; Header always renders inside it via main.jsx. Guarding on `user &&` keeps existing Header tests — if any render it bare — from crashing only if they wrap a provider; if a Header test exists without the provider, wrap it in `<AuthProvider>` with a mocked fetch or mock `useAuth`.)

- [ ] **Step 10: Verify in the browser**

`npm run dev` (Vite) with the API server running (`npm start`):
- Fresh DB → bootstrap screen; wrong token → error shown; correct token → reload → dashboard.
- Logout → login screen; wrong password → generic error; correct → dashboard, user chip shows name + role.
- Full suite: `npx vitest run` — green.

- [ ] **Step 11: Commit**

```bash
git add src/auth/AuthContext.jsx src/auth/LoginScreen.jsx src/auth/BootstrapScreen.jsx src/auth/AuthGate.jsx src/auth/AuthGate.test.jsx src/main.jsx src/components/Header.jsx
git commit -m "feat(auth): login + bootstrap screens, auth context, header user chip"
```

---

### Task 10: Audit log helper + retention prune

**Files:**
- Create: `server/auditLog.js`
- Test: `tests/server/auditLog.test.js`

**Interfaces:**
- Consumes: migrated `db` (`audit_log` table from Task 1).
- Produces module (singleton — one audit log per process, like the metrics store):
  - `initAudit({ db, dataDir })`
  - `audit(req, action, target, detail = {}, outcome = 'success')` — `req` may be `null` (system events); reads `req.user` / `req.ip`; caps `username` at 100 chars; never throws (fail-open: on insert failure appends the JSON line to `audit-fallback.jsonl` in `dataDir`)
  - `pruneAudit({ retentionDays, now = Date.now() })` → rows removed; `retentionDays <= 0` or unset → keep forever; emits an `audit.prune` event when rows were removed
  - `_reset()` (tests only)

- [ ] **Step 1: Write the failing tests**

Create `tests/server/auditLog.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const schema = require('../../server/metricsSchema');
const auditLog = require('../../server/auditLog');

describe('auditLog', () => {
  let db, dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    db = new Database(':memory:');
    schema.applyPragmas(db);
    schema.migrate(db);
    auditLog.initAudit({ db, dataDir: dir });
  });
  afterEach(() => {
    auditLog._reset();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rows = () => db.prepare('SELECT * FROM audit_log ORDER BY id').all();

  it('writes a row with user, ip, JSON detail, outcome', () => {
    const req = { user: { id: 7, username: 'zia' }, ip: '10.0.0.5' };
    auditLog.audit(req, 'session.kill', 'spid:123', { spid: 123, login: 'app_user', database: 'medcare_db' }, 'success');
    const r = rows()[0];
    expect(r).toMatchObject({ user_id: 7, username: 'zia', ip: '10.0.0.5', action: 'session.kill', target: 'spid:123', outcome: 'success' });
    expect(JSON.parse(r.detail)).toEqual({ spid: 123, login: 'app_user', database: 'medcare_db' });
    expect(r.ts).toBeGreaterThan(Date.now() - 5000);
  });

  it('handles null req (system events) and caps username at 100 chars', () => {
    auditLog.audit(null, 'audit.prune', null, { removed: 3 }, 'success');
    auditLog.audit({ user: { id: 1, username: 'x'.repeat(300) }, ip: null }, 'logout', null, {}, 'success');
    expect(rows()[0].user_id).toBeNull();
    expect(rows()[1].username).toHaveLength(100);
  });

  it('fail-open: broken DB falls back to audit-fallback.jsonl, never throws', () => {
    db.exec('DROP TABLE audit_log');
    expect(() => auditLog.audit(null, 'login.failure', 'ghost', {}, 'failure')).not.toThrow();
    const lines = fs.readFileSync(path.join(dir, 'audit-fallback.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ action: 'login.failure', target: 'ghost', outcome: 'failure' });
  });

  it('pruneAudit removes only rows older than retention and self-audits', () => {
    const now = Date.now();
    const ins = db.prepare(`INSERT INTO audit_log (ts, action, outcome) VALUES (?, 'logout', 'success')`);
    ins.run(now - 400 * 86_400_000);   // 400 days old
    ins.run(now - 1000);               // fresh
    expect(auditLog.pruneAudit({ retentionDays: 365, now })).toBe(1);
    const remaining = rows();
    expect(remaining.some(r => r.action === 'audit.prune')).toBe(true);
    expect(remaining.filter(r => r.action === 'logout')).toHaveLength(1);
  });

  it('retentionDays 0 keeps forever', () => {
    db.prepare(`INSERT INTO audit_log (ts, action, outcome) VALUES (1, 'logout', 'success')`).run();
    expect(auditLog.pruneAudit({ retentionDays: 0 })).toBe(0);
    expect(rows()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/auditLog.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/auditLog.js`**

```js
'use strict';
// ============================================================================
// PHI RULE — READ BEFORE ADDING ANY AUDIT DETAIL FIELD
//
// This tool monitors hospital SQL Servers. Query text contains PHI — patient
// names, MRNs, SSNs appear in WHERE clauses. Audit detail stores IDENTIFIERS,
// NEVER CONTENT: SPID, login name, host, program, database, connection name,
// rowcount. Never persist SQL text, query parameters, or anything that came
// from a password field. If query context is ever genuinely needed, store the
// first 100 characters truncated, or a query hash — and get that reviewed.
// ============================================================================
const fs = require('fs');
const path = require('path');

let db = null;
let insertStmt = null;
let deleteStmt = null;
let fallbackFile = null;

function initAudit(opts) {
  db = opts.db;
  insertStmt = db.prepare(`INSERT INTO audit_log (ts, user_id, username, ip, action, target, detail, outcome)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  deleteStmt = db.prepare('DELETE FROM audit_log WHERE ts < ?');
  fallbackFile = path.join(opts.dataDir, 'audit-fallback.jsonl');
}

function audit(req, action, target, detail = {}, outcome = 'success') {
  const row = {
    ts: Date.now(),
    user_id: req?.user?.id ?? null,
    username: req?.user?.username != null ? String(req.user.username).slice(0, 100) : null,
    ip: req?.ip ?? null,
    action,
    target: target == null ? null : String(target).slice(0, 400),
    detail: JSON.stringify(detail ?? {}),
    outcome,
  };
  try {
    if (!insertStmt) throw new Error('audit log not initialized');
    insertStmt.run(row.ts, row.user_id, row.username, row.ip, row.action, row.target, row.detail, row.outcome);
  } catch (err) {
    // Fail-open: the action proceeds; the record degrades to file-based logging.
    console.error('[audit] insert failed:', err.message);
    try {
      fs.appendFileSync(fallbackFile || path.join(__dirname, '..', 'data', 'audit-fallback.jsonl'),
        JSON.stringify(row) + '\n');
    } catch (fileErr) {
      console.error('[audit] fallback file write failed:', fileErr.message);
    }
  }
}

function pruneAudit({ retentionDays, now = Date.now() } = {}) {
  if (!deleteStmt || !retentionDays || retentionDays <= 0) return 0;   // 0 = keep forever
  const cutoff = now - retentionDays * 86_400_000;
  let removed = 0;
  try {
    removed = deleteStmt.run(cutoff).changes;
  } catch (err) {
    console.error('[audit] prune failed:', err.message);
    return 0;
  }
  if (removed > 0) {
    audit(null, 'audit.prune', null, { removed, cutoff, retentionDays }, 'success');
  }
  return removed;
}

function _reset() { db = null; insertStmt = null; deleteStmt = null; fallbackFile = null; }

module.exports = { initAudit, audit, pruneAudit, _reset };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/auditLog.test.js` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auditLog.js tests/server/auditLog.test.js
git commit -m "feat(audit): append-only audit helper with PHI rule, fail-open fallback, retention prune"
```

---

### Task 11: Audit hooks — wire the helper into every recorded action

**Files:**
- Modify: `server.js` (init + endpoint hooks + maintenance cycle at `runMetricsMaintenance`, ~line 1289)
- Modify: `server/auth/recovery.js` (audit CLI actions)
- Test: `tests/server/auditHooks.test.js` (auth-path events over HTTP; destructive-endpoint hooks verified by code review + ship-gate smoke since they need a live SQL Server)

**Interfaces:**
- Consumes: `auditLog` (Task 10), `wireAuth`'s `audit` param + `setOnAuthzDenied` (Task 6), endpoints in `server.js`.
- Produces: audit rows for — `login.success`, `login.failure`, `login.lockout`, `logout`, `admin.bootstrap`, `authz.denied` (Tasks 5/6 already call the injected `audit`; this task supplies the real one), `session.kill`, `session.kill_sleeping`, `job.start`, `job.stop`, `alert.ack`, `connection.add`, `connection.remove`, `audit.prune`, and `user.password_reset`/`user.create` from the recovery CLI. **PHI rule: every `detail` payload below is identifiers only.**

- [ ] **Step 1: Write the failing tests**

Create `tests/server/auditHooks.test.js` — reuses the Task 6 harness but passes the real audit helper:

```js
'use strict';
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('../../server/metricsSchema');
const { wireAuth } = require('../../server/auth/wire');
const auditLog = require('../../server/auditLog');

let server, base, ctx, db, dir;

async function post(url, body, cookie) {
  return fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}
const cookieFrom = res => (res.headers.get('set-cookie') || '').split(';')[0] || null;
const auditRows = action => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audithooks-'));
  db = new Database(':memory:');
  schema.applyPragmas(db);
  schema.migrate(db);
  auditLog.initAudit({ db, dataDir: dir });
  const app = express();
  app.use(express.json());
  ctx = wireAuth({ app, db, dataDir: dir, authDisabled: false, sessionSecret: 't', bcryptCost: 4,
                   audit: auditLog.audit });
  ctx.setOnAuthzDenied((req, role) =>
    auditLog.audit(req, 'authz.denied', req.originalUrl, { requiredRole: role }, 'failure'));
  app.post('/api/admin-thing', ctx.requireRole('admin'), (_req, res) => res.json({ ok: true }));
  await ctx.authStore.createUser({ username: 'root', password: 'longenough1', role: 'admin' });
  await ctx.authStore.createUser({ username: 'vw', password: 'longenough1', role: 'viewer' });
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(res => {
  auditLog._reset();
  server.close(res);
  fs.rmSync(dir, { recursive: true, force: true });
}));

describe('audit hooks: auth path', () => {
  it('login.success carries the user identity', async () => {
    const res = await post('/api/auth/login', { username: 'root', password: 'longenough1' });
    expect(res.status).toBe(200);
    const r = auditRows('login.success').at(-1);
    expect(r).toMatchObject({ username: 'root', target: 'root', outcome: 'success' });
  });

  it('login.failure logs attempted username in target, never the password', async () => {
    await post('/api/auth/login', { username: 'GhostUser', password: 'supersecretpw' });
    const r = auditRows('login.failure').at(-1);
    expect(r.target).toBe('GhostUser');
    expect(JSON.stringify(r)).not.toContain('supersecretpw');
  });

  it('lockout writes login.lockout', async () => {
    for (let i = 0; i < 5; i++) await post('/api/auth/login', { username: 'lockme2', password: 'wrongwrong' });
    expect(auditRows('login.lockout').length).toBeGreaterThan(0);
  });

  it('403 on a role-gated route writes authz.denied with the required role', async () => {
    const vw = cookieFrom(await post('/api/auth/login', { username: 'vw', password: 'longenough1' }));
    await post('/api/admin-thing', {}, vw);
    const r = auditRows('authz.denied').at(-1);
    expect(r).toMatchObject({ username: 'vw', outcome: 'failure' });
    expect(JSON.parse(r.detail)).toEqual({ requiredRole: 'admin' });
  });

  it('logout writes a logout row', async () => {
    const c = cookieFrom(await post('/api/auth/login', { username: 'root', password: 'longenough1' }));
    await post('/api/auth/logout', {}, c);
    expect(auditRows('logout').at(-1).username).toBe('root');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/auditHooks.test.js`
Expected: FAIL — no audit rows: `wireAuth` in the test passes `audit`, which already works from Task 6's late-binding design, so if these pass immediately, that's fine — the failing part is `authz.denied` wiring if `setOnAuthzDenied` isn't implemented. If everything passes, proceed (the contract is already satisfied) and treat Steps 3–5 as the production wiring that the ship gate smoke-verifies.

- [ ] **Step 3: Wire the real helper in `server.js`**

In the Task 6 block (after `metricsStore.initialize`), initialize and inject:

```js
const auditLog = require('./server/auditLog');   // top import block

if (metricsStore._db()) auditLog.initAudit({ db: metricsStore._db(), dataDir: DATA_DIR });
const auth = wireAuth({
  app, db: metricsStore._db(), dataDir: DATA_DIR, authDisabled: AUTH_DISABLED,
  audit: auditLog.audit,
});
auth.setOnAuthzDenied((req, role) =>
  auditLog.audit(req, 'authz.denied', req.originalUrl, { requiredRole: role }, 'failure'));
```

(This replaces the Task 6 `wireAuth` call — same location, now with `audit` injected.)

- [ ] **Step 4: Hook the destructive/admin endpoints in `server.js`** (PHI rule: identifiers only)

`POST /api/connections/:id/kill` — after the `KILL` succeeds and in the catch (never log SQL text; the request body only has `sessionId`):

```js
    await conn.pool.request().query(`KILL ${sessionId}`);
    console.log(`[${conn.label}] Killed session ${sessionId}`);
    auditLog.audit(req, 'session.kill', `spid:${sessionId}`,
      { spid: sessionId, connection: conn.label, server: conn.server }, 'success');
    res.json({ ok: true });
  } catch (err) {
    auditLog.audit(req, 'session.kill', `spid:${sessionId}`,
      { spid: sessionId, connection: conn.label, server: conn.server, reason: err.message }, 'failure');
    res.status(400).json({ error: err.message });
  }
```

`POST /api/connections/:id/kill-sleeping` — after the kills settle (and in the catch):

```js
    console.log(`[${conn.label}] Killed ${ids.length} sleeping sessions`);
    auditLog.audit(req, 'session.kill_sleeping', conn.label,
      { spids: ids, count: ids.length, connection: conn.label, server: conn.server }, 'success');
    res.json({ killed: ids.length });
  } catch (err) {
    auditLog.audit(req, 'session.kill_sleeping', conn.label,
      { connection: conn.label, server: conn.server, reason: err.message }, 'failure');
    res.status(400).json({ error: err.message });
  }
```

`POST /api/connections/:id/jobs/:action` — job name is an identifier, allowed:

```js
    console.log(`[${conn.label}] ${action === 'start' ? 'Started' : 'Stopped'} job: ${jobName}`);
    auditLog.audit(req, `job.${action}`, jobName,
      { job: jobName, connection: conn.label, server: conn.server }, 'success');
    res.json({ ok: true });
  } catch (err) {
    auditLog.audit(req, `job.${action}`, jobName,
      { job: jobName, connection: conn.label, server: conn.server, reason: err.message }, 'failure');
    res.status(400).json({ error: err.message });
  }
```

`POST /api/connections/:id/alerts/:alertId/ack` — after the `ok` check:

```js
  const ok = metricsStore.ackAlert(c.instanceKey || c.server, alertId, Date.now());
  if (!ok) return res.status(404).json({ error: 'Alert not found' });
  auditLog.audit(req, 'alert.ack', `alert:${alertId}`, { alertId, connection: c.label }, 'success');
  res.json({ ok: true });
```

`POST /api/connect` — success (before `res.json`, detail has NO credentials — the body contains `password`, never touch it) and failure (in the catch):

```js
    auditLog.audit(req, 'connection.add', displayLabel,
      { server, database: database || 'master', appIntent: appIntent || 'ReadWrite' }, 'success');
```
```js
  } catch (err) {
    auditLog.audit(req, 'connection.add', String(req.body?.server ?? '').slice(0, 200),
      { reason: err.message }, 'failure');
    res.status(400).json({ error: err.message });
  }
```

`DELETE /api/disconnect/:id` — before `res.json({ ok: true })`:

```js
  auditLog.audit(req, 'connection.remove', conn.label, { server: conn.server }, 'success');
```

Audit retention in the maintenance cycle — inside `runMetricsMaintenance()` right after `metricsStore.prune();`:

```js
    auditLog.pruneAudit({ retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS ?? '365', 10) });
```

- [ ] **Step 5: Audit the recovery CLI**

In `server/auth/recovery.js`, add at the top: `const { audit } = require('../auditLog');` and inside the functions, before `return`:

```js
  // in resetPassword:
  audit(null, 'user.password_reset', user.username, { via: 'reset-admin.js CLI' }, 'success');
```
```js
  // in createAdmin:
  audit(null, 'user.create', user.username, { role: 'admin', via: 'reset-admin.js CLI' }, 'success');
```

(When the CLI runs, `initAudit` was not called — the helper fail-opens to `audit-fallback.jsonl`… which is also not initialized. So in `reset-admin.js`, call `auditLog.initAudit({ db, dataDir: path.join(__dirname, 'data') })` right after `migrate(db)`, with `const auditLog = require('./server/auditLog');` in the imports.)

- [ ] **Step 6: Run tests + full suite**

Run: `npx vitest run tests/server/auditHooks.test.js` then `npx vitest run` — green. Recovery test from Task 8 still passes (audit fail-opens in its in-memory setup — no `initAudit` there; if console noise bothers, call `auditLog.initAudit` in that test's `beforeEach`).

- [ ] **Step 7: Commit**

```bash
git add server.js server/auth/recovery.js reset-admin.js tests/server/auditHooks.test.js
git commit -m "feat(audit): wire audit events into auth, destructive endpoints, maintenance, and recovery CLI"
```

---

### Task 12: Admin APIs — user management + audit query/export

**Files:**
- Create: `server/auth/usersApi.js`
- Create: `server/auditApi.js`
- Modify: `server.js` (mount both routers after the wireAuth block)
- Test: `tests/server/adminApis.test.js`

**Interfaces:**
- Consumes: `authStore`, `sessionStore` (Tasks 2–3), `auditLog.audit` (Task 10), `requireRole` (Task 4).
- Produces:
  - `createUsersRouter({ authStore, sessionStore, audit })` → Express router: `GET /` (list), `POST /` (create), `PUT /:id/role`, `POST /:id/enable`, `POST /:id/disable`, `POST /:id/password`, `DELETE /:id/sessions` (revoke). Self-protection: an admin cannot disable or demote **themselves** (409) — full lockout recovery is the CLI's job. Disabling a user also revokes their sessions. Audit events: `user.create`, `user.update` (detail `{field, from, to}`), `user.enable`, `user.disable`, `user.password_reset`, `session.revoke`.
  - `createAuditApiRouter({ db, audit })` → `GET /` (server-side pagination: `from`, `to`, `user`, `action`, `page`, `pageSize` ≤ 200; returns `{ rows, total, page, pageSize }`) and `GET /export.csv` (streams CSV with the same filters, emits `audit.export`). CSV cells are quote-escaped and formula-injection-guarded (leading `=+-@` prefixed with `'`).
  - Mounted in `server.js` as `app.use('/api/users', requireRole('admin'), usersRouter)` and `app.use('/api/audit', requireRole('admin'), auditRouter)` — both after `app.use('/api', requireAuth)` so `req.user` exists.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/adminApis.test.js`:

```js
'use strict';
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('../../server/metricsSchema');
const { wireAuth } = require('../../server/auth/wire');
const auditLog = require('../../server/auditLog');
const { createUsersRouter } = require('../../server/auth/usersApi');
const { createAuditApiRouter } = require('../../server/auditApi');

let server, base, ctx, db, dir, adminCookie, viewerCookie;

const cookieFrom = res => (res.headers.get('set-cookie') || '').split(';')[0] || null;
async function req(method, url, body, cookie) {
  return fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const auditRows = action => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminapi-'));
  db = new Database(':memory:');
  schema.applyPragmas(db);
  schema.migrate(db);
  auditLog.initAudit({ db, dataDir: dir });
  const app = express();
  app.use(express.json());
  ctx = wireAuth({ app, db, dataDir: dir, authDisabled: false, sessionSecret: 't', bcryptCost: 4, audit: auditLog.audit });
  app.use('/api/users', ctx.requireRole('admin'),
    createUsersRouter({ authStore: ctx.authStore, sessionStore: ctx.sessionStore, audit: auditLog.audit }));
  app.use('/api/audit', ctx.requireRole('admin'),
    createAuditApiRouter({ db, audit: auditLog.audit }));
  await ctx.authStore.createUser({ username: 'root', password: 'longenough1', role: 'admin' });
  await ctx.authStore.createUser({ username: 'vw', password: 'longenough1', role: 'viewer' });
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = cookieFrom(await req('POST', '/api/auth/login', { username: 'root', password: 'longenough1' }));
  viewerCookie = cookieFrom(await req('POST', '/api/auth/login', { username: 'vw', password: 'longenough1' }));
});
afterAll(() => new Promise(res => {
  auditLog._reset(); server.close(res); fs.rmSync(dir, { recursive: true, force: true });
}));

describe('users API', () => {
  it('is admin-only', async () => {
    expect((await req('GET', '/api/users', undefined, viewerCookie)).status).toBe(403);
    expect((await req('GET', '/api/users', undefined, adminCookie)).status).toBe(200);
  });

  it('creates a user and audits user.create', async () => {
    const res = await req('POST', '/api/users', { username: 'op1', password: 'longenough1', role: 'operator' }, adminCookie);
    expect(res.status).toBe(201);
    expect(auditRows('user.create').at(-1).target).toBe('op1');
  });

  it('role change audits before/after', async () => {
    const op1 = ctx.authStore.getUserByUsername('op1');
    const res = await req('PUT', `/api/users/${op1.id}/role`, { role: 'viewer' }, adminCookie);
    expect(res.status).toBe(200);
    expect(JSON.parse(auditRows('user.update').at(-1).detail))
      .toEqual({ field: 'role', from: 'operator', to: 'viewer' });
  });

  it('disable revokes sessions and audits; enable restores', async () => {
    const vw = ctx.authStore.getUserByUsername('vw');
    expect((await req('POST', `/api/users/${vw.id}/disable`, {}, adminCookie)).status).toBe(200);
    expect((await req('GET', '/api/auth/me', undefined, viewerCookie)).status).toBe(401);
    expect(auditRows('user.disable').at(-1).target).toBe('vw');
    expect((await req('POST', `/api/users/${vw.id}/enable`, {}, adminCookie)).status).toBe(200);
  });

  it('an admin cannot disable or demote themselves', async () => {
    const root = ctx.authStore.getUserByUsername('root');
    expect((await req('POST', `/api/users/${root.id}/disable`, {}, adminCookie)).status).toBe(409);
    expect((await req('PUT', `/api/users/${root.id}/role`, { role: 'viewer' }, adminCookie)).status).toBe(409);
  });

  it('password reset audits and revokes sessions', async () => {
    const op1 = ctx.authStore.getUserByUsername('op1');
    const res = await req('POST', `/api/users/${op1.id}/password`, { password: 'anotherlong1' }, adminCookie);
    expect(res.status).toBe(200);
    expect(auditRows('user.password_reset').at(-1).target).toBe('op1');
    expect((await ctx.authStore.verifyPassword('op1', 'anotherlong1'))).not.toBeNull();
  });

  it('DELETE /:id/sessions audits session.revoke', async () => {
    const vw = ctx.authStore.getUserByUsername('vw');
    expect((await req('DELETE', `/api/users/${vw.id}/sessions`, undefined, adminCookie)).status).toBe(200);
    expect(auditRows('session.revoke').at(-1).target).toBe('vw');
  });
});

describe('audit API', () => {
  it('paginates and filters by action', async () => {
    const res = await req('GET', '/api/audit?action=user.create&page=1&pageSize=10', undefined, adminCookie);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.rows.every(r => r.action === 'user.create')).toBe(true);
    expect(body.rows.length).toBeLessThanOrEqual(10);
  });

  it('filters by user and time range', async () => {
    const res = await req('GET', `/api/audit?user=root&from=0&to=${Date.now() + 1000}`, undefined, adminCookie);
    const body = await res.json();
    expect(body.rows.every(r => r.username === 'root')).toBe(true);
  });

  it('caps pageSize at 200 and rejects garbage params', async () => {
    const res = await req('GET', '/api/audit?pageSize=99999', undefined, adminCookie);
    expect((await res.json()).pageSize).toBe(200);
    expect((await req('GET', '/api/audit?from=banana', undefined, adminCookie)).status).toBe(400);
  });

  it('CSV export streams rows, audits audit.export, guards formula injection', async () => {
    auditLog.audit({ user: { id: 1, username: 'root' }, ip: null }, 'logout', '=HYPERLINK("evil")', {}, 'success');
    const res = await req('GET', '/api/audit/export.csv?action=logout', undefined, adminCookie);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('ts,user_id,username,ip,action,target,detail,outcome');
    expect(text).toContain(`"'=HYPERLINK`);
    expect(auditRows('audit.export').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/adminApis.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `server/auth/usersApi.js`**

```js
'use strict';
const express = require('express');

function createUsersRouter({ authStore, sessionStore, audit }) {
  const router = express.Router();

  const findUser = (req, res) => {
    const id = parseInt(req.params.id, 10);
    const user = Number.isInteger(id) ? authStore.getUserById(id) : null;
    if (!user) { res.status(404).json({ error: 'User not found.' }); return null; }
    return user;
  };
  const isSelf = (req, user) => req.user.id === user.id;

  router.get('/', (_req, res) => res.json({ users: authStore.listUsers() }));

  router.post('/', async (req, res) => {
    const { username, password, role } = req.body || {};
    const uname = String(username ?? '').slice(0, 100);
    try {
      const user = await authStore.createUser({ username: uname, password, role });
      audit(req, 'user.create', user.username, { role }, 'success');
      res.status(201).json({ user });
    } catch (err) {
      audit(req, 'user.create', uname, { reason: err.message }, 'failure');
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/:id/role', (req, res) => {
    const user = findUser(req, res);
    if (!user) return;
    const { role } = req.body || {};
    if (isSelf(req, user) && role !== 'admin') {
      return res.status(409).json({ error: 'You cannot change your own role. Ask another admin.' });
    }
    try {
      const from = user.role;
      authStore.setRole(user.id, role);
      audit(req, 'user.update', user.username, { field: 'role', from, to: role }, 'success');
      res.json({ user: authStore.getUserById(user.id) });
    } catch (err) {
      audit(req, 'user.update', user.username, { field: 'role', reason: err.message }, 'failure');
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/:id/disable', (req, res) => {
    const user = findUser(req, res);
    if (!user) return;
    if (isSelf(req, user)) {
      return res.status(409).json({ error: 'You cannot disable your own account.' });
    }
    authStore.setDisabled(user.id, true);
    const revoked = sessionStore.destroyByUserId(user.id);
    audit(req, 'user.disable', user.username, { sessionsRevoked: revoked }, 'success');
    res.json({ user: authStore.getUserById(user.id) });
  });

  router.post('/:id/enable', (req, res) => {
    const user = findUser(req, res);
    if (!user) return;
    authStore.setDisabled(user.id, false);
    audit(req, 'user.enable', user.username, {}, 'success');
    res.json({ user: authStore.getUserById(user.id) });
  });

  router.post('/:id/password', async (req, res) => {
    const user = findUser(req, res);
    if (!user) return;
    try {
      await authStore.setPassword(user.id, (req.body || {}).password);
      const revoked = sessionStore.destroyByUserId(user.id);
      audit(req, 'user.password_reset', user.username, { sessionsRevoked: revoked }, 'success');
      res.json({ ok: true });
    } catch (err) {
      audit(req, 'user.password_reset', user.username, { reason: err.message }, 'failure');
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:id/sessions', (req, res) => {
    const user = findUser(req, res);
    if (!user) return;
    const revoked = sessionStore.destroyByUserId(user.id);
    audit(req, 'session.revoke', user.username, { sessionsRevoked: revoked }, 'success');
    res.json({ revoked });
  });

  return router;
}

module.exports = { createUsersRouter };
```

- [ ] **Step 4: Implement `server/auditApi.js`**

```js
'use strict';
// PHI note: rows served/exported here contain whatever audit() stored — which
// is identifiers-only by the rule in server/auditLog.js. Do not join in or
// append any query text here either.
const express = require('express');

function buildFilters(query) {
  const where = [];
  const params = [];
  for (const [key, col, cast] of [['from', 'ts >= ?', Number], ['to', 'ts <= ?', Number]]) {
    if (query[key] !== undefined) {
      const v = cast(query[key]);
      if (!Number.isFinite(v)) return { error: `invalid ${key}` };
      where.push(col);
      params.push(v);
    }
  }
  if (query.user) { where.push('username = ?'); params.push(String(query.user).slice(0, 100)); }
  if (query.action) { where.push('action = ?'); params.push(String(query.action).slice(0, 100)); }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const CSV_COLS = ['ts', 'user_id', 'username', 'ip', 'action', 'target', 'detail', 'outcome'];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'` + s;   // spreadsheet formula-injection guard
  return `"${s.replace(/"/g, '""')}"`;
}

function createAuditApiRouter({ db, audit }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const f = buildFilters(req.query);
    if (f.error) return res.status(400).json({ error: f.error });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${f.clause}`).get(...f.params).n;
    const rows = db.prepare(
      `SELECT * FROM audit_log ${f.clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...f.params, pageSize, (page - 1) * pageSize);
    res.json({ rows, total, page, pageSize });
  });

  router.get('/export.csv', (req, res) => {
    const f = buildFilters(req.query);
    if (f.error) return res.status(400).json({ error: f.error });
    audit(req, 'audit.export', null, {
      filters: { from: req.query.from, to: req.query.to, user: req.query.user, action: req.query.action },
    }, 'success');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`);
    res.write(CSV_COLS.join(',') + '\n');
    const stmt = db.prepare(`SELECT * FROM audit_log ${f.clause} ORDER BY ts DESC, id DESC`);
    for (const row of stmt.iterate(...f.params)) {
      res.write(CSV_COLS.map(c => csvCell(row[c])).join(',') + '\n');
    }
    res.end();
  });

  return router;
}

module.exports = { createAuditApiRouter };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/adminApis.test.js` — expected PASS.

- [ ] **Step 6: Mount in `server.js`**

After the `wireAuth`/`setOnAuthzDenied` block (Task 11 Step 3), add (requires to the top import block):

```js
const { createUsersRouter } = require('./server/auth/usersApi');
const { createAuditApiRouter } = require('./server/auditApi');

if (!AUTH_DISABLED) {
  app.use('/api/users', auth.requireRole('admin'),
    createUsersRouter({ authStore: auth.authStore, sessionStore: auth.sessionStore, audit: auditLog.audit }));
  app.use('/api/audit', auth.requireRole('admin'),
    createAuditApiRouter({ db: metricsStore._db(), audit: auditLog.audit }));
}
```

(With `AUTH_DISABLED` there are no users to manage and possibly no DB — hiding the admin APIs in dev-hatch mode is correct.)

- [ ] **Step 7: Full suite + commit**

Run: `npx vitest run` — green.

```bash
git add server/auth/usersApi.js server/auditApi.js server.js tests/server/adminApis.test.js
git commit -m "feat(admin): user management API and paginated audit log API with streamed CSV export"
```

---

### Task 13: Users + Audit admin panels (frontend)

**Files:**
- Create: `src/components/UsersPanel.jsx`
- Create: `src/components/AuditPanel.jsx`
- Modify: `src/components/Header.jsx` (admin-only buttons)
- Modify: `src/App.jsx` (render panels)
- Test: `src/components/UsersPanel.test.jsx`

**Interfaces:**
- Consumes: `/api/users/*` and `/api/audit` (Task 12), `useAuth().hasRole` (Task 9). No router exists in this app — admin pages are overlay panels like `AlertPanel` (open/close via App state).
- Produces: `<UsersPanel open onClose />`, `<AuditPanel open onClose />`; Header gains "Users" and "Audit" buttons visible only when `hasRole('admin')`; App wires `showUsers` / `showAudit` state. Timestamps render with an explicit **UTC** label (global constraint).

- [ ] **Step 1: Write the failing test**

Create `src/components/UsersPanel.test.jsx`:

```jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import React from 'react'
import UsersPanel from './UsersPanel'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'root', role: 'admin' }, hasRole: () => true }),
}))
afterEach(() => vi.unstubAllGlobals())

const usersBody = { users: [
  { id: 1, username: 'root', role: 'admin', disabled: 0, created_at: 1, updated_at: 1 },
  { id: 2, username: 'op1', role: 'operator', disabled: 1, created_at: 1, updated_at: 1 },
] }

describe('UsersPanel', () => {
  it('lists users with role and disabled state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => usersBody })))
    render(<UsersPanel open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('op1')).toBeInTheDocument())
    expect(screen.getByText('root')).toBeInTheDocument()
    expect(screen.getByText(/disabled/i)).toBeInTheDocument()
  })

  it('creates a user via the form', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET' })
      if ((opts.method || 'GET') === 'POST') return { ok: true, status: 201, json: async () => ({ user: {} }) }
      return { ok: true, status: 200, json: async () => usersBody }
    }))
    render(<UsersPanel open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('root')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/new username/i), { target: { value: 'fresh' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'longenough1' } })
    fireEvent.click(screen.getByRole('button', { name: /create user/i }))
    await waitFor(() =>
      expect(calls.some(c => c.method === 'POST' && c.url === '/api/users')).toBe(true))
  })

  it('renders nothing when closed', () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container } = render(<UsersPanel open={false} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/UsersPanel.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/components/UsersPanel.jsx`**

```jsx
import React, { useEffect, useState, useCallback } from 'react'
import { X, KeyRound, Ban, CheckCircle2, LogOut } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'

const ROLES = ['viewer', 'operator', 'admin']

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export default function UsersPanel({ open, onClose }) {
  const { user: me } = useAuth()
  const [users, setUsers] = useState([])
  const [error, setError] = useState(null)
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer' })

  const load = useCallback(async () => {
    try { setUsers((await api('/api/users')).users); setError(null) }
    catch (err) { setError(err.message) }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])
  if (!open) return null

  const run = fn => async () => {
    try { await fn(); await load() } catch (err) { setError(err.message) }
  }

  async function onCreate(e) {
    e.preventDefault()
    await run(async () => {
      await api('/api/users', 'POST', newUser)
      setNewUser({ username: '', password: '', role: 'viewer' })
    })()
  }

  function resetPassword(u) {
    const password = window.prompt(`New password for ${u.username} (min 8 chars):`)
    if (password) run(() => api(`/api/users/${u.id}/password`, 'POST', { password }))()
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-label="User management">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-lg h-full overflow-y-auto p-6"
           style={{ background: 'var(--card-bg)', boxShadow: 'var(--card-shadow)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Users</h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-black/5"
                  style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>
        {error && <p className="text-xs text-red-500 mb-3" role="alert">{error}</p>}

        <form onSubmit={onCreate} className="mb-5 rounded-2xl p-4" style={{ border: '1px solid var(--input-border)' }}>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <label className="block col-span-2 sm:col-span-1">
              <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>New username</span>
              <input value={newUser.username} onChange={e => setNewUser(s => ({ ...s, username: e.target.value }))}
                     className="w-full rounded-xl px-2.5 py-1.5 text-sm"
                     style={{ border: '1px solid var(--input-border)', background: 'var(--body-bg)', color: 'var(--text-primary)' }} />
            </label>
            <label className="block col-span-2 sm:col-span-1">
              <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Password</span>
              <input type="password" value={newUser.password} onChange={e => setNewUser(s => ({ ...s, password: e.target.value }))}
                     className="w-full rounded-xl px-2.5 py-1.5 text-sm"
                     style={{ border: '1px solid var(--input-border)', background: 'var(--body-bg)', color: 'var(--text-primary)' }} />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <select value={newUser.role} onChange={e => setNewUser(s => ({ ...s, role: e.target.value }))}
                    className="rounded-xl px-2.5 py-1.5 text-sm"
                    style={{ border: '1px solid var(--input-border)', background: 'var(--body-bg)', color: 'var(--text-primary)' }}>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="submit" disabled={!newUser.username || newUser.password.length < 8}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--header-bg)' }}>
              Create user
            </button>
          </div>
        </form>

        <ul className="space-y-2">
          {users.map(u => (
            <li key={u.id} className="rounded-2xl p-3 flex items-center gap-2"
                style={{ border: '1px solid var(--input-border)', opacity: u.disabled ? 0.6 : 1 }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{u.username}</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {u.disabled ? 'disabled' : 'active'}{u.id === me?.id ? ' · you' : ''}
                </div>
              </div>
              <select value={u.role} disabled={u.id === me?.id} aria-label={`Role for ${u.username}`}
                      onChange={e => run(() => api(`/api/users/${u.id}/role`, 'PUT', { role: e.target.value }))()}
                      className="rounded-lg px-1.5 py-1 text-xs"
                      style={{ border: '1px solid var(--input-border)', background: 'var(--body-bg)', color: 'var(--text-primary)' }}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <button title="Reset password" aria-label={`Reset password for ${u.username}`}
                      onClick={() => resetPassword(u)}
                      className="p-1.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--text-muted)' }}>
                <KeyRound size={14} />
              </button>
              <button title="Sign out everywhere" aria-label={`Revoke sessions for ${u.username}`}
                      onClick={run(() => api(`/api/users/${u.id}/sessions`, 'DELETE'))}
                      className="p-1.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--text-muted)' }}>
                <LogOut size={14} />
              </button>
              {u.id !== me?.id && (
                <button title={u.disabled ? 'Enable' : 'Disable'}
                        aria-label={`${u.disabled ? 'Enable' : 'Disable'} ${u.username}`}
                        onClick={run(() => api(`/api/users/${u.id}/${u.disabled ? 'enable' : 'disable'}`, 'POST'))}
                        className="p-1.5 rounded-lg hover:bg-black/5"
                        style={{ color: u.disabled ? 'var(--text-muted)' : '#ef4444' }}>
                  {u.disabled ? <CheckCircle2 size={14} /> : <Ban size={14} />}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/UsersPanel.test.jsx` — expected PASS.

- [ ] **Step 5: Implement `src/components/AuditPanel.jsx`**

```jsx
import React, { useEffect, useState, useCallback } from 'react'
import { X, Download, ChevronLeft, ChevronRight } from 'lucide-react'

const PAGE_SIZE = 50

function fmtUtc(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export default function AuditPanel({ open, onClose }) {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState({ user: '', action: '' })
  const [error, setError] = useState(null)

  const query = useCallback((p = page) => {
    const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
    if (filters.user) params.set('user', filters.user)
    if (filters.action) params.set('action', filters.action)
    return params.toString()
  }, [page, filters])

  const load = useCallback(async (p = page) => {
    try {
      const res = await fetch(`/api/audit?${query(p)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load audit log')
      setRows(data.rows); setTotal(data.total); setError(null)
    } catch (err) { setError(err.message) }
  }, [page, query])

  useEffect(() => { if (open) load(page) }, [open, page, load])
  if (!open) return null

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-label="Audit log">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-3xl h-full overflow-y-auto p-6"
           style={{ background: 'var(--card-bg)', boxShadow: 'var(--card-shadow)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Audit trail <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>(append-only)</span>
          </h2>
          <div className="flex items-center gap-2">
            <a href={`/api/audit/export.csv?${query(1)}`} download
               className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium hover:bg-black/5"
               style={{ border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}>
              <Download size={13} /> Export CSV
            </a>
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-black/5"
                    style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
          </div>
        </div>

        <div className="flex gap-2 mb-3">
          {[['user', 'Filter by user'], ['action', 'Filter by action (e.g. session.kill)']].map(([k, ph]) => (
            <input key={k} value={filters[k]} placeholder={ph}
                   onChange={e => setFilters(s => ({ ...s, [k]: e.target.value }))}
                   onKeyDown={e => { if (e.key === 'Enter') { setPage(1); load(1) } }}
                   className="flex-1 rounded-xl px-2.5 py-1.5 text-xs"
                   style={{ border: '1px solid var(--input-border)', background: 'var(--body-bg)', color: 'var(--text-primary)' }} />
          ))}
          <button onClick={() => { setPage(1); load(1) }}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white hover:opacity-90"
                  style={{ background: 'var(--header-bg)' }}>Apply</button>
        </div>
        {error && <p className="text-xs text-red-500 mb-3" role="alert">{error}</p>}

        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              {['Time (UTC)', 'User', 'Action', 'Target', 'Outcome'].map(h =>
                <th key={h} className="text-left font-medium pb-2 pr-3">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}>
                <td className="py-1.5 pr-3 whitespace-nowrap">{fmtUtc(r.ts)}</td>
                <td className="py-1.5 pr-3">{r.username ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono">{r.action}</td>
                <td className="py-1.5 pr-3 truncate max-w-[200px]" title={r.detail}>{r.target ?? '—'}</td>
                <td className="py-1.5" style={{ color: r.outcome === 'failure' ? '#ef4444' : undefined }}>{r.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex items-center justify-between mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{total} events</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page"
                    className="p-1.5 rounded-lg hover:bg-black/5 disabled:opacity-40"><ChevronLeft size={14} /></button>
            <span>{page} / {pages}</span>
            <button disabled={page >= pages} onClick={() => setPage(p => p + 1)} aria-label="Next page"
                    className="p-1.5 rounded-lg hover:bg-black/5 disabled:opacity-40"><ChevronRight size={14} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Wire Header + App**

`src/components/Header.jsx` — extend the props with `onOpenUsers, onOpenAudit`, add `Users2, ScrollText` to the lucide import, get `hasRole` from `useAuth()`, and insert before the user chip:

```jsx
        {/* Admin: users + audit */}
        {hasRole('admin') && (
          <>
            <button onClick={onOpenUsers}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--header-icon)' }} title="Manage users">
              <Users2 size={14} /><span>Users</span>
            </button>
            <button onClick={onOpenAudit}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--header-icon)' }} title="Audit trail">
              <ScrollText size={14} /><span>Audit</span>
            </button>
          </>
        )}
```

`src/App.jsx` — add state + render (imports at top):

```jsx
import UsersPanel from './components/UsersPanel'
import AuditPanel from './components/AuditPanel'
```
```jsx
  const [showUsers, setShowUsers] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
```

Pass `onOpenUsers={() => setShowUsers(true)} onOpenAudit={() => setShowAudit(true)}` to `<Header ...>`, and next to `<AlertPanel ...>` render:

```jsx
      <UsersPanel open={showUsers} onClose={() => setShowUsers(false)} />
      <AuditPanel open={showAudit} onClose={() => setShowAudit(false)} />
```

- [ ] **Step 7: Verify in the browser**

`npm start` + `npm run dev`: as admin — create a user, change role, disable/enable, reset password, revoke sessions; open Audit, filter by action `user.create`, export CSV and open it. Log in as the viewer — Users/Audit buttons absent; hitting `/api/users` directly returns 403 (and writes `authz.denied`). Full suite: `npx vitest run` — green.

- [ ] **Step 8: Commit**

```bash
git add src/components/UsersPanel.jsx src/components/AuditPanel.jsx src/components/UsersPanel.test.jsx src/components/Header.jsx src/App.jsx
git commit -m "feat(admin): Users and Audit admin panels with role-gated header entry points"
```

---

### Task 14: R1 ship gate

**Files:** none new — verification + docs touch-ups only.

**Interfaces:** Consumes everything above. Produces a shippable R1.

- [ ] **Step 1: Full automated suite**

Run: `npx vitest run` — everything green, including all pre-existing tests (evaluator, metricsStore, history, frontend).

- [ ] **Step 2: Production build**

Run: `npm run build` — Vite build succeeds; `npm start` serves `dist/` with login screen.

- [ ] **Step 3: Manual smoke — spec §6 ship-gate checklist**

Fresh DB (temporarily move `data/metrics.db` aside — restore afterwards):
1. Boot → console prints bootstrap token; browser shows token-protected bootstrap screen and nothing else.
2. Bootstrap **without** token (curl and UI) → fails. With token → admin created, token file deleted, `admin.bootstrap` audit row exists.
3. Restart with users present → no token printed.
4. All endpoints 401 without a session: `curl -s -o /dev/null -w "%{http_code}" localhost:3000/api/connections` → 401.
5. Permission matrix over HTTP: viewer 403 on kill/ack, operator 403 on `/api/users` (each writes `authz.denied`).
6. Destructive-action audit (needs a dev SQL Server connection — `medcare_db_dev`, never production): kill a session → `session.kill` row has SPID + connection label and **no SQL text**; ack an alert → `alert.ack` row.
7. Socket.io: logged-out browser tab gets no live data; after login, live charts stream.
8. **Recovery CLI flow:** disable your own admin via a second admin (or set `disabled=1` in SQLite), confirm lockout, run `node reset-admin.js <username>`, log back in with the printed password.
9. `AUTH_DISABLED=true HOST=0.0.0.0 npm start` → refuses to start. `AUTH_DISABLED=true` alone → starts with loud warning, no login required.
10. Upgrade path: restore the pre-R1 `metrics.db` copy, boot → migration v3 runs, backup file printed and present next to the DB.

- [ ] **Step 4: Documentation**

Update `CLAUDE.md` "Auth" section and `.env.example`: add `SESSION_SECRET` (optional — auto-generated), `AUTH_DISABLED`, `TRUST_PROXY`, `AUDIT_RETENTION_DAYS` (default 365, `0` = keep forever). Release-note line: upgrading turns on login; first boot shows the token-protected bootstrap screen; copy says "append-only audit trail" — never "tamper-proof".

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .env.example
git commit -m "docs: R1 auth/audit configuration and upgrade notes"
```

---

## Self-Review (completed at plan time)

- **Spec coverage (§2, §3, §6):** session auth + custom store (T3), cookie flags + TRUST_PROXY (T6), bcrypt 12 + rate limit + lockout event (T2/T4/T11), gate all REST (T6), Socket.io (T7), permission matrix (T6), bootstrap token incl. regeneration + deletion (T5), recovery CLI (T8), dev hatch + 0.0.0.0 refusal (T6), login/bootstrap UI + header chip (T9), audit helper + PHI comment + fail-open + fallback (T10), all §3 recorded actions (T11/T12; `channel.*`/`rule.change` are R2/R3 by spec), before/after on `user.update` (T12), retention + `audit.prune` (T10/T11), server-side pagination + streamed audited CSV (T12/T13), indexes (T1), migration discipline: v3, VACUUM INTO backup, restore story, newer-DB refusal (T1). Curl-testable backend ordering preserved: T1 migration → T2–T5 auth module + session store → T6 gate REST → T7 gate Socket.io → (T8 recovery CLI, host-side) → T9 login UI + bootstrap → T10–T11 audit helper + hooks → T12–T13 Users/Audit admin surfaces.
- **Known deviation:** T8 (recovery CLI) sits between "gate Socket.io" and "login UI" — it is backend/CLI-only and keeps the backend fully verifiable before any UI work; audit calls for it are retrofitted in T11 because the audit helper intentionally comes after the UI per the mandated ordering.
- **Type consistency:** `createAuthStore(db, {bcryptCost})` signature consistent across T2/T6/T8 harnesses; `wireAuth` return shape consistent across T6/T11/T12; `audit(req, action, target, detail, outcome)` arity consistent everywhere; `SQLiteSessionStore.destroyByUserId` used in T6 test, T8, T12.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code.
