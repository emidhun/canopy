// The agent lane (VariantC) — a first-class right-hand column holding the
// per-worktree context, the coding agent, and a shell. Both the Agent and Shell
// tabs are backed by their own live PTY (see TerminalPane); toggling between
// them keeps both sessions alive.
import { useEffect, useRef, useState } from "react";
import type { RepoNode, WorktreeNode } from "../types";
import { useStore } from "../store";
import { hasBackend, ipc } from "../ipc";
import { ChevLeft, ChevRight, Doc, Spinner, Sparkle, Terminal as TerminalIcon, X } from "../icons";
import TerminalPane from "./TerminalPane";
import { ContextEditor, bodyPreview, composeContextMd, isBlank, useWtContext } from "./WorktreeContext";

const COLLAPSE_KEY = "canopy.lane.collapsed";

type Tab = "agent" | "shell";

/** Write to a PTY that may have only just been opened (retry briefly). */
async function writeWhenReady(id: string, data: string, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      await ipc.terminalWrite(id, data);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export default function AgentLane({ repo, wt }: { repo: RepoNode; wt: WorktreeNode }) {
  const showToast = useStore((s) => s.showToast);
  const agentState = useStore((s) => s.agents[wt.wtKey] ?? "off");
  const setAgent = useStore((s) => s.setAgent);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [tab, setTab] = useState<Tab>("agent");
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctx, setCtx] = useWtContext(wt.wtKey);
  // lazily mount a tab's terminal the first time it's shown, then keep it
  // mounted (hidden) so its PTY keeps running in the background.
  const activated = useRef<Set<Tab>>(new Set(["agent"]));
  activated.current.add(tab);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

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

  // Start the configured agent CLI inside the agent PTY (the terminal *is* the
  // chat). The context, if any, is written to .canopy/context.md so the agent
  // can read it, and we show a banner noting the seed.
  const startAgent = async () => {
    setCtxOpen(false);
    setTab("agent");
    if (!hasBackend()) {
      setAgent(wt.wtKey, "running");
      showToast(`Agent — ${repo.name} · ${wt.branch}`);
      return;
    }
    try {
      if (!isBlank(ctx)) {
        await ipc.saveTextFile(`${wt.path}/.canopy/context.md`, composeContextMd(ctx)).catch(() => {});
      }
      const cmd = (await ipc.resolveAgentCommand(wt.wtKey)) || "claude";
      await writeWhenReady(`${wt.wtKey}::agent`, `${cmd}\n`);
      setAgent(wt.wtKey, "running");
      showToast(`Agent started — ${repo.name} · ${wt.branch}`);
    } catch (e) {
      showToast(String(e));
    }
  };

  const stopAgent = () => {
    if (hasBackend()) ipc.terminalWrite(`${wt.wtKey}::agent`, "\x03").catch(() => {}); // Ctrl-C
    setAgent(wt.wtKey, "off");
    showToast("Agent stopped");
  };

  return (
    <aside className="lane">
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
        <button className="ib" title="Collapse lane" onClick={() => setCollapsed(true)}>
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
          {activated.current.has("agent") && (
            <div className={"term-body" + (tab === "agent" ? "" : " hidden")}>
              <TerminalPane termId={agentId} cwd={wt.path} hidden={tab !== "agent"} />
            </div>
          )}
          {activated.current.has("shell") && (
            <div className={"term-body" + (tab === "shell" ? "" : " hidden")}>
              <TerminalPane termId={shellId} cwd={wt.path} hidden={tab !== "shell"} />
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
