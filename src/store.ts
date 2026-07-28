// Shared store for both windows. With a Tauri backend, all state flows from
// Rust via events; in a plain browser tab it falls back to the Phase-2 mock.
import { create } from "zustand";
import type { LogLine, RepoNode, ServiceNode, SvcStats, SvcStatus, WorktreeNode } from "./types";
import { isLive } from "./types";
import { genLine, logTime, mockTree } from "./mock";
import { hasBackend, ipc, on } from "./ipc";

const LOG_CAP = 160;
const OP_LOG_CAP = 300;

/** Buffered progress of a worktree-level operation (setup / create / custom cmd). */
export interface OpLog {
  lines: LogLine[];
  /** last "[k/n]: cmd" step marker seen, for the inline loader */
  step: string | null;
  running: boolean;
}

/* ── agent-lane sessions ──────────────────────────────────────────────────────
   A worktree can hold any number of concurrent agent and shell tabs. Each one
   is a PTY in Rust keyed by `id`; this list is the UI's view of them. It lives
   in the store (not the lane) so it survives the lane remounting on worktree
   switch — the PTYs keep running either way. */
export type LaneKind = "agent" | "shell";

export interface LaneSession {
  /** backend PTY id — `${wtKey}::agent#3`, `${wtKey}::shell#1` */
  id: string;
  wtKey: string;
  kind: LaneKind;
  /** tab label: the agent profile's name, or "Shell" / "Shell 2" */
  title: string;
  /** repo agent-profile id this was launched from (agent tabs only) */
  agentId?: string;
  /** command the PTY was created with; undefined = interactive login shell */
  command?: string;
  /** false once the PTY exits — the tab stays so its output can be read/restarted */
  running: boolean;
  /** bumped on restart so the pane remounts and creates a fresh PTY */
  gen: number;
}

/** Per-worktree id counter. Ids are never reused, so a closed tab's in-flight
    backend events can't be mistaken for a new session under the same id. */
const termSeq: Record<string, number> = {};
export function nextTermId(wtKey: string, kind: LaneKind): string {
  const n = (termSeq[wtKey] = (termSeq[wtKey] ?? 0) + 1);
  return `${wtKey}::${kind}#${n}`;
}
/** wtKey of a session id (a wtKey is a filesystem path — it has no `::`). */
const wtOf = (termId: string) => termId.slice(0, termId.lastIndexOf("::"));

interface State {
  tree: RepoNode[];
  logs: Record<string, LogLine[]>;
  ops: Record<string, OpLog>;
  stats: Record<string, SvcStats>;
  resetting: Record<string, boolean>;
  toast: string | null;
  flash: "manager" | "quit" | null;

  selKey: string | null;
  query: string;
  tabSvcKey: string | null;
  collapsed: boolean;
  /** agent-lane tabs per worktree (wtKey → sessions); survives worktree switch */
  sessions: Record<string, LaneSession[]>;
  /** focused tab per worktree (wtKey → session id) */
  activeTerm: Record<string, string | null>;
  openSession: (s: Omit<LaneSession, "running" | "gen">) => void;
  closeSession: (id: string) => void;
  /** kill the process but keep the tab (its output stays readable) */
  stopSession: (id: string) => void;
  restartSession: (id: string) => void;
  setActiveTerm: (wtKey: string, id: string) => void;
  /** terminal ids currently shown in a detached window — in the store so the
      placeholder survives a lane remount (worktree switch) */
  detachedTerms: Set<string>;
  setTermDetached: (id: string, v: boolean) => void;
  /** bumped whenever settings are saved, so views holding a cached copy (the
      agent lane's launcher list) know to re-read them */
  settingsRev: number;
  bumpSettings: () => void;
  /** focus mode: the middle pane drops to a rail so the terminal takes the window */
  mainRailed: boolean;
  setMainRailed: (v: boolean) => void;

  setQuery: (q: string) => void;
  select: (wtKey: string) => void;
  setTab: (svcKey: string) => void;
  setCollapsed: (c: boolean) => void;
  clearLogs: (svcKey: string) => void;
  clearOpLog: (wtKey: string) => void;
  showToast: (msg: string) => void;

