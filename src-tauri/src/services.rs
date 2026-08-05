use crate::settings::ServiceCfg;
use crate::state::{AppState, SvcStatus};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use parking_lot::Mutex;
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
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let offset = cached_utc_offset(secs);
    let local = (secs as i64 + offset).rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", local / 3600, (local % 3600) / 60, local % 60)
}

/// Local UTC offset with a 60s cache — the exact value only shifts on a DST
/// boundary, and computing it per log line meant a localtime_r call for every
/// line of a webpack burst.
fn cached_utc_offset(now_secs: u64) -> i64 {
    use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
    static OFFSET: AtomicI64 = AtomicI64::new(0);
    static FETCHED_AT: AtomicU64 = AtomicU64::new(0);
    let last = FETCHED_AT.load(Ordering::Relaxed);
    if last == 0 || now_secs.saturating_sub(last) > 60 {
        let off = crate::proc::local_utc_offset_secs();
        OFFSET.store(off, Ordering::Relaxed);
        FETCHED_AT.store(now_secs, Ordering::Relaxed);
        off
    } else {
        OFFSET.load(Ordering::Relaxed)
    }
}

pub struct ProcEntry {
    pub pid: u32,
    /// process-group / job handle used to tear down the whole child tree
    pub group: crate::proc::ProcGroup,
    pub started_at: Instant,
    pub started_unix: u64,
    /// generation guard: stop() bumps this so a stale waiter doesn't clobber state
    pub generation: u64,
}

#[derive(Default)]
pub struct ProcTable {
    pub procs: Mutex<HashMap<String, ProcEntry>>,
    pub logs: Mutex<HashMap<String, VecDeque<LogLine>>>,
    generation: Mutex<u64>,
}

