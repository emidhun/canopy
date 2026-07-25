import { useEffect, useMemo, useState } from "react";
import { initSync, useStore } from "../store";
import { isLive } from "../types";
import { ChevRight, Fork, Logs, Plus, Refresh, Settings } from "../icons";
import Sidebar from "./Sidebar";
import WorktreeHeader from "./WorktreeHeader";
import ServiceCard from "./ServiceCard";
import DatabaseControl from "./DatabaseControl";
import Console from "./Console";
import AgentLane from "./AgentLane";
import SettingsView from "./SettingsView";
import NewWorktreeModal from "./NewWorktreeModal";
import RemoveWorktreeModal from "./RemoveWorktreeModal";
import Onboarding from "../onboarding/Onboarding";

export default function App() {
  const tree = useStore((s) => s.tree);
  const selKey = useStore((s) => s.selKey);
  const toast = useStore((s) => s.toast);
  const showToast = useStore((s) => s.showToast);
  const mainRailed = useStore((s) => s.mainRailed);
  const setMainRailed = useStore((s) => s.setMainRailed);
  const [, setTick] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewWt, setShowNewWt] = useState(false);
  const [removeWt, setRemoveWt] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [obDismissed, setObDismissed] = useState(false);

  useEffect(() => initSync(), []);
  // uptime re-render
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const sel = useMemo(() => {
    for (const r of tree) for (const w of r.worktrees) if (w.wtKey === selKey) return { repo: r, wt: w };
    const r = tree[0];
    return r ? { repo: r, wt: r.worktrees[0] } : null;
  }, [tree, selKey]);

  const refresh = () => {
    showToast("Rescanning worktrees…");
    import("../ipc").then(({ hasBackend, ipc }) => {
      if (hasBackend()) ipc.refresh().catch(() => {});
    });
  };

  const running = sel?.wt ? sel.wt.services.filter((s) => isLive(s.status)).length : 0;
  // first run (no repos configured) → onboarding, unless the user skipped it
  const onboardingActive = showOnboarding || (tree.length === 0 && !obDismissed);

  return (
    <div className="shell">
      <div className="topbar" data-tauri-drag-region>
        <div className="tb-brand" data-tauri-drag-region>
          <span className="fork">
            <Fork size={13} />
          </span>
          Canopy
        </div>
        <div className="sp" data-tauri-drag-region />
        <button className="ib" title="Add repository" onClick={() => setShowOnboarding(true)}>
          <Plus size={15} />
        </button>
        <button className="ib" title="Rescan worktrees" onClick={refresh}>
          <Refresh size={15} />
        </button>
        <button className="ib" title="Settings" onClick={() => setShowSettings(true)}>
          <Settings size={15} />
        </button>
      </div>

      <div className={"app" + (!showSettings && sel?.wt ? " with-lane" : "")}>
        <Sidebar onAdd={() => setShowNewWt(true)} />

        {showSettings ? (
          <SettingsView onClose={() => setShowSettings(false)} />
        ) : !sel?.wt ? (
          <div className="main" style={{ alignItems: "center", justifyContent: "center" }}>
            <button className="primary" onClick={() => setShowOnboarding(true)}>
              <Plus size={13} />
              Add your first repository
            </button>
          </div>
        ) : mainRailed ? (
          <div className="main railed">
            <div className="main-rail">
              <button className="ib" title="Show worktree details" onClick={() => setMainRailed(false)}>
                <ChevRight size={16} />
              </button>
              <span className="rdiv" />
              {sel.wt.services
                .filter((s) => isLive(s.status))
                .map((s) => (
                  <span className="rdot" key={s.svcKey} title={`${s.name} running`} />
                ))}
              <span className="rdiv" />
              <button className="ib" title="Logs" onClick={() => setMainRailed(false)}>
                <Logs size={15} />
              </button>
              <span className="grow" />
              <span className="vtxt">{sel.wt.branch}</span>
            </div>
          </div>
        ) : (
          <section className="main">
            <WorktreeHeader
              repo={sel.repo}
              wt={sel.wt}
              onRemove={() => setRemoveWt(true)}
              onOpenSettings={() => setShowSettings(true)}
            />
            <div className="block">
              <div className="section-label">
                Services <span className="count">· {running ? `${running} running` : "all stopped"}</span>
              </div>
              {sel.wt.services.length === 0 ? (
                <div className="log-empty" style={{ padding: "6px 8px 14px", fontSize: 12.5 }}>
                  No services configured — add them in Settings.
                </div>
              ) : (
                sel.wt.services.map((svc) => <ServiceCard key={svc.svcKey} svc={svc} />)
              )}

              <div className="section-label">Database</div>
              <DatabaseControl wt={sel.wt} />
            </div>
            <Console wt={sel.wt} />
          </section>
        )}

        {!showSettings && sel?.wt && <AgentLane key={sel.wt.wtKey} repo={sel.repo} wt={sel.wt} />}
      </div>

      {showNewWt && <NewWorktreeModal repoId={sel?.repo.repoId ?? ""} onClose={() => setShowNewWt(false)} />}
      {removeWt && sel?.wt && <RemoveWorktreeModal wt={sel.wt} onClose={() => setRemoveWt(false)} />}
      {onboardingActive && (
        <Onboarding
          onClose={() => {
            setShowOnboarding(false);
            setObDismissed(true);
          }}
          onCreateWorktree={() => setShowNewWt(true)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
