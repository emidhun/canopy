// The agent lane (VariantC) — a first-class right-hand column holding the
// per-worktree context, the coding agent, and a shell. Both the Agent and Shell
// tabs are backed by their own live PTY (see TerminalPane); toggling between
// them keeps both sessions alive.
import { useEffect, useRef, useState } from "react";
import type { RepoNode, WorktreeNode } from "../types";
import { useStore } from "../store";
import { ChevLeft, ChevRight, Doc, Sparkle, Terminal as TerminalIcon } from "../icons";
import TerminalPane from "./TerminalPane";

const COLLAPSE_KEY = "canopy.lane.collapsed";

type Tab = "agent" | "shell";

export default function AgentLane({ repo, wt }: { repo: RepoNode; wt: WorktreeNode }) {
  const showToast = useStore((s) => s.showToast);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [tab, setTab] = useState<Tab>("agent");
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
          <button className="ib" title="Context" onClick={() => setCollapsed(false)}>
            <Doc size={15} />
          </button>
          <span className="vtxt">Agent</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="lane">
      <div className="lane-head">
        <span className="ag-pip busy" style={{ width: 26, height: 26, borderRadius: 8, background: "var(--accent-dim)" }}>
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
          <button
            className="ib"
            style={{ height: 22, fontSize: 11, padding: "0 7px" }}
            onClick={() => showToast("Context editor — coming next")}
          >
            Edit
          </button>
        </div>
        <div className="lc-title" style={{ color: "var(--faint)" }}>
          What is this worktree for?
        </div>
        <div className="lc-body">Set a task or PR description to seed the agent and pre-fill the PR body.</div>
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
        <button
          className="startagent"
          style={{ flex: 1, justifyContent: "center", height: 30 }}
          onClick={() => {
            setTab("agent");
            showToast(`Agent — ${repo.name} · ${wt.branch}`);
          }}
        >
          <Sparkle size={13} />
          Start agent
          <span className="ar">▸</span>
        </button>
      </div>
    </aside>
  );
}