  startService: (svcKey: string) => void;
  stopService: (svcKey: string) => void;
  restartService: (svcKey: string) => void;
  startAll: (wtKey: string) => void;
  stopAll: (wtKey: string) => void;
  toggleWorktree: (wtKey: string) => void;
  resetDb: (wtKey: string) => void;
  gitPull: (wtKey: string) => void;
  openWorktree: (wtKey: string, where: "editor" | "finder" | "terminal") => void;
  openPort: (port: number) => void;
  openManager: () => void;
  quit: () => void;
}

/* ── tree helpers ── */
function findWt(tree: RepoNode[], wtKey: string): { repo: RepoNode; wt: WorktreeNode } | null {
  for (const r of tree) for (const w of r.worktrees) if (w.wtKey === wtKey) return { repo: r, wt: w };
  return null;
}
function findSvc(tree: RepoNode[], svcKey: string): ServiceNode | null {
  for (const r of tree) for (const w of r.worktrees) for (const s of w.services) if (s.svcKey === svcKey) return s;
  return null;
}
function patchStatus(tree: RepoNode[], svcKey: string, status: SvcStatus): RepoNode[] {
  return tree.map((r) => ({
    ...r,
    worktrees: r.worktrees.map((w) => ({
      ...w,
      services: w.services.map((s) => (s.svcKey === svcKey ? { ...s, status } : s)),
    })),
  }));
}

export function wtLabel(tree: RepoNode[], wtKey: string): string {
  const f = findWt(tree, wtKey);
  return f ? `${f.wt.branch} · ${f.repo.name}` : wtKey;
}

const timers: Record<string, ReturnType<typeof setTimeout>> = {};
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const startedAt: Record<string, number> = {}; // svcKey -> ms epoch
const sessionStartedAt: Record<string, number> = {}; // term id -> ms epoch (session start)
const QUICK_EXIT_MS = 2500; // agent gone this fast after start = it never really ran

function appendLogs(svcKey: string, lines: LogLine[]) {
  useStore.setState((st) => {
    const arr = [...(st.logs[svcKey] || []), ...lines];
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
    return { logs: { ...st.logs, [svcKey]: arr } };
  });
}

const STEP_MARK = /\[\d+\/\d+\]:/;

/** Fold a worktree:op event into the per-worktree op buffer. A progress event
    after an idle state starts a fresh buffer (new run). */
function appendOpLine(wtKey: string, state: "progress" | "done" | "error", detail: string) {
  useStore.setState((st) => {
    const prev = st.ops[wtKey];
    const fresh = state === "progress" && !prev?.running;
    const lv = state === "error" ? "err" : state === "done" ? "ok" : "info";
    const lines = [...(fresh ? [] : prev?.lines ?? []), { t: logTime(), lv, text: detail } as LogLine];
    if (lines.length > OP_LOG_CAP) lines.splice(0, lines.length - OP_LOG_CAP);
    const step = STEP_MARK.test(detail) ? detail : fresh ? null : prev?.step ?? null;
    return { ops: { ...st.ops, [wtKey]: { lines, step, running: state === "progress" } } };
  });
}

