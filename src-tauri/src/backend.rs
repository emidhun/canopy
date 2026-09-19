//! Foreground, GUI-free runtime host. Transports attach in subsequent slices.
use crate::{ownership, runtime::{Audience, Host, RuntimeContext, RuntimePaths}, settings, state::AppState};
use std::{future::Future, sync::Arc, time::Duration};

const APP_ID: &str = "com.midhunkumare.canopy";

/// Keep these identical to Tauri's desktop PathResolver defaults.
pub fn default_paths() -> Result<RuntimePaths, String> {
    let config = dirs::config_dir().ok_or("cannot resolve configuration directory")?.join(APP_ID);
    let data = dirs::data_dir().ok_or("cannot resolve data directory")?.join(APP_ID);
    #[cfg(target_os = "macos")]
    let logs = dirs::home_dir().ok_or("cannot resolve home directory")?.join("Library/Logs").join(APP_ID);
    #[cfg(not(target_os = "macos"))]
    let logs = dirs::data_local_dir().ok_or("cannot resolve local data directory")?.join(APP_ID).join("logs");
    Ok(RuntimePaths { config, data, logs })
}

struct HeadlessHost;
impl Host for HeadlessHost {
    fn interested(&self, _: Audience) -> bool { false }
    fn publish(&self, _: Audience, _: &str, _: serde_json::Value) -> Result<(), String> { Ok(()) }
    fn notify(&self, _: &str, _: &str, _: bool) -> Result<(), String> { Ok(()) }
    fn badge(&self, _: &str, _: i64) {}
}

/// No state is read, quarantined, or swept until both owner checks succeed.
/// Every task's context clone retains the OS lock, including during shutdown.
pub fn open(paths: RuntimePaths) -> Result<RuntimeContext, String> {
    let owner = ownership::RuntimeOwner::acquire(&paths.data)?;
    ownership::refuse_legacy_desktop()?;
    let loaded: settings::Settings = settings::load_checked(&paths.config.join("settings.json"))?;
    let persisted = settings::load_checked(&paths.data.join("state.json"))?;
    ownership::verify_recovery(&persisted)?;
    crate::git::apply_credentials(&loaded.security.ssh_key, &loaded.security.credential_helper);
    Ok(RuntimeContext::with_owner(
        AppState::new(loaded, persisted), paths, tokio::runtime::Handle::current(),
        Arc::new(HeadlessHost), owner,
    ))
}

/// A foreground supervisor: any unexpected periodic-task exit is fatal and
/// takes the same cleanup path as an explicit stop. Never silently lose a loop.
/// There is no UI lifecycle hook here; closing a client cannot stop this host.
pub async fn serve(app: RuntimeContext, stop: impl Future<Output = Result<(), String>>) -> Result<(), String> {
    crate::services::sweep_orphans(&app);
    crate::terminal::sweep_orphans(&app);
    let mut stats = crate::stats::spawn_stats_task(app.clone());
    let mut updates = crate::updates::spawn_check_task(app.clone());
    let mut refresh = {
        let app = app.clone();
        tokio::spawn(async move {
            loop {
                crate::state::refresh_all(&app).await;
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        })
    };
    let mut terminals = {
        let app = app.clone();
        tokio::spawn(async move {
            let mut ticks = 0u16;
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                crate::terminal::poll_states(&app);
                ticks += 1;
                if ticks == 300 {
                    crate::terminal::sweep_idle(&app, app.state());
                    ticks = 0;
                }
            }
        })
    };
    let outcome = tokio::select! {
        result = stop => result,
        result = &mut stats => Err(format!("stats task stopped unexpectedly: {result:?}")),
        result = &mut updates => Err(format!("update task stopped unexpectedly: {result:?}")),
        result = &mut refresh => Err(format!("refresh task stopped unexpectedly: {result:?}")),
        result = &mut terminals => Err(format!("terminal monitor stopped unexpectedly: {result:?}")),
    };
    // Abort before stopping children so periodic state refresh cannot race
    // cleanup. Join only unfinished handles: select may have consumed one.
    for task in [&mut stats, &mut updates, &mut refresh, &mut terminals] {
        if !task.is_finished() { task.abort(); let _ = task.await; }
    }
    crate::terminal::close_all(app.state());
    crate::services::stop_all(&app).await;
    if !app.state::<crate::services::ProcTable>().procs.lock().is_empty() {
        return Err("backend shutdown timed out waiting for services to exit".into());
    }
    outcome
}

