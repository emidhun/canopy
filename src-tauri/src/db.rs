// Built-in Postgres helpers for the snapshot / switch-database features.
// Connection params come from the worktree's .env (standard PG_* keys), so the
// user configures nothing — they just click. All CLIs run via a login shell so
// psql/pg_dump/createdb resolve (Postgres.app etc.), with PGPASSWORD injected.
use std::collections::HashMap;
use std::path::Path;
use tokio::process::Command;

/// PG_* connection settings read from a worktree's .env.
pub struct PgConn {
    pub host: String,
    pub port: String,
    pub user: String,
    pub pass: Option<String>,
    pub db: String,
}

fn read_env(wt_path: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Ok(txt) = std::fs::read_to_string(Path::new(wt_path).join(".env")) {
        for line in txt.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                m.insert(k.trim().to_string(), v.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    m
}

pub fn conn(wt_path: &str) -> Result<PgConn, String> {
    let e = read_env(wt_path);
    let db = e.get("PG_DB").cloned().ok_or("PG_DB not set in this worktree's .env")?;
    Ok(PgConn {
        host: e.get("PG_HOST").cloned().unwrap_or_else(|| "localhost".into()),
        port: e.get("PG_PORT").cloned().unwrap_or_else(|| "5432".into()),
        user: e.get("PG_USER").cloned().unwrap_or_else(|| "postgres".into()),
        pass: e.get("PG_PASS").cloned().filter(|s| !s.is_empty()),
        db,
    })
}

impl PgConn {
    /// `-h host -p port -U user` shared connection args.
    fn args(&self) -> Vec<String> {
        vec!["-h".into(), self.host.clone(), "-p".into(), self.port.clone(), "-U".into(), self.user.clone()]
    }
}

/// Cap for one Postgres CLI invocation — dumps/restores of big databases take
/// a while, but a hung server must not wedge the command forever.
const PG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(900);

/// Run a shell command line in the worktree dir with PGPASSWORD set.
async fn run(wt_path: &str, c: &PgConn, cmdline: &str) -> Result<String, String> {
    let (shell, shargs) = crate::toolchain::shell_argv(cmdline);
    let mut cmd = Command::new(shell);
    cmd.args(&shargs).current_dir(wt_path).kill_on_drop(true);
    if let Some(p) = &c.pass {
        cmd.env("PGPASSWORD", p);
    }
    let out = match tokio::time::timeout(PG_TIMEOUT, cmd.output()).await {
        Ok(res) => res.map_err(|e| format!("failed to run: {e}"))?,
        Err(_) => return Err(format!("database command timed out after {}s", PG_TIMEOUT.as_secs())),
    };
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

/// shell-quote a single argument (wrap in single quotes, escape embedded quotes)
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The server's major version (e.g. 16) via `SHOW server_version_num`. `None` if
/// it can't be read (any client psql can run this against any server).
async fn server_major(wt_path: &str, c: &PgConn) -> Option<u32> {
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let out = run(
        wt_path,
        c,
        &format!("psql {conn_args} -d {} -tAc {}", q(&c.db), q("SHOW server_version_num")),
    )
    .await
    .ok()?;
    out.trim().parse::<u32>().ok().map(|n| n / 10000)
}

/// Return an `export PATH="<bin>:$PATH"; ` prefix selecting a suitable
/// pg_dump/pg_restore. Prefer the binaries matching the **server's** major
/// version: a dump from a newer client emits directives the server can't restore
/// (e.g. PG17's `SET transaction_timeout` into a PG16 server) and produces a
/// newer archive an older pg_restore can't read. Only when no exact match is
/// installed fall back to the newest available (newer can dump older).
fn pg_path_prefix_for(server_major: Option<u32>) -> String {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(maj) = server_major {
        candidates.push(format!("/Applications/Postgres.app/Contents/Versions/{maj}/bin"));
        candidates.push(format!("/opt/homebrew/opt/postgresql@{maj}/bin"));
        candidates.push(format!("/usr/local/opt/postgresql@{maj}/bin"));
        #[cfg(target_os = "windows")]
        candidates.push(format!("C:\\Program Files\\PostgreSQL\\{maj}\\bin"));
    }
    candidates.push("/Applications/Postgres.app/Contents/Versions/latest/bin".into());
    for major in (12..=18).rev() {
        candidates.push(format!("/Applications/Postgres.app/Contents/Versions/{major}/bin"));
        candidates.push(format!("/opt/homebrew/opt/postgresql@{major}/bin"));
        candidates.push(format!("/usr/local/opt/postgresql@{major}/bin"));
        #[cfg(target_os = "windows")]
        candidates.push(format!("C:\\Program Files\\PostgreSQL\\{major}\\bin"));
    }
    for dir in candidates {
        let p = Path::new(&dir);
        // pg_dump on Windows is pg_dump.exe; the command runs under Git Bash so
        // the emitted PATH entry is converted to MSYS form (see toolchain::bash_path)
        if p.join("pg_dump").exists() || p.join("pg_dump.exe").exists() {
            return format!("export PATH={}:\"$PATH\"; ", q(&crate::toolchain::bash_path(&dir)));
        }
    }
    String::new()
}

pub fn current_db(wt_path: &str) -> Option<String> {
    read_env(wt_path).get("PG_DB").cloned().filter(|s| !s.is_empty())
}

/// All non-template databases the connection user can see.
pub async fn list_databases(wt_path: &str) -> Result<Vec<String>, String> {
    let c = conn(wt_path)?;
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let sql = "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname";
    let out = run(wt_path, &c, &format!("psql {conn_args} -d {} -tAc {}", q(&c.db), q(sql))).await?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

pub async fn database_exists(wt_path: &str, name: &str) -> Result<bool, String> {
    Ok(list_databases(wt_path).await?.iter().any(|d| d == name))
}

/// Clone the worktree's current DB into a new database `target`. Uses a
/// pg_dump|pg_restore pipe so it works while the server is connected (no
/// template lock). Refuses to overwrite an existing database.
pub async fn clone_database(wt_path: &str, target: &str, mut progress: impl FnMut(String)) -> Result<(), String> {
    let c = conn(wt_path)?;
    if database_exists(wt_path, target).await? {
        return Err(format!("A database named '{target}' already exists"));
    }
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    progress(format!("creating database {target}…"));
    run(wt_path, &c, &format!("createdb {conn_args} {}", q(target))).await?;
    progress(format!("copying {} → {target}…", c.db));
    // custom-format dump piped straight into restore, using binaries matching the
    // server version so directives/archive format stay compatible on restore.
    // pipefail: a pipeline's status is otherwise the LAST command's — a failed
    // pg_dump feeding a tolerant pg_restore would report a truncated copy as ok.
    // (`|| true` keeps plain sh/dash working, where pipefail doesn't exist —
    // those shells just keep the old last-command semantics.)
    let line = format!(
        "{{ set -o pipefail; }} 2>/dev/null || true; {pre}pg_dump {conn_args} -Fc {src} | pg_restore {conn_args} --no-owner --no-acl -d {dst}",
        pre = pg_path_prefix_for(server_major(wt_path, &c).await),
        src = q(&c.db),
        dst = q(target),
    );
    run(wt_path, &c, &line).await?;
    progress("snapshot ready".into());
    Ok(())
}

/// Dump the worktree's current DB to a custom-format file at `file_path`.
pub async fn export_database(wt_path: &str, file_path: &str, mut progress: impl FnMut(String)) -> Result<(), String> {
    let c = conn(wt_path)?;
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    progress(format!("exporting {} to file…", c.db));
    let pre = pg_path_prefix_for(server_major(wt_path, &c).await);
    run(wt_path, &c, &format!("{pre}pg_dump {conn_args} -Fc {} -f {}", q(&c.db), q(file_path))).await?;
    progress("export complete".into());
    Ok(())
}

/// Restore a dump file INTO the worktree's current DB. Custom-format/.dump files
/// go through pg_restore (`--clean --if-exists` to replace existing objects); a
/// plain .sql file goes through psql. Binaries are matched to the server version.
pub async fn restore_database(wt_path: &str, file_path: &str, mut progress: impl FnMut(String)) -> Result<(), String> {
    let c = conn(wt_path)?;
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let pre = pg_path_prefix_for(server_major(wt_path, &c).await);
    progress(format!("restoring {} from file…", c.db));
    let line = if file_path.to_lowercase().ends_with(".sql") {
        // ON_ERROR_STOP=1: without it psql runs the whole script regardless of
        // failures and exits 0 — a half-restored database reported as success.
        format!("{pre}psql {conn_args} -d {db} -v ON_ERROR_STOP=1 -f {f}", db = q(&c.db), f = q(file_path))
    } else {
        format!(
            "{pre}pg_restore {conn_args} --no-owner --no-acl --clean --if-exists -d {db} {f}",
            db = q(&c.db),
            f = q(file_path),
        )
    };
    run(wt_path, &c, &line).await?;
    progress("restore complete".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::q;
    #[test]
    fn quotes_args_safely() {
        assert_eq!(q("tooljet_main"), "'tooljet_main'");
        assert_eq!(q("a'b"), "'a'\\''b'");
    }
}
