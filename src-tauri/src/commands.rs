use crate::error::CanopyError;
use crate::git;
use crate::services::{self, LogLine, ProcTable};
use crate::settings::{self, RepoCfg, Settings};
use crate::state::{refresh_all_git_meta, refresh_git_meta, refresh_tree, AppState, RepoNode};
use crate::terminal::{self, TermTable};
use tauri::{AppHandle, Manager, State};

/// Uniform containment: commands that act on a `wt_key` only accept keys the
/// tree actually knows. Without this, a compromised webview could point
/// git/db/terminal operations at arbitrary filesystem paths.
fn ensure_known_worktree(app: &AppHandle, wt_key: &str) -> Result<(), CanopyError> {
    if app.state::<AppState>().wt_context(wt_key).is_some() {
        Ok(())
    } else {
        Err(CanopyError::not_found("unknown worktree"))
    }
}

#[tauri::command]
pub async fn get_tree(app: AppHandle) -> Result<Vec<RepoNode>, CanopyError> {
    let cached = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.clone()
    };
    if cached.is_empty() {
        refresh_tree(&app).await.map_err(CanopyError::internal)
    } else {
        Ok(cached)
    }
}

#[tauri::command]
pub async fn refresh(app: AppHandle, wt_key: Option<String>) -> Result<(), CanopyError> {
    match wt_key {
        Some(key) => refresh_git_meta(&app, &key).await,
        None => {
            refresh_tree(&app).await.map_err(CanopyError::internal)?;
            refresh_all_git_meta(&app).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, new_settings: Settings) -> Result<(), CanopyError> {
    {
        let state = app.state::<AppState>();
        *state.settings.write() = new_settings.clone();
    }
    settings::save_settings(&app, &new_settings).map_err(CanopyError::config)?;
    // await only the structural rebuild (the tree must reflect the new
    // services/repos when this resolves); git meta is 2 spawns per worktree
    // and arrives via worktree:git events — holding the Save button on it
    // meant seconds of spinner for a millisecond write
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move { refresh_all_git_meta(&app2).await });
    Ok(())
}

/// Validate + register a repo; returns the canonical repo config that was added.
#[tauri::command]
pub async fn add_repo(app: AppHandle, path: String) -> Result<RepoCfg, CanopyError> {
    let top = git::validate_repo(&path).await.map_err(CanopyError::git)?;
    let name = std::path::Path::new(&top)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());

    let repo = RepoCfg {
        id: name.to_lowercase().replace(' ', "-"),
        name: name.clone(),
        // Default new worktrees to a hidden dir INSIDE the repo. Keeping them
        // under the repo root (rather than a `<repo>-worktrees` sibling) means
        // one self-contained tree to back up, move, or delete.
        worktree_dir: format!("{top}/.worktrees"),
        path: top,
        reset_db: String::new(),
        migrate_db: String::new(),
        services: Vec::new(),
        custom_commands: Vec::new(),
        agent_command: String::new(),
        agents: Vec::new(),
    };

    let updated = {
        let state = app.state::<AppState>();
        let mut s = state.settings.write();
        if s.repos.iter().any(|r| r.path == repo.path) {
            return Err(CanopyError::conflict("Repository already registered"));
        }
        // repo lookups key on `id`, so two different paths must never share one
        // (e.g. ~/work/tooljet + ~/client/tooljet) — suffix until unique.
        let mut repo = repo;
        let base = repo.id.clone();
        let mut n = 2;
        while s.repos.iter().any(|r| r.id == repo.id) {
            repo.id = format!("{base}-{n}");
            n += 1;
        }
        s.repos.push(repo.clone());
        let updated = s.clone();
        drop(s);
        (repo, updated)
    };
    let (repo, updated) = updated;
    settings::save_settings(&app, &updated).map_err(CanopyError::config)?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    // meta arrives via worktree:git events — same reasoning as save_settings
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move { refresh_all_git_meta(&app2).await });
    Ok(repo)
}

/// What onboarding shows for a repo: identity (name/branch/origin), a best-guess
/// stack, and the package.json scripts it can map into services + commands.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetection {
    pub top: String,
    pub name: String,
    pub branch: String,
    pub origin: String,
    /// node | next | nest | rails | django | go | rust | other
    pub stack: String,
    pub scripts: Vec<ScriptEntry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub name: String,
    pub command: String,
}

/// Inspect a repo path for onboarding: validate it's a git repo, read its
/// branch/origin, guess the stack from manifest files, and list package.json
/// scripts. Read-only — registers nothing.
#[tauri::command]
pub async fn detect_repo(path: String) -> Result<RepoDetection, CanopyError> {
    let top = git::validate_repo(&path).await.map_err(CanopyError::git)?;
    let name = std::path::Path::new(&top)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());

    let branch = git::run_git(&top, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let origin = git::run_git(&top, &["remote", "get-url", "origin"])
        .await
        .map(|s| s.trim().trim_end_matches(".git").replace("git@github.com:", "github.com/").replace("https://", ""))
        .unwrap_or_default();

    let has = |f: &str| std::path::Path::new(&top).join(f).exists();
    let has_glob = |stem: &str| {
        ["js", "ts", "mjs", "cjs"].iter().any(|ext| std::path::Path::new(&top).join(format!("{stem}.{ext}")).exists())
    };
    let stack = if has_glob("next.config") {
        "next"
    } else if has("nest-cli.json") {
        "nest"
    } else if has("Gemfile") {
        "rails"
    } else if has("manage.py") {
        "django"
    } else if has("go.mod") {
        "go"
    } else if has("Cargo.toml") {
        "rust"
    } else if has("package.json") {
        "node"
    } else {
        "other"
    }
    .to_string();

    // package.json scripts → ordered list (preserves file order)
    let mut scripts = Vec::new();
    if let Ok(txt) = std::fs::read_to_string(std::path::Path::new(&top).join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
                for (name, cmd) in obj {
                    if let Some(c) = cmd.as_str() {
                        scripts.push(ScriptEntry { name: name.clone(), command: c.to_string() });
                    }
                }
            }
        }
    }

    Ok(RepoDetection { top, name, branch, origin, stack, scripts })
}

