/* The worktree bar + service rail + work surface.

   The bar is ONE line: the branch is the only elastic item, and the actions
   never shrink — a shrinking action group just clips its own button. The
   reason rides in front of the next action and is the first thing to yield. */
import { useEffect, useRef, useState } from "react";
import { Cube, Editor, Finder, Fork, More, SidebarIcon, Terminal, Trash } from "../../icons";
import { hasBackend, ipc } from "../../ipc";
import { useStore } from "../../store";
import type { ServiceNode, WorktreeNode } from "../../types";
import { nextClass, type NextAction } from "../nextAction";
import ServiceRail from "./ServiceRail";
import WorkSurface, { type LayoutId } from "./WorkSurface";
import type { LaneLaunch } from "./laneLaunch";

export default function WorktreeView({
  wt,
  na,
  onNext,
  layout,
  setLayout,
  launch,
  sideHidden,
  onShowSide,
  onRemove,
  onDatabase,
}: {
  wt: WorktreeNode;
  na: NextAction;
  onNext: () => void;
  layout: LayoutId;
  setLayout: (l: LayoutId) => void;
  launch: LaneLaunch;
  sideHidden: boolean;
  onShowSide: () => void;
  onRemove: () => void;
  onDatabase: () => void;
}) {
  const openWorktree = useStore((s) => s.openWorktree);
  const restartService = useStore((s) => s.restartService);
  const showToast = useStore((s) => s.showToast);
  const [filter, setFilter] = useState("all");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const NaIcon = na.icon;

  // a filter naming a service that no longer exists would silently hide
  // everything, so fall back to "all" when the worktree changes
  useEffect(() => setFilter("all"), [wt.wtKey]);

  useEffect(() => {
    if (!menu) return;
    const d = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [menu]);

  const runSetup = () => {
    setMenu(false);
    if (!hasBackend()) {
      showToast("Setup runs in the desktop app");
      return;
    }
    showToast(`Running setup — ${wt.branch}…`);
    ipc.runWorktreeSetup(wt.wtKey).catch((e) => showToast(`Setup failed — ${String(e)}`));
  };

  return (
    <div className="cxs-main">
      <div className="cxs-wtbar">
        {/* the toggle lives in the sidebar; collapsed, it reappears here —
            flush against the edge the sidebar just vacated */}
        {sideHidden && (
          <button className="cx-ib" title="Show worktrees  (⌘B)" onClick={onShowSide}>
            <SidebarIcon size={14} />
          </button>
        )}
        <span className="fk">
          <Fork size={14} />
        </span>
        <h1 title={wt.path}>{wt.branch}</h1>

        <div className="cxs-gitchips">
          {wt.git && wt.git.ahead > 0 && <span className="cxs-gc cxs-gc--up">↑{wt.git.ahead}</span>}
          {wt.git && wt.git.behind > 0 && <span className="cxs-gc cxs-gc--down">↓{wt.git.behind}</span>}
          {wt.git?.dirty && (
            <span className="cxs-gc cxs-gc--dirty" title="uncommitted changes">
              ●
            </span>
          )}
        </div>

        <div className="cxs-acts">
          <button className="cx-ib" title="Open in editor" onClick={() => openWorktree(wt.wtKey, "editor")}>
            <Editor size={14} />
          </button>
          <button className="cx-ib" title="Reveal in Finder" onClick={() => openWorktree(wt.wtKey, "finder")}>
            <Finder size={14} />
          </button>
          <div style={{ position: "relative", display: "inline-flex" }} ref={menuRef}>
            <button className="cx-ib" title="More" onClick={() => setMenu((m) => !m)}>
              <More size={15} />
            </button>
            {menu && (
              <div className="cx-pop" style={{ top: 28, right: 0, minWidth: 216 }}>
                <button className="cx-pop__item" onClick={runSetup}>
                  <span className="cx-pop__ic">
                    <Cube size={13} />
                  </span>
                  Run setup
                </button>
                <button
                  className="cx-pop__item"
                  onClick={() => {
                    setMenu(false);
                    openWorktree(wt.wtKey, "terminal");
                  }}
                >
                  <span className="cx-pop__ic">
                    <Terminal size={13} />
                  </span>
                  Open in Terminal
                </button>
                {!wt.isMain && (
                  <>
                    <div className="cx-pop__sep" />
                    <button
                      className="cx-pop__item cx-pop__item--danger"
                      onClick={() => {
                        setMenu(false);
                        onRemove();
                      }}
                    >
                      <span className="cx-pop__ic">
                        <Trash size={13} />
                      </span>
                      Remove worktree…
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <span className="cxs-actdiv" />

          {/* the reason, then the action — never a bare button */}
          <span className="cx-why">{na.why}</span>
          <button className={nextClass(na.kind)} onClick={onNext} disabled={na.kind === "busy"}>
            <NaIcon size={12} />
            {na.label}
            {na.key && <span className="cx-k">{na.key}</span>}
          </button>
        </div>
      </div>

      <ServiceRail wt={wt} filter={filter} onFilter={setFilter} onDatabase={onDatabase} />

      <WorkSurface
        wt={wt}
        layout={layout}
        setLayout={setLayout}
        filter={filter}
        onFilter={setFilter}
        na={na}
        onNext={onNext}
        onRestart={(s: ServiceNode) => restartService(s.svcKey)}
        launch={launch}
      />
    </div>
  );
}
