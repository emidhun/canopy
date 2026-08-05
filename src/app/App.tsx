/* The Canopy workspace shell.

   Owns the view (worktree vs overview), layout presets, keyboard bindings, and
   the one runner that turns a NextAction into work. Everything that offers
   "the next thing" routes through `runNext`, so the worktree bar's button,
   ⌘K's Suggested row, ⏎, and the overview's row action stay in lockstep. */
import { useEffect, useMemo, useRef, useState } from "react";
import { hasBackend, ipc } from "../ipc";
import { initSync, useStore } from "../store";
import type { RepoNode, WorktreeNode } from "../types";
import { Plus } from "../icons";
import { attentionItems, nextAction, type AttnItem, type NextAction } from "./nextAction";
import { TopBar, AttentionPop } from "./canopy/TopBar";
import SidebarNav from "./canopy/SidebarNav";
import WorktreeView from "./canopy/WorktreeView";
import Overview from "./canopy/Overview";
import Palette from "./canopy/Palette";
import StatusBar from "./canopy/StatusBar";
import { LAYOUT_ORDER, LAYOUTS, panesOf, type LayoutId, type PaneKind } from "./canopy/WorkSurface";
import { useLaneLaunch } from "./canopy/laneLaunch";
import DatabaseModal from "./canopy/DatabaseModal";
import SetupRunnerModal from "./canopy/SetupRunnerModal";
import ServiceDetailModal from "./canopy/ServiceDetailModal";
import ContextModal from "./canopy/ContextModal";
import SettingsView from "./SettingsView";
import NewWorktreeModal from "./NewWorktreeModal";
import RemoveWorktreeModal from "./RemoveWorktreeModal";
import SwitchBranchModal from "./SwitchBranchModal";
import Onboarding from "../onboarding/Onboarding";

