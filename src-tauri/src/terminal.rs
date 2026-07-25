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
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Per-session scrollback cap (bytes). Big enough for a screenful of history on
/// rehydrate, small enough to stay cheap across many idle worktrees.
const SCROLLBACK_CAP: usize = 256 * 1024;
const READ_CHUNK: usize = 8 * 1024;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// raw byte scrollback, capped at SCROLLBACK_CAP
    scrollback: VecDeque<u8>,
}

#[derive(Default)]
pub struct TermTable {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DataEvent<'a> {
    id: &'a str,
    /// base64 of the raw PTY bytes (raw bytes aren't guaranteed valid UTF-8)
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent<'a> {
    id: &'a str,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Open (or no-op if already open) a terminal session `id` running an interactive
/// login shell in `cwd`. `cols`/`rows` size the initial PTY.
pub fn open(app: &AppHandle, table: &TermTable, id: &str, cwd: &str, cols: u16, rows: u16) -> Result<(), String> {
    {
        let sessions = table.sessions.lock().unwrap();
        if sessions.contains_key(id) {
            return Ok(()); // already running
        }
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // interactive login shell (nvm/asdf/volta + user PATH initialize); honor a
    // worktree's pinned Node the same way spawned services do.
    let shell = crate::toolchain::user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    let name = std::path::Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    if !matches!(name, "sh" | "dash") {
        cmd.arg("-l");
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    if let Some(bin) = crate::toolchain::pinned_node_bin(cwd) {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{bin}:{path}"));
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn failed: {e}"))?;
    // the parent doesn't need the slave handle; dropping it lets EOF propagate
    // when the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader clone failed: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer failed: {e}"))?;

    {
        let mut sessions = table.sessions.lock().unwrap();
        sessions.insert(
            id.to_string(),
            PtySession { master: pair.master, writer, child, scrollback: VecDeque::new() },
        );
    }

    // reader loop on a dedicated thread: PTY reads are blocking byte I/O.
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell exited / pty closed
                Ok(n) => {
                    let chunk = &buf[..n];
                    // append to the session's scrollback (capped)
                    if let Some(table) = app.try_state::<TermTable>() {
                        if let Some(sess) = table.sessions.lock().unwrap().get_mut(&id) {
                            sess.scrollback.extend(chunk.iter().copied());
                            let overflow = sess.scrollback.len().saturating_sub(SCROLLBACK_CAP);
                            if overflow > 0 {
                                sess.scrollback.drain(0..overflow);
                            }
                        }
                    }
                    let _ = app.emit("terminal:data", &DataEvent { id: &id, data: b64(chunk) });
                }
                Err(_) => break,
            }
        }
        // session ended: drop it and tell the UI
        if let Some(table) = app.try_state::<TermTable>() {
            table.sessions.lock().unwrap().remove(&id);
        }
        let _ = app.emit("terminal:exit", &ExitEvent { id: &id });
    });

    Ok(())
}

/// Write user input (keystrokes, or a command the UI injects such as the agent
/// CLI) to a session.
pub fn write(table: &TermTable, id: &str, data: &str) -> Result<(), String> {
    let mut sessions = table.sessions.lock().unwrap();
    let sess = sessions.get_mut(id).ok_or("no such terminal")?;
    sess.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
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

/// Base64 of a session's whole scrollback, for a re-mounting window to rehydrate.
/// `None` when the session doesn't exist (never opened, or exited).
pub fn get_buffer(table: &TermTable, id: &str) -> Option<String> {
    let sessions = table.sessions.lock().unwrap();
    sessions.get(id).map(|s| {
        let bytes: Vec<u8> = s.scrollback.iter().copied().collect();
        b64(&bytes)
    })
}

/// Kill and drop a session.
pub fn close(table: &TermTable, id: &str) {
    if let Some(mut sess) = table.sessions.lock().unwrap().remove(id) {
        let _ = sess.child.kill();
    }
}

/// Kill every session (app quit).
pub fn close_all(table: &TermTable) {
    let mut sessions = table.sessions.lock().unwrap();
    for (_, mut sess) in sessions.drain() {
        let _ = sess.child.kill();
    }
}
