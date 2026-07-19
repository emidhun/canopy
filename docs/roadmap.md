# Status & roadmap

## Delivered
- v1 core: popover + main window, worktree discovery/create/delete with submodule object-sharing,
  per-service start/stop/restart, live logs, CPU/MEM/uptime, settings, Reset DB, Pull (submodule-aware).
- Provisioning: `.worktreemanager.json` — generalized **`provision`** array (seed + key-upsert for
  dotenv/json/yaml, copy + interpolate for text, at any subpath; legacy `env` auto-migrates), plus
  `setup`/`migrate`/`teardown`; per-worktree isolated DB + deterministic ports, pinned-Node handling.
- Settings: repo-nav + tabbed detail layout (General / Services / Commands / Files / Setup) with a
  live config preview and import/export.
- In-place branch switch (submodule-aware) and per-submodule pull/branch-switch from the header.
- Branding: Canopy brandmark (app icon, tray, in-app mark).
- DB tools: switch database, save snapshot, export to file, run migration, drop-on-delete — in an
  inline database bar in the worktree header.
- Per-service port override (editable port chip; validates, re-derives env, auto-restarts).
- Commands run through the user's own shell (`$SHELL`), not a hardcoded zsh.
- CI: ubuntu + macos jobs (`cargo check`/`cargo test` + frontend build) so the Linux code paths
  compile on every push.

## Follow-ups (offered, not requested — none block anything)
1. **Notarization** — removes the install warning. (See distribution.md.)
2. **Port-index reclamation on delete** — removed worktrees still hold their `portIndices` slot, so
   indices climb over time. Free it in `remove_worktree` (clear from `RuntimeState.port_indices`).
3. **Global "Stop all worktrees"** — today Stop-all is per-worktree; only Quit stops everything.
4. **"Reset to default" for a port override** — clear the `portOverrides` entry from the UI (currently
   revert by typing the derived `basePort + index*10`).
5. **Edit `migrate`/`teardown` in Settings UI** — shown read-only in the Files preview today.
6. **"Use shared backend" toggle**, **two-tone in-app mark**, **dropdown flip-up near screen bottom**,
   **universal (Intel) build**, **split SettingsView into per-tab modules**.

## Cross-platform (Linux / Windows) support
Released builds are macOS **arm64**. The Linux port is underway — the code compiles in CI and the
macOS-only pieces are cfg-gated — but it has not yet been validated on a real Linux desktop.

| Area | Status |
|---|---|
| Tray popover | ✅ cfg-gated: NSPanel on macOS, plain window + tray **menu** fallback elsewhere (appindicator delivers no click events) |
| Shell | ✅ user's `$SHELL` everywhere (zsh/bash/fish; `sh` fallback) |
| Open editor / file manager / terminal | ✅ per-platform (`open` / `xdg-open` + terminal-emulator detection / `explorer`) |
| Process control | ✅ POSIX process groups work on Linux; ❌ Windows needs Job Objects / `taskkill /T` |
| Postgres binaries | ❌ Linux distro paths (`/usr/lib/postgresql/<maj>/bin` etc.) not probed yet — only Postgres.app + PATH |
| Window chrome | ⚠️ `titleBarStyle: Overlay` is macOS-only; Linux gets stock decorations — needs a look |
| Packaging | ⚠️ bundle targets include deb/AppImage/rpm but artifacts are unbuilt/untested; signing story per-OS |
| Real-desktop validation | ❌ tray, popover positioning, transparency under GNOME/KDE compositors |

**Effort:** Linux is *moderate* (pg-path detection + validation pass). Windows is *substantial* —
the POSIX process-group/signal model that kills whole service trees has no direct equivalent.

## v2+ (out of v1 scope)
- AI-agent workflows: run multiple coding agents in parallel, each in its own isolated, running
  worktree environment — the per-worktree DB/port isolation is the foundation.
