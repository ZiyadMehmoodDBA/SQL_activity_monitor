# Design — SQL Server Activity Monitor

Visual language, component patterns, and design decisions.

---

## Design Philosophy

**Enterprise observability aesthetic.** The register is Grafana / Datadog / Azure Monitor — dense information, minimal decoration, function over form. The dashboard should feel like a professional tool, not a consumer app.

**Status-only color.** Metric values are neutral by default. Color appears only when a threshold is breached (WARN amber, CRIT red). No decorative colorization of numbers, labels, or chart fills simply because they can be colored.

**Information density over whitespace.** Cards and tables use compact padding. Rows are tight. Numbers use compact notation (`82.9M`, `4.3k`, `1h 22m`). Full values appear on hover — not inline.

**Interactivity at boundaries.** Hover states on cards (shadow lift), rows (background tint), sort headers (background), and section toggles. Transitions are short (0.15–0.28s) — responsive, not decorative.

---

## Color System

All colors flow through CSS custom properties. No hardcoded hex values in component code.

### Design Tokens (`:root`)

```css
/* Layout */
--body-bg          Page background
--header-bg        Fixed navigation bar
--card-bg          Card/panel background
--divider          Section divider line
--section-hover    Section header hover state
--row-hover        Table row hover tint

/* Typography */
--body-text        Default text (body)
--text-primary     High-emphasis labels
--text-secondary   Supporting labels, subtext
--text-muted       Timestamps, metadata, de-emphasized values

/* Status */
--c-ok             #16a34a  Healthy / passing
--c-warn           #ea580c  Warning threshold breached
--c-crit           #dc2626  Critical threshold breached
--c-info           #475569  Informational / neutral annotation

/* Process status badges */
--status-run-bg / --status-run-txt        Running (green tint)
--status-susp-bg / --status-susp-txt      Suspended / waiting (amber tint)
--status-sleep-bg / --status-sleep-txt    Sleeping / idle (slate tint)
--status-bgnd-bg / --status-bgnd-txt      Background system session (blue tint)

/* Metric chart colors (per-metric accent) */
--val-cpu          CPU %       — blue
--val-wait         Wait tasks  — amber
--val-io           DB I/O      — green
--val-batch        Batch req   — purple

/* Connection status dots */
--dot-live         Active / connected    — green
--dot-dead         Disconnected / error  — red
--dot-warn         Degraded connection   — amber
--dot-idle         No connection         — slate

/* Interactive */
--sort-active      Active sort column indicator — blue
--badge-bg / --badge-text   KPI / status badge fill and label color

/* Scrollbar */
--scroll-track / --scroll-thumb / --scroll-thumb-h

/* Form / input */
--input-bg / --input-border

/* Card chrome */
--card-border      Card border color
--card-radius      14px — all cards
--card-shadow      Multi-layer box-shadow (depth + border simulation)
```

### Severity Levels

Four-level system used on drive space cards and wherever a metric can escalate beyond critical:

| Level | Token | Default hex | Label |
|---|---|---|---|
| 0 | `--c-ok` | `#16a34a` | HEALTHY |
| 1 | `--c-warn` | `#ea580c` | WARNING |
| 2 | `--c-crit` | `#dc2626` | CRITICAL |
| 3 | `#7f1d1d` (static) | — | EMERGENCY |

Drive space thresholds vary by drive type (system / data / log / tempdb) — see `src/lib/thresholds.js`.

---

## Themes (Palettes)

10 named color schemes. Each palette overrides the full design token set by writing values directly to `:root` style via `document.documentElement.style.setProperty`. No CSS class toggling, no stylesheet swap — runtime CSS variable injection.

Dark mode is a special case: additionally sets `data-theme="dark"` on `<html>`, which enables a set of Tailwind utility class overrides in `index.css` that can't be expressed through custom properties alone (e.g., `text-slate-700` mapped to light text).

| Palette | Character |
|---|---|
| **Enterprise** | Clean light blue — default |
| **Dark** | GitHub Dark — deep navy, blue accents |
| **Mossy Hollow** | Muted olive greens and earth tones |
| **Golden Taupe** | Warm tans and amber |
| **Wisteria Bloom** | Soft lavenders and purple tints |
| **Burnt Sienna** | Deep rust and terracotta |
| **Desert Dusk** | Dusty mauve and sand |
| **Wildflowers** | Bright meadow greens with pop accents |

Palette selection persisted to `localStorage` and restored on page load.

---

## Layout

