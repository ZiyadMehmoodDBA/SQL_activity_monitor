# Unit of Work — SQL Server Activity Monitor

Complete setup, development, and operational reference.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 18+ | LTS recommended |
| npm 9+ | Ships with Node |
| SQL Server 2016+ | 2019/2022 recommended for all features |
| SQL login permission | `VIEW SERVER STATE` minimum |
| Windows Auth (optional) | Requires app runs on domain-joined machine or service account |

---

## First-Time Setup

```bash
# 1. Clone / unzip project
cd dashbaords

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — see Configuration section below

# 4. Build frontend (production)
npm run build

# 5. Start server
npm start
# Opens at http://localhost:3000
```

---

## Configuration (`.env`)

```env
# Target SQL Server
DB_SERVER=HCMPSDB01\HCMPS      # SERVER\INSTANCE or SERVER,PORT
DB_NAME=master                  # Default database

# Auth type: "windows" (trusted) or "sql" (SQL login)
AUTH_TYPE=windows

# SQL auth only — leave blank for Windows auth
DB_USER=
DB_PASS=

# Server tuning
PORT=3000
POLL_INTERVAL_MS=2000           # Data refresh rate (ms)
```

### Windows Authentication Notes
- Tedious driver uses NTLM. Works when the Node process runs under a domain account with access to SQL Server.
- If NTLM fails, install the native driver: `npm install msnodesqlv8` and set `AUTH_TYPE=windows-native`.
  Requires SQL Server Native Client or ODBC Driver installed on the same machine.

### SQL Server Permissions Required
```sql
-- Minimum
GRANT VIEW SERVER STATE TO [login];

-- For SQL Agent job operations (start/stop)
-- User must be a member of:
-- msdb.dbo.SQLAgentOperatorRole  (start/stop own jobs)
-- msdb.dbo.SQLAgentReaderRole    (view all jobs)
```

---

## Development Workflow

```bash
# Run backend + Vite dev server concurrently (hot reload on both)
npm run dev
# Backend:  http://localhost:3000
# Frontend: http://localhost:5173  (proxies /api and /socket.io to :3000)

# Build for production
npm run build
# Output: dist/  (served by server.js automatically)

# Run tests
npm test              # watch mode
npm run test:run      # single run (CI)
npm run test:coverage # coverage report (lcov + text)
```

---

## Test Structure

```
src/
├── __tests__/
│   ├── components/
│   │   ├── JobsPanel.test.jsx
│   │   ├── SessionsPanel.test.jsx
│   │   ├── WhoIsActive.test.jsx
│   │   └── WidgetSidebar.test.jsx
│   ├── context/
│   ├── integration/
│   └── lib/
│       ├── fmt.test.js
│       └── widgetRegistry.test.js
└── test/
    ├── setup.js        — jsdom + @testing-library/jest-dom matchers
    └── helpers.jsx     — shared test utilities
```

Test runner: **Vitest** with jsdom environment. No real DB connection required for unit tests.

---

## Project File Map

```
dashbaords/
├── server.js               — Express + Socket.io backend (775 lines)
├── package.json
├── vite.config.js          — Vite build config + Vitest config + dev proxy
├── .env.example            — Environment variable template
├── .env                    — Local config (NEVER commit)
├── tailwind.config.js
├── postcss.config.js
├── data/
│   └── db-size-history.json  — Daily DB size snapshots (auto-created, gitignored)
├── dist/                     — Production build output (gitignored)
├── public/                   — Static fallback assets
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── index.css
    ├── context/
    │   └── AppContext.jsx
    ├── hooks/
    │   └── useSocket.js
    ├── lib/
    │   ├── palettes.js
    │   ├── widgetRegistry.js
    │   ├── tableCols.js
    │   ├── thresholds.js
    │   ├── fmt.js
    │   └── cn.js
    └── components/
        ├── Dashboard.jsx
        ├── Header.jsx
        ├── TabBar.jsx
        ├── ConnectModal.jsx
        ├── WidgetSidebar.jsx
        ├── CollapsibleSection.jsx
        ├── KPIBar.jsx
        ├── ChartCard.jsx
        ├── MemoryHealth.jsx
        ├── DriveMonitor.jsx
        ├── DbSizes.jsx
        ├── DbSizeTrend.jsx
        ├── JobsPanel.jsx
        ├── SessionsPanel.jsx
        ├── WhoIsActive.jsx
        ├── VirtualTable.jsx
        └── ui/
            └── Dialog.jsx
```

