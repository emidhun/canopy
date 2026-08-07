// Per-worktree provisioning declared in the repo ("from code"), via a JSON file
// (.worktreemanager.json or wtm.json). Two parts:
//
//   {
//     "env": {                          // declarative .env overrides (add-or-replace)
//       "PG_DB": "${WT_DB_NAME}",
//       "PORT": "${WT_SERVER_PORT}",
//       "TOOLJET_SERVER_PORT": "${WT_SERVER_PORT}"
//     },
//     "setup": [ "npm --prefix server install", "npm run db:create" ]
//   }
//
// On create/setup Canopy seeds `.env` from the main checkout, applies the `env`
// overrides (interpolating ${VAR}), then runs the `setup` commands. Available
// vars: WT_SLUG, WT_DB_NAME, WT_INDEX, WT_<SERVICE>_PORT, WT_PATH, REPO_PATH.
//
// Config lookup order: the worktree's own copy first (committed → travels with
// the branch), then the main checkout (configure once without committing).
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const CONFIG_NAMES: [&str; 2] = [".worktreemanager.json", "wtm.json"];

/// One file Canopy seeds + templates into every new worktree. `dotenv`/`json`/
/// `yaml` seed the file (copy `from`, or the same path in the main checkout, if
/// missing) then upsert `keys` — every other line is preserved. `text` copies
/// the whole file and, when `interpolate` is set, replaces every `${VAR}`.
#[derive(Default, Clone)]
pub struct ProvisionFile {
    /// destination path, relative to the worktree root (e.g. "server/.env")
    pub path: String,
    /// dotenv | json | yaml | text
    pub format: String,
    /// source path to copy from (relative to the repo); empty = same as `path`
    pub from: String,
    /// text mode only: interpolate ${VAR} after copying
    pub interpolate: bool,
    /// ordered (key, value-template) pairs upserted into the file (not for text)
    pub keys: Vec<(String, String)>,
}

#[derive(Default, Clone)]
pub struct WtmConfig {
    /// files seeded + templated into the worktree (the ".env" root file is just
    /// one entry — legacy top-level `env` is migrated into this list on read)
    pub provision: Vec<ProvisionFile>,
    pub setup: Vec<String>,
    /// commands run before a worktree is deleted (e.g. drop its database)
    pub teardown: Vec<String>,
    /// commands run by the "Run migration" action
    pub migrate: Vec<String>,
}