impl ProcTable {
    fn next_gen(&self) -> u64 {
        let mut g = self.generation.lock();
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
    state.statuses.write().insert(key.to_string(), status);
    // patch cached tree so late get_tree calls see fresh statuses
    {
        let mut tree = state.tree.write();
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


/// Deliver to the main window's listeners only — the popover subscribes to the
/// shared store but renders no logs/stats, and log bursts are the hottest
/// event in the app.
fn main_window_only(t: &tauri::EventTarget) -> bool {
    matches!(t, tauri::EventTarget::WebviewWindow { label } if label == "main")
}

pub fn push_log(app: &AppHandle, key: &str, line: LogLine) {
    let table = app.state::<ProcTable>();
    {
        let mut logs = table.logs.lock();
        let buf = logs.entry(key.to_string()).or_default();
        buf.push_back(line.clone());
        while buf.len() > LOG_CAP {
            buf.pop_front();
        }
    }
    persist_log_lines(app, key, std::slice::from_ref(&line));
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct LogEvent<'a> {
        svc_key: &'a str,
        lines: Vec<LogLine>,
    }
    let _ = app.emit_filter("service:log", &LogEvent { svc_key: key, lines: vec![line] }, main_window_only);
}

/// Cap for one on-disk service log before it rolls to `<name>.1.log`.
const SVC_LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;

/// Append log lines to a per-service file under `<app-log-dir>/services/`.
/// The in-memory ring keeps only LOG_CAP lines — a crash 500 lines in would
/// otherwise lose its own cause. Best-effort: log I/O never fails a service op.
fn persist_log_lines(app: &AppHandle, key: &str, lines: &[LogLine]) {
    use std::io::Write;
    let Ok(dir) = app.path().app_log_dir().map(|d| d.join("services")) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // svc_key is `<wt path>::<service id>` — flatten to a safe filename
    let name: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    let path = dir.join(format!("{name}.log"));
    // size-capped: roll the current file to `.1.log` (replacing the previous roll)
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > SVC_LOG_ROTATE_BYTES {
            let _ = std::fs::rename(&path, dir.join(format!("{name}.1.log")));
        }
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
    let mut out = String::new();
    for l in lines {
        out.push_str(&format!("{} [{}] {}\n", l.t, l.lv, l.text));
    }
    let _ = f.write_all(out.as_bytes());
}

/// Persist live service pgids so a crash can be swept on next launch. Unix-only:
/// on Windows the Job Object's KILL_ON_JOB_CLOSE makes the OS reap the tree when
/// Canopy dies, so there is nothing to persist or sweep.
#[cfg(unix)]
fn persist_orphans(app: &AppHandle) {
    use crate::settings::OrphanProc;
    let table = app.state::<ProcTable>();
    let orphans: Vec<OrphanProc> = table
        .procs
        .lock()
        .iter()
        .map(|(k, p)| OrphanProc {
            svc_key: k.clone(),
            pgid: crate::proc::group_key(&p.group) as i32,
            spawn_time_secs: p.started_unix,
        })
        .collect();
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.orphans = orphans;
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

#[cfg(windows)]
fn persist_orphans(_app: &AppHandle) {}

/// Resolve a service's config + worktree env (PORT etc.) from settings.
fn resolve_service(app: &AppHandle, key: &str) -> Result<(ServiceCfg, String, HashMap<String, String>), String> {
    let state = app.state::<AppState>();
    let tree = state.tree.read();
    for r in tree.iter() {
        for w in r.worktrees.iter() {
            for s in w.services.iter() {
                if s.svc_key == key {
                    let settings = state.settings.read();
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
        if table.procs.lock().contains_key(key) {
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
        .kill_on_drop(false);
    // isolate the child (+ its whole tree) in its own process group / job so we
    // can tear it all down on stop (see proc.rs)
    crate::proc::prepare_group_command(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        set_status(app, key, SvcStatus::Error, None, None);
        push_log(app, key, LogLine::now("err", format!("spawn failed: {e}")));
        format!("spawn failed: {e}")
    })?;

    let pid = child.id().unwrap_or(0);
    // establish the group (Windows: assigns the suspended child to a Job and
    // resumes it). On failure the child would linger — kill it and bail.
    let group = match crate::proc::attach_group(pid) {
        Ok(g) => g,
        Err(e) => {
            let _ = child.kill().await;
            set_status(app, key, SvcStatus::Error, None, None);
            push_log(app, key, LogLine::now("err", format!("group setup failed: {e}")));
            return Err(format!("group setup failed: {e}"));
        }
    };
    let started_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    let generation = {
        let table = app.state::<ProcTable>();
        let generation = table.next_gen();
        table.procs.lock().insert(
            key.to_string(),
            ProcEntry { pid, group, started_at: Instant::now(), started_unix, generation },
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
                let mut procs = table.procs.lock();
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
        let mut logs = table.logs.lock();
        let buf = logs.entry(key.to_string()).or_default();
        for l in batch.iter() {
            buf.push_back(l.clone());
        }
        while buf.len() > LOG_CAP {
            buf.pop_front();
        }
    }
    persist_log_lines(app, key, batch);
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct LogEvent<'a> {
        svc_key: &'a str,
        lines: Vec<LogLine>,
    }
    let _ = app.emit_filter("service:log", &LogEvent { svc_key: key, lines: std::mem::take(batch) }, main_window_only);
}

/// Case-insensitive substring search without allocating (the old
/// `to_lowercase()` copied every log line — thousands per webpack burst).
fn contains_ci(hay: &str, needle: &str) -> bool {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    !n.is_empty() && h.len() >= n.len() && h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
}

fn classify_line(text: &str, _from_stderr: bool) -> &'static str {
    if contains_ci(text, "error") || contains_ci(text, "fatal") || contains_ci(text, "err!") {
        "err"
    } else if contains_ci(text, "warn") {
        "warn"
    } else if contains_ci(text, "listening") || contains_ci(text, "compiled successfully") || contains_ci(text, "ready") {
        "ok"
    } else {
        // stderr alone isn't an error — many dev tools log normal output there
        "info"
    }
}

pub async fn stop_service(app: &AppHandle, key: &str) -> Result<(), String> {
    // graceful terminate under the lock (we need the group handle); capture the
    // generation so a restart during the grace window isn't hard-killed by us.
    let generation = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock();
        match procs.get(key) {
            Some(p) => {
                crate::proc::terminate_group(&p.group);
                p.generation
            }
            None => return Ok(()), // not running
        }
    };

    set_status(app, key, SvcStatus::Stopping, None, None);

    // grace period, then hard kill if the *same* process is still tracked
    let app2 = app.clone();
    let key2 = key.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STOP_GRACE).await;
        let table = app2.state::<ProcTable>();
        let procs = table.procs.lock();
        if let Some(p) = procs.get(&key2) {
            if p.generation == generation {
                crate::proc::kill_group(&p.group);
            }
        }
    });
    Ok(())
}

/// Wait up to `ticks * 150ms` for the waiter task to reap `key`.
async fn wait_reaped(app: &AppHandle, key: &str, ticks: u32) -> bool {
    for _ in 0..ticks {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let table = app.state::<ProcTable>();
        if !table.procs.lock().contains_key(key) {
            return true;
        }
    }
    false
}

pub async fn restart_service(app: &AppHandle, key: &str) -> Result<(), String> {
    let was_running = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock();
        procs.contains_key(key)
    };
    if was_running {
        push_log(app, key, LogLine::now("warn", "restarting…"));
        stop_service(app, key).await?;
        // stop() SIGTERMs now and SIGKILLs at the 3s grace mark; give the
        // waiter up to 6s to reap before escalating ourselves.
        if !wait_reaped(app, key, 40).await {
            {
                let table = app.state::<ProcTable>();
                let procs = table.procs.lock();
                if let Some(p) = procs.get(key) {
                    crate::proc::kill_group(&p.group);
                }
            }
            if !wait_reaped(app, key, 20).await {
                // start_service would see the stale entry and return Ok(())
                // doing nothing — the restart MUST fail loudly instead, or a
                // port/database change reports applied while the old process
                // keeps serving the old config.
                let msg = "restart failed: previous process did not exit (SIGKILL sent) — try again";
                push_log(app, key, LogLine::now("err", msg));
                return Err(msg.into());
            }
        }
    }
    start_service(app, key).await
}

/// Stop everything; returns once all process groups are reaped or grace expires.
pub async fn stop_all(app: &AppHandle) {
    let keys: Vec<String> = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock();
        procs.keys().cloned().collect()
    };
    for k in &keys {
        let _ = stop_service(app, k).await;
    }
    for _ in 0..40 {
        let table = app.state::<ProcTable>();
        let empty = table.procs.lock().is_empty();
        if empty {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Worktree-level: collect svc keys of one worktree.
pub fn worktree_svc_keys(app: &AppHandle, wt_key: &str) -> Vec<String> {
    app.state::<AppState>().wt_service_keys(wt_key)
}

/// Reset DB: runs the repo's resetDb command in the worktree root; output goes
/// to the first server-kind service's log buffer.
pub async fn reset_db(app: &AppHandle, wt_key: &str) -> Result<(), String> {
    let (cmd_str, log_key) = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        let settings = state.settings.read();
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

    // concurrency guard: the command layer holds the per-worktree OpLease
    // (state::try_lease) for the whole reset — no separate flag needed.

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
/// (avoids killing a recycled PID). Unix-only — on Windows KILL_ON_JOB_CLOSE
/// makes the OS reap the tree when Canopy dies, so there are no orphans to sweep.
#[cfg(unix)]
pub fn sweep_orphans(app: &AppHandle) {
    let orphans = {
        let state = app.state::<AppState>();
        let rt = state.runtime.read();
        rt.orphans.clone()
    };
    for o in &orphans {
        if o.pgid <= 1 {
            continue;
        }
        let alive = unsafe { libc::killpg(o.pgid, 0) == 0 };
        if alive && proc_start_time_matches(o.pgid as u32, o.spawn_time_secs) {
            log::warn!("sweeping orphan pgid {} ({})", o.pgid, o.svc_key);
            unsafe {
                libc::killpg(o.pgid, libc::SIGTERM);
            }
        }
    }
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.orphans.clear();
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

#[cfg(windows)]
pub fn sweep_orphans(_app: &AppHandle) {}

/// Compare recorded spawn time against the process's actual start time (±5s).
/// This is the guard against PID recycling: after a reboot (or enough process
/// churn) the persisted pgid can belong to an unrelated process — the sweep
/// must never SIGTERM that. Unix-only; only the Unix crash sweep calls it.
#[cfg(unix)]
pub(crate) fn proc_start_time_matches(pid: u32, recorded_secs: u64) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        false,
        ProcessRefreshKind::nothing(),
    );
    let Some(p) = sys.process(Pid::from_u32(pid)) else { return false };
    let actual = p.start_time(); // seconds since the epoch
    // an unreadable start time (0) fails the match — skipping a sweep is safe,
    // killing an innocent process group is not
    actual != 0 && actual.abs_diff(recorded_secs) <= 5
}

#[cfg(test)]
mod tests {
    use super::classify_line;

    /// The PID-recycling guard must recognize a live process's real start time
    /// (this also proves sysinfo delivers a non-zero start_time on this OS —
    /// the guard fails closed to "no match" when it can't read one).
    #[test]
    #[cfg(unix)]
    fn own_process_start_time_matches_itself() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let pid = std::process::id();
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
            false,
            ProcessRefreshKind::nothing(),
        );
        let start = sys.process(Pid::from_u32(pid)).map(|p| p.start_time()).unwrap_or(0);
        assert!(start > 0, "sysinfo must expose a start time");
        assert!(super::proc_start_time_matches(pid, start), "exact start time matches");
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!(!super::proc_start_time_matches(pid, now + 3600), "wrong time must not match");
    }

    #[test]
    fn classifies_log_levels() {
        assert_eq!(classify_line("Error: boom", false), "err");
        assert_eq!(classify_line("npm WARN deprecated", false), "warn");
        assert_eq!(classify_line("webpack compiled successfully", false), "ok");
        assert_eq!(classify_line("Listening on :3000", true), "ok");
        assert_eq!(classify_line("plain build output", true), "info", "stderr alone isn't an error");
    }
}
