/* The sidebar: navigation only, dense and grouped.

   Grouping is what makes a long list scannable — worktrees sort themselves by
   what they want from you, not by which repo they happen to live in.
   "Needs you" outranks everything; pinned worktrees hold the top of the rest. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Chevron, Editor, Fork, Logs, Pin, Play, Plus, Search, SidebarIcon, Sparkle, Stop, Terminal } from "../../icons";
import { useStore, type LaneSession } from "../../store";
import { isLive, type RepoNode, type WorktreeNode } from "../../types";
import { agentState, dotClass, wtDot, type AttnItem } from "../nextAction";
import { isPinned, togglePin, usePins } from "../pins";

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
  const pins = usePins();
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [repoFilter, setRepoFilter] = useState<string | null>(null);

  const flat = useMemo<Flat[]>(() => tree.flatMap((repo) => repo.worktrees.map((wt) => ({ wt, repo }))), [tree]);
  const q = query.toLowerCase().trim();
  // a filter pointing at a removed repo falls back to "all" rather than hiding everything
  const activeRepo = repoFilter && tree.some((r) => r.repoId === repoFilter) ? repoFilter : null;

  const groups = useMemo(() => {
    const vis = flat.filter(({ wt, repo }) => (!activeRepo || repo.repoId === activeRepo) && (!q || `${wt.branch} ${repo.name}`.toLowerCase().includes(q)));
    const needs = new Set(attn.map((a) => a.wtKey));
    const pinned = new Set(pins);
    const rest = vis.filter((f) => !needs.has(f.wt.wtKey));
    return [
      { k: "attn", label: "Needs you", items: vis.filter((f) => needs.has(f.wt.wtKey)) },
      { k: "pin", label: "Pinned", items: rest.filter((f) => pinned.has(f.wt.wtKey)) },
      {
        k: "run",
        label: "Running",
        items: rest.filter((f) => !pinned.has(f.wt.wtKey) && f.wt.services.some((s) => isLive(s.status))),
      },
      {
        k: "idle",
        label: "Idle",
        items: rest.filter((f) => !pinned.has(f.wt.wtKey) && !f.wt.services.some((s) => isLive(s.status))),
      },
    ].filter((g) => g.items.length);
  }, [flat, q, activeRepo, attn, pins]);

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

      {tree.length > 1 && (
        <RepoFilter repos={tree.map((r) => ({ id: r.repoId, name: r.name }))} value={activeRepo} onPick={setRepoFilter} />
      )}

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
              g.items.map(({ wt, repo }) => (
                <WorktreeRow
                  key={wt.wtKey}
                  wt={wt}
                  repoName={repo.name}
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

/* Filter the list to one repository. Hidden when there's only one repo — the
   text field already narrows by branch (and repo name), so the dropdown only
   earns its space once worktrees span more than one repo. */
function RepoFilter({ repos, value, onPick }: { repos: { id: string; name: string }[]; value: string | null; onPick: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [open]);
  const sel = repos.find((r) => r.id === value);
  return (
    <div className="cxs-repobar" ref={ref}>
      <button className="cxs-repobtn" onClick={() => setOpen((o) => !o)} title="Filter by repository" aria-haspopup="listbox" aria-expanded={open}>
        <Fork size={11} />
        <span className="nm">{sel ? sel.name : "All repositories"}</span>
        <Chevron size={10} />
      </button>
      {open && (
        <div className="cxs-repomenu" role="listbox">
          <button className={"cxs-repoitem" + (value === null ? " is-on" : "")} role="option" aria-selected={value === null} onClick={() => { onPick(null); setOpen(false); }}>
            <span className="nm">All repositories</span>
          </button>
          {repos.map((r) => (
            <button key={r.id} className={"cxs-repoitem" + (r.id === value ? " is-on" : "")} role="option" aria-selected={r.id === value} onClick={() => { onPick(r.id); setOpen(false); }}>
              <Fork size={11} />
              <span className="nm">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WorktreeRow({
  wt,
  repoName,
  selected,
  sessions,
  onSelect,
  onToggleServices,
  onTerminal,
  onEditor,
}: {
  wt: WorktreeNode;
  repoName: string;
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
  const pinned = isPinned(wt.wtKey);

  return (
    <div className={"cxs-wtr" + (selected ? " is-on" : "")} title={`${repoName}: ${wt.branch}`} onClick={onSelect} role="button" tabIndex={0}
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
            togglePin(wt.wtKey);
          }}
        >
          <Pin size={11} />
        </button>
      </span>
    </div>
  );
}