#[tauri::command]
pub async fn remove_repo(app: AppHandle, repo_id: String) -> Result<(), CanopyError> {
    // Deregistering a repo must not leave its dev servers running untracked
    // or its runtime state (port indices/overrides, statuses, logs) behind.
    let wt_keys: Vec<String> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter()
            .filter(|r| r.repo_id == repo_id)
            .flat_map(|r| r.worktrees.iter().map(|w| w.wt_key.clone()))
            .collect()
    };
    for wt in &wt_keys {
        for key in services::worktree_svc_keys(&app, wt) {
            let _ = services::stop_service(&app, &key).await;
        }
        terminal::close_worktree(&app, &app.state::<TermTable>(), wt);
    }

    let updated = {
        let state = app.state::<AppState>();
        let mut s = state.settings.write();
        s.repos.retain(|r| r.id != repo_id);
        s.clone()
    };
    settings::save_settings(&app, &updated).map_err(CanopyError::config)?;

    for wt in &wt_keys {
        crate::state::release_worktree_runtime(&app, &repo_id, wt);
    }
    // drop the repo's whole port-index map (covers worktrees no longer listed)
    {
        let state = app.state::<AppState>();
        let runtime = {
            let mut rt = state.runtime.write();
            rt.port_indices.remove(&repo_id);
            rt.clone()
        };
        let _ = settings::save_runtime(&app, &runtime);
    }
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    Ok(())
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, wt_key: String) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let summary = git::pull(&wt_key).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

// ── submodules ──

#[tauri::command]
pub async fn submodule_status(app: AppHandle, wt_key: String) -> Result<Vec<git::SubmoduleStatus>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    Ok(git::submodule_status(&wt_key).await)
}

#[tauri::command]
pub async fn pull_submodule(app: AppHandle, wt_key: String, path: String) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let summary = git::pull_submodule(&wt_key, &path).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

#[tauri::command]
pub async fn switch_submodule_branch(app: AppHandle, wt_key: String, path: String, branch: String) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::switch_submodule_branch(&wt_key, &path, &branch).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

#[tauri::command]
pub async fn list_submodule_branches(app: AppHandle, wt_key: String, path: String) -> Result<git::Branches, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::list_submodule_branches(&wt_key, &path).await.map_err(CanopyError::git)
}

#[tauri::command]
pub async fn fetch_submodules(app: AppHandle, wt_key: String) -> Result<usize, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    Ok(git::fetch_submodules(&wt_key).await)
}

/// Re-pin every submodule to the commit the parent records (⇧⌘S in the UI).
#[tauri::command]
pub async fn sync_submodules(app: AppHandle, wt_key: String) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    // shares the worktree lease with pull/setup: a sync rewriting submodule
    // checkouts under a running `pnpm install` is exactly the collision leases exist for
    let _lease = crate::state::try_lease(&app, &wt_key, "sync submodules")?;
    let n = git::sync_submodules(&wt_key).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(match n {
        0 => "No submodules to sync".to_string(),
        1 => "1 submodule back on its pinned commit".to_string(),
        n => format!("{n} submodules back on their pinned commits"),
    })
}

/// Check out a different branch in this worktree (in place — deps reused).
#[tauri::command]
pub async fn switch_worktree_branch(
    app: AppHandle,
    wt_key: String,
    branch: String,
    create: bool,
    base: Option<String>,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::switch_branch(&wt_key, &branch, create, base.as_deref()).await.map_err(CanopyError::git)?;
    let _ = refresh_tree(&app).await;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

// ── services ──

#[tauri::command]
pub fn get_logs(table: State<'_, ProcTable>, svc_key: String) -> Vec<LogLine> {
    table
        .logs
        .lock()
        .get(&svc_key)
        .map(|b| b.iter().cloned().collect())
        .unwrap_or_default()
}

// ── embedded terminals (agent lane) ──

// async so they run on the runtime thread pool: open does openpty + spawn,
// get_buffer base64-encodes up to 256KB, and write can block on a stalled
// child — none of that belongs on the main (UI) thread.

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    table: State<'_, TermTable>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &cwd)?;
    terminal::open(&app, &table, &id, &cwd, cols, rows, command).map_err(CanopyError::terminal)
}

#[tauri::command]
pub async fn terminal_write(table: State<'_, TermTable>, id: String, data: String) -> Result<(), CanopyError> {
    terminal::write(&table, &id, &data).map_err(CanopyError::terminal)
}

#[tauri::command]
pub async fn terminal_resize(table: State<'_, TermTable>, id: String, cols: u16, rows: u16) -> Result<(), CanopyError> {
    terminal::resize(&table, &id, cols, rows).map_err(CanopyError::terminal)
}