/// Parse a JSON `provision` array into ordered `ProvisionFile`s.
fn parse_provision(v: &serde_json::Value) -> Vec<ProvisionFile> {
    v.get("provision")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    let path = o.get("path").and_then(|x| x.as_str())?.to_string();
                    let format = o
                        .get("format")
                        .and_then(|x| x.as_str())
                        .filter(|f| matches!(*f, "dotenv" | "json" | "yaml" | "text"))
                        .unwrap_or("dotenv")
                        .to_string();
                    let from = o.get("from").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let interpolate = o.get("interpolate").and_then(|x| x.as_bool()).unwrap_or(false);
                    let keys = o
                        .get("keys")
                        .and_then(|k| k.as_object())
                        .map(|m| {
                            m.iter()
                                .map(|(k, val)| {
                                    let s = match val {
                                        serde_json::Value::String(s) => s.clone(),
                                        other => other.to_string(),
                                    };
                                    (k.clone(), s)
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(ProvisionFile { path, format, from, interpolate, keys })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn read_config(wt_path: &str, repo_path: &str) -> WtmConfig {
    for dir in [wt_path, repo_path] {
        for name in CONFIG_NAMES {
            let p = Path::new(dir).join(name);
            let Ok(txt) = std::fs::read_to_string(&p) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else { continue };
            let arr = |key: &str| {
                v.get(key)
                    .and_then(|s| s.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
                    .unwrap_or_default()
            };
            let setup = arr("setup");
            let teardown = arr("teardown");
            let migrate = arr("migrate");
            let mut provision = parse_provision(&v);
            // back-compat: fold a legacy top-level `env` object into a leading
            // ".env" dotenv entry so old configs keep working (and migrate on save).
            let legacy_env: Vec<(String, String)> = v
                .get("env")
                .and_then(|e| e.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            if !legacy_env.is_empty() && !provision.iter().any(|p| p.path == ".env") {
                provision.insert(
                    0,
                    ProvisionFile {
                        path: ".env".into(),
                        format: "dotenv".into(),
                        from: String::new(),
                        interpolate: false,
                        keys: legacy_env,
                    },
                );
            }
            if !setup.is_empty() || !provision.is_empty() || !teardown.is_empty() || !migrate.is_empty() {
                return WtmConfig { provision, setup, teardown, migrate };
            }
        }
    }
    WtmConfig::default()
}

pub fn read_repo_config(repo_path: &str) -> WtmConfig {
    read_config(repo_path, repo_path)
}

pub fn has_config(wt_path: &str, repo_path: &str) -> bool {
    let c = read_config(wt_path, repo_path);
    !c.provision.is_empty() || !c.setup.is_empty()
}

/// Serialize a `ProvisionFile` list to a JSON `provision` array.
fn provision_to_json(provision: &[ProvisionFile]) -> serde_json::Value {
    serde_json::Value::Array(
        provision
            .iter()
            .filter(|p| !p.path.trim().is_empty())
            .map(|p| {
                let mut o = serde_json::Map::new();
                o.insert("path".into(), serde_json::Value::String(p.path.clone()));
                o.insert("format".into(), serde_json::Value::String(p.format.clone()));
                if !p.from.trim().is_empty() {
                    o.insert("from".into(), serde_json::Value::String(p.from.clone()));
                }
                if p.format == "text" {
                    o.insert("interpolate".into(), serde_json::Value::Bool(p.interpolate));
                } else {
                    o.insert("mode".into(), serde_json::Value::String("upsert".into()));
                    let mut keys = serde_json::Map::new();
                    for (k, v) in p.keys.iter().filter(|(k, _)| !k.trim().is_empty()) {
                        keys.insert(k.clone(), serde_json::Value::String(v.clone()));
                    }
                    o.insert("keys".into(), serde_json::Value::Object(keys));
                }
                serde_json::Value::Object(o)
            })
            .collect(),
    )
}

/// Write `.worktreemanager.json` at the repo root with the given provision list +
/// setup commands. Preserves other top-level keys (teardown/migrate) and drops
/// the legacy `env` block, which is now folded into `provision`. An existing but
/// malformed file is an ERROR — rewriting it would silently drop those keys.
pub fn write_repo_config(repo_path: &str, provision: &[ProvisionFile], setup: &[String]) -> Result<(), String> {
    let path = Path::new(repo_path).join(".worktreemanager.json");
    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(txt) if !txt.trim().is_empty() => serde_json::from_str(&txt).map_err(|e| {
            format!(".worktreemanager.json is malformed ({e}) — fix it by hand before saving from Settings")
        })?,
        _ => serde_json::json!({}),
    };
    if !root.is_object() {
        return Err(".worktreemanager.json is not a JSON object — fix it by hand before saving from Settings".into());
    }
    if let Some(obj) = root.as_object_mut() {
        obj.remove("env"); // migrated into `provision`
    }
    root["$schema"] = serde_json::Value::String("canopy://worktree-manager/v1".into());
    root["provision"] = provision_to_json(provision);
    root["setup"] = serde_json::Value::Array(
        setup
            .iter()
            .filter(|c| !c.trim().is_empty())
            .map(|c| serde_json::Value::String(c.clone()))
            .collect(),
    );
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, body + "\n").map_err(|e| e.to_string())
}

/// Stable, db-safe per-worktree identifier from the worktree folder name:
/// lowercased, non-alphanumerics → '_'.
pub fn wt_slug(wt_path: &str) -> String {
    Path::new(wt_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Replace `${VAR}` tokens in a template using the vars map (unknown left as-is).
fn interpolate(tpl: &str, vars: &HashMap<String, String>) -> String {
    let mut out = tpl.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("${{{k}}}"), v);
    }
    out
}

/// Add-or-replace literal KEY=VALUE pairs in the worktree's `.env`, preserving
/// every other line. Seeds `.env` from the main checkout if missing.
pub fn set_env_keys(wt_path: &str, repo_path: &str, pairs: &[(String, String)]) -> Result<(), String> {
    if pairs.is_empty() {
        return Ok(());
    }
    let env_path = Path::new(wt_path).join(".env");
    if !env_path.exists() {
        let main_env = Path::new(repo_path).join(".env");
        if main_env.exists() {
            std::fs::copy(&main_env, &env_path).map_err(|e| format!("seed .env failed: {e}"))?;
        }
    }
    let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
    let body = upsert_dotenv_str(&existing, pairs);
    std::fs::write(&env_path, body).map_err(|e| format!("write .env failed: {e}"))
}

/// Upsert literal KEY=VALUE pairs into every *provisioned dotenv file* that
/// declares any of the keys — so e.g. switching database repoints `PG_DB` in
/// `server/.env` too, not just the root `.env`.
pub fn set_env_keys_in_provisioned(wt_path: &str, repo_path: &str, pairs: &[(String, String)]) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    for pf in cfg.provision.iter().filter(|p| p.format == "dotenv" && p.path != ".env") {
        let relevant: Vec<(String, String)> = pairs
            .iter()
            .filter(|(k, _)| pf.keys.iter().any(|(pk, _)| pk == k))
            .cloned()
            .collect();
        if relevant.is_empty() {
            continue;
        }
        let target = Path::new(wt_path).join(&pf.path);
        if !target.exists() {
            continue; // never materialize a file just to repoint a key
        }
        let existing = std::fs::read_to_string(&target).unwrap_or_default();
        let body = upsert_dotenv_str(&existing, &relevant);
        std::fs::write(&target, body).map_err(|e| format!("write {}: {e}", target.display()))?;
    }
    Ok(())
}

/// Upsert `KEY=VALUE` pairs into dotenv `existing` text, preserving every other
/// line and replacing keys already present (including `export KEY=` variants).
/// Updated keys move to the end of the file.
fn upsert_dotenv_str(existing: &str, pairs: &[(String, String)]) -> String {
    let keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|l| {
            let head = l.split('=').next().unwrap_or("").trim();
            let key = head.strip_prefix("export ").map(str::trim).unwrap_or(head);
            !keys.contains(&key)
        })
        .map(String::from)
        .collect();
    for (k, v) in pairs {
        lines.push(format!("{k}={v}"));
    }
    let mut body = lines.join("\n");
    body.push('\n');
    body
}

/// Set a dotted key (`development.database`) to a string value inside a JSON
/// object, creating intermediate objects as needed.
fn set_dotted_json(root: &mut serde_json::Value, dotted: &str, value: &str) {
    if !root.is_object() {
        *root = serde_json::json!({});
    }
    let segs: Vec<&str> = dotted.split('.').collect();
    let mut cur = root;
    for seg in &segs[..segs.len() - 1] {
        let obj = cur.as_object_mut().unwrap();
        let entry = obj.entry(seg.to_string()).or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        cur = entry;
    }
    if let Some(obj) = cur.as_object_mut() {
        obj.insert(segs[segs.len() - 1].to_string(), serde_json::Value::String(value.to_string()));
    }
}

/// Upsert dotted keys into `existing` JSON text (or `{}` when empty), returning
/// pretty-printed JSON. Malformed input is an ERROR, never silently replaced —
/// defaulting to `{}` would wipe the user's file down to just the upserted keys.
fn upsert_json_str(existing: &str, pairs: &[(String, String)]) -> Result<String, String> {
    let mut root: serde_json::Value = if existing.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(existing)
            .map_err(|e| format!("refusing to rewrite malformed JSON ({e}) — fix the file or remove it so it can be re-seeded"))?
    };
    for (k, v) in pairs {
        set_dotted_json(&mut root, k, v);
    }
    let mut body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    body.push('\n');
    Ok(body)
}

/// Upsert dotted keys into `existing` YAML text with a line-based, comment- and
/// layout-preserving rewrite. An existing dotted path has just its scalar value
/// replaced; a missing path is appended as an indented block. Indent width is
/// detected from the file (first indented mapping line; 2 for new files) so
/// 4-space and tab-free wide-indent files descend correctly. Not a full YAML
/// parser — targets the seed-an-example-then-set-values workflow.
fn upsert_yaml_str(existing: &str, pairs: &[(String, String)]) -> String {
    let mut lines: Vec<String> = existing.lines().map(String::from).collect();
    let indent_of = |l: &str| l.len() - l.trim_start().len();
    let key_of = |l: &str| -> Option<String> {
        let t = l.trim_start();
        if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
            return None;
        }
        t.split_once(':').map(|(k, _)| k.trim().to_string())
    };
    // indent unit = the first indented, non-comment mapping line's indent
    let step = lines
        .iter()
        .filter(|l| key_of(l).is_some())
        .map(|l| indent_of(l))
        .find(|&i| i > 0)
        .unwrap_or(2) as i32;

    for (dotted, value) in pairs {
        let segs: Vec<&str> = dotted.split('.').collect();
        // walk the segments, tracking the line range + indent of the current block
        let (mut lo, mut hi, mut depth_indent) = (0usize, lines.len(), 0i32);
        let mut found_upto = 0usize; // how many leading segments matched
        let mut target_line: Option<usize> = None;
        'seg: for (si, seg) in segs.iter().enumerate() {
            let want_indent = depth_indent;
            let mut i = lo;
            while i < hi {
                let l = &lines[i];
                if l.trim().is_empty() || (indent_of(l) as i32) != want_indent {
                    i += 1;
                    continue;
                }
                if key_of(l).as_deref() == Some(*seg) {
                    found_upto = si + 1;
                    if si == segs.len() - 1 {
                        target_line = Some(i);
                        break 'seg;
                    }
                    // descend into this key's block. The child indent is whatever
                    // the block actually uses (first keyed line inside it).
                    lo = i + 1;
                    // block ends where indentation drops back to <= want_indent
                    let mut j = lo;
                    while j < hi {
                        let lj = &lines[j];
                        if !lj.trim().is_empty() && (indent_of(lj) as i32) <= want_indent {
                            break;
                        }
                        j += 1;
                    }
                    hi = j;
                    depth_indent = lines[lo..hi]
                        .iter()
                        .find(|l| key_of(l).is_some())
                        .map(|l| indent_of(l) as i32)
                        .unwrap_or(want_indent + step);
                    continue 'seg;
                }
                i += 1;
            }
            break; // segment not found at this level
        }

        if let Some(li) = target_line {
            let indent = " ".repeat(indent_of(&lines[li]));
            lines[li] = format!("{indent}{}: {value}", segs.last().unwrap());
        } else {
            // append the missing tail as an indented nested block at the deepest
            // matched position (end of file for a wholly-new top-level key).
            let base = found_upto as i32 * step;
            let mut block = Vec::new();
            for (k, seg) in segs[found_upto..].iter().enumerate() {
                let indent = " ".repeat((base + k as i32 * step) as usize);
                if found_upto + k == segs.len() - 1 {
                    block.push(format!("{indent}{seg}: {value}"));
                } else {
                    block.push(format!("{indent}{seg}:"));
                }
            }
            let at = hi.min(lines.len());
            for (k, b) in block.into_iter().enumerate() {
                lines.insert(at + k, b);
            }
        }
    }
    let mut body = lines.join("\n");
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body
}

