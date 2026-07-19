# Handoff: Worktree Manager — Menu-bar Popover + Main Window

## Overview
Two coordinated UIs for an Electron-based git worktree / dev-service manager on macOS:

1. **Menu-bar popover** — a frameless `BrowserWindow` opened from the tray icon, replacing the native `Tray.setContextMenu`. Glanceable: one row per worktree with status chips and quick actions (open worktree, reset DB, start/stop the whole tree).
2. **Main window** — the full management app: sidebar of repos → worktrees, per-service control (start/stop/restart), live log console, ports, CPU/MEM/uptime, git status, and worktree-level actions.

Product split principle: **popover = glance + one click; main window = the workbench.** Anything that requires reading or deciding (logs, stats, per-service control) lives in the window, never the popover.

## About the Design Files
The files in this bundle are **design references created in HTML** — interactive prototypes showing intended look and behavior, **not production code to copy directly**. The task is to **recreate these designs in the target Electron app's renderer** (per the existing build plan: `src/menubar.html` / `src/menubar.css` / `src/menubar.js` for the popover; the main window's existing renderer for the app) using the codebase's established patterns. The prototypes use React for state simulation; the real implementations can be vanilla JS — all state comes from `main.js` via IPC.

The HTML pages also contain presentation scaffolding (light-gray page background, captions, a fake macOS desktop scene, a "Tweaks" panel). **Ignore all of that** — only the dark popover (`.wm-pop`) and the dark window (`.win`) are the designs.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and interactions are final. Recreate pixel-perfectly.

## Design Tokens (shared by both UIs)

### Colors (dark, fixed — not theme-reactive)
| Token | Value | Use |
|---|---|---|
| bg | `#1e1f22` | popover + window background |
| sidebar bg | `#191a1d` | main-window sidebar |
| titlebar bg | `#25272b` | main-window titlebar |
| panel | `#232529` | service cards |
| panel-2 | `#1b1c1f` | console, search field |
| border | `#34373c` (app) / `#3a3d42` (popover) | borders, separators |
| border-soft | `#2b2d32` | subtle internal borders |
| text | `#e8e8ea` | primary text |
| dim | `#9a9ba0` | secondary text |
| faint | `#6a6c72` | labels, placeholders |
| accent | `#58c2c8` | fork glyph, ports, selection, links |
| accent-dim | `rgba(88,194,200,.16)` | selected row bg, port chip bg |
| running | `#3fb950` | green status |
| stopped | `#e0533d` | red status |
| warn | `#e0a458` | dirty git state, warnings, partial-running dot |
| button bg | `rgba(255,255,255,.085–.11)` hover `.15–.18` | ghost buttons |
| row hover | `rgba(255,255,255,.045–.05)` | hover highlight |

### Typography
- UI: `-apple-system, "SF Pro Text", system-ui, sans-serif`
- Code/logs/paths/ports: `ui-monospace, "SF Mono", Menlo, monospace`
- Popover: menu items 14px, branch names 14px/550, service chips 12px, repo headers 11.5px/600, buttons 12.5px/500
- Window: worktree title 19px/640, service names 14.5px/560, sidebar items 13px, section headers 12px uppercase +.06em, logs 12px mono line-height 1.65, stats 11.5px mono with 10px uppercase labels

### Radii & shadows
- Popover window: 11px radius, 1px border, shadow `0 14px 44px rgba(0,0,0,.55)`, vertical padding 5px
- Main window: 12px radius
- Cards/rows: 7–10px; buttons 6–7px
- Status dot glow (running, sidebar): `0 0 0 3px rgba(63,185,80,.14)`

## Screens / Views

