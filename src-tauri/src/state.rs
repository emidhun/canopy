use crate::git::{self, GitMeta};
use crate::settings::{RepoCfg, RuntimeState, Settings};
use serde::Serialize;
use std::collections::HashMap;
use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SvcStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceNode {
    pub svc_key: String,
    pub service_id: String,
    pub name: String,
    pub kind: String,
    /// the port the service actually uses — an override if one is set, else
    /// the derived one
    pub port: Option<u32>,
    /// what `base_port + index*10` yields, ignoring any override. Carried
    /// alongside `port` so the detail modal can say whether the current value
    /// is derived or overridden, and so Esc can revert to something meaningful
    /// rather than to whatever the modal happened to open with.
    pub derived_port: Option<u32>,
    pub status: SvcStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeNode {
    pub wt_key: String,
    pub branch: String,
    pub path: String,
    pub is_main: bool,
    pub git: Option<GitMeta>,
    /// database name from the worktree's .env (PG_DB), if present
    pub db_name: Option<String>,
    pub services: Vec<ServiceNode>,
}

/// Read a single key's value from a worktree's `.env` (no quoting/expansion).
fn env_value(wt_path: &str, key: &str) -> Option<String> {
    let txt = std::fs::read_to_string(std::path::Path::new(wt_path).join(".env")).ok()?;
    for line in txt.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(v) = rest.strip_prefix('=') {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoNode {
    pub repo_id: String,
    pub name: String,
    pub path: String,
    pub worktrees: Vec<WorktreeNode>,
}

pub struct AppState {
    pub settings: RwLock<Settings>,
    pub runtime: RwLock<RuntimeState>,
    pub tree: RwLock<Vec<RepoNode>>,
    /// svcKey -> current status (process table lands here in Phase 4)
    pub statuses: RwLock<HashMap<String, SvcStatus>>,
    /// wt_key -> label of the mutating operation currently holding the lease
    /// (see `try_lease`)
    pub ops: Mutex<HashMap<String, &'static str>>,
}

/// RAII lease for a mutating per-worktree operation. Exactly one of
/// create/setup/remove/migrate/snapshot/restore/switch may run per worktree at
/// a time — without this, `remove_worktree` could race `run_worktree_setup`,
/// two creates could TOCTOU the same path, and a restore could race a
/// snapshot. Dropped (including on panic/early return) it frees the slot.
pub struct OpLease {
    app: AppHandle,
    key: String,
}

impl Drop for OpLease {
    fn drop(&mut self) {
        let state = self.app.state::<AppState>();
        state.ops.lock().remove(&self.key);
    }
}

/// Release everything runtime-side that belongs to a removed worktree: its
/// port index (so the slot is reclaimed and derived ports stop creeping up),
/// its port overrides, its statuses, and its in-memory log buffers. Persists
/// the runtime file. Idempotent.
pub fn release_worktree_runtime(app: &AppHandle, repo_id: &str, wt_key: &str) {
    let state = app.state::<AppState>();
    let prefix = format!("{wt_key}::");
    let runtime = {
        let mut rt = state.runtime.write();
        if let Some(map) = rt.port_indices.get_mut(repo_id) {
            map.remove(wt_key);
        }
        rt.port_overrides.retain(|k, _| !k.starts_with(&prefix));
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
    state.statuses.write().retain(|k, _| !k.starts_with(&prefix));
    if let Some(table) = app.try_state::<crate::services::ProcTable>() {
        table.logs.lock().retain(|k, _| !k.starts_with(&prefix));
        // close the on-disk log handles too, or a removed worktree keeps file
        // descriptors open for the rest of the run
        table.log_files.lock().retain(|k, _| !k.starts_with(&prefix));
    }
}

/// Take the operation lease for `wt_key`, or fail with a conflict naming the
/// operation already running.
pub fn try_lease(app: &AppHandle, wt_key: &str, op: &'static str) -> Result<OpLease, crate::error::CanopyError> {
    let state = app.state::<AppState>();
    let mut ops = state.ops.lock();
    if let Some(existing) = ops.get(wt_key) {
        return Err(crate::error::CanopyError::conflict(format!(
            "'{existing}' is already running on this worktree — wait for it to finish"
        )));
    }
    ops.insert(wt_key.to_string(), op);
    Ok(OpLease { app: app.clone(), key: wt_key.to_string() })
}

/// A worktree resolved to its owning repo — the answer every command needs
/// before it can act on a `wt_key`.
#[derive(Debug, Clone)]
pub struct WtContext {
    pub repo_id: String,
    pub repo_path: String,
    pub branch: String,
    pub is_main: bool,
}

impl AppState {
    pub fn new(settings: Settings, runtime: RuntimeState) -> Self {
        Self {
            settings: RwLock::new(settings),
            runtime: RwLock::new(runtime),
            tree: RwLock::new(Vec::new()),
            statuses: RwLock::new(HashMap::new()),
            ops: Mutex::new(HashMap::new()),
        }
    }

    // ── tree queries ──
    //
    // The tree is the single navigable model (repos → worktrees → services);
    // every command used to hand-roll the same triple-nested loop with subtly
    // different miss behavior. These are the only sanctioned lookups — they
    // take the tree read lock briefly and return owned data, so callers never
    // hold a lock across an await point.

    /// Resolve a worktree key to its owning repo.
    pub fn wt_context(&self, wt_key: &str) -> Option<WtContext> {
        let tree = self.tree.read();
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                if w.wt_key == wt_key {
                    return Some(WtContext {
                        repo_id: r.repo_id.clone(),
                        repo_path: r.path.clone(),
                        branch: w.branch.clone(),
                        is_main: w.is_main,
                    });
                }
            }
        }
        None
    }

    /// Resolve a service key to `(wt_key, repo_id, repo_path)`.
    pub fn service_context(&self, svc_key: &str) -> Option<(String, String, String)> {
        let tree = self.tree.read();
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                if w.services.iter().any(|s| s.svc_key == svc_key) {
                    return Some((w.wt_key.clone(), r.repo_id.clone(), r.path.clone()));
                }
            }
        }
        None
    }

    /// All service keys of one worktree.
    pub fn wt_service_keys(&self, wt_key: &str) -> Vec<String> {
        let tree = self.tree.read();
        tree.iter()
            .flat_map(|r| r.worktrees.iter())
            .filter(|w| w.wt_key == wt_key)
            .flat_map(|w| w.services.iter().map(|s| s.svc_key.clone()))
            .collect()
    }

    /// A registered repo's path by id.
    pub fn repo_path_by_id(&self, repo_id: &str) -> Option<String> {
        let s = self.settings.read();
        s.repos.iter().find(|r| r.id == repo_id).map(|r| r.path.clone())
    }
}

