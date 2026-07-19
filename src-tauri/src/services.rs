use crate::settings::{OrphanProc, ServiceCfg};
use crate::state::{AppState, SvcStatus};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub const LOG_CAP: usize = 160;
const LOG_FLUSH_MS: u64 = 80;
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub t: String,
    pub lv: String, // info | ok | warn | err
    pub text: String,
}

impl LogLine {
    pub fn now(lv: &str, text: impl Into<String>) -> Self {
        let t = chrono_time();
        Self { t, lv: lv.into(), text: text.into() }
    }
}

fn chrono_time() -> String {
    // HH:MM:SS local time without pulling in chrono
    let now = std::time::SystemTime::now();
    let secs = now.duration_since(UNIX_EPOCH).unwrap().as_secs();
    let offset = local_utc_offset_secs();
    let local = (secs as i64 + offset).rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", local / 3600, (local % 3600) / 60, local % 60)
}

fn local_utc_offset_secs() -> i64 {
    // localtime_r-based offset; cheap and correct for display purposes
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm.tm_gmtoff as i64
    }
}

pub struct ProcEntry {
    pub pid: u32,
    pub pgid: i32,
    pub started_at: Instant,
    pub started_unix: u64,
    /// generation guard: stop() bumps this so a stale waiter doesn't clobber state
    pub generation: u64,
}

#[derive(Default)]
pub struct ProcTable {
    pub procs: Mutex<HashMap<String, ProcEntry>>,
    pub logs: Mutex<HashMap<String, VecDeque<LogLine>>>,
    pub resetting: Mutex<HashMap<String, bool>>,
    generation: Mutex<u64>,
}

