# Persistent Connection Manager — Design Spec

**Date:** 2026-07-08
**Status:** Approved for implementation
**Scope:** MVP (v1.0) — Move active server tabs to a persistent Connections section in the left sidebar

---

## 1. Overview

Replace the top horizontal server tab bar (`TabBar.jsx`) with a persistent **Connections** section inside the left slide-out sidebar. Connection metadata persists across browser refresh, browser restart, and app restart. On startup the app restores saved connections and reconnects in the background. One selected connection drives the dashboard; a global refresh action refreshes all connected servers; switching between connected servers is instant via cached metrics.

### Architecture principles

1. **Profile/Live separation.** `ConnectionProfile` (persisted metadata) and `LiveConnection` (runtime state) are distinct layers linked by a stable UUID. Profiles never contain runtime state; live entries are never persisted.
2. **Single owner.** `ConnectionContext` (ConnectionManager) is the sole owner of connection lifecycle: create, connect, reconnect, remove, refresh, select. No component talks to `/api/connect` or the socket directly.
3. **One-way dependencies.** Sidebar renders from profiles + derived status. Dashboard renders from live state of the selected connection. Neither reaches into the other's layer.
4. **Selection is UI state, not profile state.** Stored separately (`sqlmon-ui-state`) so switching servers never rewrites the profile array.
5. **Never persist credentials.** SQL auth passwords live at most in `sessionStorage` for the browser session, only if the user opts in. Windows auth needs no credentials.
6. **Event-driven completion.** Refresh and status changes complete via socket events with correlation IDs, not HTTP responses.
7. **Read-only view models.** UI consumes derived `EnrichedConnection` objects; it never mutates context state directly.

### Non-goals (explicitly out of scope for v1.0)

- No cloud sync or multi-device profile sharing
- No multi-user support or per-user profiles
- No encrypted credential storage (client-side encryption rejected: decryption key recoverable from browser profile — unacceptable for production SQL Server credentials)
- No server-side profile persistence
- No folders, favorites, drag-and-drop reorder, duplicate, search, or import/export (deferred to v1.1/v1.2)

---

## 2. Data Model & Storage

### ConnectionProfile (persisted)

```typescript
{
  schemaVersion: 1,
  id: string,                    // stable UUID; links profile ↔ live entry
  displayName: string,
  serverName: string,
  authenticationType: 'windows' | 'sql',
  database?: string,
  color?: string,
  environment?: 'production' | 'qa' | 'development' | 'dr',
  autoConnect: boolean,          // Windows auth only; always false for sql
  displayOrder: number,
  lastConnectedAt?: string,      // ISO timestamp, set on successful connect
  createdAt: string,
  updatedAt: string
}
```

### LiveConnection (React state only — never persisted)

```typescript
{
  id: string,
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting' | 'failed' | 'expired',
  refreshState: 'idle' | 'refreshing' | 'failed',   // independent of status
  metrics?: MetricsCache,
  history?: HistoryBuckets,
  lastRefresh?: number,          // timestamp of last successful metrics RECEIVED
  lastError?: string
}
```

`status` and `refreshState` are orthogonal: a connection can be `connected` + `refreshing`, or `connected` + `failed` (last refresh failed but connection alive).

### Storage keys

| Key | Store | Contents |
|-----|-------|----------|
| `sqlmon-connection-profiles` | localStorage | Array of ConnectionProfile |
| `sqlmon-ui-state` | localStorage | `{ selectedConnectionId: string \| null }` (+ future UI prefs) |
| `sqlmon-session-passwords` | sessionStorage | Single object keyed by connectionId: `{ [id]: password }`. Opt-in only. Cleared when browser closes. |

### Migration (one-time, idempotent)

Old keys `sqlmon-saved-conn` and `sqlmon-conn-id` are migrated into a ConnectionProfile with `schemaVersion: 1`, then deleted. Guarded so re-running is a no-op (if `sqlmon-connection-profiles` exists, skip). Old sessionStorage `sqlmon-saved-pass` is discarded.

### Credential policy (Option C+)

- **Windows auth:** auto-reconnect on startup (`autoConnect: true` allowed). No credentials stored anywhere.
- **SQL auth:** password is NEVER persisted to localStorage, cookies, or profiles. On startup the profile restores as `expired` (awaiting credentials). Clicking it selects it and auto-opens the ReconnectModal to prompt for the password. Optional checkbox "Remember password for this session" stores it in `sqlmon-session-passwords` (sessionStorage) until the browser closes.
- Future enterprise path (out of scope): server-side encryption + secrets manager + temporary tokens.

---

## 3. Connection State Machine