pub fn svc_key(wt_key: &str, service_id: &str) -> String {
    format!("{wt_key}::{service_id}")
}

/// Stable per-worktree port index: main checkout = 0, others get the first free
/// slot, persisted so ports never shuffle. Effective port = basePort + index*10.
fn port_index(runtime: &mut RuntimeState, repo_id: &str, wt_key: &str, is_main: bool) -> u32 {
    let map = runtime.port_indices.entry(repo_id.to_string()).or_default();
    if let Some(i) = map.get(wt_key) {
        return *i;
    }
    let idx = if is_main {
        0
    } else {
        let mut used: Vec<u32> = map.values().copied().collect();
        used.sort_unstable();
        let mut i = 1;
        while used.contains(&i) {
            i += 1;
        }
        i
    };
    map.insert(wt_key.to_string(), idx);
    idx
}

/// A service's effective port: an explicit override if set, else the derived
/// `base_port + index*10`.
pub fn effective_port(overrides: &HashMap<String, u32>, svc_key: &str, base_port: u32, idx: u32) -> u32 {
    overrides.get(svc_key).copied().unwrap_or(base_port + idx * 10)
}

/// Assign (or look up) the worktree's port index and return the variables setup
/// can use to provision isolated resources: WT_SLUG, WT_INDEX, WT_DB_NAME, and
/// WT_<SERVICE>_PORT (plus WM_* aliases for back-compat). Idempotent; persists
/// the index. Called before setup so .env overrides can reference these.
pub fn worktree_vars(app: &AppHandle, repo_id: &str, wt_key: &str, is_main: bool) -> HashMap<String, String> {
    let state = app.state::<AppState>();
    let idx = {
        let mut rt = state.runtime.write();
        port_index(&mut rt, repo_id, wt_key, is_main)
    };
    {
        let rt = state.runtime.read().clone();
        let _ = crate::settings::save_runtime(app, &rt);
    }
    let slug = crate::setup::wt_slug(wt_key);
    let repo_slug: String = repo_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();

    let mut m = HashMap::new();
    m.insert("WT_SLUG".into(), slug.clone());
    m.insert("WT_INDEX".into(), idx.to_string());
    m.insert("WT_DB_NAME".into(), format!("{repo_slug}_{slug}"));
    m.insert("WM_WT_SLUG".into(), slug); // back-compat alias

    let overrides = state.runtime.read().port_overrides.clone();
    let settings = state.settings.read();
    if let Some(repo) = settings.repos.iter().find(|r| r.id == repo_id) {
        for s in &repo.services {
            if let Some(bp) = s.base_port {
                let key = svc_key(wt_key, &s.id);
                let port = effective_port(&overrides, &key, bp as u32, idx).to_string();
                let id_up = s.id.to_uppercase();
                m.insert(format!("WT_{id_up}_PORT"), port.clone());
                m.insert(format!("WM_PORT_{id_up}"), port.clone()); // back-compat alias
                // Also expose the port under the service's human NAME, so an .env
                // template can use `${WT_SERVER_PORT}` for a service named "Server"
                // regardless of its internal id (ids like `svc-19` never matched a
                // human-authored template). Additive: `or_insert` never clobbers an
                // id-based var, and a name collision keeps the first service's port.
                let name_slug: String = s
                    .name
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                    .collect();
                let name_slug = name_slug.trim_matches('_');
                if !name_slug.is_empty() {
                    m.entry(format!("WT_{name_slug}_PORT")).or_insert(port);
                }
            }
        }
    }
    m
}

