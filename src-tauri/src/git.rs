use serde::Serialize;
use tokio::process::Command;

pub async fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}

/// `git worktree list --porcelain` — first entry is the main working tree.
pub async fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let out = run_git(repo_path, &["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktree_list(&out))
}

/// Pure parser for `git worktree list --porcelain` output.
fn parse_worktree_list(porcelain: &str) -> Vec<WorktreeInfo> {
    struct Entry {
        path: String,
        branch: Option<String>,
        bare: bool,
    }
    let mut entries: Vec<Entry> = Vec::new();
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            entries.push(Entry { path: p.to_string(), branch: None, bare: false });
        } else if let Some(e) = entries.last_mut() {
            if let Some(b) = line.strip_prefix("branch ") {
                e.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "bare" {
                e.bare = true;
            } else if line == "detached" {
                e.branch = Some("(detached)".into());
            }
        }
    }

    entries
        .into_iter()
        .filter(|e| !e.bare)
        .enumerate()
        .map(|(i, e)| WorktreeInfo {
            path: e.path,
            branch: e.branch.unwrap_or_else(|| "(detached)".into()),
            is_main: i == 0,
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitMeta {
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub last_commit_ts: i64,
    pub last_commit_msg: String,
}

pub async fn git_meta(wt_path: &str) -> Result<GitMeta, String> {
    let status = run_git(wt_path, &["status", "--porcelain=v2", "--branch"]).await?;
    let mut meta = parse_status_meta(&status);
    if let Ok(log) = run_git(wt_path, &["log", "-1", "--format=%ct%x09%s"]).await {
        let (ts, msg) = parse_last_commit(&log);
        meta.last_commit_ts = ts;
        meta.last_commit_msg = msg;
    }
    Ok(meta)
}

/// Pure parser for `git status --porcelain=v2 --branch`: ahead/behind + dirty.
fn parse_status_meta(status: &str) -> GitMeta {
    let mut meta = GitMeta::default();
    for line in status.lines() {
        if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // "+A -B"
            for part in ab.split_whitespace() {
                if let Some(a) = part.strip_prefix('+') {
                    meta.ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = part.strip_prefix('-') {
                    meta.behind = b.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            meta.dirty = true;
        }
    }
    meta
}

/// Pure parser for `git log -1 --format=%ct%x09%s`.
fn parse_last_commit(log: &str) -> (i64, String) {
    let mut it = log.trim_end().splitn(2, '\t');
    let ts = it.next().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    let msg = it.next().unwrap_or("").to_string();
    (ts, msg)
}

/// (name, path) pairs from a worktree's .gitmodules (empty if none).
async fn submodule_entries(wt_path: &str) -> Vec<(String, String)> {
    if !std::path::Path::new(wt_path).join(".gitmodules").exists() {
        return Vec::new();
    }
    let out = run_git(
        wt_path,
        &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
    )
    .await
    .unwrap_or_default();
    out.lines()
        .filter_map(|l| {
            let (key, path) = l.split_once(' ')?;
            let name = key.strip_prefix("submodule.")?.strip_suffix(".path")?;
            Some((name.to_string(), path.to_string()))
        })
        .collect()
}

/// Fast-forward pull, then bring submodules up to date. A bare
/// `submodule update` only pins submodules back to the superproject's recorded
/// commit — it never advances them (the reported "pull skips submodules" bug).
/// Per submodule:
///   - checked out on a branch → `git pull --ff-only` inside it
///   - detached but .gitmodules pins a branch (the ToolJet flow:
///     `branch = lts-3.16`) → `submodule update --remote` to that branch's tip
///   - otherwise → sync to the recorded commit as before
pub async fn pull(wt_path: &str) -> Result<String, String> {
    // Superproject fast-forward. A worktree branch with no upstream (or a
    // non-ff remote) shouldn't block pulling submodules that DO track a branch,
    // so this failure is soft — recorded, then we still update submodules.
    let super_res = run_git(wt_path, &["pull", "--ff-only"]).await;

    let mods = submodule_entries(wt_path).await;
    if mods.is_empty() {
        return super_res.map(|_| "pulled".into());
    }

    let mut pulled = 0usize;
    let mut synced = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for (name, sm) in &mods {
        let sm_path = format!("{wt_path}/{sm}");
        // on a branch? (fails when detached or not yet initialized)
        let on_branch = run_git(&sm_path, &["symbolic-ref", "-q", "--short", "HEAD"])
            .await
            .map(|b| !b.trim().is_empty())
            .unwrap_or(false);
        let tracks_branch = run_git(
            wt_path,
            &["config", "-f", ".gitmodules", "--get", &format!("submodule.{name}.branch")],
        )
        .await
        .map(|b| !b.trim().is_empty())
        .unwrap_or(false);
        // -c protocol.file.allow=always: submodules with local/relative URLs
        // would otherwise be blocked by git's file-protocol default
        let result = if on_branch {
            run_git(&sm_path, &["pull", "--ff-only"]).await.map(|_| pulled += 1)
        } else if tracks_branch {
            run_git(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--remote", "--recursive", "--", sm],
            )
            .await
            .map(|_| pulled += 1)
        } else {
            run_git(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", sm],
            )
            .await
            .map(|_| synced += 1)
        };
        if let Err(e) = result {
            errors.push(format!("{sm}: {e}"));
        }
    }

    if !errors.is_empty() {
        // include the superproject failure too — it would otherwise be lost
        let super_note = match &super_res {
            Err(e) => format!("; superproject: {}", e.lines().next().unwrap_or("not pulled").trim()),
            Ok(_) => String::new(),
        };
        return Err(format!("submodule(s) failed — {}{super_note}", errors.join("; ")));
    }
    let mut parts = Vec::new();
    match &super_res {
        Ok(_) => parts.push("pulled".to_string()),
        Err(e) => {
            let short = e.lines().next().map(|l| l.trim()).unwrap_or("superproject not pulled").to_string();
            parts.push(format!("superproject skipped ({short})"));
        }
    }
    if pulled > 0 {
        parts.push(format!("{pulled} submodule(s) pulled"));
    }
    if synced > 0 {
        parts.push(format!("{synced} submodule(s) synced"));
    }
    Ok(parts.join(", "))
}

/// Per-submodule state for the pull menu: which branch it's on (or detached),
/// whether it has local changes, and whether it has moved ahead of the commit
/// the superproject pins (the same-branch workflow drifts here by design).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleStatus {
    pub name: String,
    /// path relative to the worktree root
    pub path: String,
    /// branch name, or None when detached
    pub branch: Option<String>,
    /// short HEAD sha
    pub sha: String,
    pub dirty: bool,
    /// HEAD is a descendant of the pinned commit (moved forward on a branch)
    pub ahead: bool,
    /// "clean" | "attention" | "detached" — drives the row's status dot
    pub status: String,
}

/// Status of every submodule in a worktree (empty when the repo has none).
pub async fn submodule_status(wt_path: &str) -> Vec<SubmoduleStatus> {
    let mut out = Vec::new();
    for (name, sm) in submodule_entries(wt_path).await {
        let sm_path = format!("{wt_path}/{sm}");
        let branch = run_git(&sm_path, &["symbolic-ref", "-q", "--short", "HEAD"])
            .await
            .ok()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty());
        let sha = run_git(&sm_path, &["rev-parse", "--short", "HEAD"])
            .await
            .unwrap_or_default()
            .trim()
            .to_string();
        let dirty = run_git(&sm_path, &["status", "--porcelain"])
            .await
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        // compare HEAD against the commit the superproject records for this path
        let pinned = run_git(wt_path, &["rev-parse", &format!("HEAD:{sm}")])
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let head_full = run_git(&sm_path, &["rev-parse", "HEAD"]).await.unwrap_or_default().trim().to_string();
        let drifted = pinned.as_deref().map(|p| !head_full.is_empty() && p != head_full).unwrap_or(false);
        // ahead = pinned commit is an ancestor of HEAD (moved forward, not diverged)
        let ahead = if drifted {
            if let Some(p) = &pinned {
                run_git(&sm_path, &["merge-base", "--is-ancestor", p, "HEAD"]).await.is_ok()
            } else {
                false
            }
        } else {
            false
        };
        let diverged = drifted && !ahead;

        let status = if branch.is_none() {
            "detached"
        } else if dirty || diverged {
            "attention"
        } else {
            "clean"
        };

        out.push(SubmoduleStatus {
            name,
            path: sm,
            branch,
            sha,
            dirty,
            ahead,
            status: status.to_string(),
        });
    }
    out
}

/// Pull a single submodule — same rules as the worktree-wide `pull`:
///   - on a branch → `git pull --ff-only` inside it
///   - detached but .gitmodules pins a branch (the ToolJet flow) →
///     `submodule update --remote` to that branch's tip
///   - otherwise → sync to the superproject's recorded commit
pub async fn pull_submodule(wt_path: &str, sm: &str) -> Result<String, String> {
    let sm_path = format!("{wt_path}/{sm}");
    // .gitmodules keys are by submodule NAME (usually == path, but resolve it)
    let name = submodule_entries(wt_path)
        .await
        .into_iter()
        .find(|(_, p)| p == sm)
        .map(|(n, _)| n)
        .unwrap_or_else(|| sm.to_string());
    let on_branch = run_git(&sm_path, &["symbolic-ref", "-q", "--short", "HEAD"])
        .await
        .map(|b| !b.trim().is_empty())
        .unwrap_or(false);
    let tracks_branch = run_git(
        wt_path,
        &["config", "-f", ".gitmodules", "--get", &format!("submodule.{name}.branch")],
    )
    .await
    .map(|b| !b.trim().is_empty())
    .unwrap_or(false);

    if on_branch {
        run_git(&sm_path, &["pull", "--ff-only"]).await?;
        Ok("pulled".into())
    } else if tracks_branch {
        run_git(
            wt_path,
            &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--remote", "--recursive", "--", sm],
        )
        .await?;
        Ok("pulled".into())
    } else {
        run_git(
            wt_path,
            &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", sm],
        )
        .await?;
        Ok("synced".into())
    }
}

/// Check out `branch` in a submodule. Refuses when the submodule is dirty.
/// Accepts a local name or a remote-qualified ref (origin/x) → creates a
/// tracking branch; falls back to creating the branch from HEAD if it's new.
pub async fn switch_submodule_branch(wt_path: &str, sm: &str, branch: &str) -> Result<(), String> {
    let sm_path = format!("{wt_path}/{sm}");
    let dirty = run_git(&sm_path, &["status", "--porcelain"])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if dirty {
        return Err(format!("{sm} has uncommitted changes — commit or stash before switching branch"));
    }

    let short = branch.strip_prefix("origin/").unwrap_or(branch);
    let local_exists = run_git(&sm_path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{short}")])
        .await
        .is_ok();
    if local_exists {
        run_git(&sm_path, &["checkout", short]).await?;
        return Ok(());
    }

    let remote_ref = if branch.starts_with("origin/") { branch.to_string() } else { format!("origin/{short}") };
    let remote_exists = run_git(&sm_path, &["rev-parse", "--verify", "--quiet", &remote_ref]).await.is_ok();
    if remote_exists {
        run_git(&sm_path, &["checkout", "-b", short, "--track", &remote_ref]).await?;
    } else {
        run_git(&sm_path, &["checkout", branch]).await?;
    }
    Ok(())
}

/// Branches available inside a submodule (for the switch picker).
pub async fn list_submodule_branches(wt_path: &str, sm: &str) -> Result<Branches, String> {
    let sm_path = format!("{wt_path}/{sm}");
    list_branches(&sm_path).await
}

/// Switch a worktree to a different branch IN PLACE — same folder, so
/// node_modules / build output are reused (no reinstall). `create` makes a new
/// branch from `base` (defaults to current HEAD). Git refuses if the branch is
/// already checked out in another worktree; that error is surfaced as-is.
/// After the checkout, submodules are re-pinned to the new branch's recorded
/// commits — a plain checkout leaves them on the old branch's pins, which reads
/// as spurious dirt/drift on submodule-heavy repos.
pub async fn switch_branch(wt_path: &str, branch: &str, create: bool, base: Option<&str>) -> Result<(), String> {
    if create {
        match base {
            Some(b) if !b.trim().is_empty() => {
                run_git(wt_path, &["checkout", "-b", branch, b]).await?;
            }
            _ => {
                run_git(wt_path, &["checkout", "-b", branch]).await?;
            }
        }
    } else {
        // plain checkout; git DWIMs a tracking branch from origin/<branch> if needed
        run_git(wt_path, &["checkout", branch]).await?;
    }
    // sync submodules to the new branch's pins (no-op when there are none).
    // The branch HAS switched at this point, so a sync failure says so.
    if !submodule_entries(wt_path).await.is_empty() {
        run_git(
            wt_path,
            &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
        )
        .await
        .map_err(|e| format!("switched to {branch}, but submodule update failed:\n{e}"))?;
    }
    Ok(())
}

/// `git fetch --prune` inside every submodule so ahead/behind-of-remote and
/// drift are computed against fresh remote refs. Best-effort per submodule.
pub async fn fetch_submodules(wt_path: &str) -> usize {
    let mut n = 0usize;
    for (_name, sm) in submodule_entries(wt_path).await {
        let sm_path = format!("{wt_path}/{sm}");
        if run_git(&sm_path, &["fetch", "--prune"]).await.is_ok() {
            n += 1;
        }
    }
    n
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub tags: Vec<String>,
}

/// `git fetch --all --prune` to refresh remote-tracking branches, recursing
/// into submodules so their objects are fetched too.
pub async fn fetch_all(repo_path: &str) -> Result<(), String> {
    run_git(repo_path, &["fetch", "--all", "--prune", "--recurse-submodules"])
        .await
        .map(|_| ())
}

pub async fn list_branches(repo_path: &str) -> Result<Branches, String> {
    let local = run_git(
        repo_path,
        &["for-each-ref", "refs/heads", "--format=%(refname:short)"],
    )
    .await?;
    let remote = run_git(
        repo_path,
        &["for-each-ref", "refs/remotes", "--format=%(refname:short)"],
    )
    .await?;
    // newest tags first — release tags are usually what worktrees branch from
    let tags = run_git(
        repo_path,
        &["for-each-ref", "refs/tags", "--sort=-creatordate", "--format=%(refname:short)"],
    )
    .await
    .unwrap_or_default();
    Ok(Branches {
        local: local.lines().map(|s| s.to_string()).collect(),
        remote: remote
            .lines()
            .filter(|s| !s.ends_with("/HEAD"))
            .map(|s| s.to_string())
            .collect(),
        tags: tags.lines().map(|s| s.to_string()).collect(),
    })
}

/// Validate a path is a git repo work-tree root; returns canonical top-level path.
pub async fn validate_repo(path: &str) -> Result<String, String> {
    let top = run_git(path, &["rev-parse", "--show-toplevel"]).await?;
    Ok(top.trim().to_string())
}

/// Submodule paths declared in a worktree's .gitmodules (empty if none).
pub async fn submodule_paths(wt_path: &str) -> Vec<String> {
    if !std::path::Path::new(wt_path).join(".gitmodules").exists() {
        return Vec::new();
    }
    let out = run_git(
        wt_path,
        &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
    )
    .await
    .unwrap_or_default();
    out.lines()
        .filter_map(|l| l.split_once(' ').map(|(_, p)| p.to_string()))
        .collect()
}

/// `git worktree add` + submodule init with object sharing against the main
/// checkout. Progress lines stream through `progress`.
pub async fn create_worktree(
    repo_path: &str,
    wt_path: &str,
    branch: &str,
    base: Option<&str>,
    create_branch: bool,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    progress(format!("git worktree add {wt_path}"));
    if create_branch {
        let base = base.unwrap_or("HEAD");
        run_git(repo_path, &["worktree", "add", wt_path, "-b", branch, base]).await?;
    } else {
        run_git(repo_path, &["worktree", "add", wt_path, branch]).await?;
        // A remote pick reusing an existing local branch passes the origin ref
        // as `base`. Fast-forward the checkout to it so the worktree (and the
        // submodule commits it pins) reflect origin rather than a stale local
        // branch — the "created before pulling" regression. ff-only never
        // discards local commits; a diverged branch simply stays put.
        if let Some(b) = base.map(str::trim).filter(|b| !b.is_empty()) {
            if let Err(e) = run_git(wt_path, &["merge", "--ff-only", b]).await {
                progress(format!("note: could not fast-forward {branch} to {b} — left as-is ({e})"));
            }
        }
    }

    let subs = submodule_paths(wt_path).await;
    if subs.is_empty() {
        return Ok(());
    }

    progress(format!("initializing {} submodule(s)…", subs.len()));
    run_git(wt_path, &["submodule", "init"]).await?;

    for sm in &subs {
        // Share objects with the main checkout's submodule clone (near-zero
        // transfer); plain clone as fallback. NOTE: alternates mean the main
        // checkout's .git/modules must never be deleted/GC'd while linked
        // worktrees exist.
        let reference = format!("{repo_path}/{sm}");
        let with_ref = std::path::Path::new(&reference).exists();
        progress(format!("submodule {sm}{}", if with_ref { " (sharing objects)" } else { "" }));

        // -c protocol.file.allow=always: submodules with relative/local URLs
        // would otherwise be blocked by git's file-protocol default
        let result = if with_ref {
            run_git(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--reference", &reference, "--", sm],
            )
            .await
        } else {
            Err("no reference".into())
        };
        if result.is_err() {
            progress(format!("submodule {sm}: falling back to full clone"));
            run_git(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", sm],
            )
            .await?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyReport {
    pub dirty: bool,
    pub details: Vec<String>,
}

/// Dirty check covering the worktree AND its submodules.
pub async fn dirty_report(wt_path: &str) -> DirtyReport {
    let mut details = Vec::new();
    if let Ok(out) = run_git(wt_path, &["status", "--porcelain", "--ignore-submodules=none"]).await {
        for l in out.lines().take(10) {
            details.push(l.to_string());
        }
    }
    DirtyReport { dirty: !details.is_empty(), details }
}

/// Remove a worktree. `--force` is required for any worktree containing
/// submodules, even a clean one — the caller must have confirmed with the user.
pub async fn remove_worktree(
    repo_path: &str,
    wt_path: &str,
    branch: Option<&str>,
    delete_branch: bool,
) -> Result<(), String> {
    run_git(repo_path, &["worktree", "remove", "--force", wt_path]).await?;
    if delete_branch {
        if let Some(b) = branch {
            // best-effort: branch may be checked out elsewhere or unmerged
            let _ = run_git(repo_path, &["branch", "-D", b]).await;
        }
    }
    let _ = run_git(repo_path, &["worktree", "prune"]).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let out = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n\
                   worktree /repo-worktrees/feat\nHEAD def456\nbranch refs/heads/feat\n\n\
                   worktree /repo-worktrees/det\nHEAD 987fed\ndetached\n";
        let wts = parse_worktree_list(out);
        assert_eq!(wts.len(), 3);
        assert!(wts[0].is_main && wts[0].branch == "main" && wts[0].path == "/repo");
        assert!(!wts[1].is_main && wts[1].branch == "feat");
        assert_eq!(wts[2].branch, "(detached)");
    }

    #[test]
    fn skips_bare_entries() {
        let out = "worktree /repo.git\nbare\n\nworktree /wt\nHEAD abc\nbranch refs/heads/x\n";
        let wts = parse_worktree_list(out);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/wt");
        // NOTE: is_main is positional over the filtered list — a bare main repo
        // promotes the first linked worktree, which matches git's ordering.
        assert!(wts[0].is_main);
    }

    #[test]
    fn parses_status_ahead_behind_dirty() {
        let s = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -1\n\
                 1 .M N... 100644 100644 100644 abc def src/x.rs\n";
        let m = parse_status_meta(s);
        assert_eq!((m.ahead, m.behind, m.dirty), (3, 1, true));
        let clean = "# branch.oid abc\n# branch.head main\n# branch.ab +0 -0\n";
        let m = parse_status_meta(clean);
        assert_eq!((m.ahead, m.behind, m.dirty), (0, 0, false));
    }

    #[test]
    fn parses_last_commit_line() {
        let (ts, msg) = parse_last_commit("1722500000\tfix: tab\tin message\n");
        assert_eq!(ts, 1722500000);
        assert_eq!(msg, "fix: tab\tin message", "only the first tab splits");
        assert_eq!(parse_last_commit(""), (0, String::new()));
    }
}
