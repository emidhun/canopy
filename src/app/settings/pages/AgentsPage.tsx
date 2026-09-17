// Agents — which agent CLIs are available in this repo.
import { useState } from "react";
import { type AgentCfg } from "../../../ipc";
import { Check, ChevRight, Plus, Sparkle, Trash } from "../../../icons";
import { emptyAgent } from "../provision";
import { Toggle, TRow, Soon } from "../primitives";
import { missingText, rowKey } from "../incomplete";
import type { PageProps } from "../types";

export default function AgentsPage({ repo, patchRepo, markDirty, flash, invalid }: PageProps) {
  if (!repo) return null;
  const agents = repo.agents || [];
  const patch = (id: string, p: Partial<AgentCfg>) => { patchRepo({ agents: agents.map((a) => (a.id === id ? { ...a, ...p } : a)) }); markDirty("agents"); };
  const makeDefault = (id: string) => { const a = agents.find((x) => x.id === id); if (!a) return; patchRepo({ agents: [a, ...agents.filter((x) => x.id !== id)] }); markDirty("agents"); flash(`${a.name || a.command} is now the default agent`); };
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="sec">
        <div className="slab">Agent CLIs<span className="n">the first is the default</span></div>
        <div className="objs">
          {agents.map((a, i) => {
            const bad = invalid.get(rowKey("agent", i));
            return (
            <div className={"obj" + (open === a.id ? " open" : "") + (bad ? " incomplete" : "")} aria-invalid={bad ? true : undefined} key={a.id}>
              <button className="ohead" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <span className="cv"><ChevRight size={11} /></span>
                <Sparkle size={12} />
                <span className="nm">{a.name || "Untitled"}</span>
                {bad && <span className="tag warn">{missingText(bad)}</span>}
                {i === 0 && <span className="tag" style={{ color: "var(--action-primary)", background: "var(--accent-dim)" }}>default</span>}
                <span className="gr" />
                <span className="mono">{a.command}</span>
                <span className="oacts">
                  {i !== 0 && <span className="ico" title="Make default" onClick={(e) => { e.stopPropagation(); makeDefault(a.id); }}><Check size={11} /></span>}
                  <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); patchRepo({ agents: agents.filter((x) => x.id !== a.id) }); markDirty("agents"); }}><Trash size={11} /></span>
                </span>
              </button>
              {open === a.id && (
                <div className="obody">
                  <div className="fgrid">
                    <span className="lb">Name</span><input className="inp" value={a.name} placeholder="Claude Code" onChange={(e) => patch(a.id, { name: e.target.value })} />
                    <span className="lb">Command</span><input className="inp mono" value={a.command} placeholder="claude" onChange={(e) => patch(a.id, { command: e.target.value })} />
                  </div>
                  <div className="tglrow" style={{ borderTop: 0 }}>
                    <span className="tt"><b>Prompt on launch</b><span>Append Canopy's structured handoff as the first prompt.</span></span>
                    <Toggle on={a.promptOnLaunch} onClick={() => patch(a.id, { promptOnLaunch: !a.promptOnLaunch })} />
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => { const a = { ...emptyAgent(), name: "New agent" }; patchRepo({ agents: agents.concat([a]) }); setOpen(a.id); markDirty("agents"); }}>
          <Plus size={11} />Add agent</button>
      </div>
      <div className="sec">
        <div className="slab">Context handed to every agent</div>
        <Soon>The per-agent context toggles and concurrency limit aren't wired yet — Canopy currently seeds the worktree context by default.</Soon>
        <div className="soonwrap">
          <TRow title="Worktree context" hint="Task title, description and linked PR or issue." on disabled />
          <TRow title="Runtime facts" hint="Branch, ports, database name and running services." on disabled />
          <TRow title="Recent failing logs" hint="The last 40 error lines, when a service is unhealthy." on={false} disabled />
        </div>
      </div>
    </>
  );
}