```
                       ┌─────────────────────────────────────────────┐
                       │                                             │
   profile loaded      ▼                                             │
  ┌──────────┐   ┌───────────┐  connect OK   ┌───────────┐           │
  │ expired  │──▶│connecting │──────────────▶│ connected │           │
  │(sql auth)│   └───────────┘               └───────────┘           │
  └──────────┘     │      ▲                    │       │             │
       ▲           │      │ user reconnect     │       │ unexpected  │
       │   connect │      │ (password if sql)  │       │ disconnect  │
       │   fails   │      │                    │       ▼             │
       │           ▼      │                    │  ┌──────────────┐   │
       │       ┌────────┐ │                    │  │ reconnecting │───┘
       │       │ failed │─┘                    │  │ (1 retry,    │ retry OK
       │       └────────┘                      │  │  after 5s)   │
       │            ▲                          │  └──────────────┘
       │            │ retry fails              │       │
       │            └──────────────────────────│───────┘ retry fails
       │                                       ▼
       │  sql auth, startup restore    ┌──────────────┐
       └───────────────────────────────│ disconnected │ (user removed / clean stop)
                                       └──────────────┘
```

Rules:
- Unexpected disconnect → `reconnecting`, one automatic retry after 5s. Retry fails → `failed`. No infinite retry loops.
- SQL-auth profiles restore on startup as `expired` (the only meaning of `expired`: SQL auth awaiting credentials).
- Windows-auth profiles with `autoConnect: true` restore as `connecting` immediately.
- User-initiated reconnect from `failed`/`disconnected`/`expired` → `connecting`.

### Startup sequence

1. Load profiles from `sqlmon-connection-profiles` (run migration first if needed).
2. Create ALL LiveConnection runtime entries BEFORE any reconnect attempt (sidebar renders fully, instantly).
3. Restore selection: saved `selectedConnectionId` → else first profile by `displayOrder` → else null.
4. Kick off background reconnects: Windows auth + `autoConnect` → connect; SQL auth → leave `expired`.
5. `isInitializing` guard prevents duplicate startup on React StrictMode double-mount.

---

## 4. ConnectionContext API

```typescript
{
  // state
  profiles: ConnectionProfile[],
  liveConnections: Map<string, LiveConnection>,
  selectedConnectionId: string | null,
  isInitializing: boolean,
  isRefreshing: boolean,

  // derived (read-only view models)
  enrichedConnections: EnrichedConnection[],   // { profile, live, displayStatus, isSelected }

  // actions
  addConnection(form): Promise<void>,
  updateConnection(id, updates: Partial<ConnectionProfile>): Promise<void>,
  removeConnection(id): Promise<void>,
  reconnect(id, password?): Promise<void>,
  renameConnection(id, name): void,            // thin wrapper → updateConnection
  setSelected(id): void,
  refreshAllConnections(): Promise<void>,      // deduped via refresh lock

  // lookups
  getProfile(id), getLiveConnection(id), getEnrichedConnection(id),

  // dashboard selectors
  selectedMetrics, selectedHistory, selectedConnection
}
```

Behavior notes:
- `refreshAllConnections()` holds a refresh lock: concurrent calls while `isRefreshing` are no-ops.
- `isRefreshing` clears event-driven: when metrics arrive for all requested connection IDs, or on a 10–15s timeout (connections that never reported are marked `refreshState: 'failed'`).
- Metrics arriving for an ID not in `liveConnections` (removed connection) are ignored.
- Expired connection click: `setSelected(id)` first, THEN auto-open ReconnectModal (selection behavior stays consistent for all statuses).

---

## 5. UI Components

### Component ownership matrix

| Component | Owns | Reads | Never touches |
|-----------|------|-------|---------------|
| `ConnectionContext` | Profiles, live state, selection, socket subscriptions, refresh lock | localStorage, socket events | UI/DOM |
| `Sidebar.jsx` | Slide-out open/close state (via AppContext `sidebarOpen`) | — | Connection internals |
| `ConnectionList.jsx` | List layout, pinned Add button, empty state, scroll preservation | `enrichedConnections` | Live state directly |
| `ConnectionItem.jsx` | Row render, status indicator, click/keyboard selection, context-menu trigger | One `EnrichedConnection` | Other connections |
| `ConnectionContextMenu.jsx` | Menu positioning, action dispatch | Item's enriched state | Storage |
| `ReconnectModal.jsx` | Password prompt, session-remember checkbox | Profile of target ID | Profile persistence |
| `ConnectModal.jsx` (existing, updated) | Add/edit connection form | — | Live state |
| `Dashboard` | Chart/table rendering | `selectedMetrics`, `selectedHistory` | Profiles |
| `AppContext` (slimmed) | `palette`, `widgetLayout`, `sidebarOpen` only | — | Connections |