/// A provision path must stay inside its root: relative, no `..` components.
fn check_contained(p: &str, what: &str) -> Result<(), String> {
    use std::path::Component;
    let path = Path::new(p);
    // On Windows a leading-`/` path (`/etc/hosts`) is *rooted* but not *absolute*
    // (no drive), yet `join` still resolves it onto the current drive and escapes
    // the root — so reject `has_root()` and drive prefixes (`C:\`, `C:foo`) too.
    let escapes = path.is_absolute()
        || path.has_root()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)));
    if escapes {
        return Err(format!("provision {what} '{p}' must be a relative path without '..'"));
    }
    Ok(())
}

/// Seed + template one provisioned file into the worktree. `dotenv`/`json`/`yaml`
/// seed the file (copy `from`/same-path from the main checkout when missing) then
/// upsert `keys`; `text` copies the whole file and optionally interpolates.
fn provision_file(wt_path: &str, repo_path: &str, pf: &ProvisionFile, vars: &HashMap<String, String>) -> Result<(), String> {
    if pf.path.trim().is_empty() {
        return Ok(());
    }
    check_contained(&pf.path, "path")?;
    if !pf.from.trim().is_empty() {
        check_contained(&pf.from, "from")?;
    }
    let target = Path::new(wt_path).join(&pf.path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let src_rel = if pf.from.trim().is_empty() { pf.path.as_str() } else { pf.from.as_str() };
    let src = Path::new(repo_path).join(src_rel);

    if pf.format == "text" {
        let content = if target.exists() {
            std::fs::read_to_string(&target).unwrap_or_default()
        } else if src.exists() {
            std::fs::read_to_string(&src).map_err(|e| format!("read {}: {e}", src.display()))?
        } else {
            String::new()
        };
        let out = if pf.interpolate { interpolate(&content, vars) } else { content };
        return std::fs::write(&target, out).map_err(|e| format!("write {}: {e}", target.display()));
    }

    // key formats: seed from source if the target doesn't exist yet
    if !target.exists() && src.exists() {
        std::fs::copy(&src, &target).map_err(|e| format!("seed {}: {e}", target.display()))?;
    }
    let resolved: Vec<(String, String)> = pf
        .keys
        .iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .map(|(k, tpl)| (k.clone(), interpolate(tpl, vars)))
        .collect();
    if resolved.is_empty() {
        return Ok(());
    }
    let existing = std::fs::read_to_string(&target).unwrap_or_default();
    let body = match pf.format.as_str() {
        "json" => upsert_json_str(&existing, &resolved)?,
        "yaml" => upsert_yaml_str(&existing, &resolved),
        _ => upsert_dotenv_str(&existing, &resolved),
    };
    std::fs::write(&target, body).map_err(|e| format!("write {}: {e}", target.display()))
}

/// Re-apply every key-based provisioned file's keys with fresh `vars` (e.g. after
/// a port override, so dependent values like TOOLJET_SERVER_PORT follow). Skips
/// `text` files so their contents aren't re-copied.
pub fn reapply_provision(wt_path: &str, repo_path: &str, vars: &HashMap<String, String>) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    for pf in cfg.provision.iter().filter(|p| p.format != "text") {
        provision_file(wt_path, repo_path, pf, vars)?;
    }
    Ok(())
}