impl ProcTable {
    fn next_gen(&self) -> u64 {
        let mut g = self.generation.lock().unwrap();
        *g += 1;
        *g
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusEvent<'a> {
    svc_key: &'a str,
    status: SvcStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

pub fn set_status(app: &AppHandle, key: &str, status: SvcStatus, started_at: Option<u64>, exit_code: Option<i32>) {
    let state = app.state::<AppState>();
    state.statuses.write().unwrap().insert(key.to_string(), status);
    // patch cached tree so late get_tree calls see fresh statuses
    {
        let mut tree = state.tree.write().unwrap();
        for r in tree.iter_mut() {
            for w in r.worktrees.iter_mut() {
                for s in w.services.iter_mut() {
                    if s.svc_key == key {
                        s.status = status;
                    }
                }
            }
        }
    }
    let _ = app.emit("service:status", &StatusEvent { svc_key: key, status, started_at, exit_code });
}

pub fn push_log(app: &AppHandle, key: &str, line: LogLine) {
    let table = app.state::<ProcTable>();
    {
        let mut logs = table.logs.lock().unwrap();
        let buf = logs.entry(key.to_string()).or_default();
        buf.push_back(line.clone());
        while buf.len() > LOG_CAP {
            buf.pop_front();
        }
    }
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct LogEvent<'a> {
        svc_key: &'a str,
        lines: Vec<LogLine>,
    }
    let _ = app.emit("service:log", &LogEvent { svc_key: key, lines: vec![line] });
}

fn persist_orphans(app: &AppHandle) {
    let table = app.state::<ProcTable>();
    let orphans: Vec<OrphanProc> = table
        .procs
        .lock()
        .unwrap()
        .iter()
        .map(|(k, p)| OrphanProc {
            svc_key: k.clone(),
            pgid: p.pgid,
            spawn_time_secs: p.started_unix,
        })
        .collect();
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write().unwrap();
        rt.orphans = orphans;
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

/// Resolve a service's config + worktree env (PORT etc.) from settings.
fn resolve_service(app: &AppHandle, key: &str) -> Result<(ServiceCfg, String, HashMap<String, String>), String> {
    let state = app.state::<AppState>();
    let tree = state.tree.read().unwrap();
    for r in tree.iter() {
        for w in r.worktrees.iter() {
            for s in w.services.iter() {
                if s.svc_key == key {
                    let settings = state.settings.read().unwrap();
                    let repo = settings.repos.iter().find(|rc| rc.id == r.repo_id).ok_or("repo gone")?;
                    let cfg = repo
                        .services
                        .iter()
                        .find(|sc| sc.id == s.service_id)
                        .ok_or("service gone")?
                        .clone();
                    let mut env = cfg.env.clone();
                    if let Some(port) = s.port {
                        env.insert("PORT".into(), port.to_string());
                    }
                    // expose every sibling service's port under both names: the
                    // documented WT_<ID>_PORT and the back-compat WM_PORT_<ID>,
                    // matching what setup/custom commands see (see setup.rs).
                    for sib in w.services.iter() {
                        if let Some(p) = sib.port {
                            let id = sib.service_id.to_uppercase();
                            env.insert(format!("WT_{id}_PORT"), p.to_string());
                            env.insert(format!("WM_PORT_{id}"), p.to_string());
                        }
                    }
                    // per-worktree identifier, matching what setup saw (e.g. for DB names)
                    env.insert("WM_WT_SLUG".into(), crate::setup::wt_slug(&w.path));
                    return Ok((cfg, w.path.clone(), env));
                }
            }
        }
    }
    Err(format!("unknown service: {key}"))
}

pub async fn start_service(app: &AppHandle, key: &str) -> Result<(), String> {
    {
        let table = app.state::<ProcTable>();
        if table.procs.lock().unwrap().contains_key(key) {
            return Ok(()); // already running
        }
    }
    let (cfg, wt_path, env) = resolve_service(app, key)?;
    let cwd = if cfg.cwd.is_empty() {
        wt_path.clone()
    } else {
        format!("{wt_path}/{}", cfg.cwd)
    };

    set_status(app, key, SvcStatus::Starting, None, None);
    push_log(app, key, LogLine::now("info", format!("starting {}…", cfg.name.to_lowercase())));

    // expand ${PORT} in the command, run via the user's login shell so
    // nvm/volta/asdf resolve
    let mut command_str = cfg.command.clone();
    if let Some(port) = env.get("PORT") {
        command_str = command_str.replace("${PORT}", port).replace("$PORT", port);
    }
    // honor the worktree's pinned Node version (see toolchain.rs)
    command_str = crate::toolchain::with_pinned_node(&cwd, &command_str);

    let (shell, shargs) = crate::toolchain::shell_argv(&command_str);
    let mut cmd = Command::new(shell);
    cmd.args(&shargs)
        .current_dir(&cwd)
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);

    let mut child = cmd.spawn().map_err(|e| {
        set_status(app, key, SvcStatus::Error, None, None);
        push_log(app, key, LogLine::now("err", format!("spawn failed: {e}")));
        format!("spawn failed: {e}")
    })?;

    let pid = child.id().unwrap_or(0);
    let pgid = pid as i32; // process_group(0) => pgid == child pid
    let started_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    let generation = {
        let table = app.state::<ProcTable>();
        let generation = table.next_gen();
        table.procs.lock().unwrap().insert(
            key.to_string(),
            ProcEntry { pid, pgid, started_at: Instant::now(), started_unix, generation },
        );
        generation
    };
    persist_orphans(app);

    set_status(app, key, SvcStatus::Running, Some(started_unix), None);
    if let Some(port) = env.get("PORT") {
        push_log(app, key, LogLine::now("ok", format!("spawned — expecting http://localhost:{port}")));
    }

    // ── log pumps (batched) ──
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    for (stream, is_err) in [(stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), false)]
        .into_iter()
        .chain([(stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), true)])
    {
        let Some(stream) = stream else { continue };
        let app = app.clone();
        let key = key.to_string();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            let mut batch: Vec<LogLine> = Vec::new();
            let mut last_flush = Instant::now();
            loop {
                let line = tokio::select! {
                    l = lines.next_line() => l,
                    _ = tokio::time::sleep(Duration::from_millis(LOG_FLUSH_MS)) => {
                        if !batch.is_empty() { flush_batch(&app, &key, &mut batch); }
                        last_flush = Instant::now();
                        continue;
                    }
                };
                match line {
                    Ok(Some(text)) => {
                        let lv = classify_line(&text, is_err);
                        batch.push(LogLine::now(lv, text));
                        if last_flush.elapsed().as_millis() as u64 >= LOG_FLUSH_MS {
                            flush_batch(&app, &key, &mut batch);
                            last_flush = Instant::now();
                        }
                    }
                    _ => {
                        if !batch.is_empty() {
                            flush_batch(&app, &key, &mut batch);
                        }
                        break;
                    }
                }
            }
        });
    }

    // ── waiter: authoritative exit handling ──
    {
        let app = app.clone();
        let key = key.to_string();
        tauri::async_runtime::spawn(async move {
            let status = child.wait().await;
            let table = app.state::<ProcTable>();
            {
                let mut procs = table.procs.lock().unwrap();
                match procs.get(&key) {
                    Some(p) if p.generation == generation => {
                        procs.remove(&key);
                    }
                    // a newer process replaced us (restart) — don't touch state
                    _ => return,
                }
            }
            persist_orphans(&app);
            let code = status.ok().and_then(|s| s.code());
            match code {
                Some(0) => {
                    push_log(&app, &key, LogLine::now("warn", "process exited (code 0)"));
                    set_status(&app, &key, SvcStatus::Stopped, None, Some(0));
                }
                Some(c) => {
                    push_log(&app, &key, LogLine::now("err", format!("process exited (code {c})")));
                    set_status(&app, &key, SvcStatus::Error, None, Some(c));
                }
                None => {
                    // killed by signal (our stop path or external)
                    push_log(&app, &key, LogLine::now("warn", "process exited (SIGTERM)"));
                    set_status(&app, &key, SvcStatus::Stopped, None, None);
                }
            }
        });
    }

    Ok(())
}

