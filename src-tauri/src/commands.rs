use crate::git;
use crate::services::{self, LogLine, ProcTable};
use crate::settings::{self, RepoCfg, Settings};
use crate::state::{refresh_all_git_meta, refresh_git_meta, refresh_tree, AppState, RepoNode};
use crate::terminal::{self, TermTable};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn get_tree(app: AppHandle) -> Result<Vec<RepoNode>, String> {
    let cached = {
        let state = app.state::<AppState>();
        let tree = state.tree.read().unwrap();
        tree.clone()
    };
    if cached.is_empty() {
        refresh_tree(&app).await
    } else {
        Ok(cached)
    }
}

#[tauri::command]
pub async fn refresh(app: AppHandle, wt_key: Option<String>) -> Result<(), String> {
    match wt_key {
        Some(key) => refresh_git_meta(&app, &key).await,
        None => {
            refresh_tree(&app).await?;
            refresh_all_git_meta(&app).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().unwrap().clone()
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, new_settings: Settings) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        *state.settings.write().unwrap() = new_settings.clone();
    }
    settings::save_settings(&app, &new_settings)?;
    refresh_tree(&app).await?;
    refresh_all_git_meta(&app).await;
    Ok(())
}

/// Validate + register a repo; returns the canonical repo config that was added.
#[tauri::command]
pub async fn add_repo(app: AppHandle, path: String) -> Result<RepoCfg, String> {
    let top = git::validate_repo(&path).await?;
    let name = std::path::Path::new(&top)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());

    let repo = RepoCfg {
        id: name.to_lowercase().replace(' ', "-"),
        name: name.clone(),
        worktree_dir: format!("{top}-worktrees"),
        path: top,
        reset_db: String::new(),
        migrate_db: String::new(),
        services: Vec::new(),
        custom_commands: Vec::new(),
        agent_command: String::new(),
    };

    let updated = {
        let state = app.state::<AppState>();
        let mut s = state.settings.write().unwrap();
        if s.repos.iter().any(|r| r.path == repo.path) {
            return Err("Repository already registered".into());
        }
        s.repos.push(repo.clone());
        s.clone()
    };
    settings::save_settings(&app, &updated)?;
    refresh_tree(&app).await?;
    refresh_all_git_meta(&app).await;
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
pub async fn detect_repo(path: String) -> Result<RepoDetection, String> {
    let top = git::validate_repo(&path).await?;
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
pub async fn remove_repo(app: AppHandle, repo_id: String) -> Result<(), String> {
    let updated = {
        let state = app.state::<AppState>();
        let mut s = state.settings.write().unwrap();
        s.repos.retain(|r| r.id != repo_id);
        s.clone()
    };
    settings::save_settings(&app, &updated)?;
    refresh_tree(&app).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, wt_key: String) -> Result<String, String> {
    let summary = git::pull(&wt_key).await?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

// ── submodules ──

#[tauri::command]
pub async fn submodule_status(wt_key: String) -> Result<Vec<git::SubmoduleStatus>, String> {
    Ok(git::submodule_status(&wt_key).await)
}

#[tauri::command]
pub async fn pull_submodule(app: AppHandle, wt_key: String, path: String) -> Result<String, String> {
    let summary = git::pull_submodule(&wt_key, &path).await?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

#[tauri::command]
pub async fn switch_submodule_branch(app: AppHandle, wt_key: String, path: String, branch: String) -> Result<(), String> {
    git::switch_submodule_branch(&wt_key, &path, &branch).await?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

#[tauri::command]
pub async fn list_submodule_branches(wt_key: String, path: String) -> Result<git::Branches, String> {
    git::list_submodule_branches(&wt_key, &path).await
}

#[tauri::command]
pub async fn fetch_submodules(wt_key: String) -> Result<usize, String> {
    Ok(git::fetch_submodules(&wt_key).await)
}

/// Check out a different branch in this worktree (in place — deps reused).
#[tauri::command]
pub async fn switch_worktree_branch(
    app: AppHandle,
    wt_key: String,
    branch: String,
    create: bool,
    base: Option<String>,
) -> Result<(), String> {
    git::switch_branch(&wt_key, &branch, create, base.as_deref()).await?;
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
        .unwrap()
        .get(&svc_key)
        .map(|b| b.iter().cloned().collect())
        .unwrap_or_default()
}

// ── embedded terminals (agent lane) ──

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    table: State<'_, TermTable>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<(), String> {
    terminal::open(&app, &table, &id, &cwd, cols, rows, command)
}

#[tauri::command]
pub fn terminal_write(table: State<'_, TermTable>, id: String, data: String) -> Result<(), String> {
    terminal::write(&table, &id, &data)
}

#[tauri::command]
pub fn terminal_resize(table: State<'_, TermTable>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize(&table, &id, cols, rows)
}

#[tauri::command]
pub fn terminal_get_buffer(table: State<'_, TermTable>, id: String) -> Option<terminal::BufferSnapshot> {
    terminal::get_buffer(&table, &id)
}

#[tauri::command]
pub fn terminal_close(app: AppHandle, table: State<'_, TermTable>, id: String) {
    terminal::close_and_persist(&app, &table, &id);
}

/// Ensure a worktree's `.canopy/` exists with a self-ignoring `.gitignore`, then
/// write `context.md`. Never truncates an existing `.gitignore`.
#[tauri::command]
pub fn write_worktree_context(wt_path: String, contents: String) -> Result<(), String> {
    let dir = std::path::Path::new(&wt_path).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n").map_err(|e| format!("write {}: {e}", ignore.display()))?;
    }
    let file = dir.join("context.md");
    std::fs::write(&file, contents).map_err(|e| format!("write {}: {e}", file.display()))
}

/// The agent CLI to run for a worktree: the repo's configured `agentCommand`,
/// or the built-in default when unset.
#[tauri::command]
pub fn resolve_agent_command(state: State<'_, AppState>, wt_key: String) -> String {
    const DEFAULT_AGENT: &str = "claude";
    let repo_id = {
        let tree = state.tree.read().unwrap();
        tree.iter()
            .find(|r| r.worktrees.iter().any(|w| w.wt_key == wt_key))
            .map(|r| r.repo_id.clone())
    };
    let cmd = repo_id.and_then(|id| {
        let settings = state.settings.read().unwrap();
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
pub async fn service_start(app: AppHandle, svc_key: String) -> Result<(), String> {
    services::start_service(&app, &svc_key).await
}

#[tauri::command]
pub async fn service_stop(app: AppHandle, svc_key: String) -> Result<(), String> {
    services::stop_service(&app, &svc_key).await
}

#[tauri::command]
pub async fn service_restart(app: AppHandle, svc_key: String) -> Result<(), String> {
    services::restart_service(&app, &svc_key).await
}

#[tauri::command]
pub async fn worktree_start_all(app: AppHandle, wt_key: String) -> Result<(), String> {
    for key in services::worktree_svc_keys(&app, &wt_key) {
        services::start_service(&app, &key).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn worktree_stop_all(app: AppHandle, wt_key: String) -> Result<(), String> {
    for key in services::worktree_svc_keys(&app, &wt_key) {
        services::stop_service(&app, &key).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn reset_db(app: AppHandle, wt_key: String) -> Result<(), String> {
    services::reset_db(&app, &wt_key).await
}

/// Run the worktree's configured DB migration (`migrate` in .worktreemanager.json).
#[tauri::command]
pub async fn run_migration(app: AppHandle, wt_key: String) -> Result<(), String> {
    let (repo_path, repo_id) = repo_for_wt(&app, &wt_key)?;
    // prefer the Settings "Migrate cmd"; fall back to .worktreemanager.json `migrate`
    let settings_cmd = {
        let state = app.state::<AppState>();
        let s = state.settings.read().unwrap();
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
            Err(e)
        }
    }
}

/// Run a repo-defined custom command in the worktree root, on the pinned Node,
/// streaming progress via `worktree:op` (op="custom") — same model as migrate.
#[tauri::command]
pub async fn run_custom_command(app: AppHandle, wt_key: String, command: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Empty command".into());
    }
    let (repo_path, repo_id) = repo_for_wt(&app, &wt_key)?;
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
            Err(e)
        }
    }
}

// ── open things ──

#[tauri::command]
pub async fn open_in_editor(app: AppHandle, wt_key: String) -> Result<(), String> {
    let editor = {
        let state = app.state::<AppState>();
        let s = state.settings.read().unwrap();
        s.editor.command.clone()
    };
    let editor = if editor.trim().is_empty() { "code".to_string() } else { editor };
    let (shell, shargs) = crate::toolchain::shell_argv(&format!("{editor} '{wt_key}'"));
    tokio::process::Command::new(shell)
        .args(&shargs)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reveal a path in the OS file manager (Finder / Files / Explorer).
#[tauri::command]
pub fn reveal_in_finder(wt_key: String) -> Result<(), String> {
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
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a terminal at the worktree root. macOS uses the configured terminal app;
/// Linux tries the user's preference then common emulators.
#[tauri::command]
pub fn open_terminal(app: AppHandle, wt_key: String) -> Result<(), String> {
    let term = {
        let state = app.state::<AppState>();
        let s = state.settings.read().unwrap();
        s.terminal.clone()
    };

    #[cfg(target_os = "macos")]
    {
        let term = if term.trim().is_empty() { "Terminal".to_string() } else { term };
        std::process::Command::new("open")
            .args(["-a", &term, &wt_key])
            .spawn()
            .map_err(|e| e.to_string())?;
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
        return Err("No terminal emulator found — set one in Settings".into());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = term;
        std::process::Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", "cd", "/D", &wt_key])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub fn open_port(app: AppHandle, port: u32) -> Result<(), String> {
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(format!("http://localhost:{port}"), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> Result<(), String> {
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
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), String> {
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

fn sanitize_branch(branch: &str) -> String {
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
) -> Result<String, String> {
    let repo = {
        let state = app.state::<AppState>();
        let s = state.settings.read().unwrap();
        s.repos.iter().find(|r| r.id == repo_id).cloned().ok_or("unknown repo")?
    };
    let wt_dir = if repo.worktree_dir.trim().is_empty() {
        format!("{}-worktrees", repo.path)
    } else {
        repo.worktree_dir.clone()
    };
    let wt_path = format!("{wt_dir}/{}", sanitize_branch(&branch));
    if std::path::Path::new(&wt_path).exists() {
        return Err(format!("Path already exists: {wt_path}"));
    }

    emit_op(&app, &wt_path, "create", "progress", format!("creating worktree for {branch}…"));

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
        return Err(e);
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

    refresh_tree(&app).await?;
    refresh_git_meta(&app, &wt_path).await;

    match setup_result {
        Ok(()) => {
            emit_op(&app, &wt_path, "create", "done", "worktree ready");
            Ok(wt_path)
        }
        Err(e) => {
            emit_op(&app, &wt_path, "create", "error", format!("worktree created, but {e}"));
            Err(format!("Worktree created, but setup failed:\n{e}"))
        }
    }
}

/// Manually (re)run a worktree's setup commands — for worktrees created before
/// setup was configured, or to retry after a failure.
#[tauri::command]
pub async fn run_worktree_setup(app: AppHandle, wt_key: String) -> Result<(), String> {
    let (repo_path, repo_id, is_main) = {
        let state = app.state::<AppState>();
        let tree = state.tree.read().unwrap();
        let r = tree
            .iter()
            .find(|r| r.worktrees.iter().any(|w| w.wt_key == wt_key))
            .ok_or("unknown worktree")?;
        let is_main = r.worktrees.iter().find(|w| w.wt_key == wt_key).map(|w| w.is_main).unwrap_or(false);
        (r.path.clone(), r.repo_id.clone(), is_main)
    };
    if !crate::setup::has_config(&wt_key, &repo_path) {
        return Err("Nothing to run — add provisioned files or setup commands in .worktreemanager.json".into());
    }
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
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn worktree_dirty_report(wt_key: String) -> git::DirtyReport {
    git::dirty_report(&wt_key).await
}

#[tauri::command]
pub async fn remove_worktree(app: AppHandle, wt_key: String, delete_branch: bool, drop_db: bool) -> Result<(), String> {
    // never remove a main checkout; find owning repo + branch
    let (repo_path, repo_id, branch, is_main) = {
        let state = app.state::<AppState>();
        let tree = state.tree.read().unwrap();
        let mut found = None;
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                if w.wt_key == wt_key {
                    found = Some((r.path.clone(), r.repo_id.clone(), w.branch.clone(), w.is_main));
                }
            }
        }
        found.ok_or("unknown worktree")?
    };
    if is_main {
        return Err("Refusing to remove the main checkout".into());
    }

    // stop its services first
    for key in services::worktree_svc_keys(&app, &wt_key) {
        let _ = services::stop_service(&app, &key).await;
    }
    // and close its embedded terminals, so no shell/agent lingers with no UI
    terminal::close_worktree(&app, &app.state::<TermTable>(), &wt_key);

    // run teardown (e.g. drop the worktree's database) while the worktree still
    // exists. Best-effort: a teardown failure shouldn't block removal.
    if drop_db && crate::setup::has_teardown(&wt_key, &repo_path) {
        emit_op(&app, &wt_key, "remove", "progress", "running teardown (dropping database)…");
        let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
        let app_t = app.clone();
        let wt_t = wt_key.clone();
        if let Err(e) = crate::setup::run_teardown(&wt_key, &repo_path, &vars, move |line| {
            emit_op(&app_t, &wt_t, "remove", "progress", line)
        })
        .await
        {
            emit_op(&app, &wt_key, "remove", "progress", format!("teardown warning: {e}"));
        }
    }

    emit_op(&app, &wt_key, "remove", "progress", "removing worktree…");
    match git::remove_worktree(&repo_path, &wt_key, Some(&branch), delete_branch).await {
        Ok(()) => {
            emit_op(&app, &wt_key, "remove", "done", "worktree removed");
            refresh_tree(&app).await?;
            Ok(())
        }
        Err(e) => {
            emit_op(&app, &wt_key, "remove", "error", e.clone());
            Err(e)
        }
    }
}

fn is_running(app: &AppHandle, key: &str) -> bool {
    let table = app.state::<services::ProcTable>();
    let procs = table.procs.lock().unwrap();
    procs.contains_key(key)
}

// ── database: list / snapshot / export / switch ──

/// repo path + repo_id for a worktree key.
fn repo_for_wt(app: &AppHandle, wt_key: &str) -> Result<(String, String), String> {
    let state = app.state::<AppState>();
    let tree = state.tree.read().unwrap();
    tree.iter()
        .find(|r| r.worktrees.iter().any(|w| w.wt_key == wt_key))
        .map(|r| (r.path.clone(), r.repo_id.clone()))
        .ok_or_else(|| "unknown worktree".to_string())
}

#[tauri::command]
pub async fn list_databases(wt_key: String) -> Result<Vec<String>, String> {
    crate::db::list_databases(&wt_key).await
}

#[tauri::command]
pub fn current_database(wt_key: String) -> Option<String> {
    crate::db::current_db(&wt_key)
}

#[tauri::command]
pub async fn snapshot_database(app: AppHandle, wt_key: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Snapshot name is required".into());
    }
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    crate::db::clone_database(&wt_key, &name, move |line| emit_op(&app2, &wt2, "snapshot", "progress", line)).await?;
    emit_op(&app, &wt_key, "snapshot", "done", format!("snapshot '{name}' created"));
    Ok(())
}

#[tauri::command]
pub async fn export_database(app: AppHandle, wt_key: String, file_path: String) -> Result<(), String> {
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    crate::db::export_database(&wt_key, &file_path, move |line| emit_op(&app2, &wt2, "snapshot", "progress", line)).await?;
    emit_op(&app, &wt_key, "snapshot", "done", "exported to file");
    Ok(())
}

#[tauri::command]
pub async fn restore_database(app: AppHandle, wt_key: String, file_path: String) -> Result<(), String> {
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    crate::db::restore_database(&wt_key, &file_path, move |line| emit_op(&app2, &wt2, "snapshot", "progress", line)).await?;
    emit_op(&app, &wt_key, "snapshot", "done", "restore complete");
    Ok(())
}

#[tauri::command]
pub async fn switch_database(app: AppHandle, wt_key: String, db_name: String) -> Result<(), String> {
    let (repo_path, _repo_id) = repo_for_wt(&app, &wt_key)?;
    // repoint PG_DB in the worktree's root .env AND in any provisioned dotenv
    // file (e.g. server/.env) that declares it
    let pairs = [("PG_DB".to_string(), db_name.clone())];
    crate::setup::set_env_keys(&wt_key, &repo_path, &pairs)?;
    crate::setup::set_env_keys_in_provisioned(&wt_key, &repo_path, &pairs)?;
    refresh_tree(&app).await?;
    // auto-restart the server so it connects to the new DB
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            let _ = services::restart_service(&app, &key).await;
        }
    }
    Ok(())
}

/// Override a service's port. Validates range + cross-worktree conflict, updates
/// the override, re-derives env (so dependent keys follow), and auto-restarts
/// the worktree's running services so the change takes effect.
#[tauri::command]
pub async fn set_service_port(app: AppHandle, svc_key: String, port: u32) -> Result<(), String> {
    if !(1024..=65535).contains(&port) {
        return Err("Port must be between 1024 and 65535".into());
    }
    // locate the worktree + repo for this service, and check for conflicts
    let (wt_key, repo_id, repo_path) = {
        let state = app.state::<AppState>();
        let tree = state.tree.read().unwrap();
        let mut found = None;
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                for s in w.services.iter() {
                    if s.svc_key == svc_key {
                        found = Some((w.wt_key.clone(), r.repo_id.clone(), r.path.clone()));
                    }
                    // conflict: another service already uses this effective port
                    if s.svc_key != svc_key && s.port == Some(port) {
                        return Err(format!("Port {port} is already used by {} ({})", s.name, w.branch));
                    }
                }
            }
        }
        found.ok_or("unknown service")?
    };

    // record the override + persist
    {
        let state = app.state::<AppState>();
        state.runtime.write().unwrap().port_overrides.insert(svc_key.clone(), port);
        let rt = state.runtime.read().unwrap().clone();
        let _ = settings::save_runtime(&app, &rt);
    }

    // re-derive .env (TOOLJET_SERVER_PORT etc.) from the declarative env block
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
    let _ = crate::setup::reapply_provision(&wt_key, &repo_path, &vars);
    refresh_tree(&app).await?;

    // auto-restart running services of this worktree to apply the new port(s)
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            let _ = services::restart_service(&app, &key).await;
        }
    }
    Ok(())
}

fn repo_path(app: &AppHandle, repo_id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let s = state.settings.read().unwrap();
    s.repos
        .iter()
        .find(|r| r.id == repo_id)
        .map(|r| r.path.clone())
        .ok_or_else(|| "unknown repo".to_string())
}

#[tauri::command]
pub async fn list_branches(app: AppHandle, repo_id: String) -> Result<git::Branches, String> {
    let path = repo_path(&app, &repo_id)?;
    git::list_branches(&path).await
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
pub fn get_repo_config(app: AppHandle, repo_id: String) -> Result<RepoConfig, String> {
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
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("write {path}: {e}"))
}

/// Write provisioned files + setup commands to the repo's `.worktreemanager.json`.
#[tauri::command]
pub fn save_repo_config(app: AppHandle, repo_id: String, provision: Vec<ProvisionEntry>, setup: Vec<String>) -> Result<(), String> {
    let path = repo_path(&app, &repo_id)?;
    let files: Vec<crate::setup::ProvisionFile> = provision.into_iter().map(Into::into).collect();
    crate::setup::write_repo_config(&path, &files, &setup)
}

/// `git fetch --all --prune` then return the refreshed branch lists.
#[tauri::command]
pub async fn fetch_branches(app: AppHandle, repo_id: String) -> Result<git::Branches, String> {
    let path = repo_path(&app, &repo_id)?;
    git::fetch_all(&path).await?;
    git::list_branches(&path).await
}
