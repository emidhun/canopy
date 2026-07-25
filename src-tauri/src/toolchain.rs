// Respect a project's pinned Node version when spawning commands.
//
// Repos pin Node via .nvmrc / .node-version (nvm/fnm convention) or
// .tool-versions (asdf). A login shell only honors the pin if the user's
// version manager is configured for that file — e.g. asdf ignores .nvmrc
// unless legacy_version_file is on, so a ToolJet worktree resolves the asdf
// *global* Node instead of the pinned one, and engine-strict installs fail.
//
// We locate the pinned version's actual bin dir (asdf or nvm install) and, if
// found, prepend it inside the spawned command so it wins after profile init.
use std::path::Path;

fn read_pin(dir: &Path) -> Option<String> {
    for f in [".nvmrc", ".node-version"] {
        if let Ok(v) = std::fs::read_to_string(dir.join(f)) {
            let v = v.trim().trim_start_matches('v').to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    if let Ok(tv) = std::fs::read_to_string(dir.join(".tool-versions")) {
        for line in tv.lines() {
            if let Some(rest) = line.trim().strip_prefix("nodejs ") {
                let v = rest.trim().trim_start_matches('v').to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// The user's home directory. `$HOME` on Unix; `%USERPROFILE%` (with `$HOME`
/// honored if a shell like Git Bash set it) on Windows.
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
}

fn bin_for_version(version: &str) -> Option<String> {
    let home = home_dir()?;
    // `mut` is only exercised under cfg(windows) where extra candidates are pushed
    #[allow(unused_mut)]
    let mut candidates = vec![
        format!("{home}/.asdf/installs/nodejs/{version}/bin"),
        format!("{home}/.asdf/installs/nodejs/v{version}/bin"),
        format!("{home}/.nvm/versions/node/v{version}/bin"),
        format!("{home}/.local/share/fnm/node-versions/v{version}/installation/bin"),
    ];
    #[cfg(target_os = "windows")]
    {
        // nvm-windows drops node.exe directly under %APPDATA%\nvm\vX (no bin/);
        // fnm and Volta keep their own layouts under %LOCALAPPDATA%.
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\nvm\\v{version}"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!("{local}\\fnm\\node-versions\\v{version}\\installation"));
            candidates.push(format!("{local}\\Volta\\tools\\image\\node\\{version}"));
        }
    }
    candidates.into_iter().find(|c| {
        let p = Path::new(c);
        p.join("node").exists() || p.join("node.exe").exists()
    })
}

/// Convert a native path into a form the command shell accepts on PATH. On
/// Windows commands run through Git Bash, whose PATH wants MSYS form
/// (`C:\Users\me` → `/c/Users/me`); elsewhere it's the identity.
#[cfg(target_os = "windows")]
pub(crate) fn bash_path(p: &str) -> String {
    let p = p.replace('\\', "/");
    if let Some((drive, rest)) = p.split_once(":/") {
        if drive.len() == 1 {
            return format!("/{}/{}", drive.to_lowercase(), rest);
        }
    }
    p
}
#[cfg(not(target_os = "windows"))]
pub(crate) fn bash_path(p: &str) -> String {
    p.to_string()
}

/// Walk up from `dir` looking for a Node pin; return the bin dir of that version
/// if it's installed locally. None if unpinned or the version isn't installed.
pub fn pinned_node_bin(dir: &str) -> Option<String> {
    let mut cur = Some(Path::new(dir));
    while let Some(d) = cur {
        if let Some(v) = read_pin(d) {
            return bin_for_version(&v);
        }
        cur = d.parent();
    }
    None
}

/// Wrap a command so the worktree's pinned Node bin is first on PATH. The
/// prepend runs after the login shell's profile, so it wins over asdf/nvm shims.
pub fn with_pinned_node(cwd: &str, command: &str) -> String {
    match pinned_node_bin(cwd) {
        Some(bin) => format!("export PATH=\"{}:$PATH\"; {command}", bash_path(&bin)),
        None => command.to_string(),
    }
}

/// The shell Canopy runs commands through. Honors `$SHELL` (so bash/fish/etc.
/// users get their own shell + profile), falling back to zsh on macOS, Git Bash
/// on Windows, and sh on other Unix. Commands run as a *login* shell so version
/// managers (nvm/asdf/volta) and the user's PATH are initialized.
pub fn user_shell() -> String {
    if let Some(s) = std::env::var("SHELL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && Path::new(s).exists())
    {
        return s;
    }
    default_shell()
}

#[cfg(target_os = "windows")]
fn default_shell() -> String {
    // Windows runs commands through Git for Windows' bash, keeping the whole
    // POSIX execution model (&&, pipes, export, quoting) working unchanged.
    find_git_bash().unwrap_or_else(|| "bash.exe".into())
}
#[cfg(target_os = "macos")]
fn default_shell() -> String {
    "/bin/zsh".into()
}
#[cfg(all(unix, not(target_os = "macos")))]
fn default_shell() -> String {
    "/bin/sh".into()
}

/// Locate Git for Windows' `bash.exe`. `$SHELL` in Git Bash is an MSYS virtual
/// path (`/usr/bin/bash`) that a native process can't stat, so probe the known
/// install locations, then fall back to `where bash`.
#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(p) = std::env::var(var) {
            candidates.push(format!("{p}\\Git\\bin\\bash.exe"));
        }
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!("{la}\\Programs\\Git\\bin\\bash.exe"));
    }
    for c in &candidates {
        if Path::new(c).exists() {
            return Some(c.clone());
        }
    }
    if let Ok(out) = std::process::Command::new("where").arg("bash").output() {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let line = line.trim();
                if !line.is_empty() {
                    return Some(line.to_string());
                }
            }
        }
    }
    None
}

/// Build `(shell, argv)` to run `cmdline` through the user's shell. Flags are
/// chosen per shell family: pass `-l` and `-c` as *separate* args so fish parses
/// them (it rejects the combined `-lc`), and drop `-l` for plain `sh`/`dash`
/// which don't accept a login flag.
pub fn shell_argv(cmdline: &str) -> (String, Vec<String>) {
    let shell = user_shell();
    let name = Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    // on Windows the shell is `bash.exe`; normalize so family checks below match
    let name = name.strip_suffix(".exe").unwrap_or(name);
    let mut args: Vec<String> = Vec::new();
    if !matches!(name, "sh" | "dash") {
        args.push("-l".into());
    }
    args.push("-c".into());
    args.push(cmdline.to_string());
    (shell, args)
}

#[cfg(test)]
mod tests {
    use super::shell_argv;

    #[test]
    fn shell_argv_passes_login_and_command_separately() {
        // whatever $SHELL resolves to, the command must be the last arg and
        // -c must precede it (login flag optional per shell family)
        let (_shell, args) = shell_argv("echo hi");
        assert_eq!(args.last().unwrap(), "echo hi");
        assert!(args.iter().any(|a| a == "-c"));
    }
}
