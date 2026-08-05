mod commands;
mod db;
mod error;
mod git;
mod proc;
mod services;
mod settings;
mod setup;
mod state;
mod stats;
#[cfg(feature = "devtools")]
mod suite;
mod terminal;
mod toolchain;
mod tray;

use services::ProcTable;
use state::AppState;
use tauri::Manager;
use terminal::TermTable;

/// Is any Canopy window (main / popover / detached terminal) on screen?
/// Gates the background refresh + stats loops — work nobody can see.
pub(crate) fn any_window_visible(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_visible().unwrap_or(false))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // GUI apps on macOS get a bare PATH; fix it so git/node/nvm resolve.
    let _ = fix_path_env::fix();

    let builder = tauri::Builder::default()
        // MUST be first: a second instance exits immediately after notifying
        // the first. Without this, instance B's startup sweep reads instance
        // A's persisted *live* pgids and SIGTERMs A's running services, and
        // both instances race on settings.json/state.json writes.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(
            // rolling log file in the platform log dir (~/Library/Logs/… on
            // macOS) + stderr echo for dev. INFO default; RUST_LOG overrides.
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("canopy".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stderr),
                ])
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_dialog::init());
    // NSPanel plugin is macOS-only; other platforms use a plain popover window.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .setup(|app| {
            let handle = app.handle().clone();
            tray::init(&handle)?;
            app.manage(AppState::new(
                settings::load_settings(&handle),
                settings::load_runtime(&handle),
            ));
            app.manage(ProcTable::default());
            app.manage(TermTable::default());

            // kill process groups left over from a crashed previous run
            services::sweep_orphans(&handle);
            terminal::sweep_orphans(&handle);

            stats::spawn_stats_task(handle.clone());

            // periodically sweep idle shell terminals (bounds long-run memory)
            {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                        if let Some(table) = handle.try_state::<TermTable>() {
                            terminal::sweep_idle(&table);
                        }
                    }
                });
            }

            // initial scan + 60s background git refresh. The app lives in the
            // tray — while no window is visible nobody can see git meta, so
            // the periodic tick is skipped (show_main_window / the popover
            // toggle kick an immediate refresh when a window comes back).
            tauri::async_runtime::spawn(async move {
                let _ = state::refresh_tree(&handle).await;
                state::refresh_all_git_meta(&handle).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    if !any_window_visible(&handle) {
                        continue;
                    }
                    let _ = state::refresh_tree(&handle).await;
                    state::refresh_all_git_meta(&handle).await;
                }
            });

            // headless end-to-end suite: WTM_SUITE=<repoId>
            #[cfg(feature = "devtools")]
            if let Ok(repo_id) = std::env::var("WTM_SUITE") {
                suite::run(app.handle().clone(), repo_id);
            }

            // headless smoke test of the process layer: WTM_SELFTEST=<svcKey>
            // (Unix-only: it pokes pgids with killpg to verify the group died)
            #[cfg(all(unix, feature = "devtools"))]
            if let Ok(key) = std::env::var("WTM_SELFTEST") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    eprintln!("[selftest] starting {key}");
                    match services::start_service(&handle, &key).await {
                        Err(e) => eprintln!("[selftest] FAIL start: {e}"),
                        Ok(()) => {
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                            let (running, pgid) = {
                                let table = handle.state::<ProcTable>();
                                let procs = table.procs.lock();
                                (procs.contains_key(&key), procs.get(&key).map(|p| crate::proc::group_key(&p.group) as i32))
                            };
                            let log_len = {
                                let table = handle.state::<ProcTable>();
                                let logs = table.logs.lock();
                                logs.get(&key).map(|b| b.len()).unwrap_or(0)
                            };
                            eprintln!("[selftest] running={running} pgid={pgid:?} log_lines={log_len}");
                            let _ = services::stop_service(&handle, &key).await;
                            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                            let table = handle.state::<ProcTable>();
                            let gone = table.procs.lock().is_empty();
                            let pg_dead = pgid.map(|p| unsafe { libc::killpg(p, 0) != 0 }).unwrap_or(true);
                            eprintln!("[selftest] after stop: table_empty={gone} pgid_dead={pg_dead}");
                            eprintln!("[selftest] {}", if running && gone && pg_dead && log_len > 0 { "PASS" } else { "FAIL" });
                        }
                    }
                });
            }
            // headless create+start test: WTM_SELFTEST_CREATE="repoId|branch|serviceId"
            #[cfg(feature = "devtools")]
            if let Ok(spec) = std::env::var("WTM_SELFTEST_CREATE") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let parts: Vec<&str> = spec.split('|').collect();
                    if parts.len() != 3 {
                        eprintln!("[ct] FAIL: WTM_SELFTEST_CREATE wants repoId|branch|serviceId, got {spec:?}");
                        return;
                    }
                    let (repo_id, branch, service_id) = (parts[0], parts[1], parts[2]);
                    eprintln!("[ct] create_worktree repo={repo_id} branch={branch}");
                    match commands::create_worktree(
                        handle.clone(),
                        repo_id.to_string(),
                        branch.to_string(),
                        Some("HEAD".to_string()),
                        true,
                    )
                    .await
                    {
                        Err(e) => eprintln!("[ct] FAIL create: {e}"),
                        Ok(wt_path) => {
                            eprintln!("[ct] created at {wt_path}");
                            let svc_key = format!("{wt_path}::{service_id}");
                            // confirm the new service is in the tree
                            let in_tree = {
                                let st = handle.state::<state::AppState>();
                                let tree = st.tree.read();
                                tree.iter().flat_map(|r| r.worktrees.iter()).flat_map(|w| w.services.iter()).any(|s| s.svc_key == svc_key)
                            };
                            eprintln!("[ct] service {svc_key} in tree: {in_tree}");
                            match services::start_service(&handle, &svc_key).await {
                                Err(e) => eprintln!("[ct] FAIL start: {e}"),
                                Ok(()) => {
                                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                                    let running = {
                                        let t = handle.state::<services::ProcTable>();
                                        let p = t.procs.lock();
                                        p.contains_key(&svc_key)
                                    };
                                    eprintln!("[ct] running={running}");
                                    let _ = services::stop_service(&handle, &svc_key).await;
                                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                    eprintln!("[ct] {}", if in_tree && running { "PASS" } else { "FAIL" });
                                }
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // main window close = hide to tray; the app lives in the menu bar
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    // macOS: drop out of the Dock while only the tray is showing
                    #[cfg(target_os = "macos")]
                    let _ = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_tree,
            commands::refresh,
            commands::get_settings,
            commands::save_settings,
            commands::add_repo,
            commands::detect_repo,
            commands::remove_repo,
            commands::git_pull,
            commands::submodule_status,
            commands::pull_submodule,
            commands::switch_submodule_branch,
            commands::list_submodule_branches,
            commands::fetch_submodules,
            commands::switch_worktree_branch,
            commands::list_branches,
            commands::fetch_branches,
            commands::get_repo_config,
            commands::save_repo_config,
            commands::save_text_file,
            commands::get_logs,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_get_buffer,
            commands::terminal_close,
            commands::write_worktree_context,
            commands::resolve_agent_command,
            commands::service_start,
            commands::service_stop,
            commands::service_restart,
            commands::worktree_start_all,
            commands::worktree_stop_all,
            commands::reset_db,
            commands::open_in_editor,
            commands::open_file_in_editor,
            commands::reveal_in_finder,
            commands::open_terminal,
            commands::open_port,
            commands::show_main_window,
            commands::quit_app,
            commands::create_worktree,
            commands::run_worktree_setup,
            commands::worktree_dirty_report,
            commands::remove_worktree,
            commands::list_databases,
            commands::current_database,
            commands::snapshot_database,
            commands::export_database,
            commands::restore_database,
            commands::switch_database,
            commands::set_service_port,
            commands::run_migration,
            commands::run_custom_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Cmd-Q / app exit: kill every spawned process group before dying
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // kill embedded terminal shells before their host process dies
                if let Some(table) = app.try_state::<TermTable>() {
                    terminal::close_all(&table);
                }
                let handle = app.clone();
                tauri::async_runtime::block_on(async move {
                    services::stop_all(&handle).await;
                });
            }
        });
}
