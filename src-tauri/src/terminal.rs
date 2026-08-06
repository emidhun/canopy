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
#[cfg(unix)]
use crate::settings::TermOrphan;
// only the Unix orphan persist/sweep reads app state — on Windows the Job
// Object reaps the tree, so both are stubs and this import would be unused
#[cfg(unix)]
use crate::state::AppState;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::Mutex;
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
    /// Behind its own Arc<Mutex> so a write blocked by a stalled child (full
    /// PTY buffer) doesn't hold the sessions table lock — the reader thread
    /// needs that lock to drain the master, which is what unblocks the write.
    writer: std::sync::Arc<Mutex<Box<dyn Write + Send>>>,
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
    /// child pgid (session leader) + spawn time, persisted for the Unix
    /// crash-orphan sweep. On Windows there is no sweep (portable-pty's ConPTY
    /// child is killed directly), so these go unread there.
    #[allow(dead_code)]
    pgid: i32,
    #[allow(dead_code)]
    started_unix: u64,
}

/// The final scrollback of a session whose process has exited, kept so the UI
/// can still show what it printed. The PTY, child and reader are all gone by
/// then — this is just bytes.
struct ExitedBuffer {
    scrollback: Vec<u8>,
    seq: u64,
    at: Instant,
}

/// How many exited sessions keep their output. Past this the oldest is dropped,
/// so a long session of starting and stopping agents can't grow without bound.
const EXITED_CAP: usize = 24;

#[derive(Default)]
pub struct TermTable {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    /// scrollback of exited sessions, by id (see `ExitedBuffer`)
    exited: Mutex<HashMap<String, ExitedBuffer>>,
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


/// Terminal bytes go to the windows that render terminals: the main window
/// and detached `term-*` windows — never the popover.
fn terminal_windows(t: &tauri::EventTarget) -> bool {
    matches!(t, tauri::EventTarget::WebviewWindow { label }
        if label == "main" || label.starts_with("term-"))
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The kind of a session id — `"agent"` or `"shell"`. A worktree holds any
/// number of each, so ids carry an instance suffix (`…::agent#3`); the wtKey is
/// a filesystem path and never contains `::`, so the last segment is the kind.
/// Ids from before multi-session (`…::agent`) parse the same way.
fn kind_of(id: &str) -> &str {
    let last = id.rsplit("::").next().unwrap_or("");
    last.split('#').next().unwrap_or("")
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
    let mut sessions = table.sessions.lock();
    if sessions.contains_key(id) {
        return Ok(()); // already running — idempotent attach
    }
    // A restart reuses the id; the previous run's retained output would
    // otherwise be replayed as though the new process had printed it.
    table.exited.lock().remove(id);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // login shell (nvm/asdf/volta + user PATH initialize); honor a worktree's
    // pinned Node the same way spawned services do.
    let shell = crate::toolchain::user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    let name = std::path::Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    // on Windows the shell is `bash.exe`; normalize so the family checks below
    // (login flag, and the `-i` interactive flag) match as they do on Unix
    let name = name.strip_suffix(".exe").unwrap_or(name);
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
    // Every agent profile can read the same durable handoff even when it opts
    // out of positional prompts because its CLI has a different interface.
    if kind_of(id) == "agent" {
        cmd.env("CANOPY_CONTEXT_FILE", std::path::Path::new(cwd).join(".canopy/context.md"));
        cmd.env("CANOPY_WORKTREE", cwd);
    }
    if let Some(bin) = crate::toolchain::pinned_node_bin(cwd) {
        // prepend to PATH using the OS separator (';' on Windows, ':' elsewhere)
        // and native path form — this is the process env bash.exe inherits, not a
        // bash-internal PATH string.
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs = vec![std::path::PathBuf::from(&bin)];
        dirs.extend(std::env::split_paths(&existing));
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn failed: {e}"))?;
    // the parent doesn't need the slave handle; dropping it lets EOF propagate
    // when the shell/command exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader clone failed: {e}"))?;
    let writer = std::sync::Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| format!("writer failed: {e}"))?,
    ));

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
                    let mut ours = false;
                    if let Some(table) = app.try_state::<TermTable>() {
                        if let Some(sess) = table.sessions.lock().get_mut(&id) {
                            // Same generation guard the exit path uses: a restart
                            // reopens this id, and bytes this (now stale) reader
                            // drains afterwards must not be appended to — or
                            // emitted as — the replacement session's output.
                            if sess.generation == generation {
                                sess.scrollback.extend(chunk.iter().copied());
                                let overflow = sess.scrollback.len().saturating_sub(SCROLLBACK_CAP);
                                if overflow > 0 {
                                    sess.scrollback.drain(0..overflow);
                                }
                                sess.seq += n as u64;
                                sess.last_activity = Instant::now();
                                seq = sess.seq;
                                ours = true;
                            }
                        }
                    }
                    // Skip the emit while nothing is on screen: base64 + JSON +
                    // waking a hidden webview per chunk is pure waste. The
                    // scrollback + seq advanced above regardless, and the UI
                    // resyncs from the snapshot on show / on the next chunk's
                    // seq-gap check — the same race-free cursor rehydrate
                    // mechanism it already uses on mount.
                    if ours && crate::windows_visible() {
                        let _ = app.emit_filter("terminal:data", &DataEvent { id: &id, data: b64(chunk), seq }, terminal_windows);
                    }
                }
                Err(_) => break,
            }
        }
        // session ended: drop it and tell the UI — but only if a newer session
        // hasn't already replaced this id (fast reopen), else we'd delete the
        // replacement and emit a false exit.
        let removed = if let Some(table) = app.try_state::<TermTable>() {
            let mut sessions = table.sessions.lock();
            match sessions.get(&id) {
                Some(s) if s.generation == generation => {
                    // Keep what it printed: the UI shows an exited tab read-only
                    // until it's closed or restarted, and without this the output
                    // would die with the session the moment the process ended.
                    let sess = sessions.remove(&id).unwrap();
                    let mut exited = table.exited.lock();
                    if exited.len() >= EXITED_CAP {
                        if let Some(oldest) = exited.iter().min_by_key(|(_, b)| b.at).map(|(k, _)| k.clone()) {
                            exited.remove(&oldest);
                        }
                    }
                    exited.insert(
                        id.clone(),
                        ExitedBuffer { scrollback: sess.scrollback.into_iter().collect(), seq: sess.seq, at: Instant::now() },
                    );
                    true
                }
                _ => false,
            }
        } else {
            false
        };
        if removed {
            persist_orphans(&app);
            let _ = app.emit_filter("terminal:exit", &ExitEvent { id: &id }, terminal_windows);
        }
    });

    Ok(())
}