/// Rebuild the structural tree (repos -> worktrees -> services) from settings +
/// `git worktree list`. Git meta is carried over from the previous snapshot and
/// refreshed separately. Emits `tree:changed`.
pub async fn refresh_tree(app: &AppHandle) -> Result<Vec<RepoNode>, String> {
    let state = app.state::<AppState>();
    let repos_cfg: Vec<RepoCfg> = state.settings.read().repos.clone();

    // previous git meta, preserved across rebuilds
    let prev_git: HashMap<String, GitMeta> = state
        .tree
        .read()
        .iter()
        .flat_map(|r| r.worktrees.iter())
        .filter_map(|w| w.git.clone().map(|g| (w.wt_key.clone(), g)))
        .collect();

    let mut tree = Vec::new();
    for repo in &repos_cfg {
        let wts = match git::list_worktrees(&repo.path).await {
            Ok(w) => w,
            Err(e) => {
                log::warn!("list_worktrees failed for {}: {e}", repo.path);
                Vec::new()
            }
        };

        let mut worktrees = Vec::new();
        for wt in wts {
            // a worktree whose folder was deleted outside Canopy is `prunable` —
            // don't render it as a live row; the Sync-prune flow reconciles it
            if wt.prunable {
                continue;
            }
            let (idx, overrides) = {
                let mut runtime = state.runtime.write();
                let idx = port_index(&mut runtime, &repo.id, &wt.path, wt.is_main);
                (idx, runtime.port_overrides.clone())
            };
            let statuses = state.statuses.read();
            let services = repo
                .services
                .iter()
                .map(|s| {
                    let key = svc_key(&wt.path, &s.id);
                    ServiceNode {
                        port: s.base_port.map(|p| effective_port(&overrides, &key, p as u32, idx)),
                        derived_port: s.base_port.map(|p| p as u32 + idx * 10),
                        status: statuses.get(&key).copied().unwrap_or(SvcStatus::Stopped),
                        svc_key: key,
                        service_id: s.id.clone(),
                        name: s.name.clone(),
                        kind: s.kind.clone(),
                    }
                })
                .collect();

            worktrees.push(WorktreeNode {
                db_name: env_value(&wt.path, "PG_DB"),
                wt_key: wt.path.clone(),
                git: prev_git.get(&wt.path).cloned(),
                branch: wt.branch,
                path: wt.path,
                is_main: wt.is_main,
                services,
            });
        }

        tree.push(RepoNode {
            repo_id: repo.id.clone(),
            name: repo.name.clone(),
            path: repo.path.clone(),
            worktrees,
        });
    }

    // swap in the new tree; emit only when something actually changed — the
    // unconditional broadcast forced every window through a full JSON
    // serialize + React reconcile once a minute even when nothing moved
    let changed = {
        let mut cached = state.tree.write();
        let changed = *cached != tree;
        *cached = tree.clone();
        changed
    };
    // self-heal the statuses map: a service's exit waiter can fire set_status
    // AFTER its worktree was removed and cleaned (stop is async), re-inserting
    // an orphan key — prune anything the rebuilt tree doesn't know.
    {
        let known: std::collections::HashSet<&str> = tree
            .iter()
            .flat_map(|r| r.worktrees.iter())
            .flat_map(|w| w.services.iter().map(|s| s.svc_key.as_str()))
            .collect();
        state.statuses.write().retain(|k, _| known.contains(k.as_str()));
    }
    {
        let runtime = state.runtime.read().clone();
        let _ = crate::settings::save_runtime(app, &runtime);
    }
    if changed {
        let _ = app.emit("tree:changed", &tree);
    }
    Ok(tree)
}