#[tauri::command]
pub async fn terminal_get_buffer(table: State<'_, TermTable>, id: String) -> Result<Option<terminal::BufferSnapshot>, CanopyError> {
    Ok(terminal::get_buffer(&table, &id))
}

#[tauri::command]
pub async fn terminal_close(app: AppHandle, table: State<'_, TermTable>, id: String) -> Result<(), CanopyError> {
    terminal::close_and_persist(&app, &table, &id);
    Ok(())
}

/// Ensure a worktree's `.canopy/` exists with a self-ignoring `.gitignore`, then
/// write `context.md`. Never truncates an existing `.gitignore`.
#[tauri::command]
pub fn write_worktree_context(app: AppHandle, wt_path: String, contents: String) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_path)?;
    let dir = std::path::Path::new(&wt_path).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| CanopyError::setup(format!("mkdir {}: {e}", dir.display())))?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n").map_err(|e| CanopyError::setup(format!("write {}: {e}", ignore.display())))?;
    }
    let file = dir.join("context.md");
    std::fs::write(&file, contents).map_err(|e| CanopyError::setup(format!("write {}: {e}", file.display())))
}

/// The agent CLI to run for a worktree: the repo's configured `agentCommand`,
/// or the built-in default when unset.
#[tauri::command]
pub fn resolve_agent_command(state: State<'_, AppState>, wt_key: String) -> String {
    const DEFAULT_AGENT: &str = "claude";
    let repo_id = state.wt_context(&wt_key).map(|c| c.repo_id);
    let cmd = repo_id.and_then(|id| {
        let settings = state.settings.read();
        settings
            .repos
            .iter()
            .find(|r| r.id == id)
            .map(|r| r.agent_command.trim().to_string())
    });
    match cmd {
        Some(c) if !c.is_empty() => c,
        _ => DEFAULT_AGENT.to_string(),
    }
}

#[tauri::command]
pub async fn service_start(app: AppHandle, svc_key: String) -> Result<(), CanopyError> {
    services::start_service(&app, &svc_key).await.map_err(CanopyError::process)
}

#[tauri::command]
pub async fn service_stop(app: AppHandle, svc_key: String) -> Result<(), CanopyError> {
    services::stop_service(&app, &svc_key).await.map_err(CanopyError::process)
}

#[tauri::command]
pub async fn service_restart(app: AppHandle, svc_key: String) -> Result<(), CanopyError> {
    services::restart_service(&app, &svc_key).await.map_err(CanopyError::process)
}

#[tauri::command]
pub async fn worktree_start_all(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    // start every service, collecting failures — one bad service must not
    // silently prevent its siblings from starting
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if let Err(e) = services::start_service(&app, &key).await {
            errors.push(format!("{key}: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!("some services failed to start — {}", errors.join("; "))))
    }
}

#[tauri::command]
pub async fn worktree_stop_all(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if let Err(e) = services::stop_service(&app, &key).await {
            errors.push(format!("{key}: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!("some services failed to stop — {}", errors.join("; "))))
    }
}

#[tauri::command]
pub async fn reset_db(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let _lease = crate::state::try_lease(&app, &wt_key, "reset db")?;
    services::reset_db(&app, &wt_key).await.map_err(CanopyError::db)
}

/// Run the worktree's configured DB migration (`migrate` in .worktreemanager.json).
#[tauri::command]
pub async fn run_migration(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let (repo_path, repo_id) = repo_for_wt(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "migrate")?;
    // prefer the Settings "Migrate cmd"; fall back to .worktreemanager.json `migrate`
    let settings_cmd = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.repos.iter().find(|r| r.id == repo_id).map(|r| r.migrate_db.clone()).unwrap_or_default()
    };
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    emit_op(&app, &wt_key, "migrate", "progress", "running migration…");
    let result = if !settings_cmd.trim().is_empty() {
        crate::setup::run_custom_command(&wt_key, &repo_path, &settings_cmd, &vars, move |line| {
            emit_op(&app2, &wt2, "migrate", "progress", line)
        })
        .await
    } else {
        crate::setup::run_migration(&wt_key, &repo_path, &vars, move |line| {
            emit_op(&app2, &wt2, "migrate", "progress", line)
        })
        .await
    };
    match result {
        Ok(()) => {
            emit_op(&app, &wt_key, "migrate", "done", "migration complete");
            Ok(())
        }
        Err(e) => {
            emit_op(&app, &wt_key, "migrate", "error", e.clone());
            Err(CanopyError::setup(e))
        }
    }
}

/// Run a repo-defined custom command in the worktree root, on the pinned Node,
/// streaming progress via `worktree:op` (op="custom") — same model as migrate.
#[tauri::command]
pub async fn run_custom_command(app: AppHandle, wt_key: String, command: String) -> Result<(), CanopyError> {
    if command.trim().is_empty() {
        return Err(CanopyError::invalid_input("Empty command"));
    }
    let (repo_path, repo_id) = repo_for_wt(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "command")?;
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    emit_op(&app, &wt_key, "custom", "progress", format!("running: {command}"));
    match crate::setup::run_custom_command(&wt_key, &repo_path, &command, &vars, move |line| {
        emit_op(&app2, &wt2, "custom", "progress", line)
    })
    .await
    {
        Ok(()) => {
            emit_op(&app, &wt_key, "custom", "done", "command finished");
            Ok(())
        }
        Err(e) => {
            emit_op(&app, &wt_key, "custom", "error", e.clone());
            Err(CanopyError::setup(e))
        }
    }
}

// ── open things ──

#[tauri::command]
pub async fn open_in_editor(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let editor = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.editor.command.clone()
    };
    let editor = if editor.trim().is_empty() { "code".to_string() } else { editor };
    let (shell, shargs) = crate::toolchain::shell_argv(&format!("{editor} {}", crate::toolchain::sh_quote(&wt_key)));
    tokio::process::Command::new(shell)
        .args(&shargs)
        .spawn()
        .map_err(|e| CanopyError::process(e.to_string()))?;
    Ok(())
}

/// Open a worktree-contained file in the selected editor. Relative paths are
/// resolved from the worktree root; canonicalization rejects traversal and
/// symlinks that leave it before any shell command is launched.
#[tauri::command]
pub async fn open_file_in_editor(app: AppHandle, wt_key: String, path: String) -> Result<(), CanopyError> {
    let root = std::fs::canonicalize(&wt_key).map_err(|e| CanopyError::invalid_input(format!("worktree path: {e}")))?;
    let requested = std::path::PathBuf::from(&path);
    let candidate = if requested.is_absolute() { requested } else { root.join(requested) };
    let file = std::fs::canonicalize(&candidate).map_err(|e| CanopyError::invalid_input(format!("file path: {e}")))?;
    if !file.starts_with(&root) {
        return Err(CanopyError::invalid_input("File must be inside the selected worktree"));
    }
    let editor = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.editor.command.clone()
    };
    let editor = if editor.trim().is_empty() { "code".to_string() } else { editor };
    let file = crate::toolchain::sh_quote(&file.to_string_lossy());
    let (shell, shargs) = crate::toolchain::shell_argv(&format!("{editor} {file}"));
    tokio::process::Command::new(shell)
        .args(&shargs)
        .spawn()
        .map_err(|e| CanopyError::process(e.to_string()))?;
    Ok(())
}

/// Reveal a path in the OS file manager (Finder / Files / Explorer).
#[tauri::command]
pub fn reveal_in_finder(wt_key: String) -> Result<(), CanopyError> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.args(["-R", &wt_key]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(&wt_key);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        // no portable "select this file", so open the containing directory
        let dir = std::path::Path::new(&wt_key)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| wt_key.clone());
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir);
        c
    };
    cmd.spawn().map_err(|e| CanopyError::process(e.to_string()))?;
    Ok(())
}