export default function App() {
  const tree = useStore((s) => s.tree);
  const selKey = useStore((s) => s.selKey);
  const select = useStore((s) => s.select);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const showToast = useStore((s) => s.showToast);
  const primeLogs = useStore((s) => s.primeLogs);
  const startAll = useStore((s) => s.startAll);
  const startService = useStore((s) => s.startService);
  const restartService = useStore((s) => s.restartService);
  const gitPull = useStore((s) => s.gitPull);
  const openPort = useStore((s) => s.openPort);
  const openWorktree = useStore((s) => s.openWorktree);
  const setActiveTerm = useStore((s) => s.setActiveTerm);

  const [view, setView] = useState<"wt" | "overview">("wt");
  // the pane set is the state; a preset is just a named one, so a hand-made
  // combination is as valid as ⌘1–⌘5 and the status bar simply calls it Custom
  const [panes, setPanes] = useState<PaneKind[]>(() => panesOf("runtime"));
  const setLayout = (l: LayoutId) => setPanes(panesOf(l));
  const [sideHidden, setSideHidden] = useState(false);
  const [palette, setPalette] = useState(false);
  const [attnOpen, setAttnOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewWt, setShowNewWt] = useState(false);
  const [showSwitchBranch, setShowSwitchBranch] = useState(false);
  const [showDb, setShowDb] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const [svcDetail, setSvcDetail] = useState<string | null>(null);
  const [removeWtFor, setRemoveWtFor] = useState<WorktreeNode | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [obDismissed, setObDismissed] = useState(false);
  const [, setTick] = useState(0);
  const attnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => initSync(), []);
  // uptime / relative-time re-render
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const sel = useMemo<{ repo: RepoNode; wt: WorktreeNode } | null>(() => {
    for (const r of tree) for (const w of r.worktrees) if (w.wtKey === selKey) return { repo: r, wt: w };
    const r = tree[0];
    return r?.worktrees[0] ? { repo: r, wt: r.worktrees[0] } : null;
  }, [tree, selKey]);

  // the logs pane merges every service's buffer, so prime them all on switch
  useEffect(() => {
    if (sel) primeLogs(sel.wt.wtKey);
  }, [sel?.wt.wtKey, primeLogs]);

  const attn = useMemo<AttnItem[]>(() => attentionItems(tree, sessions), [tree, sessions]);
  const na = useMemo<NextAction | null>(
    () => (sel ? nextAction(sel.wt, sessions[sel.wt.wtKey] ?? []) : null),
    [sel, sessions],
  );

  const running = tree.reduce(
    (n, r) => n + r.worktrees.reduce((m, w) => m + w.services.filter((s) => s.status === "running").length, 0),
    0,
  );
  const agentCount = Object.values(sessions)
    .flat()
    .filter((s) => s.kind === "agent" && s.running).length;

  const launch = useLaneLaunch(sel?.repo ?? EMPTY_REPO, sel?.wt ?? EMPTY_WT);

  /** Resolve a launch target by key. `select()` does not update this render's
      closure, so anything launching for a worktree other than the currently
      selected one has to say which one explicitly. */
  const targetFor = (wtKey: string) => {
    for (const r of tree) for (const w of r.worktrees) if (w.wtKey === wtKey) return { repo: r, wt: w };
    return undefined;
  };

  /* ── the one action ───────────────────────────────────────────────
     Every surface that offers "the next thing" calls this. */
  const runNext = (action?: NextAction | null, forKey?: string) => {
    const key = forKey ?? sel?.wt.wtKey;
    if (!key) return;
    const target = tree.flatMap((r) => r.worktrees).find((w) => w.wtKey === key);
    if (!target) return;
    const a = action ?? nextAction(target, sessions[key] ?? []);

    switch (a.id) {
      case "restart":
        if (a.svcKey) restartService(a.svcKey);
        break;
      case "answer":
      case "watch":
        select(key);
        setView("wt");
        setLayout("agent");
        if (a.sessionId) setActiveTerm(key, a.sessionId);
        break;
      case "setup":
        select(key);
        setView("wt");
        setShowSetup(true);
        break;
      case "starting":
        break; // busy — acting again would double-start
      case "pull":
        gitPull(key);
        break;
      case "start":
        startAll(key);
        break;
      case "startrest":
        if (a.svcKey) startService(a.svcKey);
        else startAll(key);
        break;
      case "review":
        openWorktree(key, "editor");
        break;
      case "open":
        if (a.port) openPort(a.port);
        break;
      case "agent":
        select(key);
        setView("wt");
        setLayout("agent");
        launch.startAgent(targetFor(key));
        break;
    }
  };

  const goto = (wtKey: string, want?: "terminal") => {
    select(wtKey);
    setView("wt");
    if (want === "terminal") {
      setLayout("shell");
      launch.startShell(targetFor(wtKey));
    }
  };

  const openTerminalFor = (wtKey: string) => {
    select(wtKey);
    setView("wt");
    setLayout("shell");
    // open one only if that worktree has none — naming the target means this
    // works for any worktree, not just the one already selected
    if ((sessions[wtKey] ?? []).every((s) => s.kind !== "shell")) launch.startShell(targetFor(wtKey));
  };

  const refresh = () => {
    showToast("Rescanning worktrees…");
    if (hasBackend()) ipc.refresh().catch(() => {});
  };

  /* ── keyboard: the whole app is reachable without the mouse ─────── */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const el = document.activeElement;
      const typing = /^(INPUT|TEXTAREA)$/.test(el?.tagName ?? "") || (el as HTMLElement | null)?.isContentEditable === true;

      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.key === "Escape") {
        setPalette(false);
        setAttnOpen(false);
        return;
      }
      if (palette) return;
      if (meta && e.key >= "1" && e.key <= String(LAYOUT_ORDER.length)) {
        e.preventDefault();
        setLayout(LAYOUT_ORDER[Number(e.key) - 1]);
      }
      if (meta && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSideHidden((s) => !s);
      }
      if (meta && e.key === "\\") {
        e.preventDefault();
        if (sel) setShowSwitchBranch(true);
      }
      if (meta && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setView((v) => (v === "overview" ? "wt" : "overview"));
      }
      // ⏎ runs the next action — but never while a terminal or field has focus
      if (e.key === "Enter" && !meta && !typing && view === "wt" && na && na.kind !== "busy") {
        e.preventDefault();
        runNext(na);
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });

  const onboardingActive = showOnboarding || (tree.length === 0 && !obDismissed);
  const worktreeCount = tree.reduce((n, r) => n + r.worktrees.length, 0);

  return (
    <div className="cxs-shell">
      <TopBar
        repo={sel?.repo ?? null}
        wt={view === "overview" ? null : (sel?.wt ?? null)}
        attn={attn}
        running={running}
        agents={agentCount}
        onPalette={() => setPalette(true)}
        onAttn={() => setAttnOpen((a) => !a)}
        onOverview={() => setView("overview")}
        onRefresh={refresh}
        onSettings={() => setShowSettings(true)}
        attnRef={attnRef}
      />

      <div className="cxs-body">
        <SidebarNav
          hidden={sideHidden}
          view={view}
          selKey={sel?.wt.wtKey ?? null}
          attn={attn}
          onSelect={(k) => goto(k)}
          onOverview={() => setView("overview")}
          onToggle={() => setSideHidden((s) => !s)}
          onNew={() => setShowNewWt(true)}
          onOpenTerminal={openTerminalFor}
        />

        {showSettings ? (
          <SettingsView onClose={() => setShowSettings(false)} />
        ) : view === "overview" ? (
          <Overview
            attn={attn}
            onSelect={(k) => goto(k)}
            onOpenTerminal={openTerminalFor}
            onRunNext={(k) => runNext(null, k)}
            sideHidden={sideHidden}
            onShowSide={() => setSideHidden(false)}
          />
        ) : !sel ? (
          <div className="cxs-main">
            <div className="cxs-empty">
              <span className="eic">
                <Plus size={17} />
              </span>
              <span className="et">No repositories yet</span>
              <span className="es">Add a repository and Canopy will track every worktree in it.</span>
              <button className="cx-next" onClick={() => setShowOnboarding(true)} style={{ marginTop: 3 }}>
                <Plus size={12} />
                Add your first repository
              </button>
            </div>
          </div>
        ) : (
          na && (
            <WorktreeView
              wt={sel.wt}
              na={na}
              onNext={() => runNext(na)}
              panes={panes}
              setPanes={setPanes}
              launch={launch}
              sideHidden={sideHidden}
              onShowSide={() => setSideHidden(false)}
              onRemove={() => setRemoveWtFor(sel.wt)}
              onDatabase={() => setShowDb(true)}
              onSetup={() => setShowSetup(true)}
              onOpenService={(s) => setSvcDetail(s.svcKey)}
              onEditContext={() => setShowCtx(true)}
              onSwitchBranch={() => setShowSwitchBranch(true)}
            />
          )
        )}
      </div>

      <StatusBar
        wt={showSettings ? null : (sel?.wt ?? null)}
        view={showSettings ? "overview" : view}
        attn={attn}
        panes={panes}
        onCycleLayout={() => {
          const at = LAYOUT_ORDER.findIndex((l) => LAYOUTS[l].panes.join() === panes.join());
          setLayout(LAYOUT_ORDER[(at + 1) % LAYOUT_ORDER.length]);
        }}
        onAttn={() => setAttnOpen((a) => !a)}
        onSwitchBranch={() => setShowSwitchBranch(true)}
        worktreeCount={worktreeCount}
        repoCount={tree.length}
      />

      {attnOpen && (
        <AttentionPop
          anchor={attnRef}
          items={attn}
          onClose={() => setAttnOpen(false)}
          onPick={(a) => {
            setAttnOpen(false);
            goto(a.wtKey);
            if (a.kind === "wait") setLayout("agent");
          }}
        />
      )}

      {palette && (
        <Palette
          selKey={sel?.wt.wtKey ?? null}
          attn={attn}
          onClose={() => setPalette(false)}
          onSelect={(k) => goto(k)}
          onOverview={() => setView("overview")}
          onAction={(a) => runNext(a)}
          onRunFor={(k) => runNext(null, k)}
          onLayout={(l) => {
            setLayout(l);
            setView("wt");
          }}
          onNewWorktree={() => setShowNewWt(true)}
          onSettings={() => setShowSettings(true)}
          onOpenTerminal={() => sel && openTerminalFor(sel.wt.wtKey)}
          onStartAgent={() => {
            setView("wt");
            setLayout("agent");
            launch.startAgent(sel ? { repo: sel.repo, wt: sel.wt } : undefined);
          }}
        />
      )}

      {showDb && sel && <DatabaseModal wt={sel.wt} onClose={() => setShowDb(false)} />}
      {showSetup && sel && (
        <SetupRunnerModal
          wt={sel.wt}
          onClose={() => setShowSetup(false)}
          onStartServices={() => startAll(sel.wt.wtKey)}
        />
      )}
      {svcDetail && sel && <ServiceDetailModal wt={sel.wt} svcKey={svcDetail} onClose={() => setSvcDetail(null)} />}
      {showCtx && sel && (
        <ContextModal
          repo={sel.repo}
          wt={sel.wt}
          onClose={() => setShowCtx(false)}
          onStartAgent={() => {
            setView("wt");
            setLayout("agent");
            launch.startAgent(sel ? { repo: sel.repo, wt: sel.wt } : undefined);
          }}
        />
      )}
      {showNewWt && <NewWorktreeModal repoId={sel?.repo.repoId ?? ""} onClose={() => setShowNewWt(false)} />}
      {removeWtFor && <RemoveWorktreeModal wt={removeWtFor} onClose={() => setRemoveWtFor(null)} />}
      {showSwitchBranch && sel && (
        <SwitchBranchModal repo={sel.repo} wt={sel.wt} onClose={() => setShowSwitchBranch(false)} />
      )}
      {onboardingActive && (
        <Onboarding
          onClose={() => {
            setShowOnboarding(false);
            setObDismissed(true);
          }}
          onCreateWorktree={() => setShowNewWt(true)}
        />
      )}
      {toast && <div className="cx-toast">{toast}</div>}
    </div>
  );
}

/* Stable placeholders so the launch hook keeps a consistent identity while the
   tree is still loading — it reads repo/worktree lazily inside its callbacks. */
const EMPTY_REPO: RepoNode = { repoId: "", name: "", path: "", worktrees: [] };
const EMPTY_WT: WorktreeNode = {
  wtKey: "",
  branch: "",
  path: "",
  isMain: false,
  git: null,
  dbName: null,
  services: [],
};
