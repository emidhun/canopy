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

fn bin_for_version(version: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let candidates = [
        format!("{home}/.asdf/installs/nodejs/{version}/bin"),
        format!("{home}/.asdf/installs/nodejs/v{version}/bin"),
        format!("{home}/.nvm/versions/node/v{version}/bin"),
        format!("{home}/.local/share/fnm/node-versions/v{version}/installation/bin"),
    ];
    candidates.into_iter().find(|c| Path::new(c).join("node").exists())
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
        Some(bin) => format!("export PATH=\"{bin}:$PATH\"; {command}"),
        None => command.to_string(),
    }
}

/// The shell Canopy runs commands through. Honors `$SHELL` (so bash/fish/etc.
/// users get their own shell + profile), falling back to zsh on macOS and sh
/// elsewhere. Commands run as a *login* shell so version managers (nvm/asdf/
/// volta) and the user's PATH are initialized.
pub fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && Path::new(s).exists())
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() })
}

/// Build `(shell, argv)` to run `cmdline` through the user's shell. Flags are
/// chosen per shell family: pass `-l` and `-c` as *separate* args so fish parses
/// them (it rejects the combined `-lc`), and drop `-l` for plain `sh`/`dash`
/// which don't accept a login flag.
pub fn shell_argv(cmdline: &str) -> (String, Vec<String>) {
    let shell = user_shell();
    let name = Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
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