---

## Adding a New Widget

1. Register it in `src/lib/widgetRegistry.js` — add entry to `WIDGET_REGISTRY` array with a unique `id`, `label`, `group` (`panel` or `section`), `category`, and `defaultEnabled`.
2. Add the DMV query in `server.js` `pollMetrics()` — push result into the metrics object emitted on every tick.
3. Handle it in `AppContext.jsx` `UPDATE_METRICS` reducer if history/ring-buffer is needed.
4. Render it in `Dashboard.jsx` — check `on('widget_id')` (panel group) or add to section list (section group).
5. If it's a sortable table, add column definitions to `src/lib/tableCols.js`.

---

## Adding a New Theme / Palette

1. Add entry to `PALETTES` object in `src/lib/palettes.js`. Copy an existing palette and change colors.
2. Add the palette name to the picker in `src/components/Header.jsx` (`PALETTES` import already covers it — just ensure the name is spelled exactly).
3. If the new palette is dark (dark card backgrounds), add `[data-theme="yourname"]` overrides in `src/index.css` for tables, inputs, and `.mc` cards.

---

## Connecting to Multiple SQL Server Instances

Each connected instance gets its own:
- Socket.io room (`connId`)
- Poll loop (`setInterval` in server.js connection registry)
- Tab in the UI (TabBar.jsx)
- State slice in AppContext (`connections[connId]`)

Maximum concurrent connections: limited only by SQL Server pool availability and Node thread capacity.

---

## Data Persistence

| Data | Storage | Location | TTL |
|------|---------|----------|-----|
| DB size history | JSON file | `data/db-size-history.json` | 10 days (auto-pruned) |
| Widget layout | localStorage | `sqlmon-widget-layout` | Until cleared |
| Active palette | localStorage | `palette` | Until cleared |
| Section collapse state | In-memory only | — | Resets on page load |
| Connection credentials | `.env` (server default) or entered at runtime | — | Session only for runtime |

---

## Deployment (Production)

```bash
npm run build       # compile React → dist/
npm start           # server.js serves dist/ as static files
```

Reverse proxy with nginx (optional):

```nginx
server {
    listen 80;
    server_name sqlmon.internal;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";  # required for Socket.io
        proxy_set_header Host $host;
    }
}
```

Run as Windows service with [NSSM](https://nssm.cc/):
```
nssm install SqlActivityMonitor "C:\Program Files\nodejs\node.exe" "D:\dashbaords\server.js"
nssm set SqlActivityMonitor AppDirectory D:\dashbaords
nssm set SqlActivityMonitor AppEnvironmentExtra "NODE_ENV=production"
nssm start SqlActivityMonitor
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ConnectionError: Login failed` | Wrong credentials or auth type | Check `AUTH_TYPE`, `DB_USER`, `DB_PASS` in `.env` |
| `ECONNREFUSED` on start | SQL Server not reachable | Check `DB_SERVER`, firewall, SQL Server Browser running |
| Windows Auth fails with Tedious | NTLM negotiation issue | Install `msnodesqlv8`, set `AUTH_TYPE=windows-native` |
| Drive cards show duplicates | Old server.js without GROUP BY fix | Ensure GROUP BY `volume_mount_point` only (not including `total_bytes`) |
| Charts grow taller each tick | ResizeObserver loop | Ensure `overflow:hidden` on `.mc` + `chart-wrap`, `contain:layout style` on `.section-body-inner` |
| `sp_WhoIsActive` returns error | Proc not installed on target | Install sp_WhoIsActive on the target SQL Server instance |
| DB size trends empty | No snapshot taken yet | Snapshot runs once per day at first poll — wait or restart server |
| Deadlocks section empty | system_health XE session not running | Enable system_health XE session (on by default in SQL 2008+) |
