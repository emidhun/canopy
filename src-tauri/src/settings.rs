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
    /// Directory where new worktrees are created. Absolute, or relative to the
    /// repo root (e.g. ".worktrees"). Empty falls back to `<repo>/.worktrees`.
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
    /// Selectable agent launchers for the worktree agent lane. Kept alongside
    /// `agent_command` so existing settings files upgrade without data loss.
    #[serde(default)]
    pub agents: Vec<AgentCfg>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentCfg {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Append Canopy's initial handoff as the first CLI prompt argument.
    pub prompt_on_launch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomCmd {
    /// Button label shown in the worktree header
    pub label: String,
    /// Shell command run in the worktree root
    pub command: String,
    /// Optional heading this command sits under in the rail's Commands menu.
    /// Empty = ungrouped, which is where every existing command starts.
    #[serde(default)]
    pub group: String,
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
    /// Readiness probe path, e.g. `/api/health`. Empty = none, and the service
    /// counts as running the moment its process is alive (today's behaviour).
    ///
    /// A path, not a URL: the host is always localhost and the port is the
    /// service's own derived one, so accepting a full URL would let a health
    /// check silently point at a different service — or a different machine.
    #[serde(default)]
    pub health: String,
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
    /// pgids of embedded terminal sessions, swept on startup after a crash
    #[serde(default)]
    pub terminal_orphans: Vec<TermOrphan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OrphanProc {
    pub svc_key: String,
    pub pgid: i32,
    pub spawn_time_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TermOrphan {
    pub id: String,
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

/// Load a JSON state file. A *missing* file is a fresh install (defaults); a
/// file that EXISTS but doesn't parse is user data in danger — quarantine it
/// to `<name>.corrupt` and log loudly, so the repos/services/ports it held can
/// be recovered by hand instead of being silently wiped on the next save.
fn load_json<T: for<'a> Deserialize<'a> + Default>(path: &PathBuf) -> T {
    let Ok(txt) = fs::read_to_string(path) else { return T::default() };
    match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(e) => {
            let backup = path.with_extension("json.corrupt");
            let _ = fs::copy(path, &backup);
            log::error!(
                "failed to parse {} ({e}) — original preserved at {}; starting from defaults",
                path.display(),
                backup.display()
            );
            T::default()
        }
    }
}

/// Atomic save: write a sibling temp file, fsync, rename over the target. A
/// crash or full disk mid-write can no longer truncate settings/state — the
/// old file stays intact until the rename. Skips the write entirely when the
/// serialized content is unchanged (state.json is saved on every refresh).
fn save_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == body {
            return Ok(());
        }
    }
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename {} → {}: {e}", tmp.display(), path.display()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_is_atomic_and_load_quarantines_corrupt_files() {
        let dir = std::env::temp_dir().join("canopy_settings_test_xyz");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        let s = Settings { terminal: "iTerm".into(), ..Default::default() };
        save_json(&path, &s).unwrap();
        let loaded: Settings = load_json(&path);
        assert_eq!(loaded.terminal, "iTerm", "round-trips");
        assert!(!path.with_extension("json.tmp").exists(), "temp file renamed away");

        // corrupt file → defaults, but the original is preserved
        fs::write(&path, "{ truncated").unwrap();
        let loaded: Settings = load_json(&path);
        assert_eq!(loaded.terminal, "", "defaults on parse failure");
        let backup = path.with_extension("json.corrupt");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{ truncated", "original quarantined");

        // unchanged content → no rewrite (mtime-stable persistence)
        fs::write(&path, serde_json::to_string_pretty(&s).unwrap()).unwrap();
        save_json(&path, &s).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