/// Open a terminal at the worktree root. macOS uses the configured terminal app;
/// Linux tries the user's preference then common emulators.
#[tauri::command]
#[allow(clippy::needless_return)] // cfg-gated per-OS tails; return keeps them uniform
pub fn open_terminal(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let term = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.terminal.clone()
    };

    #[cfg(target_os = "macos")]
    {
        let term = if term.trim().is_empty() { "Terminal".to_string() } else { term };
        std::process::Command::new("open")
            .args(["-a", &term, &wt_key])
            .spawn()
            .map_err(|e| CanopyError::process(e.to_string()))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // honor an explicit setting first, then fall back through common emulators.
        // gnome-terminal wants `--working-directory`; most others accept a `cwd`
        // spawn plus a shell, so we set current_dir and let the emulator inherit it.
        let mut candidates: Vec<String> = Vec::new();
        if !term.trim().is_empty() {
            candidates.push(term.trim().to_string());
        }
        candidates.extend(
            ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm"]
                .iter()
                .map(|s| s.to_string()),
        );
        for bin in candidates {
            let mut cmd = std::process::Command::new(&bin);
            cmd.current_dir(&wt_key);
            if bin.contains("gnome-terminal") {
                cmd.arg(format!("--working-directory={wt_key}"));
            }
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        return Err(CanopyError::process("No terminal emulator found — set one in Settings"));
    }

    #[cfg(target_os = "windows")]
    {
        let _ = term;
        std::process::Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", "cd", "/D", &wt_key])
            .spawn()
            .map_err(|e| CanopyError::process(e.to_string()))?;
        Ok(())
    }
}

#[tauri::command]
pub fn open_port(app: AppHandle, port: u32) -> Result<(), CanopyError> {
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(format!("http://localhost:{port}"), None::<String>)
        .map_err(|e| CanopyError::process(e.to_string()))
}

#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> Result<(), CanopyError> {
    // macOS: return to the Dock when a real window is on screen
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if let Some(pop) = app.get_webview_window("popover") {
        let _ = pop.hide();
    }
    // the background refresh pauses while every window is hidden — catch up now
    crate::tray::catch_up_refresh(&app);
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), CanopyError> {
    services::stop_all(&app).await;
    app.exit(0);
    Ok(())
}

// ── worktree create / remove ──

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorktreeOpEvent {
    wt_key: String,
    op: &'static str,
    state: &'static str,
    detail: String,
}

fn emit_op(app: &AppHandle, wt_key: &str, op: &'static str, state: &'static str, detail: impl Into<String>) {
    use tauri::Emitter;
    let _ = app.emit(
        "worktree:op",
        &WorktreeOpEvent { wt_key: wt_key.to_string(), op, state, detail: detail.into() },
    );
}

pub(crate) fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect()
}

