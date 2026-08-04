/* The topbar: global state, always visible.

   Left is identity (brand + which worktree you're in), centre is the one
   global entry point (⌘K), right is the cross-worktree signal — how much is
   running, how many agents, and what needs a human. */
import { useEffect, useRef } from "react";
import { Bell, Check, ChevRight, Chevron, Cube, Fork, Refresh, Settings, Sparkle, Alert } from "../../icons";
import type { AttnItem } from "../nextAction";
import type { RepoNode, WorktreeNode } from "../../types";

export function TopBar({
  repo,
  wt,
  attn,
  running,
  agents,
  onPalette,
  onAttn,
  onOverview,
  onRefresh,
  onSettings,
}: {
  repo: RepoNode | null;
  wt: WorktreeNode | null;
  attn: AttnItem[];
  running: number;
  agents: number;
  onPalette: () => void;
  onAttn: () => void;
  onOverview: () => void;
  onRefresh: () => void;
  onSettings: () => void;
}) {
  const crashes = attn.filter((a) => a.kind === "crash").length;

  return (
    <div className="cxs-topbar" data-tauri-drag-region>
      <div className="cxs-tb-l">
        <div className="cxs-brand">
          <span className="fk">
            <Fork size={13} />
          </span>
          Canopy
        </div>
        <span className="cxs-tdiv" />
        {repo && wt && (
          <button className="cxs-crumb" onClick={onPalette} title="Switch worktree  (⌘K)">
            <span className="rp">{repo.name}</span>
            <span className="rpchev">
              <ChevRight size={11} />
            </span>
            <span className="br">{wt.branch}</span>
            <Chevron size={11} />
          </button>
        )}
      </div>

      <div className="cxs-tb-c">
        <button className="cxs-gsearch" onClick={onPalette} title="Search or run command  (⌘K)">
          <span className="k">⌘K</span>
          <span className="ph">Search or run command…</span>
        </button>
      </div>

      <div className="cxs-tb-r">
        <button className="cxs-gchip" onClick={onOverview} title="All worktrees  (⌘O)">
          <span className="cx-dot cx-dot--running" />
          <span>{running}</span>
          <span className="lbl">running</span>
        </button>
        {agents > 0 && (
          <button className="cxs-gchip cxs-gchip--agent" onClick={onOverview} title="Active agents">
            <Sparkle size={11} />
            <span>{agents}</span>
            <span className="lbl">{agents === 1 ? "agent" : "agents"}</span>
          </button>
        )}
        {attn.length > 0 ? (
          <button className={"cxs-attn" + (crashes ? " cxs-attn--crash" : "")} onClick={onAttn}>
            <span className="d" />
            <span>{attn.length}</span>
            <span className="lbl">{`need${attn.length === 1 ? "s" : ""} you`}</span>
          </button>
        ) : (
          <button className="cxs-attn cxs-attn--clear" onClick={onAttn} title="Nothing needs you">
            <Check size={12} />
            <span className="lbl">All clear</span>
          </button>
        )}
        <span className="cxs-tdiv" />
        <button className="cx-ib" title="Rescan worktrees" onClick={onRefresh}>
          <Refresh size={14} />
        </button>
        <button className="cx-ib" title="Settings" onClick={onSettings}>
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}

/** The attention queue — everything needing a human, across worktrees, ranked. */
export function AttentionPop({ items, onPick, onClose }: { items: AttnItem[]; onPick: (a: AttnItem) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const d = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [onClose]);

  return (
    <div className="cx-pop cxs-attnpop" ref={ref}>
      <div className="cx-pop__head">
        <Bell size={11} />
        Needs you
        <span className="cxs-pop__count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="cxs-pop-empty">
          <div className="ic">
            <Check size={17} />
          </div>
          Nothing needs you. Everything is running.
        </div>
      ) : (
        items.map((a) => (
          <button className="cxs-attn-i" key={a.id} onClick={() => onPick(a)}>
            <span className={"ic " + a.kind}>
              {a.kind === "crash" ? <Alert size={12} /> : a.kind === "wait" ? <Sparkle size={12} /> : <Cube size={12} />}
            </span>
            <span className="tx">
              <span className="tt">{a.title}</span>
              <span className="wt">{a.wt}</span>
            </span>
            <span className="go">
              {a.act}
              <ChevRight size={11} />
            </span>
          </button>
        ))
      )}
    </div>
  );
}