/// Write user input (keystrokes, or a command the UI injects such as the agent
/// CLI) to a session.
pub fn write(table: &TermTable, id: &str, data: &str) -> Result<(), String> {
    // clone the writer handle out, then release the table lock BEFORE the
    // (potentially blocking) write — see the field comment on `writer`.
    let writer = {
        let mut sessions = table.sessions.lock();
        let sess = sessions.get_mut(id).ok_or("no such terminal")?;
        sess.last_activity = Instant::now();
        sess.writer.clone()
    };
    let mut w = writer.lock();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Resize a session's PTY (xterm's fit addon drives this).
pub fn resize(table: &TermTable, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = table.sessions.lock();
    let sess = sessions.get(id).ok_or("no such terminal")?;
    sess.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Scrollback snapshot + its end cursor, for a re-mounting window to rehydrate.
/// Falls back to the retained buffer of an exited session, so a tab that ended
/// while its worktree wasn't selected can still be read. `None` only when the id
/// was never opened (or has since been closed).
pub fn get_buffer(table: &TermTable, id: &str) -> Option<BufferSnapshot> {
    if let Some(s) = table.sessions.lock().get(id) {
        let bytes: Vec<u8> = s.scrollback.iter().copied().collect();
        return Some(BufferSnapshot { buffer: b64(&bytes), seq: s.seq });
    }
    table
        .exited
        .lock()
        .get(id)
        .map(|b| BufferSnapshot { buffer: b64(&b.scrollback), seq: b.seq })
}

/// Kill and drop a session, including any retained output — closing a tab is the
/// point at which the user is done with it.
pub fn close(table: &TermTable, id: &str) {
    if let Some(mut sess) = table.sessions.lock().remove(id) {
        let _ = sess.child.kill();
    }
    table.exited.lock().remove(id);
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
    let ids: Vec<String> = table.sessions.lock().keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    for id in &ids {
        close(table, id);
    }
    table.exited.lock().retain(|k, _| !k.starts_with(&prefix));
    if !ids.is_empty() {
        persist_orphans(app);
    }
}

/// Kill every session (app quit).
pub fn close_all(table: &TermTable) {
    let mut sessions = table.sessions.lock();
    for (_, mut sess) in sessions.drain() {
        let _ = sess.child.kill();
    }
    table.exited.lock().clear();
}

/// Snapshot live sessions' pgids into persisted runtime state, so a crash can be
/// cleaned up on next launch (mirrors the service orphan sweep). Unix-only — see
/// `sweep_orphans`.
#[cfg(unix)]
fn persist_orphans(app: &AppHandle) {
    let table = app.state::<TermTable>();
    let orphans: Vec<TermOrphan> = table
        .sessions
        .lock()
        .iter()
        .map(|(id, s)| TermOrphan { id: id.clone(), pgid: s.pgid, spawn_time_secs: s.started_unix })
        .collect();
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.terminal_orphans = orphans;
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

#[cfg(windows)]
fn persist_orphans(_app: &AppHandle) {}

/// Startup: kill terminal process groups left over from a crashed previous run
/// (only when the group leader still exists and its start time matches). Unix-only
/// — on Windows portable-pty's ConPTY child is killed directly and there is no
/// pgid to sweep (a documented limitation: PTY grandchildren may linger).
#[cfg(windows)]
pub fn sweep_orphans(_app: &AppHandle) {}

#[cfg(unix)]
pub fn sweep_orphans(app: &AppHandle) {
    let orphans = {
        let state = app.state::<AppState>();
        let rt = state.runtime.read();
        rt.terminal_orphans.clone()
    };
    for o in &orphans {
        if o.pgid <= 1 {
            continue;
        }
        let alive = unsafe { libc::killpg(o.pgid, 0) == 0 };
        if alive && crate::services::proc_start_time_matches(o.pgid as u32, o.spawn_time_secs) {
            log::warn!("sweeping terminal orphan pgid {} ({})", o.pgid, o.id);
            unsafe {
                libc::killpg(o.pgid, libc::SIGTERM);
            }
        }
    }
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.terminal_orphans.clear();
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

/// Sweep idle SHELL sessions (bounds long-run resource growth). Killing the
/// child makes its reader hit EOF, which removes the session and emits
/// `terminal:exit`. Agent sessions are exempt — a quiet agent may just be
/// waiting for the user, and killing it would lose work.
pub fn sweep_idle(app: &AppHandle, table: &TermTable) {
    // Per-repo agent timeout, keyed by the repo's worktree paths. Resolved
    // once per sweep rather than per session — the sweep runs every 5 minutes
    // and this is two lock acquisitions instead of one per open terminal.
    let agent_limits: HashMap<String, Duration> = app
        .try_state::<AppState>()
        .map(|state| {
            let settings = state.settings.read();
            let tree = state.tree.read();
            tree.iter()
                .filter_map(|r| {
                    let mins = settings.repos.iter().find(|c| c.id == r.repo_id)?.agent_idle_timeout_min;
                    (mins > 0).then(|| {
                        r.worktrees
                            .iter()
                            .map(|w| (w.wt_key.clone(), Duration::from_secs(mins as u64 * 60)))
                            .collect::<Vec<_>>()
                    })
                })
                .flatten()
                .collect()
        })
        .unwrap_or_default();

    let mut sessions = table.sessions.lock();
    for (id, sess) in sessions.iter_mut() {
        let kind = kind_of(id);
        if kind == "shell" && sess.last_activity.elapsed() > IDLE_LIMIT {
            let _ = sess.child.kill();
            continue;
        }
        // Agents are exempt unless the repo opted in: a quiet agent may just
        // be waiting for the user, and killing it loses work. Only an explicit
        // per-repo timeout overrides that.
        if kind == "agent" {
            let wt = id.rsplit_once("::").map(|(w, _)| w).unwrap_or("");
            if let Some(limit) = agent_limits.get(wt) {
                if sess.last_activity.elapsed() > *limit {
                    log::info!("closing idle agent {id} after {}s", limit.as_secs());
                    let _ = sess.child.kill();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{b64, kind_of};

    /// TerminalPane detects missed chunks (emits skipped while hidden) by
    /// computing each chunk's decoded length WITHOUT decoding it:
    /// `len/4*3 - padding`. That formula is only correct while this encoder
    /// emits standard, unwrapped base64 — pin the contract on the Rust side
    /// so a future encoder change can't silently break the frontend gap math.
    #[test]
    fn b64_length_formula_matches_frontend_gap_math() {
        for n in 0..=9usize {
            let s = b64(&vec![0xAB; n]);
            assert!(!s.contains('\n') && !s.contains('\r'), "must be unwrapped: {s:?}");
            let pad = if s.ends_with("==") {
                2
            } else if s.ends_with('=') {
                1
            } else {
                0
            };
            assert_eq!(s.len() / 4 * 3 - pad, n, "n={n} s={s}");
        }
    }

    #[test]
    fn kind_of_reads_multi_session_ids() {
        assert_eq!(kind_of("/Users/me/wt/feature#1::agent#3"), "agent");
        assert_eq!(kind_of("/Users/me/wt/feature#1::shell#12"), "shell");
        // ids carry a per-launch nonce so a webview reload can't reuse one
        assert_eq!(kind_of("/Users/me/wt/x::agent#mfz1a2b-4"), "agent");
        assert_eq!(kind_of("/Users/me/wt/x::shell#mfz1a2b-11"), "shell");
        // ids written before multi-session carried no instance suffix
        assert_eq!(kind_of("/Users/me/wt/feature::agent"), "agent");
        assert_eq!(kind_of("/Users/me/wt/feature::shell"), "shell");
        assert_eq!(kind_of("nonsense"), "nonsense");
    }
}
