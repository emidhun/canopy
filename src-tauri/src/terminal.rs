// Embedded per-worktree terminals.
//
// Each session is a real PTY running the user's login shell in a worktree's
// directory — the foundation for the agent lane, where the configured coding
// agent CLI runs inside a shell just like anything else the user types.
//
// Model mirrors `services.rs`: a table of sessions keyed by an opaque id, with a
// capped scrollback ring buffer per session so a late-joining or re-mounting
// window can rehydrate. Where a service is spawned over pipes and read *by line*
// on the async runtime, a PTY is raw, bidirectional, byte-oriented I/O — so the
// read loop lives on a dedicated std thread and streams `terminal:data` events.
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use crate::settings::TermOrphan;
use crate::state::AppState;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Per-session scrollback cap (bytes). Big enough for a screenful of history on
/// rehydrate, small enough to stay cheap across many idle worktrees.
const SCROLLBACK_CAP: usize = 256 * 1024;
/// Idle shell sessions past this are swept (bounds long-run memory/threads over,
/// e.g., an overnight run of visiting many worktrees). Agents are exempt.
const IDLE_LIMIT: Duration = Duration::from_secs(60 * 60);
// a read() returns whatever bytes are already available (up to this size), so a
// larger buffer coalesces bursts into fewer events — fewer base64/JSON emits
// under heavy output, with no added latency for small writes.
const READ_CHUNK: usize = 32 * 1024;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// raw byte scrollback, capped at SCROLLBACK_CAP
    scrollback: VecDeque<u8>,
    /// total bytes ever emitted for this session (monotonic). Lets a re-mounting
    /// window rehydrate without double-rendering: it replays the snapshot up to
    /// this cursor and applies only later `terminal:data` events.
    seq: u64,
    /// last output or input time, for idle sweeping
    last_activity: Instant,
    /// generation guard: a fast reopen under the same id bumps this so a stale
    /// reader thread doesn't remove/exit the replacement session.
    generation: u64,
    /// child pgid (session leader) + spawn time, persisted for crash-orphan sweep
    pgid: i32,
    started_unix: u64,
}

#[derive(Default)]
pub struct TermTable {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    next_gen: AtomicU64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DataEvent<'a> {
    id: &'a str,
    /// base64 of the raw PTY bytes (raw bytes aren't guaranteed valid UTF-8)
    data: String,
    /// cumulative byte cursor *after* this chunk
    seq: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent<'a> {
    id: &'a str,
}

/// Scrollback snapshot + the byte cursor it ends at (for race-free rehydrate).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BufferSnapshot {
    pub buffer: String,
    pub seq: u64,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Open (or no-op if already open) a terminal session `id` in `cwd`. With no
/// `command` it runs an interactive login shell; with one it runs that command
/// under a login shell (so the session ends — firing `terminal:exit` — when the
/// command exits, which is how the agent lane tracks agent lifecycle).
///
/// The whole check→spawn→insert runs under the sessions lock so two concurrent
/// attaches for one id (StrictMode remount, pop-out) can't both spawn.
pub fn open(
    app: &AppHandle,
    table: &TermTable,
    id: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<(), String> {
    let mut sessions = table.sessions.lock().unwrap();
    if sessions.contains_key(id) {
        return Ok(()); // already running — idempotent attach
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // login shell (nvm/asdf/volta + user PATH initialize); honor a worktree's
    // pinned Node the same way spawned services do.
    let shell = crate::toolchain::user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    let name = std::path::Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    if !matches!(name, "sh" | "dash") {
        cmd.arg("-l");
    }
    if let Some(c) = command.as_deref().filter(|c| !c.trim().is_empty()) {
        // A bare login shell on a PTY is interactive (so it sources .zshrc /
        // .bashrc), but `-c` is NOT — user aliases/functions and rc-only PATH
        // wouldn't resolve (e.g. an agent aliased in .zshrc). Force interactive
        // for bash/zsh so the agent command runs like it would when typed.
        if matches!(name, "zsh" | "bash") {
            cmd.arg("-i");
        }
        cmd.arg("-c");
        cmd.arg(c);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    if let Some(bin) = crate::toolchain::pinned_node_bin(cwd) {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{bin}:{path}"));
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn failed: {e}"))?;
    // the parent doesn't need the slave handle; dropping it lets EOF propagate
    // when the shell/command exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader clone failed: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer failed: {e}"))?;

    // the child is its own session leader (the pty setsid's it), so pid == pgid
    let pgid = child.process_id().unwrap_or(0) as i32;
    let started_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let generation = table.next_gen.fetch_add(1, Ordering::Relaxed) + 1;

    sessions.insert(
        id.to_string(),
        PtySession {
            master: pair.master,
            writer,
            child,
            scrollback: VecDeque::new(),
            seq: 0,
            last_activity: Instant::now(),
            generation,
            pgid,
            started_unix,
        },
    );
    drop(sessions); // release before spawning the reader thread
    persist_orphans(app); // record for the crash-orphan sweep

    // reader loop on a dedicated thread: PTY reads are blocking byte I/O.
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell/command exited / pty closed
                Ok(n) => {
                    let chunk = &buf[..n];
                    // append to scrollback and advance the cursor atomically, so
                    // the emitted seq always matches a chunk boundary.
                    let mut seq = 0;
                    if let Some(table) = app.try_state::<TermTable>() {
                        if let Some(sess) = table.sessions.lock().unwrap().get_mut(&id) {
                            sess.scrollback.extend(chunk.iter().copied());
                            let overflow = sess.scrollback.len().saturating_sub(SCROLLBACK_CAP);
                            if overflow > 0 {
                                sess.scrollback.drain(0..overflow);
                            }
                            sess.seq += n as u64;
                            sess.last_activity = Instant::now();
                            seq = sess.seq;
                        }
                    }
                    let _ = app.emit("terminal:data", &DataEvent { id: &id, data: b64(chunk), seq });
                }
                Err(_) => break,
            }
        }
        // session ended: drop it and tell the UI — but only if a newer session
        // hasn't already replaced this id (fast reopen), else we'd delete the
        // replacement and emit a false exit.
        let removed = if let Some(table) = app.try_state::<TermTable>() {
            let mut sessions = table.sessions.lock().unwrap();
            match sessions.get(&id) {
                Some(s) if s.generation == generation => {
                    sessions.remove(&id);
                    true
                }
                _ => false,
            }
        } else {
            false
        };
        if removed {
            persist_orphans(&app);
            let _ = app.emit("terminal:exit", &ExitEvent { id: &id });
        }
    });

    Ok(())
}