### 1. Menu-bar Popover (`Worktree Manager Popover.html` + `popover.jsx`)
**Width 284px, height fits content** (the Electron plan's `menubar:resize` handles this).

Structure, top to bottom:
1. `Open Manager` menu item (window icon, 14px text, 6px/14px padding, hover `rgba(255,255,255,.05)`)
2. `Quit` menu item (power icon)
3. Separator — 1px line, 6px/12px margins
4. Per **repo**: a non-interactive header — teal fork glyph + repo name, 11.5px, color faint. Groups after the first get a 1px top border + 5px spacing.
5. Per **worktree** (inside its repo group): a two-line block, 7px radius hover highlight:
   - Line 1: branch name (14px, weight 550, ellipsizes) … actions right-aligned:
     - **Open worktree** icon button (external-link glyph, 26×24, dim → text on hover, bg `rgba(255,255,255,.11)` on hover)
     - **Reset DB** icon button (database glyph; while resetting shows a spinning arc in accent color)
     - **Start/Stop** pill — min-width 52px, 12.5px/500, 6px radius, bg `rgba(255,255,255,.11)` hover `.18`. Label `Stop` when any service is live, else `Start`. Disabled+50% opacity while transitioning.
   - Line 2: service chips — `● Frontend  ● Server`, 12px dim text, 6px dot: green `#3fb950` running, faint `#6a6c72` stopped, accent pulsing (`opacity .35↔1`, .9s) while starting/stopping, red on error.

Behavior:
- Start/Stop acts on **the whole worktree** (all its services).
- Optimistic flip: clicking immediately shows the transitional state; the real `service:status` events from main confirm.
- No "start all" / global actions. Repo headers are not clickable.
- `Open Manager` opens/creates the main window. `Quit` kills all processes and quits.

### 2. Main Window (`Worktree Manager App.html` + `app-window.jsx` + `app-icons.jsx`)
Dark window, ~1240×760 default, three regions:

**Titlebar (44px)** — traffic lights, fork glyph + "Worktree Manager" (13px/600 dim), right side: refresh + settings icon buttons (28px, 7px radius).

**Sidebar (256px, bg `#191a1d`, 1px right border)**
- Search field: 30px, bg `#1b1c1f`, 1px `#2b2d32` border, 8px radius, magnifier icon, placeholder "Filter worktrees…". Filters on `repo + branch` substring.
- Repo header rows: fork glyph (accent) + repo name + right-aligned worktree count (11.5px/600 faint).
- Worktree items: status dot (7px; green+glow = all running, amber = partial, faint = stopped) + branch + right-aligned `running/total` count (11px). Selected: bg `accent-dim`, branch text `#cfeff1`. 8px radius.
- Footer: dashed-border "New worktree" button (32px, dashed `#34373c`, 8px radius) → `git worktree add` flow.

**Main pane**
- *Worktree header* (20px/22px padding, bottom border): fork glyph + branch (19px/640) `·` repo (dim) ; mono path 12px faint; meta row 12px — `↑N ↓N vs origin` (mono numerals), `● uncommitted changes` in warn / `○ clean`, `last commit <time> — <msg>`.
- *Header toolbar* (right-aligned icon buttons, 28px, 1px dividers between groups): editor / Finder / Terminal · `Pull` / `Reset DB` (spinner while resetting) · **Start all** (accent-filled primary, dark text `#08171a`, 600) or **Stop all** (ghost) depending on whether anything runs · `…` overflow.
- *Services section*: "SERVICES" 12px uppercase header with hairline. One **card** per service (bg `#232529`, 1px `#2b2d32` border, 10px radius, hover border `#34373c`, selected-for-logs border accent):
  - status icon 19px (green circled check / red circled ✗ / accent spinner)
  - kind glyph (globe = web, server rack = server, cog = worker) + name 14.5px/560, sub-line `Running` (green) / `Stopped` / `Starting…`
  - **port chip** `:3000 ↗` — mono 12px accent on accent-dim, 6px radius; click opens `http://localhost:PORT`; grey + disabled when stopped; `no port` for workers
  - stats: CPU % / MEM mb / Uptime — mono 11.5px with 10px uppercase labels; `—` and 40% opacity when stopped
  - controls: restart (icon), logs (icon; accent when its log tab is active), **Start/Stop** pill 62px min (Stop label gets a reddish tint `#ffd9d2`)
- *Console* (bottom, fills remaining height, bg `#1b1c1f`, 1px top border):
  - tab strip: one tab per service (status dot + name; active tab bg `rgba(255,255,255,.085)`), right: `Clear` and `▾ Logs` collapse toggle. Collapsed = tab strip only, anchored to bottom.
  - log body: mono 12px, line-height 1.65, color `#c6c8cc`. Line format: `HH:MM:SS` (faint) + level glyph (`›` info accent, `✓` ok green, `WARN` amber, `ERROR` red) + message. Auto-scrolls to bottom on new lines. Empty state: italic faint "No output — service is stopped."

## Interactions & Behavior
- **Start service**: status → `starting` (spinner) → `running`; log line "starting …" then "listening on http://localhost:PORT". Stop: → `stopping` → `stopped`, log "process exited (SIGTERM)". Restart chains stop→start.
- **Start all / Stop all** operate on the selected worktree's services.
- **Reset DB**: button shows spinner ~1.5s; logs "db: dropping schema + re-seeding…" then "db: reset complete"; toast confirms. One concurrent reset per worktree.
- **Selection**: clicking a sidebar worktree swaps header/services/console to it; the console tab falls back to that worktree's first running service.
- **Toasts**: bottom-center pill (bg `#16171a`, 1px border, 10px radius, 13px) for fire-and-forget actions (open editor, pull, etc.), ~2s.
- All transitions: background/color ~.1s ease; no entrance animations on the window itself.
- Both UIs listen to the same `service:status` events — state lives in `main.js` only (per the build plan §4: `menubar:getTree`, `service:start`, `service:stop`).

## State Management
- Source of truth: Electron main process (`procs`, `statusOf`, `getServices`, `listWorktrees`).
- Renderer state per the plan's §5 tree shape: `[{ repo, path, worktrees: [{ branch, services: [{ id, name, status }] }] }]`, status ∈ `running | stopped | starting | stopping | error`.
- Main window additionally needs per-service: `port`, `kind` (web/server/worker), stats (cpu/mem — e.g. `pidusage`), startedAt for uptime, and per-worktree git status (`ahead/behind/dirty/lastCommit`).
- Logs: ring buffer per service (prototype caps at 160 lines), streamed `proc.stdout/stderr` → renderer.

## Assets
No raster assets. All icons are inline SVG, Tabler-style (24×24 viewBox, stroke 2, round caps) — see `app-icons.jsx` for the exact paths (fork, search, plus, refresh, settings, editor, finder, terminal, pull, database, play, stop, restart, logs, globe, server, cog, check, x, spinner, external, more). The real app can use the Tabler Icons package instead (`ti-circle-check`, `ti-circle-x`, etc.).

## Files
| File | Contents |
|---|---|
| `Worktree Manager Popover.html` | Popover page: all popover CSS (`.wm-*` classes map 1:1 to the planned `src/menubar.css`) + presentation scaffolding |
| `popover.jsx` | Popover markup/logic reference (rows, chips, actions, status icons) |
| `app.jsx` | Popover page state simulation (toggle/reset/open behavior, timings) |
| `Worktree Manager App.html` | Main window page: all window CSS (`.win`, `.side`, `.svc`, `.console` …) |
| `app-window.jsx` | Main window markup/logic reference (sidebar, header, service rows, console, log streaming) |
| `app-icons.jsx` | Inline SVG icon set |
| `tweaks-panel.jsx` | Prototype-only design-review control panel — **ignore for implementation** |

Open either HTML file in a browser to interact with the live reference.
