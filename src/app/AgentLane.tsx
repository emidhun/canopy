// The agent lane (VariantC) — a first-class right-hand column holding the
// per-worktree context, the coding agent, and a shell. Both the Agent and Shell
// tabs are backed by their own live PTY (see TerminalPane); toggling between
// them keeps both sessions alive.
import { useEffect, useRef, useState } from "react";
import type { RepoNode, WorktreeNode } from "../types";
import { useStore } from "../store";
import { hasBackend, ipc } from "../ipc";
import { ChevLeft, ChevRight, Doc, ExpandH, PopIn, PopOut, Spinner, Sparkle, Terminal as TerminalIcon, X } from "../icons";
import TerminalPane from "./TerminalPane";
import { ContextEditor, bodyPreview, composeContextMd, isBlank, useWtContext } from "./WorktreeContext";

/** Deterministic window label for a detached terminal (matches the term-* capability). */
const laneLabel = (id: string) => "term-" + id.replace(/[^a-zA-Z0-9_-]/g, "_");

function DetachedPlaceholder({ onBack }: { onBack: () => void }) {
  return (
    <div className="term-ph">
      <span className="ph-ic">
        <PopOut size={19} />
      </span>
      <span className="ph-t">
        Running in a detached window <PopOut size={12} />
      </span>
      <span className="ph-s">
        The shell keeps running — output goes to the floating window. Close it or bring it back here any time.
      </span>
      <button className="btn-sm" onClick={onBack}>
        <PopIn size={13} />
        Bring back
      </button>
    </div>
  );
}

function AgentIdle({ onStart }: { onStart: () => void }) {
  return (
    <div className="term-ph">
      <span className="ph-ic">
        <Sparkle size={19} />
      </span>
      <span className="ph-t">No agent running</span>
      <span className="ph-s">
        Start the coding agent in this worktree. It runs in a real terminal, seeded with the context above.
      </span>
      <button className="startagent" onClick={onStart}>
        <Sparkle size={13} />
        Start agent
        <span className="ar">▸</span>
      </button>
    </div>
  );
}

const COLLAPSE_KEY = "canopy.lane.collapsed";
const WIDTH_KEY = "canopy.lane.width";

// layout constants (match terminal.css): sidebar, main-pane floor, focus rail.
const SIDE = 264;
const MIN_MAIN = 460;
const RAIL = 52;
const MIN_LANE = 300;
const DEFAULT_LANE = 372;
// below this the lane can't be a flex sibling without squeezing the main pane
// past its floor — it becomes an overlay drawer instead (see the handoff).
const TIGHT = 1180;

type Tab = "agent" | "shell";