#[tauri::command]
pub async fn create_worktree(
    app: AppHandle,
    repo_id: String,
    branch: String,
    base: Option<String>,
    create_branch: bool,
) -> Result<String, CanopyError> {
    let repo = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.repos
            .iter()
            .find(|r| r.id == repo_id)
            .cloned()
            .ok_or_else(|| CanopyError::not_found("unknown repo"))?
    };
    // Resolve the worktree root: empty falls back to `<repo>/.worktrees`, a
    // relative dir (e.g. ".worktrees") is taken relative to the repo — so it
    // lands inside the repo instead of wherever the process CWD happens to be —
    // and an absolute dir is used verbatim.
    let wt_dir = {
        let d = repo.worktree_dir.trim();
        if d.is_empty() {
            format!("{}/.worktrees", repo.path)
        } else if std::path::Path::new(d).is_absolute() {
            d.to_string()
        } else {
            format!("{}/{}", repo.path, d)
        }
    };
    let wt_path = format!("{wt_dir}/{}", sanitize_branch(&branch));
    if std::path::Path::new(&wt_path).exists() {
        return Err(CanopyError::conflict(format!("Path already exists: {wt_path}")));
    }

    let _lease = crate::state::try_lease(&app, &wt_path, "create")?;

    emit_op(&app, &wt_path, "create", "progress", format!("creating worktree for {branch}…"));

    // Refresh remote-tracking refs (and submodule objects) BEFORE `git worktree
    // add`, so a worktree made from an origin branch — and the submodule commits
    // it pins — reflects the remote rather than a stale local ref. Best-effort:
    // an offline or remote-less repo still creates from whatever it has locally.
    emit_op(&app, &wt_path, "create", "progress", "fetching origin…");
    if let Err(e) = git::fetch_all(&repo.path).await {
        emit_op(&app, &wt_path, "create", "progress", format!("fetch skipped — {e}"));
    }

    let app2 = app.clone();
    let wt_path2 = wt_path.clone();
    let result = git::create_worktree(
        &repo.path,
        &wt_path,
        &branch,
        base.as_deref(),
        create_branch,
        move |line| emit_op(&app2, &wt_path2, "create", "progress", line),
    )
    .await;

    if let Err(e) = result {
        emit_op(&app, &wt_path, "create", "error", e.clone());
        return Err(CanopyError::git(e));
    }

    // post-create provisioning (env overrides + setup commands) — see setup.rs.
    // Assign the worktree's ports first so .env overrides can reference them.
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_path, false);
    // The worktree exists either way; surface setup failure but keep the tree fresh.
    let app3 = app.clone();
    let wt_path3 = wt_path.clone();
    let setup_result = crate::setup::run_setup(&wt_path, &repo.path, &vars, move |line| {
        emit_op(&app3, &wt_path3, "create", "progress", line)
    })
    .await;

    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    refresh_git_meta(&app, &wt_path).await;

    match setup_result {
        Ok(()) => {
            emit_op(&app, &wt_path, "create", "done", "worktree ready");
            Ok(wt_path)
        }
        Err(e) => {
            emit_op(&app, &wt_path, "create", "error", format!("worktree created, but {e}"));
            Err(CanopyError::setup(format!("Worktree created, but setup failed:\n{e}")))
        }
    }
}

/// Manually (re)run a worktree's setup commands — for worktrees created before
/// setup was configured, or to retry after a failure.
#[tauri::command]
pub async fn run_worktree_setup(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let ctx = app
        .state::<AppState>()
        .wt_context(&wt_key)
        .ok_or_else(|| CanopyError::not_found("unknown worktree"))?;
    let (repo_path, repo_id, is_main) = (ctx.repo_path, ctx.repo_id, ctx.is_main);
    if !crate::setup::has_config(&wt_key, &repo_path) {
        return Err(CanopyError::invalid_input(
            "Nothing to run — add provisioned files or setup commands in .worktreemanager.json",
        ));
    }
    let _lease = crate::state::try_lease(&app, &wt_key, "setup")?;
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, is_main);
    let app3 = app.clone();
    let wt3 = wt_key.clone();
    emit_op(&app, &wt_key, "create", "progress", "running setup…");
    match crate::setup::run_setup(&wt_key, &repo_path, &vars, move |line| {
        emit_op(&app3, &wt3, "create", "progress", line)
    })
    .await
    {
        Ok(()) => {
            emit_op(&app, &wt_key, "create", "done", "setup complete");
            Ok(())
        }
        Err(e) => {
            emit_op(&app, &wt_key, "create", "error", e.clone());
            Err(CanopyError::setup(e))
        }
    }
}

#[tauri::command]
pub async fn worktree_dirty_report(app: AppHandle, wt_key: String) -> Result<git::DirtyReport, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::dirty_report(&wt_key).await.map_err(CanopyError::git)
}

/// Full working-tree status for the Uncommitted changes modal (every entry, not
/// the capped dirty_report).
#[tauri::command]
pub async fn worktree_status(app: AppHandle, wt_key: String) -> Result<Vec<git::StatusEntry>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::status(&wt_key).await.map_err(CanopyError::git)
}

#[tauri::command]
pub async fn worktree_commit(app: AppHandle, wt_key: String, message: String, add_untracked: bool) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::commit(&wt_key, &message, add_untracked).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

#[tauri::command]
pub async fn worktree_stash(app: AppHandle, wt_key: String, name: Option<String>, include_untracked: bool) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let summary = git::stash(&wt_key, name.as_deref(), include_untracked).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

#[tauri::command]
pub async fn worktree_discard(app: AppHandle, wt_key: String, clean_untracked: bool) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::discard(&wt_key, clean_untracked).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