/// Write user input (keystrokes, or a command the UI injects such as the agent
/// CLI) to a session.
pub fn write(table: &TermTable, id: &str, data: &str) -> Result<(), String> {
    let mut sessions = table.sessions.lock().unwrap();
    let sess = sessions.get_mut(id).ok_or("no such terminal")?;
    sess.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    sess.last_activity = Instant::now();
    sess.writer.flush().map_err(|e| e.to_string())
}

/// Resize a session's PTY (xterm's fit addon drives this).
pub fn resize(table: &TermTable, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = table.sessions.lock().unwrap();
    let sess = sessions.get(id).ok_or("no such terminal")?;
    sess.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Scrollback snapshot + its end cursor, for a re-mounting window to rehydrate.
/// `None` when the session doesn't exist (never opened, or exited).
pub fn get_buffer(table: &TermTable, id: &str) -> Option<BufferSnapshot> {
    let sessions = table.sessions.lock().unwrap();
    sessions.get(id).map(|s| {
        let bytes: Vec<u8> = s.scrollback.iter().copied().collect();
        BufferSnapshot { buffer: b64(&bytes), seq: s.seq }
    })
}

/// Kill and drop a session.
pub fn close(table: &TermTable, id: &str) {
    if let Some(mut sess) = table.sessions.lock().unwrap().remove(id) {
        let _ = sess.child.kill();
    }
}

/// Close a session and refresh the persisted orphan list (command path).
pub fn close_and_persist(app: &AppHandle, table: &TermTable, id: &str) {
    close(table, id);
    persist_orphans(app);
}

/// Close every terminal belonging to a worktree (called before it's removed, so
/// no shell/agent lingers with no UI to stop it).
pub fn close_worktree(app: &AppHandle, table: &TermTable, wt_key: &str) {
    let prefix = format!("{wt_key}::");
    let ids: Vec<String> = table.sessions.lock().unwrap().keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    for id in &ids {
        close(table, id);
    }
    if !ids.is_empty() {
        persist_orphans(app);
    }
}

/// Kill every session (app quit).
pub fn close_all(table: &TermTable) {
    let mut sessions = table.sessions.lock().unwrap();
    for (_, mut sess) in sessions.drain() {
        let _ = sess.child.kill();
    }
}

/// Snapshot live sessions' pgids into persisted runtime state, so a crash can be
/// cleaned up on next launch (mirrors the service orphan sweep).
fn persist_orphans(app: &AppHandle) {
    let table = app.state::<TermTable>();
    let orphans: Vec<TermOrphan> = table
        .sessions
        .lock()
        .unwrap()
        .iter()
        .map(|(id, s)| TermOrphan { id: id.clone(), pgid: s.pgid, spawn_time_secs: s.started_unix })
        .collect();
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write().unwrap();
        rt.terminal_orphans = orphans;
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

/// Startup: kill terminal process groups left over from a crashed previous run
/// (only when the group leader still exists and its start time matches).
pub fn sweep_orphans(app: &AppHandle) {
    let orphans = {
        let state = app.state::<AppState>();
        let rt = state.runtime.read().unwrap();
        rt.terminal_orphans.clone()
    };
    for o in &orphans {
        if o.pgid <= 1 {
            continue;
        }
        let alive = unsafe { libc::killpg(o.pgid, 0) == 0 };
        if alive && crate::services::proc_start_time_matches(o.pgid as u32, o.spawn_time_secs) {
            eprintln!("[wtm] sweeping terminal orphan pgid {} ({})", o.pgid, o.id);
            unsafe {
                libc::killpg(o.pgid, libc::SIGTERM);
            }
        }
    }
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write().unwrap();
        rt.terminal_orphans.clear();
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

/// Sweep idle SHELL sessions (bounds long-run resource growth). Killing the
/// child makes its reader hit EOF, which removes the session and emits
/// `terminal:exit`. Agent sessions are exempt — a quiet agent may just be
/// waiting for the user, and killing it would lose work.
pub fn sweep_idle(table: &TermTable) {
    let mut sessions = table.sessions.lock().unwrap();
    for (id, sess) in sessions.iter_mut() {
        if id.ends_with("::shell") && sess.last_activity.elapsed() > IDLE_LIMIT {
            let _ = sess.child.kill();
        }
    }
}