/// Provision a worktree: apply declarative env overrides, then run setup
/// commands (sequentially, via login shell on the pinned Node, with `vars`
/// exposed as env so commands can reference $WT_SERVER_PORT etc.).
/// Streams progress; stops at the first failure.
pub async fn run_setup(
    wt_path: &str,
    repo_path: &str,
    vars: &HashMap<String, String>,
    parallel: bool,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);

    if !cfg.provision.is_empty() {
        progress(format!("provisioning {} file(s)", cfg.provision.len()));
        for pf in &cfg.provision {
            progress(format!("  → {} ({})", pf.path, pf.format));
            provision_file(wt_path, repo_path, pf, vars)?;
        }
    }
    if parallel && cfg.setup.len() > 1 {
        return run_commands_parallel(wt_path, repo_path, &cfg.setup, vars, &mut progress).await;
    }
    run_commands(wt_path, repo_path, &cfg.setup, vars, "setup", &mut progress).await
}

/// Run every setup command at once (the `parallel-setup` experiment).
///
/// Correct only when the tasks are independent; the experiment's own copy says
/// so, and that is exactly why it is an experiment rather than the default.
/// Ordinary setup lists routinely encode a dependency ("install, then
/// migrate") that no static analysis here could detect.
///
/// Output is funnelled through one channel rather than shared `&mut` progress,
/// so interleaved lines stay whole and each is prefixed with its task number —
/// without that, parallel output is unreadable.
async fn run_commands_parallel(
    wt_path: &str,
    repo_path: &str,
    cmds: &[String],
    vars: &HashMap<String, String>,
    progress: &mut impl FnMut(String),
) -> Result<(), String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let n = cmds.len();
    progress(format!("setup [parallel]: running {n} tasks at once"));

    let mut handles = Vec::with_capacity(n);
    for (i, cmd) in cmds.iter().enumerate() {
        let (wt, repo, cmd, vars, tx) = (wt_path.to_string(), repo_path.to_string(), cmd.clone(), vars.clone(), tx.clone());
        handles.push(tauri::async_runtime::spawn(async move {
            let label = format!("setup [{}/{n}]", i + 1);
            let one = [cmd];
            let tx2 = tx.clone();
            let mut fwd = move |line: String| {
                let _ = tx2.send(format!("{label} {line}"));
            };
            run_commands(&wt, &repo, &one, &vars, "setup", &mut fwd).await
        }));
    }
    drop(tx); // the loop below ends when every task's sender is gone

    while let Some(line) = rx.recv().await {
        progress(line);
    }

    // Every task is awaited even after one fails: leaving the others running
    // detached would let a half-finished install keep writing into a worktree
    // the caller has already been told is broken.
    let mut first_error: Option<String> = None;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                first_error.get_or_insert(e);
            }
            Err(e) => {
                first_error.get_or_insert(format!("setup task panicked: {e}"));
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Run a worktree's teardown commands (e.g. drop its database) before deletion.
pub async fn run_teardown(
    wt_path: &str,
    repo_path: &str,
    vars: &HashMap<String, String>,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    run_commands(wt_path, repo_path, &cfg.teardown, vars, "teardown", &mut progress).await
}

pub fn has_teardown(wt_path: &str, repo_path: &str) -> bool {
    !read_config(wt_path, repo_path).teardown.is_empty()
}

/// Run the worktree's configured migration commands (`migrate` in the config).
pub async fn run_migration(
    wt_path: &str,
    repo_path: &str,
    vars: &HashMap<String, String>,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    if cfg.migrate.is_empty() {
        return Err("No migrate command configured (\"migrate\" in .worktreemanager.json)".into());
    }
    run_commands(wt_path, repo_path, &cfg.migrate, vars, "migrate", &mut progress).await
}

/// Run a single ad-hoc command (a repo "custom command") in the worktree root on
/// the pinned Node, streaming progress — same execution model as setup/migrate.
pub async fn run_custom_command(
    wt_path: &str,
    repo_path: &str,
    command: &str,
    vars: &HashMap<String, String>,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    let cmds = [command.to_string()];
    run_commands(wt_path, repo_path, &cmds, vars, "command", &mut progress).await
}

/// Minimum gap between forwarded output lines — npm can emit thousands of
/// lines; anything faster than this is dropped (step markers always pass).
const STREAM_THROTTLE: std::time::Duration = std::time::Duration::from_millis(120);

/// Run a list of commands sequentially via login shell on the pinned Node, with
/// `vars` + path vars exposed. Streams each command's output line-by-line
/// through `progress` (throttled); stops at the first failure.
async fn run_commands(
    wt_path: &str,
    repo_path: &str,
    cmds: &[String],
    vars: &HashMap<String, String>,
    label: &str,
    progress: &mut impl FnMut(String),
) -> Result<(), String> {
    for (i, cmd) in cmds.iter().enumerate() {
        progress(format!("{label} [{}/{}]: {cmd}", i + 1, cmds.len()));
        let wrapped = crate::toolchain::with_pinned_node(wt_path, cmd);
        let (shell, shargs) = crate::toolchain::shell_argv(&wrapped);
        let mut child = Command::new(shell)
            .args(&shargs)
            .current_dir(wt_path)
            .envs(vars) // WT_*/WM_* etc.
            .env("WTM_REPO", repo_path)
            .env("WTM_WORKTREE", wt_path)
            .env("REPO_PATH", repo_path)
            .env("WT_PATH", wt_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{label} spawn failed: {e}"))?;

        let mut out_lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut err_lines = BufReader::new(child.stderr.take().unwrap()).lines();
        // last stderr lines, kept for the failure message
        let mut stderr_tail: VecDeque<String> = VecDeque::new();
        let mut last_emit = std::time::Instant::now() - STREAM_THROTTLE;
        let mut emit = |line: &str, progress: &mut dyn FnMut(String)| {
            let t = line.trim_end();
            if t.is_empty() {
                return;
            }
            if last_emit.elapsed() >= STREAM_THROTTLE {
                progress(t.to_string());
                last_emit = std::time::Instant::now();
            }
        };
        // hard ceiling per command: npm installs legitimately run long, but a
        // command stuck on a dead registry or waiting for input it can never
        // get (stdin is null) must not hang setup forever.
        const STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 60);
        let run_fut = async {
            let (mut out_done, mut err_done) = (false, false);
            while !(out_done && err_done) {
                tokio::select! {
                    l = out_lines.next_line(), if !out_done => match l {
                        Ok(Some(line)) => emit(&line, progress),
                        _ => out_done = true,
                    },
                    l = err_lines.next_line(), if !err_done => match l {
                        Ok(Some(line)) => {
                            stderr_tail.push_back(line.clone());
                            if stderr_tail.len() > 64 {
                                stderr_tail.pop_front();
                            }
                            emit(&line, progress);
                        }
                        _ => err_done = true,
                    },
                }
            }
            child.wait().await
        };
        let status = match tokio::time::timeout(STEP_TIMEOUT, run_fut).await {
            Ok(res) => res.map_err(|e| format!("{label} wait failed: {e}"))?,
            Err(_) => {
                // kills the shell; its own children get EOF on the shared pipes
                let _ = child.kill().await;
                return Err(format!("{label} step timed out after {}min: {cmd}", STEP_TIMEOUT.as_secs() / 60));
            }
        };
        if !status.success() {
            // surface the first real error line plus the tail, so messages like
            // "Cannot find module" aren't buried under a stack.
            let headline = stderr_tail
                .iter()
                .find(|l| {
                    let t = l.trim_start();
                    t.starts_with("Error") || t.contains("npm error") || t.contains("ERR!") || t.contains("Cannot find")
                })
                .map(|l| format!("{}\n", l.trim()))
                .unwrap_or_default();
            let tail: Vec<&str> = stderr_tail.iter().rev().take(10).map(|s| s.as_str()).collect();
            let tail: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("{label} step failed: {cmd}\n{headline}{tail}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wt_slug_is_db_safe() {
        assert_eq!(wt_slug("/Users/me/wt/Feat-X.2"), "feat_x_2");
        assert_eq!(wt_slug("/w/plain"), "plain");
    }

    #[test]
    fn interpolates_braced_vars() {
        let mut v = HashMap::new();
        v.insert("WT_DB_NAME".to_string(), "tooljet_feature_x".to_string());
        v.insert("WT_SERVER_PORT".to_string(), "3010".to_string());
        assert_eq!(interpolate("${WT_DB_NAME}", &v), "tooljet_feature_x");
        assert_eq!(interpolate("http://localhost:${WT_SERVER_PORT}/api", &v), "http://localhost:3010/api");
        assert_eq!(interpolate("${UNKNOWN}", &v), "${UNKNOWN}"); // left as-is
    }

    #[test]
    fn dotenv_upserts_and_preserves() {
        let existing = "PG_HOST=localhost\nPG_DB=tooljet_prod\nPORT=3000\nSECRET=keep\n";
        let pairs = vec![
            ("PG_DB".to_string(), "tooljet_feature_x".to_string()),
            ("PORT".to_string(), "3010".to_string()),
            ("TOOLJET_SERVER_PORT".to_string(), "3010".to_string()),
        ];
        let out = upsert_dotenv_str(existing, &pairs);
        assert!(out.contains("PG_HOST=localhost"), "preserves untouched keys");
        assert!(out.contains("SECRET=keep"), "preserves untouched keys");
        assert!(out.contains("PG_DB=tooljet_feature_x"), "replaces PG_DB");
        assert!(out.contains("PORT=3010"), "replaces PORT");
        assert!(out.contains("TOOLJET_SERVER_PORT=3010"), "adds new key");
        assert_eq!(out.matches("PG_DB=").count(), 1, "no duplicate keys");
        assert_eq!(out.matches("PORT=").count(), 2, "PORT + TOOLJET_SERVER_PORT only");
    }

    #[test]
    fn json_upserts_dotted_keys() {
        let existing = "{\n  \"baseUrl\": \"http://old\",\n  \"keep\": true\n}";
        let pairs = vec![
            ("baseUrl".to_string(), "http://localhost:8082".to_string()),
            ("db.name".to_string(), "tooljet_feature_x".to_string()),
        ];
        let out = upsert_json_str(existing, &pairs).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["baseUrl"], "http://localhost:8082", "replaces top-level scalar");
        assert_eq!(v["db"]["name"], "tooljet_feature_x", "creates nested from dotted key");
        assert_eq!(v["keep"], true, "preserves untouched keys");
    }

    #[test]
    fn dotenv_handles_export_prefix() {
        let existing = "export PG_DB=old\nKEEP=1\n";
        let pairs = vec![("PG_DB".to_string(), "new_db".to_string())];
        let out = upsert_dotenv_str(existing, &pairs);
        assert!(out.contains("PG_DB=new_db"), "replaces export-prefixed key");
        assert!(!out.contains("export PG_DB=old"), "old export line removed");
        assert!(out.contains("KEEP=1"), "preserves other lines");
        assert_eq!(out.matches("PG_DB=").count(), 1, "no duplicate keys");
    }

    #[test]
    fn json_refuses_malformed_input() {
        // JSONC / trailing commas / half-edited files must NOT be wiped to {}
        let malformed = "{ \"a\": 1, }";
        let pairs = vec![("a".to_string(), "2".to_string())];
        let err = upsert_json_str(malformed, &pairs).unwrap_err();
        assert!(err.contains("malformed JSON"), "surfaces a parse error: {err}");
        // empty input is still fine (fresh file)
        assert!(upsert_json_str("", &pairs).is_ok());
    }

    #[test]
    fn write_repo_config_preserves_extras_and_refuses_malformed() {
        let dir = std::env::temp_dir().join("canopy_cfg_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cfg_path = dir.join(".worktreemanager.json");

        // valid existing file with extra keys → preserved, legacy env dropped
        std::fs::write(&cfg_path, r#"{ "env": {"A": "1"}, "teardown": ["dropdb"], "migrate": ["npm run m"] }"#).unwrap();
        let prov = vec![ProvisionFile {
            path: ".env".into(),
            format: "dotenv".into(),
            from: String::new(),
            interpolate: false,
            keys: vec![("A".into(), "1".into())],
        }];
        write_repo_config(dir.to_str().unwrap(), &prov, &["echo hi".into()]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert!(v.get("env").is_none(), "legacy env dropped");
        assert_eq!(v["teardown"][0], "dropdb", "teardown preserved");
        assert_eq!(v["migrate"][0], "npm run m", "migrate preserved");
        assert_eq!(v["provision"][0]["path"], ".env");
        assert_eq!(v["$schema"], "canopy://worktree-manager/v1");

        // malformed existing file → hard error, file untouched
        std::fs::write(&cfg_path, "{ not json").unwrap();
        let err = write_repo_config(dir.to_str().unwrap(), &prov, &[]).unwrap_err();
        assert!(err.contains("malformed"), "refuses to overwrite: {err}");
        assert_eq!(std::fs::read_to_string(&cfg_path).unwrap(), "{ not json", "file untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_config_migrates_legacy_env() {
        let dir = std::env::temp_dir().join("canopy_legacy_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".worktreemanager.json"),
            r#"{ "env": {"PG_DB": "${WT_DB_NAME}"}, "setup": ["echo hi"] }"#,
        )
        .unwrap();
        let c = read_repo_config(dir.to_str().unwrap());
        assert_eq!(c.provision.len(), 1, "legacy env becomes one provision entry");
        assert_eq!(c.provision[0].path, ".env");
        assert_eq!(c.provision[0].format, "dotenv");
        assert_eq!(c.provision[0].keys, vec![("PG_DB".to_string(), "${WT_DB_NAME}".to_string())]);
        assert_eq!(c.setup, vec!["echo hi"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn provision_rejects_escaping_paths() {
        let dir = std::env::temp_dir().join("canopy_contain_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vars = HashMap::new();
        let mk = |path: &str, from: &str| ProvisionFile {
            path: path.into(),
            format: "dotenv".into(),
            from: from.into(),
            interpolate: false,
            keys: vec![("K".into(), "v".into())],
        };
        let d = dir.to_str().unwrap();
        assert!(provision_file(d, d, &mk("../escape.env", ""), &vars).is_err(), "rejects ..");
        assert!(provision_file(d, d, &mk("/etc/hosts", ""), &vars).is_err(), "rejects absolute");
        assert!(provision_file(d, d, &mk("ok.env", "../secrets"), &vars).is_err(), "rejects .. in from");
        assert!(provision_file(d, d, &mk("sub/ok.env", ""), &vars).is_ok(), "accepts subpath");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn yaml_detects_four_space_indent() {
        let existing = "development:\n    database: old_db\n    host: localhost\n";
        let pairs = vec![
            ("development.database".to_string(), "new_db".to_string()),
            ("production.database".to_string(), "prod_db".to_string()),
        ];
        let out = upsert_yaml_str(existing, &pairs);
        assert!(out.contains("    database: new_db"), "replaces at the file's own indent: {out}");
        assert_eq!(out.matches("database:").count(), 2, "replaced + appended, no duplicates: {out}");
        assert!(out.contains("production:\n    database: prod_db"), "appends with detected indent: {out}");
    }

    #[test]
    fn yaml_replaces_existing_and_appends_missing() {
        let existing = "# db config\ndevelopment:\n  database: old_db\n  host: localhost\ntest:\n  database: old_test\n";
        let pairs = vec![
            ("development.database".to_string(), "tooljet_feature_x".to_string()),
            ("test.database".to_string(), "tooljet_feature_x_test".to_string()),
            ("production.database".to_string(), "brand_new".to_string()),
        ];
        let out = upsert_yaml_str(existing, &pairs);
        assert!(out.contains("# db config"), "preserves comments");
        assert!(out.contains("  database: tooljet_feature_x\n"), "replaces nested value");
        assert!(out.contains("  host: localhost"), "preserves sibling");
        assert!(out.contains("  database: tooljet_feature_x_test"), "replaces second block");
        assert!(out.contains("production:") && out.contains("  database: brand_new"), "appends missing block");
    }
}