```
┌──────────────────────────────────────────────────┐
│  Header (fixed, z-50, full width)                 │
│  Logo · Server · Status dot · Last update         │
│  ──────────────────── Widgets · Theme picker      │
├──────────────────────────────────────────────────┤
│  TabBar (one tab per SQL Server connection)       │
├──────────────────────────────────────────────────┤
│  main  (p-6, max-w-[1920px], mx-auto)            │
│  ┌────────────────────────────────────────────┐  │
│  │  KPI Bar — 6-col CSS Grid                  │  │
│  │  CPU · Waits · Sessions · I/O · Mem · PLE  │  │
│  ├────────────────────────────────────────────┤  │
│  │  Chart Grid — CSS Grid, auto-fill 280px    │  │
│  │  Up to 7 ApexCharts area charts            │  │
│  ├────────────────────────────────────────────┤  │
│  │  Memory Health panel                       │  │
│  ├────────────────────────────────────────────┤  │
│  │  Jobs Panel · Sessions Panel (fixed height)│  │
│  ├────────────────────────────────────────────┤  │
│  │  CollapsibleSection × N (user-ordered)     │  │
│  │  DB Sizes · DB Trends · Processes          │  │
│  │  Resource Waits · File I/O · Recent/Active │  │
│  │  sp_WhoIsActive · Blocking · Deadlocks     │  │
│  │  Backup Health · Error Log · Index Health  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Constraints:**
- Header is always visible (fixed, z-50) — current server and status are always reachable
- Max width 1920px with auto margins — usable on both laptop and 4K monitors
- Chart height is hard-fixed at 224px — prevents flex-grow feedback loops that accumulate ResizeObserver events across tab switches

---

## Component Patterns

### Cards (`.mc`)
White background, 14px border radius, multi-layer box-shadow. Hover lifts shadow (no `translateY` — transform creates a stacking context that fires ResizeObserver on neighboring grid cells). Overflow hidden to prevent content from breaking card boundary.

### Virtualized Tables
All data-heavy panels use `@tanstack/react-virtual`. Only rows within the scroll viewport are rendered. Enables smooth scrolling through 100+ rows without DOM size penalty. Column definitions centralized in `src/lib/tableCols.js`.

### Collapsible Sections
`grid-template-rows: 1fr → 0fr` transition — animates to the actual content height rather than a fixed `max-height` cap (which snaps at arbitrary values). Inner wrapper requires `min-height: 0` for the `0fr` clamp to work. `contain: layout style` on inner wrapper isolates chart ResizeObserver from outer document reflow.

### KPI Cards
Current value + 30-second delta indicator (up/down arrow + absolute change) + SVG sparkline (last 20 readings, no chart library) + WARN/CRIT badge (hidden when healthy). Badge uses both color and text label — never color alone.

### Status Badges
Pill shape, background tint + foreground text pair. Four process states: `running` (green), `suspended` (amber), `sleeping` (slate), `background` (blue). All from CSS custom properties — theme-aware.

### Section Headers
Chevron rotates 180° on expand/collapse (`transform: rotate(180deg)` via `.chevron.open`). Transition 0.25s ease. Border-bottom divider. Hover background tint. Collapse state persisted per connection in `localStorage`.

### Drive Space Cards
Utilization bar with four color bands (ok / warn / crit / emergency). Severity determined by drive type (system C:\, data, log, tempdb have different thresholds). Live trend: slope %/hr + ETA-to-full projected from last-30-reading ring buffer. OS-only drives (no SQL files) render compact variant — no utilization bar or thresholds.

### DB Fill Bars (`.db-bar-track` / `.db-bar-fill`)
6px height, 3px border radius. Three fill classes: `bar-ok` (green), `bar-warn` (amber), `bar-crit` (red). Width driven by percentage, 0.4s ease transition for smooth live updates.

---

## Typography

- **Font:** `'Segoe UI', system-ui, sans-serif` — matches Windows system UI; renders sharply at small sizes
- **Compact notation:** large numbers formatted via `fmtNum()` and `fmtBytes()` — `82,934,218` → `82.9M`, `1,073,741,824` → `1.0 GB`, `93600` ms → `1h 26m`
- **Table cells:** `font-size: 12px` for data density; `font-size: 13px` for section headers
- **Badges / labels:** `font-weight: 500–600` for contrast without bold weight

---

## Animation & Motion

| Element | Animation | Duration |
|---|---|---|
| Card hover | Box-shadow lift | 0.2s |
| Tab hover | Background fade | 0.15s |
| Section collapse/expand | `grid-template-rows` + opacity | 0.28s / 0.22s |
| Chevron rotate | `transform: rotate(180deg)` | 0.25s |
| DB fill bar width | Width change | 0.4s |
| Kill button hover | Background + color swap | 0.1s |
| Chart data | ApexChart area fill animation | ApexCharts internal |

Charts have `redrawOnWindowResize: false` and `redrawOnParentResize: false` — prevents resize feedback loops. `chart-wrap` uses `contain: layout` to isolate internal layout from outer document.

---

## Scrollbar Style

Custom scrollbar globally: 5px width/height, rounded thumb, theme-aware track and thumb colors via `--scroll-track`, `--scroll-thumb`, `--scroll-thumb-h`. Applied via `op-scroll` utility class on overflow containers.

---

## Form Design (ConnectModal)

Two-tab layout: **Login** (server, label, database, auth type, security, intent, tab color) and **Connection String** (raw MSSQL connection string). Auth toggle is a segmented button (`Windows Auth` / `SQL Auth`), not a dropdown. Tab color picker is a row of color swatches — the selected connection appears color-coded in the tab bar for quick multi-server identification.

Modal is centered, `max-w-lg`, white background with light backdrop. Form controls use `--input-bg` and `--input-border` tokens — theme-aware.