/// Remove one worktree — everything except the final tree refresh, so a batch
/// can remove many and refresh once. Guards the main checkout, stops services,
/// closes terminals, drops the db (best-effort), then removes the git worktree.
async fn remove_worktree_inner(app: &AppHandle, wt_key: &str, delete_branch: bool, drop_db: bool) -> Result<(), CanopyError> {
    let ctx = app
        .state::<AppState>()
        .wt_context(wt_key)
        .ok_or_else(|| CanopyError::not_found("unknown worktree"))?;
    let (repo_path, repo_id, branch, is_main) = (ctx.repo_path, ctx.repo_id, ctx.branch, ctx.is_main);
    if is_main {
        return Err(CanopyError::invalid_input("Refusing to remove the main checkout"));
    }
    let _lease = crate::state::try_lease(app, wt_key, "remove")?;

    // stop its services first
    for key in services::worktree_svc_keys(app, wt_key) {
        let _ = services::stop_service(app, &key).await;
    }
    // and close its embedded terminals, so no shell/agent lingers with no UI
    terminal::close_worktree(app, &app.state::<TermTable>(), wt_key);

    // run teardown (e.g. drop the worktree's database) while the worktree still
    // exists. Best-effort: a teardown failure shouldn't block removal.
    if drop_db && crate::setup::has_teardown(wt_key, &repo_path) {
        emit_op(app, wt_key, "remove", "progress", "running teardown (dropping database)…");
        let vars = crate::state::worktree_vars(app, &repo_id, wt_key, false);
        let app_t = app.clone();
        let wt_t = wt_key.to_string();
        if let Err(e) = crate::setup::run_teardown(wt_key, &repo_path, &vars, move |line| {
            emit_op(&app_t, &wt_t, "remove", "progress", line)
        })
        .await
        {
            emit_op(app, wt_key, "remove", "progress", format!("teardown warning: {e}"));
        }
    }

    emit_op(app, wt_key, "remove", "progress", "removing worktree…");
    match git::remove_worktree(&repo_path, wt_key, Some(&branch), delete_branch).await {
        Ok(()) => {
            // reclaim the port index + overrides + statuses + log buffers —
            // without this, months of worktree churn leak indices and derived
            // ports creep permanently upward
            crate::state::release_worktree_runtime(app, &repo_id, wt_key);
            emit_op(app, wt_key, "remove", "done", "worktree removed");
            Ok(())
        }
        Err(e) => {
            emit_op(app, wt_key, "remove", "error", e.clone());
            Err(CanopyError::git(e))
        }
    }
}

#[tauri::command]
pub async fn remove_worktree(app: AppHandle, wt_key: String, delete_branch: bool, drop_db: bool) -> Result<(), CanopyError> {
    remove_worktree_inner(&app, &wt_key, delete_branch, drop_db).await?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    Ok(())
}

/// Remove several worktrees in one action, refreshing the tree once at the end.
/// Best-effort per item: a failure on one is collected and reported but does not
/// stop the rest (each is independent).
#[tauri::command]
pub async fn remove_worktrees(app: AppHandle, wt_keys: Vec<String>, delete_branch: bool, drop_db: bool) -> Result<(), CanopyError> {
    let mut failures: Vec<String> = Vec::new();
    for wt_key in &wt_keys {
        if let Err(e) = remove_worktree_inner(&app, wt_key, delete_branch, drop_db).await {
            let name = std::path::Path::new(wt_key).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| wt_key.clone());
            failures.push(format!("{name}: {}", e.message));
        }
    }
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::internal(format!("{} of {} could not be removed — {}", failures.len(), wt_keys.len(), failures.join("; "))))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrunableWorktree {
    pub repo_id: String,
    pub repo_name: String,
    pub path: String,
    pub branch: String,
}

/// Worktrees whose folder was deleted outside Canopy (git marks them prunable),
/// across every registered repo. Drives the Sync-prune prompt.
#[tauri::command]
pub async fn list_prunable_worktrees(app: AppHandle) -> Result<Vec<PrunableWorktree>, CanopyError> {
    let repos: Vec<(String, String, String)> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter().map(|r| (r.repo_id.clone(), r.name.clone(), r.path.clone())).collect()
    };
    let mut out = Vec::new();
    for (repo_id, repo_name, repo_path) in repos {
        if let Ok(list) = git::list_prunable(&repo_path).await {
            for w in list {
                out.push(PrunableWorktree { repo_id: repo_id.clone(), repo_name: repo_name.clone(), path: w.path, branch: w.branch });
            }
        }
    }
    Ok(out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneItem {
    pub repo_id: String,
    pub branch: String,
    pub delete_branch: bool,
    pub drop_db: bool,
    /// the vanished worktree's database name, recovered by the frontend from its
    /// pre-Sync snapshot (the folder's .env is gone)
    pub db_name: Option<String>,
}

/// Reconcile worktrees whose folders were deleted externally: optionally delete
/// each one's branch and drop its database, then `git worktree prune` each
/// affected repo (repo-wide by git's design) and refresh once.
#[tauri::command]
pub async fn prune_worktrees(app: AppHandle, items: Vec<PruneItem>) -> Result<(), CanopyError> {
    let repo_paths: std::collections::HashMap<String, String> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter().map(|r| (r.repo_id.clone(), r.path.clone())).collect()
    };
    let mut failures: Vec<String> = Vec::new();
    // Prune the stale git registrations FIRST: git refuses `branch -D` for a
    // branch it still believes is checked out in a (now-missing) worktree.
    let affected: std::collections::HashSet<&String> =
        items.iter().filter_map(|i| repo_paths.get(&i.repo_id)).collect();
    for repo_path in &affected {
        let _ = git::prune_worktrees(repo_path).await;
    }
    // Now the branches are free to delete and the databases free to drop.
    for item in &items {
        let Some(repo_path) = repo_paths.get(&item.repo_id) else {
            failures.push(format!("{}: unknown repository", item.branch));
            continue;
        };
        if item.delete_branch && !item.branch.is_empty() && item.branch != "(detached)" {
            if let Err(e) = git::delete_local_branch(repo_path, &item.branch).await {
                failures.push(format!("branch {}: {e}", item.branch));
            }
        }
        if item.drop_db {
            if let Some(db) = item.db_name.as_deref().filter(|s| !s.is_empty()) {
                if let Err(e) = crate::db::drop_database_named(repo_path, db).await {
                    failures.push(format!("database {db}: {e}"));
                }
            }
        }
    }
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::internal(format!("pruned with {} issue(s): {}", failures.len(), failures.join("; "))))
    }
}