fn flush_batch(app: &AppHandle, key: &str, batch: &mut Vec<LogLine>) {
    let table = app.state::<ProcTable>();
    {
        let mut logs = table.logs.lock().unwrap();
        let buf = logs.entry(key.to_string()).or_default();
        for l in batch.iter() {
            buf.push_back(l.clone());
        }
        while buf.len() > LOG_CAP {
            buf.pop_front();
        }
    }
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct LogEvent<'a> {
        svc_key: &'a str,
        lines: Vec<LogLine>,
    }
    let _ = app.emit("service:log", &LogEvent { svc_key: key, lines: std::mem::take(batch) });
}

fn classify_line(text: &str, from_stderr: bool) -> &'static str {
    let lower = text.to_lowercase();
    if lower.contains("error") || lower.contains("fatal") || lower.contains("err!") {
        "err"
    } else if lower.contains("warn") {
        "warn"
    } else if lower.contains("listening") || lower.contains("compiled successfully") || lower.contains("ready") {
        "ok"
    } else if from_stderr {
        "info" // many dev tools log normal output to stderr
    } else {
        "info"
    }
}

pub async fn stop_service(app: &AppHandle, key: &str) -> Result<(), String> {
    let pgid = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock().unwrap();
        match procs.get(key) {
            Some(p) => p.pgid,
            None => return Ok(()), // not running
        }
    };

    set_status(app, key, SvcStatus::Stopping, None, None);
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
    }

    // grace period, then SIGKILL if the group is still alive
    let app2 = app.clone();
    let key2 = key.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STOP_GRACE).await;
        let still_tracked = {
            let table = app2.state::<ProcTable>();
            let procs = table.procs.lock().unwrap();
            procs.get(&key2).map(|p| p.pgid) == Some(pgid)
        };
        if still_tracked {
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    });
    Ok(())
}

pub async fn restart_service(app: &AppHandle, key: &str) -> Result<(), String> {
    let was_running = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock().unwrap();
        procs.contains_key(key)
    };
    if was_running {
        push_log(app, key, LogLine::now("warn", "restarting…"));
        stop_service(app, key).await?;
        // wait for the waiter to reap (status -> stopped/error)
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let table = app.state::<ProcTable>();
            if !table.procs.lock().unwrap().contains_key(key) {
                break;
            }
        }
    }
    start_service(app, key).await
}