export const useStore = create<State>((set, get) => {
  function setStatus(svcKey: string, status: SvcStatus) {
    set((st) => ({ tree: patchStatus(st.tree, svcKey, status) }));
  }
  function showToast(msg: string) {
    set({ toast: msg });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2000);
  }

  /* ── mock lifecycle (browser-only fallback) ── */
  function mockStart(svcKey: string) {
    const svc = findSvc(get().tree, svcKey);
    if (!svc || isLive(svc.status)) return;
    setStatus(svcKey, "starting");
    appendLogs(svcKey, [{ t: logTime(), lv: "info", text: `starting ${svc.name.toLowerCase()}…` }]);
    clearTimeout(timers[svcKey]);
    timers[svcKey] = setTimeout(() => {
      setStatus(svcKey, "running");
      startedAt[svcKey] = Date.now();
      appendLogs(svcKey, [
        { t: logTime(), lv: "ok", text: svc.port ? `listening on http://localhost:${svc.port}` : "worker ready" },
      ]);
    }, 700 + Math.random() * 600);
  }
  function mockStop(svcKey: string) {
    const svc = findSvc(get().tree, svcKey);
    if (!svc || svc.status === "stopped") return;
    setStatus(svcKey, "stopping");
    clearTimeout(timers[svcKey]);
    timers[svcKey] = setTimeout(() => {
      setStatus(svcKey, "stopped");
      delete startedAt[svcKey];
      appendLogs(svcKey, [{ t: logTime(), lv: "warn", text: "process exited (SIGTERM)" }]);
    }, 500 + Math.random() * 400);
  }

  /* real actions: optimistic flip, backend confirms via service:status */
  function start(svcKey: string) {
    if (!hasBackend()) return mockStart(svcKey);
    const svc = findSvc(get().tree, svcKey);
    if (!svc || isLive(svc.status)) return;
    setStatus(svcKey, "starting");
    ipc.serviceStart(svcKey).catch((e) => {
      setStatus(svcKey, "error");
      showToast(String(e));
    });
  }
  function stop(svcKey: string) {
    if (!hasBackend()) return mockStop(svcKey);
    const svc = findSvc(get().tree, svcKey);
    if (!svc || svc.status === "stopped") return;
    setStatus(svcKey, "stopping");
    ipc.serviceStop(svcKey).catch((e) => showToast(String(e)));
  }

  const mock = hasBackend() ? [] : mockTree();
  for (const r of mock)
    for (const w of r.worktrees)
      for (const s of w.services)
        if (s.status === "running") startedAt[s.svcKey] = Date.now() - (60_000 + Math.random() * 5_000_000);

  return {
    tree: mock,
    logs: seedLogs(mock),
    ops: {},
    stats: seedStats(mock),
    resetting: {},
    toast: null,
    flash: null,

    selKey: mock[0]?.worktrees[0]?.wtKey ?? null,
    query: "",
    tabSvcKey: mock[0]?.worktrees[0]?.services[0]?.svcKey ?? null,
    collapsed: false,
    sessions: {},
    activeTerm: {},
    openSession: (s) => {
      sessionStartedAt[s.id] = Date.now();
      set((st) => ({
        sessions: { ...st.sessions, [s.wtKey]: [...(st.sessions[s.wtKey] ?? []), { ...s, running: true, gen: 0 }] },
        activeTerm: { ...st.activeTerm, [s.wtKey]: s.id },
      }));
    },
    closeSession: (id) => {
      const wtKey = wtOf(id);
      // kill the PTY unconditionally: an "exited" tab may only *look* dead (the
      // command finished but a re-opened session could still hold the id).
      if (hasBackend()) ipc.terminalClose(id).catch(() => {});
      delete sessionStartedAt[id];
      set((st) => {
        const prev = st.sessions[wtKey] ?? [];
        const at = prev.findIndex((s) => s.id === id);
        const next = prev.filter((s) => s.id !== id);
        const active = st.activeTerm[wtKey];
        // focus the neighbour that visually takes the closed tab's place
        const refocus = active !== id ? active : (next[at] ?? next[at - 1])?.id ?? null;
        return {
          sessions: { ...st.sessions, [wtKey]: next },
          activeTerm: { ...st.activeTerm, [wtKey]: refocus },
        };
      });
    },
    stopSession: (id) => {
      // mark first: terminal:exit then knows this was deliberate and stays quiet
      set((st) => ({
        sessions: {
          ...st.sessions,
          [wtOf(id)]: (st.sessions[wtOf(id)] ?? []).map((s) => (s.id === id ? { ...s, running: false } : s)),
        },
      }));
      if (hasBackend()) ipc.terminalClose(id).catch(() => {});
    },
    restartSession: (id) => {
      sessionStartedAt[id] = Date.now();
      set((st) => ({
        sessions: {
          ...st.sessions,
          [wtOf(id)]: (st.sessions[wtOf(id)] ?? []).map((s) => (s.id === id ? { ...s, running: true, gen: s.gen + 1 } : s)),
        },
      }));
    },
    setActiveTerm: (wtKey, id) => set((st) => ({ activeTerm: { ...st.activeTerm, [wtKey]: id } })),
    detachedTerms: new Set(),
    setTermDetached: (id, v) =>
      set((st) => {
        const next = new Set(st.detachedTerms);
        if (v) next.add(id);
        else next.delete(id);
        return { detachedTerms: next };
      }),
    settingsRev: 0,
    bumpSettings: () => set((st) => ({ settingsRev: st.settingsRev + 1 })),
    mainRailed: false,
    setMainRailed: (mainRailed) => set({ mainRailed }),

    setQuery: (query) => set({ query }),
    select: (wtKey) => set({ selKey: wtKey }),
    setTab: (svcKey) => {
      set({ tabSvcKey: svcKey, collapsed: false });
      if (hasBackend()) {
        // late-joining window: snapshot the ring buffer
        ipc
          .getLogs(svcKey)
          .then((lines) => useStore.setState((st) => ({ logs: { ...st.logs, [svcKey]: lines } })))
          .catch(() => {});
      }
    },
    setCollapsed: (collapsed) => set({ collapsed }),
    clearLogs: (svcKey) => set((st) => ({ logs: { ...st.logs, [svcKey]: [] } })),
    clearOpLog: (wtKey) =>
      set((st) => {
        const prev = st.ops[wtKey];
        if (!prev) return {};
        return { ops: { ...st.ops, [wtKey]: { ...prev, lines: [], step: null } } };
      }),
    showToast,

    startService: start,
    stopService: stop,
    restartService: (svcKey) => {
      if (!hasBackend()) {
        const svc = findSvc(get().tree, svcKey);
        if (!svc) return;
        mockStop(svcKey);
        setTimeout(() => mockStart(svcKey), 1100);
        return;
      }
      setStatus(svcKey, "stopping");
      ipc.serviceRestart(svcKey).catch((e) => showToast(String(e)));
    },
    startAll: (wtKey) => {
      if (hasBackend()) {
        const f = findWt(get().tree, wtKey);
        f?.wt.services.forEach((s) => !isLive(s.status) && setStatus(s.svcKey, "starting"));
        ipc.worktreeStartAll(wtKey).catch((e) => showToast(String(e)));
        return;
      }
      const f = findWt(get().tree, wtKey);
      f?.wt.services.forEach((s) => !isLive(s.status) && mockStart(s.svcKey));
    },
    stopAll: (wtKey) => {
      if (hasBackend()) {
        const f = findWt(get().tree, wtKey);
        f?.wt.services.forEach((s) => isLive(s.status) && setStatus(s.svcKey, "stopping"));
        ipc.worktreeStopAll(wtKey).catch((e) => showToast(String(e)));
        return;
      }
      const f = findWt(get().tree, wtKey);
      f?.wt.services.forEach((s) => s.status !== "stopped" && mockStop(s.svcKey));
    },
    toggleWorktree: (wtKey) => {
      const f = findWt(get().tree, wtKey);
      if (!f) return;
      const anyRunning = f.wt.services.some((s) => isLive(s.status));
      if (anyRunning) get().stopAll(wtKey);
      else get().startAll(wtKey);
    },
    resetDb: (wtKey) => {
      const st = get();
      if (st.resetting[wtKey]) return;
      const label = wtLabel(st.tree, wtKey);
      if (!hasBackend()) {
        set((s) => ({ resetting: { ...s.resetting, [wtKey]: true } }));
        showToast(`Resetting database — ${label}…`);
        setTimeout(() => {
          set((s) => {
            const n = { ...s.resetting };
            delete n[wtKey];
            return { resetting: n };
          });
          showToast(`Database reset ✓ ${label}`);
        }, 1500);
        return;
      }
      // resetting flag + completion arrive via reset:status events
      showToast(`Resetting database — ${label}…`);
      ipc.resetDb(wtKey).catch((e) => showToast(String(e)));
    },
    gitPull: (wtKey) => {
      const label = wtLabel(get().tree, wtKey);
      if (!hasBackend()) {
        showToast(`Pulling from origin — ${label}`);
        return;
      }
      showToast(`Pulling from origin — ${label}…`);
      ipc
        .gitPull(wtKey)
        .then((summary) => showToast(`✓ ${summary} — ${label}`))
        .catch((e) => showToast(`Pull failed — ${String(e)}`));
    },
    openWorktree: (wtKey, where) => {
      const labels = { editor: "Opening in editor", finder: "Revealing in Finder", terminal: "Opening Terminal" };
      showToast(`${labels[where]} — ${wtLabel(get().tree, wtKey)}`);
      if (!hasBackend()) return;
      const call =
        where === "editor" ? ipc.openInEditor(wtKey) : where === "finder" ? ipc.revealInFinder(wtKey) : ipc.openTerminal(wtKey);
      call.catch((e) => showToast(String(e)));
    },
    openPort: (port) => {
      if (hasBackend()) ipc.openPort(port).catch((e) => showToast(String(e)));
      else showToast(`Opening http://localhost:${port}`);
    },
    openManager: () => {
      set({ flash: "manager" });
      setTimeout(() => set({ flash: null }), 360);
      if (hasBackend()) ipc.showMainWindow().catch(() => {});
    },
    quit: () => {
      set({ flash: "quit" });
      showToast("Quitting — killing all processes…");
      if (hasBackend()) setTimeout(() => ipc.quitApp().catch(() => {}), 200);
      else setTimeout(() => set({ flash: null }), 360);
    },
  };
});