fn is_running(app: &AppHandle, key: &str) -> bool {
    let table = app.state::<services::ProcTable>();
    let procs = table.procs.lock();
    procs.contains_key(key)
}

// ── database: list / snapshot / export / switch ──

/// repo path + repo_id for a worktree key.
fn repo_for_wt(app: &AppHandle, wt_key: &str) -> Result<(String, String), CanopyError> {
    app.state::<AppState>()
        .wt_context(wt_key)
        .map(|c| (c.repo_path, c.repo_id))
        .ok_or_else(|| CanopyError::not_found("unknown worktree"))
}

#[tauri::command]
pub async fn list_databases(app: AppHandle, wt_key: String) -> Result<Vec<String>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    crate::db::list_databases(&wt_key).await.map_err(CanopyError::db)
}

#[tauri::command]
pub fn current_database(app: AppHandle, wt_key: String) -> Result<Option<String>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    Ok(crate::db::current_db(&wt_key))
}

#[tauri::command]
pub async fn snapshot_database(app: AppHandle, wt_key: String, name: String) -> Result<(), CanopyError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(CanopyError::invalid_input("Snapshot name is required"));
    }
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "snapshot")?;
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    crate::db::clone_database(&wt_key, &name, move |line| emit_op(&app2, &wt2, "snapshot", "progress", line))
        .await
        .map_err(CanopyError::db)?;
    emit_op(&app, &wt_key, "snapshot", "done", format!("snapshot '{name}' created"));
    Ok(())
}

#[tauri::command]
pub async fn export_database(app: AppHandle, wt_key: String, file_path: String) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "export")?;
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    crate::db::export_database(&wt_key, &file_path, move |line| emit_op(&app2, &wt2, "snapshot", "progress", line))
        .await
        .map_err(CanopyError::db)?;
    emit_op(&app, &wt_key, "snapshot", "done", "exported to file");
    Ok(())
}

#[tauri::command]
pub async fn restore_database(app: AppHandle, wt_key: String, file_path: String) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "restore")?;
    // quiesce: a live connection pool holds locks against --clean drops and
    // can observe (or block) a half-restored schema. Stop the worktree's
    // running services, restore, then bring the same ones back.
    let mut was_running: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            was_running.push(key.clone());
            let _ = services::stop_service(&app, &key).await;
        }
    }
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    let restore = crate::db::restore_database(&wt_key, &file_path, move |line| {
        emit_op(&app2, &wt2, "snapshot", "progress", line)
    })
    .await;

    // restart what we stopped, whether or not the restore succeeded — the
    // worktree shouldn't be left dead because a dump file was bad
    let mut restart_errors: Vec<String> = Vec::new();
    for key in &was_running {
        if let Err(e) = services::restart_service(&app, key).await {
            restart_errors.push(format!("{key}: {e}"));
        }
    }

    restore.map_err(CanopyError::db)?;
    if restart_errors.is_empty() {
        emit_op(&app, &wt_key, "snapshot", "done", "restore complete");
        Ok(())
    } else {
        Err(CanopyError::process(format!(
            "restore complete, but restart failed — {}",
            restart_errors.join("; ")
        )))
    }
}

#[tauri::command]
pub async fn switch_database(app: AppHandle, wt_key: String, db_name: String) -> Result<(), CanopyError> {
    let (repo_path, _repo_id) = repo_for_wt(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "switch database")?;
    // repoint PG_DB in the worktree's root .env AND in any provisioned dotenv
    // file (e.g. server/.env) that declares it
    let pairs = [("PG_DB".to_string(), db_name.clone())];
    crate::setup::set_env_keys(&wt_key, &repo_path, &pairs).map_err(CanopyError::setup)?;
    crate::setup::set_env_keys_in_provisioned(&wt_key, &repo_path, &pairs).map_err(CanopyError::setup)?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    // auto-restart the server so it connects to the new DB
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            if let Err(e) = services::restart_service(&app, &key).await {
                errors.push(format!("{key}: {e}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!(
            "database switched, but restart failed — {}",
            errors.join("; ")
        )))
    }
}