/// Refresh git meta for one worktree; updates the cached tree and emits `worktree:git`.
pub async fn refresh_git_meta(app: &AppHandle, wt_path: &str) {
    if let Ok(meta) = git::git_meta(wt_path).await {
        let state = app.state::<AppState>();
        let mut changed = false;
        {
            let mut tree = state.tree.write();
            for r in tree.iter_mut() {
                for w in r.worktrees.iter_mut() {
                    if w.wt_key == wt_path && w.git.as_ref() != Some(&meta) {
                        w.git = Some(meta.clone());
                        changed = true;
                    }
                }
            }
        }
        if changed {
            #[derive(Serialize, Clone)]
            #[serde(rename_all = "camelCase")]
            struct GitEvent<'a> {
                wt_key: &'a str,
                #[serde(flatten)]
                meta: &'a GitMeta,
            }
            let _ = app.emit("worktree:git", &GitEvent { wt_key: wt_path, meta: &meta });
        }
    }
}

/// Full refresh (tree + git meta), collapsed under an in-flight guard: the
/// 60s loop, the tray catch-up paths and show_main_window can all fire at
/// once (tray click + window show is exactly that), and each full refresh is
/// 2 git spawns per worktree — no reason to run three copies concurrently.
pub async fn refresh_all(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    if IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return; // one is already running and will pick up the same state
    }
    let _ = refresh_tree(app).await;
    refresh_all_git_meta(app).await;
    IN_FLIGHT.store(false, Ordering::Release);
}

/// Refresh git meta for every worktree. Worktrees are independent, so the
/// per-worktree refreshes run concurrently (chunked so a many-worktree setup
/// doesn't fork dozens of git processes at once) — the old sequential loop
/// could take longer than the 60s refresh interval on large repos.
pub async fn refresh_all_git_meta(app: &AppHandle) {
    let paths: Vec<String> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter()
            .flat_map(|r| r.worktrees.iter().map(|w| w.wt_key.clone()))
            .collect()
    };
    for chunk in paths.chunks(6) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|p| {
                let app = app.clone();
                let p = p.clone();
                tauri::async_runtime::spawn(async move { refresh_git_meta(&app, &p).await })
            })
            .collect();
        for h in handles {
            let _ = h.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_index_is_stable_and_reclaims_gaps() {
        let mut rt = RuntimeState::default();
        assert_eq!(port_index(&mut rt, "repo", "/main", true), 0, "main is always 0");
        assert_eq!(port_index(&mut rt, "repo", "/wt-a", false), 1);
        assert_eq!(port_index(&mut rt, "repo", "/wt-b", false), 2);
        // stable across repeat calls
        assert_eq!(port_index(&mut rt, "repo", "/wt-a", false), 1);
        // freeing an index lets the next worktree take the first gap
        rt.port_indices.get_mut("repo").unwrap().remove("/wt-a");
        assert_eq!(port_index(&mut rt, "repo", "/wt-c", false), 1);
        // separate repos have independent index spaces
        assert_eq!(port_index(&mut rt, "other", "/wt-x", false), 1);
    }

    #[test]
    fn effective_port_prefers_override() {
        let mut overrides = HashMap::new();
        assert_eq!(effective_port(&overrides, "k", 3000, 2), 3020, "derived = base + idx*10");
        overrides.insert("k".to_string(), 4321);
        assert_eq!(effective_port(&overrides, "k", 3000, 2), 4321, "override wins");
    }
}