function seedLogs(tree: RepoNode[]): Record<string, LogLine[]> {
  const L: Record<string, LogLine[]> = {};
  for (const r of tree)
    for (const w of r.worktrees)
      for (const s of w.services) {
        if (s.status !== "running") continue;
        const arr: LogLine[] = [
          { t: logTime(), lv: "ok", text: s.port ? `listening on http://localhost:${s.port}` : "worker ready" },
        ];
        const n = 4 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) arr.push(genLine(s.kind));
        L[s.svcKey] = arr;
      }
  return L;
}

function seedStats(tree: RepoNode[]): Record<string, SvcStats> {
  const st: Record<string, SvcStats> = {};
  for (const r of tree)
    for (const w of r.worktrees)
      for (const s of w.services) {
        if (s.status !== "running") continue;
        const baseC = s.kind === "web" ? 6 : s.kind === "worker" ? 3 : 9;
        const baseM = s.kind === "web" ? 180 : s.kind === "worker" ? 90 : 240;
        st[s.svcKey] = { cpu: baseC, memMb: baseM, uptimeSec: getUptimeSec(s.svcKey) ?? 0 };
      }
  return st;
}

export function getUptimeSec(svcKey: string): number | undefined {
  const t = startedAt[svcKey];
  return t ? (Date.now() - t) / 1000 : undefined;
}