/// Override a service's port. Validates range + cross-worktree conflict, updates
/// the override, re-derives env (so dependent keys follow), and auto-restarts
/// the worktree's running services so the change takes effect.
#[tauri::command]
pub async fn set_service_port(app: AppHandle, svc_key: String, port: u32) -> Result<(), CanopyError> {
    if !(1024..=65535).contains(&port) {
        return Err(CanopyError::invalid_input("Port must be between 1024 and 65535"));
    }
    // check cross-worktree conflicts: another service already on this port
    {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                for s in w.services.iter() {
                    if s.svc_key != svc_key && s.port == Some(port) {
                        return Err(CanopyError::conflict(format!(
                            "Port {port} is already used by {} ({})",
                            s.name, w.branch
                        )));
                    }
                }
            }
        }
    }
    let (wt_key, repo_id, repo_path) = app
        .state::<AppState>()
        .service_context(&svc_key)
        .ok_or_else(|| CanopyError::not_found("unknown service"))?;

    // record the override + persist
    {
        let state = app.state::<AppState>();
        state.runtime.write().port_overrides.insert(svc_key.clone(), port);
        let rt = state.runtime.read().clone();
        let _ = settings::save_runtime(&app, &rt);
    }

    // re-derive .env (TOOLJET_SERVER_PORT etc.) from the declarative env block
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
    let _ = crate::setup::reapply_provision(&wt_key, &repo_path, &vars);
    refresh_tree(&app).await.map_err(CanopyError::internal)?;

    // auto-restart running services of this worktree to apply the new port(s)
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            if let Err(e) = services::restart_service(&app, &key).await {
                errors.push(format!("{key}: {e}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!("port set, but restart failed — {}", errors.join("; "))))
    }
}

fn repo_path(app: &AppHandle, repo_id: &str) -> Result<String, CanopyError> {
    app.state::<AppState>()
        .repo_path_by_id(repo_id)
        .ok_or_else(|| CanopyError::not_found("unknown repo"))
}

#[tauri::command]
pub async fn list_branches(app: AppHandle, repo_id: String) -> Result<git::Branches, CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    git::list_branches(&path).await.map_err(CanopyError::git)
}

/// One provisioned-file entry as exchanged with the Settings UI.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionEntry {
    pub path: String,
    /// dotenv | json | yaml | text
    pub format: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub interpolate: bool,
    /// ordered (key, value-template) pairs
    #[serde(default)]
    pub keys: Vec<(String, String)>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    /// files provisioned into each new worktree (the root `.env` is one entry)
    pub provision: Vec<ProvisionEntry>,
    pub setup: Vec<String>,
    /// read-only in the Settings UI today — surfaced so the preview/export
    /// match what's actually on disk
    #[serde(default)]
    pub teardown: Vec<String>,
    #[serde(default)]
    pub migrate: Vec<String>,
}

impl From<crate::setup::ProvisionFile> for ProvisionEntry {
    fn from(p: crate::setup::ProvisionFile) -> Self {
        ProvisionEntry { path: p.path, format: p.format, from: p.from, interpolate: p.interpolate, keys: p.keys }
    }
}

impl From<ProvisionEntry> for crate::setup::ProvisionFile {
    fn from(e: ProvisionEntry) -> Self {
        crate::setup::ProvisionFile {
            path: e.path,
            format: e.format,
            from: e.from,
            interpolate: e.interpolate,
            keys: e.keys,
        }
    }
}

/// Read the repo's `.worktreemanager.json` (provisioned files + setup) for the editor.
#[tauri::command]
pub fn get_repo_config(app: AppHandle, repo_id: String) -> Result<RepoConfig, CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    let c = crate::setup::read_repo_config(&path);
    Ok(RepoConfig {
        provision: c.provision.into_iter().map(Into::into).collect(),
        setup: c.setup,
        teardown: c.teardown,
        migrate: c.migrate,
    })
}

/// Write text to a path, creating parent directories as needed. Used by the
/// Settings config Export and by the agent lane (writing `.canopy/context.md`,
/// whose parent dir may not exist yet).
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), CanopyError> {
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| CanopyError::config(format!("mkdir {}: {e}", dir.display())))?;
    }
    std::fs::write(&path, contents).map_err(|e| CanopyError::config(format!("write {path}: {e}")))
}

/// Write provisioned files + setup commands to the repo's `.worktreemanager.json`.
#[tauri::command]
pub fn save_repo_config(app: AppHandle, repo_id: String, provision: Vec<ProvisionEntry>, setup: Vec<String>) -> Result<(), CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    let files: Vec<crate::setup::ProvisionFile> = provision.into_iter().map(Into::into).collect();
    crate::setup::write_repo_config(&path, &files, &setup).map_err(CanopyError::config)
}

/// `git fetch --all --prune` then return the refreshed branch lists.
#[tauri::command]
pub async fn fetch_branches(app: AppHandle, repo_id: String) -> Result<git::Branches, CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    git::fetch_all(&path).await.map_err(CanopyError::git)?;
    git::list_branches(&path).await.map_err(CanopyError::git)
}

#[cfg(test)]
mod tests {
    use super::sanitize_branch;

    #[test]
    fn sanitize_branch_maps_separators() {
        assert_eq!(sanitize_branch("feature/foo-bar"), "feature_foo-bar");
        assert_eq!(sanitize_branch("v1.2.3"), "v1.2.3");
        assert_eq!(sanitize_branch("fix db reset"), "fix_db_reset");
    }
}