/// Register before runtime startup so a signal cannot bypass graceful cleanup.
pub fn shutdown_signal() -> Result<impl Future<Output = Result<(), String>>, String> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut interrupt = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
        let mut terminate = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
        Ok(async move {
            tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
            Ok(())
        })
    }
    #[cfg(windows)]
    {
        let mut interrupt = tokio::signal::windows::ctrl_c().map_err(|e| e.to_string())?;
        let mut close = tokio::signal::windows::ctrl_close().map_err(|e| e.to_string())?;
        let mut shutdown = tokio::signal::windows::ctrl_shutdown().map_err(|e| e.to_string())?;
        Ok(async move {
            tokio::select! { _ = interrupt.recv() => {}, _ = close.recv() => {}, _ = shutdown.recv() => {} }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("canopy-host-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn paths(&self) -> RuntimePaths {
            RuntimePaths { config: self.0.clone(), data: self.0.clone(), logs: self.0.clone() }
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[tokio::test]
    async fn lock_is_checked_before_reading_or_rewriting_corrupt_state() {
        let fixture = Fixture::new();
        let bytes = b"not valid JSON";
        std::fs::write(fixture.0.join("state.json"), bytes).unwrap();
        let owner = ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        assert!(open(fixture.paths()).err().unwrap().contains("another Canopy backend"));
        drop(owner);
        assert!(open(fixture.paths()).err().unwrap().contains("parse"));
        assert_eq!(std::fs::read(fixture.0.join("state.json")).unwrap(), bytes);
        assert!(!fixture.0.join("state.json.corrupt").exists());
    }

    #[tokio::test]
    async fn context_clones_retain_ownership_until_the_last_task_finishes() {
        let fixture = Fixture::new();
        let app = open(fixture.paths()).unwrap();
        let client = app.clone();
        serve(app, async { Ok(()) }).await.unwrap();
        assert!(ownership::RuntimeOwner::acquire(&fixture.0).is_err());
        drop(client);
        let owner = ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        drop(owner);
    }

    #[tokio::test]
    async fn client_detach_preserves_service_and_explicit_stop_reaps_it() {
        let fixture = Fixture::new();
        for args in [vec!["init", "-b", "main"], vec!["-c", "user.name=Canopy Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]] {
            let result = std::process::Command::new("git").args(args).current_dir(&fixture.0).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        }
        let mut config = settings::Settings::default();
        config.updates.auto_check = false;
        config.repos.push(settings::RepoCfg {
            id: "fixture".into(), path: fixture.0.to_string_lossy().into_owned(),
            services: vec![settings::ServiceCfg {
                id: "worker".into(), name: "Worker".into(), command: "sleep 120".into(),
                ..Default::default()
            }], ..Default::default()
        });
        std::fs::write(fixture.0.join("settings.json"), serde_json::to_vec(&config).unwrap()).unwrap();
        let app = open(fixture.paths()).unwrap();
        crate::state::refresh_tree(&app).await.unwrap();
        let key = app.state::<AppState>().tree.read()[0].worktrees[0].services[0].svc_key.clone();
        crate::services::start_service(&app, &key).await.unwrap();
        let client = app.events().subscribe(crate::events::SubscriptionKind::Application).unwrap();
        let (send, receive) = tokio::sync::oneshot::channel();
        let host = tokio::spawn(serve(app.clone(), async { receive.await.map_err(|e| e.to_string()) }));
        drop(client);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let survived = app.state::<crate::services::ProcTable>().procs.lock().contains_key(&key);
        send.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), host).await;
        assert!(survived, "client disconnect stopped the service");
        result.unwrap().unwrap().unwrap();
        assert!(app.state::<crate::services::ProcTable>().procs.lock().is_empty());
        assert!(app.state::<AppState>().runtime.read().orphans.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_live_legacy_child_is_never_recovered_as_an_orphan() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
        let pid = child.id();
        let state = settings::RuntimeState {
            orphans: vec![settings::OrphanProc {
                pgid: pid as i32,
                spawn_time_secs: 0, // legacy records may lack identity data
                ..Default::default()
            }], ..Default::default()
        };
        let rejected = ownership::verify_recovery(&state).is_err();
        let parent_rejected = !ownership::orphan_parent_verified(pid);
        let still_alive = child.try_wait().unwrap().is_none();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(rejected && parent_rejected && still_alive);
    }
}