export default function AgentLane({ repo, wt }: { repo: RepoNode; wt: WorktreeNode }) {
  const showToast = useStore((s) => s.showToast);
  const agentState = useStore((s) => s.agents[wt.wtKey] ?? "off");
  const setAgent = useStore((s) => s.setAgent);
  const mainRailed = useStore((s) => s.mainRailed);
  const setMainRailed = useStore((s) => s.setMainRailed);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [tab, setTab] = useState<Tab>("agent");
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctx, setCtx] = useWtContext(wt.wtKey);
  const [laneW, setLaneW] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_LANE);
  const [resizing, setResizing] = useState(false);
  const [tight, setTight] = useState(() => window.innerWidth < TIGHT);
  const [detached, setDetached] = useState<Set<string>>(new Set());
  // resolved agent CLI, set on the first Start; only needed to *create* the
  // agent PTY — remounts while it's already running attach without it.
  const [agentCmd, setAgentCmd] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  // the shell terminal is lazily mounted the first time its tab is shown, then
  // kept mounted (hidden) so its PTY keeps running in the background.
  const shellActivated = useRef(false);
  if (tab === "shell") shellActivated.current = true;

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(laneW));
  }, [laneW]);

  // room available for the lane at a given main-pane floor
  const availFor = (railed: boolean) => {
    const body = asideRef.current?.parentElement;
    if (!body) return null;
    return body.clientWidth - SIDE - (railed ? RAIL : MIN_MAIN);
  };

  // narrow-window fallback: overlay drawer + auto-collapse on first crossing
  useEffect(() => {
    if (window.innerWidth < TIGHT) setCollapsed(true); // start collapsed when tight
    const onResize = () => {
      const t = window.innerWidth < TIGHT;
      setTight((was) => {
        if (t && !was) {
          setCollapsed(true);
          setMainRailed(false);
        }
        return t;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setMainRailed]);

  // single source of truth for lane-width validity: clamp on mount, on window
  // resize, and whenever focus mode changes the main pane's floor.
  useEffect(() => {
    if (tight) return;
    const clamp = () => {
      const avail = availFor(mainRailed);
      if (avail == null || avail < MIN_LANE) return;
      setLaneW((w) => Math.min(w, avail));
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainRailed, tight]);

  // drag the lane's left edge to resize
  useEffect(() => {
    if (!resizing) return;
    const move = (e: MouseEvent) => {
      const body = asideRef.current?.parentElement;
      if (!body) return;
      const avail = availFor(mainRailed);
      if (avail == null || avail < MIN_LANE) return; // no room to resize here
      const right = body.getBoundingClientRect().right;
      setLaneW(Math.round(Math.min(avail, Math.max(MIN_LANE, right - e.clientX))));
    };
    const up = () => setResizing(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizing, mainRailed]);

  // focus mode: collapse the middle pane to a rail, give the lane the rest
  const toggleFocus = () => {
    if (!mainRailed) {
      setMainRailed(true);
      const avail = availFor(true);
      if (avail != null) setLaneW(Math.max(MIN_LANE, avail));
      showToast("Terminal focus — worktree details collapsed");
    } else {
      setMainRailed(false);
      const avail = availFor(false);
      setLaneW(avail == null ? DEFAULT_LANE : Math.min(DEFAULT_LANE, Math.max(MIN_LANE, avail)));
    }
  };

  const shellId = `${wt.wtKey}::shell`;
  const agentId = `${wt.wtKey}::agent`;

  if (collapsed) {
    return (
      <aside className="lane collapsed">
        <div className="lane-head" style={{ padding: 0, justifyContent: "center" }}>
          <button className="ib" title="Open agent lane" onClick={() => setCollapsed(false)}>
            <ChevLeft size={16} />
          </button>
        </div>
        <div className="lane-rail">
          <button
            className="ib"
            title="Agent"
            onClick={() => {
              setCollapsed(false);
              setTab("agent");
            }}
          >
            <Sparkle size={15} />
          </button>
          <button
            className="ib"
            title="Shell"
            onClick={() => {
              setCollapsed(false);
              setTab("shell");
            }}
          >
            <TerminalIcon size={15} />
          </button>
          <button
            className="ib"
            title="Context"
            onClick={() => {
              setCollapsed(false);
              setCtxOpen(true);
            }}
          >
            <Doc size={15} />
          </button>
          <span className="vtxt">Agent</span>
        </div>
      </aside>
    );
  }

  // Start the coding agent as its OWN PTY session (the terminal *is* the chat).
  // Running it as the session's command means the session ends — and the run
  // state clears via terminal:exit — exactly when the agent exits. The context,
  // if any, is written to .canopy/context.md first so the agent can read it.
  const startAgent = async () => {
    setCtxOpen(false);
    setTab("agent");
    if (!hasBackend()) {
      setAgentCmd("agent");
      setAgent(wt.wtKey, "running");
      showToast(`Agent — ${repo.name} · ${wt.branch}`);
      return;
    }
    try {
      if (!isBlank(ctx)) {
        // propagate failure — don't claim "seeded" if the write failed
        await ipc.saveTextFile(`${wt.path}/.canopy/context.md`, composeContextMd(ctx));
      }
      const cmd = (await ipc.resolveAgentCommand(wt.wtKey)) || "claude";
      setAgentCmd(cmd);
      setAgent(wt.wtKey, "running"); // TerminalPane mounts and creates the PTY with `cmd`
      showToast(`Agent started — ${repo.name} · ${wt.branch}`);
    } catch (e) {
      showToast(`Agent start failed — ${String(e)}`);
    }
  };

  // Kill the agent PTY; terminal:exit then clears run state (see the store).
  const stopAgent = () => {
    setAgent(wt.wtKey, "off");
    if (hasBackend()) ipc.terminalClose(agentId).catch(() => {});
    showToast("Agent stopped");
  };

  // Pop a terminal into its own OS window that attaches to the SAME PTY. The
  // lane shows a placeholder while detached; closing the window (or "Bring
  // back") re-docks it — the shell never stops.
  const popOut = async (id: string) => {
    if (!hasBackend()) {
      showToast("Pop-out is available in the desktop app");
      return;
    }
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = laneLabel(id);
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      existing.setFocus();
      return;
    }
    const url = `terminal.html?id=${encodeURIComponent(id)}&cwd=${encodeURIComponent(wt.path)}&branch=${encodeURIComponent(wt.branch)}`;
    const win = new WebviewWindow(label, {
      url,
      width: 560,
      height: 360,
      minWidth: 360,
      minHeight: 220,
      title: `Terminal — ${wt.branch}`,
      decorations: false,
      resizable: true,
    });
    win.once("tauri://created", () => setDetached((s) => new Set(s).add(id)));
    win.once("tauri://error", () => showToast("Could not open terminal window"));
    win.once("tauri://destroyed", () =>
      setDetached((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      }),
    );
  };

  const bringBack = async (id: string) => {
    if (hasBackend()) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const w = await WebviewWindow.getByLabel(laneLabel(id));
      await w?.close();
    }
    setDetached((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  return (
    <aside
      ref={asideRef}
      className={"lane" + (tight ? " overlay" : "") + (resizing ? " resizing" : "")}
      style={tight ? undefined : { width: laneW }}
    >
      {!tight && (
        <span
          className={"lane-grip" + (resizing ? " on" : "")}
          onMouseDown={(e) => {
            e.preventDefault();
            setResizing(true);
          }}
        />
      )}
      <div className="lane-head">
        <span
          className={"ag-pip" + (agentState === "running" ? " busy" : "")}
          style={{ width: 26, height: 26, borderRadius: 8, background: "var(--accent-dim)", color: "var(--accent)" }}
        >
          <Sparkle size={14} />
        </span>
        <div className="lh-t">
          <b>Agent</b>
          <span>{wt.branch}</span>
        </div>
        <span className="grow" />
        <button
          className="ib"
          title="Open in a separate window"
          onClick={() => popOut(tab === "agent" ? agentId : shellId)}
        >
          <PopOut size={14} />
        </button>
        {!tight && (
          <button className="ib" title={mainRailed ? "Show worktree details" : "Focus the terminal"} onClick={toggleFocus}>
            <ExpandH size={15} />
          </button>
        )}
        <button
          className="ib"
          title="Collapse lane"
          onClick={() => {
            setCollapsed(true);
            setMainRailed(false);
          }}
        >
          <ChevRight size={16} />
        </button>
      </div>

      <div className="lane-ctx">
        <div className="lc-lbl">
          <Doc size={11} />
          Context
          <span className="grow" />
          <button className="ib" style={{ height: 22, fontSize: 11, padding: "0 7px" }} onClick={() => setCtxOpen(true)}>
            Edit
          </button>
        </div>
        {isBlank(ctx) ? (
          <>
            <div className="lc-title" style={{ color: "var(--faint)" }}>
              What is this worktree for?
            </div>
            <div className="lc-body">Set a task or PR description to seed the agent and pre-fill the PR body.</div>
          </>
        ) : (
          <>
            <div className="lc-title">{ctx.title || "Untitled"}</div>
            <div className="lc-body">{bodyPreview(ctx.body) || `${ctx.links.length} link(s)`}</div>
          </>
        )}
      </div>

      <div className="lane-seg">
        <button className={tab === "agent" ? "on" : ""} onClick={() => setTab("agent")}>
          <Sparkle size={12} />
          Agent
        </button>
        <button className={tab === "shell" ? "on" : ""} onClick={() => setTab("shell")}>
          <TerminalIcon size={12} />
          Shell
        </button>
      </div>

      {tab === "agent" && agentState === "running" && (
        <div className="ag-banner">
          <Sparkle size={13} />
          <span className="nm">agent</span>
          <span className="sep">·</span>
          <span className="ctxref">
            {isBlank(ctx) ? "running in this worktree" : `seeded with “${ctx.title || "context"}”`}
          </span>
        </div>
      )}

      <div className="lane-body">
        <div className="term">
          <div className={"term-body" + (tab === "agent" ? "" : " hidden")}>
            {detached.has(agentId) ? (
              <DetachedPlaceholder onBack={() => bringBack(agentId)} />
            ) : agentState === "running" ? (
              <TerminalPane termId={agentId} cwd={wt.path} hidden={tab !== "agent"} command={agentCmd ?? undefined} />
            ) : (
              <AgentIdle onStart={startAgent} />
            )}
          </div>
          {shellActivated.current && (
            <div className={"term-body" + (tab === "shell" ? "" : " hidden")}>
              {detached.has(shellId) ? (
                <DetachedPlaceholder onBack={() => bringBack(shellId)} />
              ) : (
                <TerminalPane termId={shellId} cwd={wt.path} hidden={tab !== "shell"} />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="lane-foot">
        {agentState === "running" ? (
          <span className="agent-live" style={{ flex: 1 }}>
            <Spinner size={12} />
            Agent working
            <span className="grow" />
            <button className="stopx" title="Stop agent" onClick={stopAgent}>
              <X size={12} />
            </button>
          </span>
        ) : (
          <button className="startagent" style={{ flex: 1, justifyContent: "center", height: 30 }} onClick={startAgent}>
            <Sparkle size={13} />
            Start agent
            <span className="ar">▸</span>
          </button>
        )}
      </div>

      {ctxOpen && (
        <ContextEditor
          ctx={ctx}
          setCtx={setCtx}
          onClose={() => setCtxOpen(false)}
          onSeed={startAgent}
          onToast={showToast}
        />
      )}
    </aside>
  );
}
