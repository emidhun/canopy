/* The sidebar: navigation only, dense and grouped.

   Grouping is what makes a long list scannable — worktrees sort themselves by
   what they want from you, not by which repo they happen to live in.
   "Needs you" outranks everything; pinned worktrees hold the top of the rest. */
import { useMemo, useState } from "react";
import { Chevron, Editor, Logs, Pin, Play, Plus, Search, SidebarIcon, Sparkle, Stop, Terminal } from "../../icons";
import { useStore, type LaneSession } from "../../store";
import { isLive, type RepoNode, type WorktreeNode } from "../../types";
import { agentState, dotClass, wtDot, type AttnItem } from "../nextAction";
import { isPinned, togglePin } from "../pins";

type Flat = { wt: WorktreeNode; repo: RepoNode };

export default function SidebarNav({
  hidden,
  view,
  selKey,
  attn,
  onSelect,
  onOverview,
  onToggle,
  onNew,
  onOpenTerminal,
}: {
  hidden: boolean;
  view: "wt" | "overview";
  selKey: string | null;
  attn: AttnItem[];
  onSelect: (wtKey: string) => void;
  onOverview: () => void;
  onToggle: () => void;
  onNew: () => void;
  onOpenTerminal: (wtKey: string) => void;
}) {
  const tree = useStore((s) => s.tree);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const sessions = useStore((s) => s.sessions);
  const toggleWorktree = useStore((s) => s.toggleWorktree);
  const openWorktree = useStore((s) => s.openWorktree);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const flat = useMemo<Flat[]>(() => tree.flatMap((repo) => repo.worktrees.map((wt) => ({ wt, repo }))), [tree]);
  const q = query.toLowerCase().trim();

  const groups = useMemo(() => {
    const vis = flat.filter(({ wt, repo }) => !q || `${wt.branch} ${repo.name}`.toLowerCase().includes(q));
    const needs = new Set(attn.map((a) => a.wtKey));
    const rest = vis.filter((f) => !needs.has(f.wt.wtKey));
    return [
      { k: "attn", label: "Needs you", items: vis.filter((f) => needs.has(f.wt.wtKey)) },
      { k: "pin", label: "Pinned", items: rest.filter((f) => f.wt.pinned) },
      {
        k: "run",
        label: "Running",
        items: rest.filter((f) => !f.wt.pinned && f.wt.services.some((s) => isLive(s.status))),
      },
      {
        k: "idle",
        label: "Idle",
        items: rest.filter((f) => !f.wt.pinned && !f.wt.services.some((s) => isLive(s.status))),
      },
    ].filter((g) => g.items.length);
  }, [flat, q, attn]);

  return (
    <aside className={"cxs-side" + (hidden ? " is-hidden" : "")} inert={hidden || undefined} aria-hidden={hidden || undefined}>
      <div className="cxs-shead">
        <div className="cx-search cxs-sfilter">
          <Search size={12} />
          <input placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="cx-ib" title="Hide worktrees  (⌘B)" aria-pressed="true" onClick={onToggle}>
          <SidebarIcon size={14} />
        </button>
      </div>

      <div className="cxs-slist">
        <button className={"cxs-ovrow" + (view === "overview" ? " is-on" : "")} onClick={onOverview}>
          <Logs size={13} />
          All worktrees
          <span className="n">{flat.length}</span>
        </button>

        {groups.map((g) => (
          <div key={g.k}>
            <button
              className={"cxs-grp" + (closed[g.k] ? " is-closed" : "")}
              onClick={() => setClosed({ ...closed, [g.k]: !closed[g.k] })}
            >
              <span className="cv">
                <Chevron size={10} />
              </span>
              {g.label}
              <span className="gn">{g.items.length}</span>
            </button>
            {!closed[g.k] &&
              g.items.map(({ wt }) => (
                <WorktreeRow
                  key={wt.wtKey}
                  wt={wt}
                  selected={wt.wtKey === selKey && view === "wt"}
                  sessions={sessions[wt.wtKey] ?? EMPTY}
                  onSelect={() => onSelect(wt.wtKey)}
                  onToggleServices={() => toggleWorktree(wt.wtKey)}
                  onTerminal={() => onOpenTerminal(wt.wtKey)}
                  onEditor={() => openWorktree(wt.wtKey, "editor")}
                />
              ))}
          </div>
        ))}

        {groups.length === 0 && <div className="cxs-sempty">{q ? `No worktrees match “${query}”.` : "No worktrees yet."}</div>}
      </div>

      <div className="cxs-sfoot">
        <button className="cxs-newbtn" onClick={onNew}>
          <Plus size={13} />
          New worktree
        </button>
      </div>
    </aside>
  );
}

const EMPTY: LaneSession[] = [];

function WorktreeRow({
  wt,
  selected,
  sessions,
  onSelect,
  onToggleServices,
  onTerminal,
  onEditor,
}: {
  wt: WorktreeNode;
  selected: boolean;
  sessions: LaneSession[];
  onSelect: () => void;
  onToggleServices: () => void;
  onTerminal: () => void;
  onEditor: () => void;
}) {
  const agents = sessions.filter((s) => s.kind === "agent" && s.running);
  const waiting = agents.some((s) => agentState(s) === "waiting");
  const live = wt.services.some((s) => isLive(s.status));
  // isLive() excludes `stopping`, so a worktree mid-shutdown reads as idle and
  // the toggle would offer "Start services" — which then races the shutdown.
  const settling = wt.services.some((s) => s.status === "starting" || s.status === "stopping");
  const pinned = isPinned(wt);

  return (
    <div className={"cxs-wtr" + (selected ? " is-on" : "")} onClick={onSelect} role="button" tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className={dotClass(wtDot(wt))} />
      <span className="b">{wt.branch}</span>

      <span className="meta">
        {wt.git?.dirty && <span className="dirty" title="uncommitted changes" />}
        {agents.length > 0 && (
          <span className={"agp" + (waiting ? " is-wait" : "")} title={`${agents.length} agent${agents.length > 1 ? "s" : ""}`}>
            <Sparkle size={9} />
            {agents.length > 1 ? agents.length : ""}
          </span>
        )}
        {pinned && (
          <span className="pin" title="pinned">
            <Pin size={10} />
          </span>
        )}
      </span>

      {/* quick actions — the common next moves without opening the worktree */}
      <span className="cxs-qa">
        <button
          className={"qb " + (live ? "st" : "go")}
          disabled={settling}
          title={settling ? "Waiting for services to settle…" : live ? "Stop services" : "Start services"}
          onClick={(e) => {
            e.stopPropagation();
            if (settling) return;
            onToggleServices();
          }}
        >
          {live ? <Stop size={10} /> : <Play size={11} />}
        </button>
        <button
          className="qb"
          title="Open terminal"
          onClick={(e) => {
            e.stopPropagation();
            onTerminal();
          }}
        >
          <Terminal size={11} />
        </button>
        <button
          className="qb"
          title="Open in editor"
          onClick={(e) => {
            e.stopPropagation();
            onEditor();
          }}
        >
          <Editor size={11} />
        </button>
        <button
          className={"qb" + (pinned ? " is-on" : "")}
          title={pinned ? "Unpin" : "Pin to the top"}
          onClick={(e) => {
            e.stopPropagation();
            togglePin(wt);
          }}
        >
          <Pin size={11} />
        </button>
      </span>
    </div>
  );
}
