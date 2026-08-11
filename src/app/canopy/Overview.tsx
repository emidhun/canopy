/* The overview — the cross-worktree surface (⌘O).

   Attention first, then running, then idle. Every section's table shares one
   geometry so columns align down the whole page. */
import { useMemo } from "react";
import { Alert, ChevRight, Play, Restart, SidebarIcon, Sparkle, Stop, Terminal } from "../../icons";
import { useStore, type LaneSession } from "../../store";
import { isLive, type RepoNode, type WorktreeNode } from "../../types";
import { agentState, dotClass, nextAction, wtDot, type AttnItem } from "../nextAction";

const EMPTY: LaneSession[] = [];

export default function Overview({
  attn,
  onSelect,
  onOpenTerminal,
  onRunNext,
  sideHidden,
  onShowSide,
}: {
  attn: AttnItem[];
  onSelect: (wtKey: string) => void;
  onOpenTerminal: (wtKey: string) => void;
  onRunNext: (wtKey: string) => void;
  sideHidden: boolean;
  onShowSide: () => void;
}) {
  const tree = useStore((s) => s.tree);
  const sessions = useStore((s) => s.sessions);
  const stats = useStore((s) => s.stats);
  const startAll = useStore((s) => s.startAll);
  const stopAll = useStore((s) => s.stopAll);
  const showToast = useStore((s) => s.showToast);

  const flat = useMemo(() => tree.flatMap((repo) => repo.worktrees.map((wt) => ({ wt, repo }))), [tree]);
  const running = flat.reduce((n, f) => n + f.wt.services.filter((s) => s.status === "running").length, 0);
  const totalSvc = flat.reduce((n, f) => n + f.wt.services.length, 0);
  const agentCount = Object.values(sessions)
    .flat()
    .filter((s) => s.kind === "agent" && s.running).length;
  // a finished-in-the-background notice is news, not a demand — it stays in
  // the queue without pulling its worktree into the Needs-you section
  const needs = new Set(attn.filter((a) => a.kind !== "info").map((a) => a.wtKey));

  const head = (
    <tr>
      <th>Worktree</th>
      <th>Repo</th>
      <th>Services</th>
      <th>Agent</th>
      <th className="r">CPU</th>
      <th className="r">Memory</th>
      <th className="r">Size</th>
      <th>Git</th>
      <th />
    </tr>
  );

  const row = (wt: WorktreeNode, repo: RepoNode) => {
    const ss = sessions[wt.wtKey] ?? EMPTY;
    const agent = ss.find((s) => s.kind === "agent" && s.running);
    const state = agent ? agentState(agent) : null;
    const live = wt.services.filter((s) => isLive(s.status)).length;
    // the store retains a service's last sample after it stops, so totalling
    // every service would keep counting processes that are gone
    const running = wt.services.filter((s) => isLive(s.status));
    const cpu = running.reduce((n, s) => n + (stats[s.svcKey]?.cpu ?? 0), 0);
    const mem = running.reduce((n, s) => n + (stats[s.svcKey]?.memMb ?? 0), 0);
    const na = nextAction(wt, ss);
    const g = wt.git;

    return (
      <tr key={wt.wtKey} onClick={() => onSelect(wt.wtKey)}>
        <td>
          <span className="bcell">
            <span className={dotClass(wtDot(wt))} />
            <span className="bn">{wt.branch}</span>
          </span>
        </td>
        <td>
          <span className="rp">{repo.name}</span>
        </td>
        <td>
          <span className="cxs-dots">
            {wt.services.map((s) => (
              <i key={s.svcKey} className={s.status === "error" ? "bad" : isLive(s.status) ? "on" : ""} />
            ))}
          </span>
          <span className="rp svccount">
            {live}/{wt.services.length}
          </span>
        </td>
        <td>
          {state ? (
            <span className={"cxs-agtag" + (state === "waiting" ? " cxs-agtag--wait" : "")}>
              <Sparkle size={9} />
              {state === "waiting" ? "waiting" : "working"}
            </span>
          ) : (
            <span className="cxs-agtag cxs-agtag--none">—</span>
          )}
        </td>
        <td className="r num">{live ? `${cpu.toFixed(1)}%` : "—"}</td>
        <td className="r num">{live ? `${Math.round(mem)} MB` : "—"}</td>
        {/* TODO(#55): no backend measures a worktree's on-disk footprint yet.
            The column is kept so the table geometry matches the design and
            wiring it up stays purely additive. */}
        <td className="r num muted" title="Disk usage is not measured yet">
          —
        </td>
        <td className="num muted">
          {g ? (
            <>
              {g.behind ? `↓${g.behind} ` : ""}
              {g.ahead ? `↑${g.ahead}` : ""}
              {g.dirty ? " ●" : ""}
              {!g.behind && !g.ahead && !g.dirty ? "clean" : ""}
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="r">
          <span className="cxs-rowact">
            <button
              className="cx-ib cx-ib--tab"
              
              title={na.label}
              onClick={(e) => {
                e.stopPropagation();
                onRunNext(wt.wtKey);
              }}
            >
              {na.kind === "crash" ? <Restart size={12} /> : na.id === "start" || na.id === "startrest" ? <Play size={12} /> : <ChevRight size={12} />}
            </button>
            <button
              className="cx-ib cx-ib--tab"
              
              title="Terminal"
              onClick={(e) => {
                e.stopPropagation();
                onOpenTerminal(wt.wtKey);
              }}
            >
              <Terminal size={12} />
            </button>
          </span>
        </td>
      </tr>
    );
  };

  const section = (label: string, items: typeof flat, colour?: string) =>
    items.length > 0 && (
      <div className="cxs-ovsec">
        <p className="cxs-ovlabel" style={colour ? { color: colour } : undefined}>
          {label}
        </p>
        <table className="cxs-tbl">
          <thead>{head}</thead>
          <tbody>{items.map((f) => row(f.wt, f.repo))}</tbody>
        </table>
      </div>
    );

  const attnItems = flat.filter((f) => needs.has(f.wt.wtKey));
  const rest = flat.filter((f) => !needs.has(f.wt.wtKey));

  return (
    <div className="cxs-ov">
      <div className="cxs-ovhead">
        {sideHidden && (
          <button className="cx-ib" title="Show worktrees  (⌘B)" onClick={onShowSide}>
            <SidebarIcon size={14} />
          </button>
        )}
        <h2>All worktrees</h2>
        <div className="cxs-ovstats">
          <span className="cxs-ovs">
            <span className="d" style={{ background: "var(--state-running)" }} />
            <b>{running}</b>/{totalSvc} services
          </span>
          <span className="cxs-ovs">
            <Sparkle size={11} />
            <b>{agentCount}</b> {agentCount === 1 ? "agent" : "agents"}
          </span>
          {attn.length > 0 && (
            <span className="cxs-ovs cxs-ovs--warn">
              <Alert size={11} />
              <b>{attn.length}</b> need you
            </span>
          )}
        </div>
        <span className="cxs-spacer" />
        <button
          className="cx-btn cx-btn--sm"
          onClick={() => {
            flat.forEach((f) => startAll(f.wt.wtKey));
            showToast("Starting every worktree…");
          }}
        >
          <Play size={11} />
          <span>Start all</span>
        </button>
        <button
          className="cx-btn cx-btn--sm"
          onClick={() => {
            flat.forEach((f) => stopAll(f.wt.wtKey));
            showToast("Stopping every worktree…");
          }}
        >
          <Stop size={10} />
          <span>Stop all</span>
        </button>
      </div>

      <div className="cxs-ovbody">
        {flat.length === 0 ? (
          <div className="cxs-ovempty">No worktrees yet — add a repository to get started.</div>
        ) : (
          <>
            {section(`Needs you · ${attnItems.length}`, attnItems, "var(--state-attention)")}
            {section(
              "Running",
              rest.filter((f) => f.wt.services.some((s) => isLive(s.status))),
            )}
            {section(
              "Idle",
              rest.filter((f) => !f.wt.services.some((s) => isLive(s.status))),
            )}
          </>
        )}
      </div>
    </div>
  );
}