`TabBar.jsx` is removed.

### Sidebar Connections section

- Width 18rem. Connections section with pinned "Add Connection" button (always visible, list scrolls under it).
- Each item: color dot/environment accent, display name, server name (secondary), status indicator.
- Status indicators use **icon + color** (never color alone): 🟢 connected / 🟡 connecting-reconnecting (animated) / 🔴 failed-disconnected / ⚪ expired (awaiting credentials).
- Tooltips on status icons explain state (e.g., "Reconnecting — attempt 1", "Password required").
- Selected item: distinct background + accent border.
- Empty state: friendly prompt + Add Connection call-to-action.
- Skeleton rows while `isInitializing`.
- Scroll position preserved across re-renders.

### Interaction

- Click / Enter / Space selects. Full keyboard navigation (arrow keys through list, Escape closes menu/sidebar).
- Context menu (right-click or ⋯ button), v1.0 actions: **Reconnect** (disabled while `connecting`/`reconnecting`), **Rename**, then separator, **Remove** (destructive styling, confirm).
- Expired item click → selects + opens ReconnectModal.
- Removing the selected connection: selection falls back to first remaining profile, else null (dashboard shows empty state).

---

## 6. Backend & Socket Contracts

### Existing (reused)

- Server already polls every connection in its `connections` Map every 2s (POLL_MS) via `Promise.all` DMV queries, broadcasting to Socket.io room `conn:{connId}`. The "background refresh engine" largely exists.
- `POST /api/connect` accepts `_clientId` for stable UUID; `DELETE /api/disconnect/:id`.

### New endpoints

- `POST /api/refresh/all` — preferred; triggers an immediate poll cycle for all live connections. Responds `204` immediately (target < 250ms); data arrives via socket.
- `POST /api/refresh/:id` — single-connection refresh (used by future context-menu Refresh; ships in v1.0 backend for completeness).

Both reuse the existing poll function; no duplicate query paths.

### Socket event contracts

```typescript
// server → client
metricsUpdated          { connectionId, refreshRequestId?, metrics, history, timestamp }
connectionStatusChanged { connectionId, status, error? }
refreshFailed           { connectionId, refreshRequestId, reason }
serverRemoved           { connectionId }

// client → server
subscribe               connectionId   // joins room conn:{connId}
```

- `refreshRequestId` is the correlation ID: present when metrics were produced by an explicit refresh request, letting the client match completion against `refreshAllConnections()`.
- **Socket reconnect handling (essential):** on socket `reconnect`, the client re-emits `subscribe` for every connection ID with live status `connected`/`reconnecting`. Without this, a dropped socket silently stops all metric flow.

---

## 7. Performance Targets

| Operation | Target |
|-----------|--------|
| Sidebar render (list of connections) | < 50ms |
| Switch selected connection (cached metrics) | < 100ms |
| Startup restore, 10 profiles | < 1s to interactive sidebar |
| `POST /api/refresh/all` accept | < 250ms |
| Profile count supported without degradation | 100+ |

---

## 8. Error Handling Summary

| Failure | Behavior |
|---------|----------|
| Unexpected pool disconnect | `reconnecting` → 1 retry after 5s → `failed` if retry fails |
| Connect attempt fails | `failed`, `lastError` set, shown in tooltip |
| Refresh partial failure | Timed-out connections marked `refreshState: 'failed'`; others complete normally |
| Metrics for removed connection | Ignored (`liveConnections.has(id)` guard) |
| Corrupt localStorage profile array | Fail safe: treat as empty, log warning, do not crash |
| Socket drop | Auto-reconnect (Socket.io) + re-subscribe all live IDs |

---

## 9. Testing

- **Reducer/context tests:** update `src/__tests__/context/reducer.test.jsx` for slimmed AppContext; new tests for ConnectionContext (state machine transitions, selection fallback, refresh lock, event-driven completion, removed-connection metric ignore).
- **Persistence tests:** extend `src/__tests__/integration/persistence.test.js` — profile round-trip, migration idempotency, ui-state selection restore, session-password opt-in scope.
- **Component tests:** ConnectionList empty/skeleton/populated states, ConnectionItem status rendering + keyboard selection, context-menu action gating (Reconnect disabled while connecting).
- **Manual:** browser-verify slide-out sidebar, expired→modal flow, refresh-all spinner lifecycle, socket-drop re-subscribe.

---

## 10. Phasing

- **v1.0 (this spec):** everything above; context menu = Reconnect / Rename / Remove.
- **v1.1:** Edit connection, Set default, favorites, richer timestamps.
- **v1.2:** Drag-drop reorder, Duplicate, search/filter, groups, import/export.
