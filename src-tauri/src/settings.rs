use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub editor: EditorCfg,
    pub terminal: String,
    pub repos: Vec<RepoCfg>,
    /// show the in-place "Switch branch" action in the worktree header
    pub show_switch_branch: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 0,
            editor: EditorCfg::default(),
            terminal: String::new(),
            repos: Vec::new(),
            show_switch_branch: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorCfg {
    pub command: String,
}

impl Default for EditorCfg {
    fn default() -> Self {
        Self { command: "code".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoCfg {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Directory where new worktrees are created (e.g. <repo>-worktrees)
    pub worktree_dir: String,
    /// Command run in the worktree root for "Reset DB" (empty = action hidden)
    pub reset_db: String,
    /// Command run in the worktree root for "Run migration". Empty = fall back to
    /// the repo's `.worktreemanager.json` `migrate` array.
    #[serde(default)]
    pub migrate_db: String,
    pub services: Vec<ServiceCfg>,
    /// Ad-hoc commands surfaced as buttons in the worktree header; each runs in
    /// the worktree root on the pinned Node.
    #[serde(default)]
    pub custom_commands: Vec<CustomCmd>,
    /// CLI the agent lane's "Start agent" runs in a worktree terminal (e.g.
    /// `claude`, `aider`, `codex`). Empty = fall back to the built-in default.
    #[serde(default)]
    pub agent_command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomCmd {
    /// Button label shown in the worktree header
    pub label: String,
    /// Shell command run in the worktree root
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceCfg {
    pub id: String,
    pub name: String,
    /// web | server | worker
    pub kind: String,
    pub command: String,
    /// cwd relative to the worktree root
    pub cwd: String,
    pub base_port: Option<u16>,
    pub env: HashMap<String, String>,
}

/// Persisted runtime state (not user-edited): stable port index per worktree,
/// and spawned process groups for the orphan sweep.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeState {
    /// repoId -> (wtKey -> index); effective port = basePort + index * 10
    pub port_indices: HashMap<String, HashMap<String, u32>>,
    /// svcKey -> explicit port override (takes precedence over the derived port)
    #[serde(default)]
    pub port_overrides: HashMap<String, u32>,
    /// pgids of spawned services, swept on startup after a crash
    pub orphans: Vec<OrphanProc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OrphanProc {
    pub svc_key: String,
    pub pgid: i32,
    pub spawn_time_secs: u64,
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("no app config dir")
        .join("settings.json")
}

fn runtime_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("state.json")
}

fn load_json<T: for<'a> Deserialize<'a> + Default>(path: &PathBuf) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())
}

pub fn load_settings(app: &AppHandle) -> Settings {
    load_json(&settings_path(app))
}

pub fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    save_json(&settings_path(app), s)
}

pub fn load_runtime(app: &AppHandle) -> RuntimeState {
    load_json(&runtime_path(app))
}

pub fn save_runtime(app: &AppHandle, s: &RuntimeState) -> Result<(), String> {
    save_json(&runtime_path(app), s)
}
