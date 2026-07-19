<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brandmark-dark.svg" />
    <img src="docs/assets/brandmark-light.svg" width="108" alt="Canopy brandmark — a git fork: two parents converging into one branch" />
  </picture>
</p>

<h1 align="center">canopy</h1>

<p align="center">A lightweight <b>menu-bar git-worktree + dev-service manager</b>.<br/>
Every branch checked out, provisioned, and running — side by side.</p>

<p align="center">
  <a href="https://github.com/emidhun/canopy/actions/workflows/ci.yml"><img src="https://github.com/emidhun/canopy/actions/workflows/ci.yml/badge.svg" alt="ci" /></a>
</p>

<p align="center">
  <img src="docs/assets/demo.gif" alt="Canopy demo — start a worktree's services on isolated ports with a per-worktree database, open the branch's app on its own port, switch branches in place, create worktrees" width="1080" />
</p>

Canopy discovers every worktree of your registered repos, provisions each one (dependencies, an
isolated database, deterministic ports), and lets you start/stop services, watch logs, manage
databases, and change ports — from a tray popover and a main window. Built for fast multi-repo /
submodule workflows like ToolJet.

- **Platform:** macOS **arm64** (Apple Silicon). Linux port in progress — compiles + tests in CI, not yet validated on a desktop.
- **Stack:** Tauri 2 (Rust) + React + zustand
- **Current version:** 0.4.0

---

## Why Canopy

Working on several branches at once with `git worktree` means each checkout needs its own
dependencies, its own database, and its own set of ports — otherwise they collide. Doing that by
hand is tedious and error-prone. Canopy automates it:

- **Isolated per worktree** — each worktree gets its own database (`<repo>_<slug>`) and a
  deterministic set of ports (`basePort + index*10`), so multiple branches run side by side.
- **Zero-bash provisioning** — how a worktree is set up (env vars, install/build/migrate/teardown)
  is declared once in the repo via `.worktreemanager.json`, so it travels with the branch.
- **One place to run everything** — start/stop services, tail logs, pull, snapshot/restore/switch
  databases, edit ports — from a tray popover or the main window.

---

## Requirements

- macOS on Apple Silicon (arm64)
- A version manager providing the Node version your project needs (e.g. **Node 22.15.1** for ToolJet)
- **Postgres** running locally (for database-backed projects like ToolJet)
- **git**
- A `.worktreemanager.json` in the repo (commit it so it travels per branch) — see the
  [Configuration guide](docs/configuration.md)

---

## Install (users)

Canopy ships as an ad-hoc-signed, **not notarized**, arm64 `.app` (usually inside a DMG). Because it
isn't notarized, macOS quarantines it on transfer — clearing that quarantine is the step that matters:

```sh
hdiutil attach ~/Downloads/Canopy-<version>-arm64.dmg
cp -R "/Volumes/Canopy/Canopy.app" /Applications/
hdiutil detach "/Volumes/Canopy"
xattr -cr /Applications/Canopy.app      # clears quarantine
open /Applications/Canopy.app
```

Or double-click the DMG, drag **Canopy** to Applications, then run only the `xattr -cr` line. On
macOS Sequoia you can instead use System Settings → Privacy & Security → **Open Anyway**.

Canopy runs as a **menu-bar app** — look for its icon in the macOS menu bar after launch. Full
install/signing details are in [docs/distribution.md](docs/distribution.md).

---

## Quick start (users)

1. Click the Canopy icon in the menu bar → **Open Manager**.
2. **Settings** (gear, top-right) → **Add repo** → pick your repo's main checkout folder. Set the
   worktree directory and define your **services** (id / name / command / cwd / basePort).
3. Commit a `.worktreemanager.json` in the repo describing env overrides + setup commands (see the
   [Configuration guide](docs/configuration.md); a ToolJet example is in
   [docs/tooljet-config.md](docs/tooljet-config.md)).
4. **New worktree** → pick a new or existing branch/tag → Canopy creates the worktree, provisions it,
   and streams progress.
5. **Start all** to boot the worktree's services, then click a service's port (`:3000`) to open it
   in the browser.

The full walkthrough — with databases, ports, pull, and troubleshooting — is in the
**[User Guide](docs/user-guide.md)**.

---

## Development

```sh
# one-time
npm install

# standard preamble for build commands on this machine (Node 22 + cargo on PATH)
export PATH="$HOME/.asdf/installs/nodejs/v22.15.1/bin:$PATH" && source "$HOME/.cargo/env"

npm run tauri dev      # run the full app (both windows + tray), hot-reloads
npm run build          # type-check + build the frontend
npm run tauri build    # release .app bundle
```

From `src-tauri/`: `cargo check` (fast Rust check) and `cargo test --lib` (unit tests).

See **[docs/development.md](docs/development.md)** for prerequisites, the release/DMG steps, and the
environment gotchas that have bitten us (Node 18 vs 22, `pg_dump` versioning, the DMG-build hang).

---

## Documentation

| Doc | What it covers |
|---|---|
| [docs/README.md](docs/README.md) | Documentation index + 60-second mental model |
| [docs/user-guide.md](docs/user-guide.md) | **Task-oriented guide for users** — install → configure → run |
| [docs/features.md](docs/features.md) | Reference: what every button and menu does |
| [docs/configuration.md](docs/configuration.md) | The three config layers, `.worktreemanager.json`, variables, ports, databases |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit (backend = source of truth, two windows, events) |
| [docs/backend.md](docs/backend.md) | Rust module map, IPC commands, events |
| [docs/development.md](docs/development.md) | Run / build / sign / DMG + environment gotchas |
| [docs/distribution.md](docs/distribution.md) | Installing the DMG, signing/notarization, why no App Store |
| [docs/tooljet-config.md](docs/tooljet-config.md) | The ToolJet `.worktreemanager.json` reproduced |
| [docs/roadmap.md](docs/roadmap.md) | What's done, follow-ups, v2 ideas |

---

## Notes

- **Settings & state** live in `~/Library/Application Support/com.midhunkumare.canopy/`
  (`settings.json`, `state.json`).
- See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and commit conventions.

---

## License

Canopy is open source under the [GNU AGPL-3.0](LICENSE). Using the app imposes no obligations on
you; the copyleft applies if you modify and distribute (or host) Canopy itself. Optional
commercial team/cloud add-ons may be offered separately in the future.