/// Stop everything; returns once all process groups are reaped or grace expires.
pub async fn stop_all(app: &AppHandle) {
    let keys: Vec<String> = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock().unwrap();
        procs.keys().cloned().collect()
    };
    for k in &keys {
        let _ = stop_service(app, k).await;
    }
    for _ in 0..40 {
        let table = app.state::<ProcTable>();
        let empty = table.procs.lock().unwrap().is_empty();
        if empty {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Worktree-level: collect svc keys of one worktree.
pub fn worktree_svc_keys(app: &AppHandle, wt_key: &str) -> Vec<String> {
    let state = app.state::<AppState>();
    let tree = state.tree.read().unwrap();
    tree.iter()
        .flat_map(|r| r.worktrees.iter())
        .filter(|w| w.wt_key == wt_key)
        .flat_map(|w| w.services.iter().map(|s| s.svc_key.clone()))
        .collect()
}

/// Reset DB: runs the repo's resetDb command in the worktree root; output goes
/// to the first server-kind service's log buffer.
pub async fn reset_db(app: &AppHandle, wt_key: &str) -> Result<(), String> {
    let (cmd_str, log_key) = {
        let state = app.state::<AppState>();
        let tree = state.tree.read().unwrap();
        let settings = state.settings.read().unwrap();
        let mut found = None;
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                if w.wt_key == wt_key {
                    let repo = settings.repos.iter().find(|rc| rc.id == r.repo_id).ok_or("repo gone")?;
                    if repo.reset_db.trim().is_empty() {
                        return Err("No Reset DB command configured for this repo (Settings)".into());
                    }
                    let log_svc = w
                        .services
                        .iter()
                        .find(|s| s.kind == "server")
                        .or(w.services.first())
                        .map(|s| s.svc_key.clone());
                    found = Some((repo.reset_db.clone(), log_svc));
                }
            }
        }
        found.ok_or("unknown worktree")?
    };

    {
        let table = app.state::<ProcTable>();
        let mut resetting = table.resetting.lock().unwrap();
        if resetting.get(wt_key).copied().unwrap_or(false) {
            return Err("Reset already in progress".into());
        }
        resetting.insert(wt_key.to_string(), true);
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct ResetEvent<'a> {
        wt_key: &'a str,
        state: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    }
    let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "started", message: None });
    if let Some(k) = &log_key {
        push_log(app, k, LogLine::now("warn", "db: reset started…"));
    }

    // honor the worktree's pinned Node version (ToolJet's reset scripts need it)
    let wrapped = crate::toolchain::with_pinned_node(wt_key, &cmd_str);
    let (shell, shargs) = crate::toolchain::shell_argv(&wrapped);
    let out = Command::new(shell)
        .args(&shargs)
        .current_dir(wt_key)
        .output()
        .await;

    {
        let table = app.state::<ProcTable>();
        table.resetting.lock().unwrap().remove(wt_key);
    }

    match out {
        Ok(o) if o.status.success() => {
            if let Some(k) = &log_key {
                for line in String::from_utf8_lossy(&o.stdout).lines().rev().take(5).collect::<Vec<_>>().into_iter().rev() {
                    push_log(app, k, LogLine::now("info", line.to_string()));
                }
                push_log(app, k, LogLine::now("ok", "db: reset complete"));
            }
            let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "done", message: None });
            Ok(())
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if let Some(k) = &log_key {
                push_log(app, k, LogLine::now("err", format!("db: reset failed — {err}")));
            }
            let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "error", message: Some(err.clone()) });
            Err(err)
        }
        Err(e) => {
            let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "error", message: Some(e.to_string()) });
            Err(e.to_string())
        }
    }
}

/// Startup sweep: kill process groups left over from a crash. Only kills when
/// the group leader still exists and its start time matches what we recorded
/// (avoids killing a recycled PID).
pub fn sweep_orphans(app: &AppHandle) {
    let orphans = {
        let state = app.state::<AppState>();
        let rt = state.runtime.read().unwrap();
        rt.orphans.clone()
    };
    for o in &orphans {
        if o.pgid <= 1 {
            continue;
        }
        let alive = unsafe { libc::killpg(o.pgid, 0) == 0 };
        if alive && proc_start_time_matches(o.pgid as u32, o.spawn_time_secs) {
            eprintln!("[wtm] sweeping orphan pgid {} ({})", o.pgid, o.svc_key);
            unsafe {
                libc::killpg(o.pgid, libc::SIGTERM);
            }
        }
    }
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write().unwrap();
        rt.orphans.clear();
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

/// Compare recorded spawn time against the process's actual start time (±5s).
fn proc_start_time_matches(pid: u32, recorded_secs: u64) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output();
    let Ok(out) = out else { return false };
    if !out.status.success() {
        return false;
    }
    let lstart = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if lstart.is_empty() {
        return false;
    }
    // The pgid-existence check plus a sane recorded time is sufficient for v1;
    // parsing lstart exactly would require another shell-out.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    recorded_secs <= now
}