/* keep selection/tab valid when the tree is replaced */
function reconcile(tree: RepoNode[]) {
  const st = useStore.getState();
  const wts = tree.flatMap((r) => r.worktrees);
  const sel = wts.find((w) => w.wtKey === st.selKey) ?? wts[0] ?? null;
  const svcs = sel?.services ?? [];
  const tab = svcs.find((s) => s.svcKey === st.tabSvcKey) ?? svcs.find((s) => isLive(s.status)) ?? svcs[0] ?? null;
  useStore.setState({ tree, selKey: sel?.wtKey ?? null, tabSvcKey: tab?.svcKey ?? null });
}

/* hydrate from the Rust backend + subscribe to its events.
   In a plain browser (no Tauri) falls back to the mock tick. */
export function initSync(): () => void {
  if (!hasBackend()) return startMockTick();

  let disposed = false;
  const unlisteners: (() => void)[] = [];
  const track = (p: Promise<() => void>) => p.then((u) => unlisteners.push(u));

  ipc
    .getTree()
    .then((tree) => !disposed && reconcile(tree))
    .catch((e) => console.error("get_tree failed", e));

  track(on.treeChanged((tree) => reconcile(tree)));

  track(
    on.worktreeGit((e) => {
      useStore.setState((st) => ({
        tree: st.tree.map((r) => ({
          ...r,
          worktrees: r.worktrees.map((w) =>
            w.wtKey === e.wtKey
              ? {
                  ...w,
                  git: {
                    ahead: e.ahead,
                    behind: e.behind,
                    dirty: e.dirty,
                    lastCommitTs: e.lastCommitTs,
                    lastCommitMsg: e.lastCommitMsg,
                  },
                }
              : w,
          ),
        })),
      }));
    }),
  );

  track(
    on.serviceStatus((e) => {
      useStore.setState((st) => ({ tree: patchStatus(st.tree, e.svcKey, e.status) }));
      if (e.status === "running" && e.startedAt) startedAt[e.svcKey] = e.startedAt * 1000;
      if (e.status === "stopped" || e.status === "error") delete startedAt[e.svcKey];
    }),
  );

  track(on.serviceLog((e) => appendLogs(e.svcKey, e.lines)));

  track(on.worktreeOp((e) => appendOpLine(e.wtKey, e.state, e.detail)));

  // session lifecycle: every lane tab is its own PTY, so its exit is the
  // authoritative "this tab stopped" signal. The tab is kept (marked not
  // running) so its output stays readable and it can be restarted in place.
  track(
    on.terminalExit((e) => {
      // NB: don't clear the detached flag here — terminal:exit means the PTY
      // process ended, not that its window closed (that's the tauri://destroyed
      // handler). Clearing it would re-dock and spawn a new inline shell while
      // the detached window is still open.
      const wtKey = wtOf(e.id);
      const sess = useStore.getState().sessions[wtKey]?.find((s) => s.id === e.id);
      if (!sess) return;
      // still "running" here means it wasn't a user-initiated stop (which marks
      // the tab first), so a near-instant exit is worth surfacing.
      if (sess.running && sess.kind === "agent") {
        const started = sessionStartedAt[e.id];
        if (started && Date.now() - started < QUICK_EXIT_MS)
          useStore.getState().showToast(`${sess.title} exited immediately — check the agent command`);
      }
      useStore.setState((st) => ({
        sessions: { ...st.sessions, [wtKey]: (st.sessions[wtKey] ?? []).map((s) => (s.id === e.id ? { ...s, running: false } : s)) },
      }));
    }),
  );

  track(
    on.serviceStats((e) => {
      useStore.setState((st) => {
        const stats = { ...st.stats };
        for (const s of e.entries) stats[s.svcKey] = { cpu: s.cpu, memMb: s.memMb, uptimeSec: s.uptimeSec };
        return { stats };
      });
    }),
  );

  track(
    on.resetStatus((e) => {
      useStore.setState((st) => {
        const resetting = { ...st.resetting };
        if (e.state === "started") resetting[e.wtKey] = true;
        else delete resetting[e.wtKey];
        return { resetting };
      });
      if (e.state === "done") useStore.getState().showToast(`Database reset ✓ ${wtLabel(useStore.getState().tree, e.wtKey)}`);
      if (e.state === "error") useStore.getState().showToast(`Reset failed — ${e.message ?? "unknown error"}`);
    }),
  );

  const rehydrate = () => {
    ipc.getTree().then(reconcile).catch(() => {});
    const tab = useStore.getState().tabSvcKey;
    if (tab) ipc.getLogs(tab).then((lines) => useStore.setState((st) => ({ logs: { ...st.logs, [tab]: lines } }))).catch(() => {});
  };
  window.addEventListener("focus", rehydrate);

  return () => {
    disposed = true;
    unlisteners.forEach((u) => u());
    window.removeEventListener("focus", rehydrate);
  };
}

/* mock live tick: stats jitter + streaming logs into running services */
export function startMockTick() {
  const id = setInterval(() => {
    const st = useStore.getState();
    const running: ServiceNode[] = [];
    for (const r of st.tree) for (const w of r.worktrees) for (const s of w.services) if (s.status === "running") running.push(s);

    const stats: Record<string, SvcStats> = { ...st.stats };
    running.forEach((s) => {
      const baseC = s.kind === "web" ? 6 : s.kind === "worker" ? 3 : 9;
      const baseM = s.kind === "web" ? 180 : s.kind === "worker" ? 90 : 240;
      stats[s.svcKey] = {
        cpu: Math.max(0, baseC + Math.round((Math.random() - 0.5) * 8)),
        memMb: baseM + Math.round((Math.random() - 0.5) * 40),
        uptimeSec: getUptimeSec(s.svcKey) ?? 0,
      };
    });
    useStore.setState({ stats });

    running.forEach((s) => {
      if (s.svcKey === st.tabSvcKey || Math.random() < 0.18) {
        appendLogs(s.svcKey, [genLine(s.kind)]);
      }
    });
  }, 1600);
  return () => clearInterval(id);
}
