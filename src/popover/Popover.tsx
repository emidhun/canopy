// Menu-bar popover — ported from design handoff popover.jsx (worktree granularity)
import { useStore } from "../store";
import type { RepoNode, WorktreeNode } from "../types";
import { aggStatus, isLive } from "../types";
import { Database, External, Fork, Globe, Power, Spinner, WindowIcon } from "../icons";

function RepoHeader({ repo }: { repo: RepoNode }) {
  return (
    <div className="wm-group">
      <span className="wm-fork">
        <Fork size={13} />
      </span>
      <span className="wm-repo">{repo.name}</span>
    </div>
  );
}

function WorktreeRow({ wt }: { wt: WorktreeNode }) {
  const resetting = useStore((s) => !!s.resetting[wt.wtKey]);
  const toggleWorktree = useStore((s) => s.toggleWorktree);
  const resetDb = useStore((s) => s.resetDb);
  const openWorktree = useStore((s) => s.openWorktree);
  const openPort = useStore((s) => s.openPort);

  const status = aggStatus(wt);
  const busy = status === "starting" || status === "stopping";
  const running = isLive(status) && !busy;
  const label = busy ? (status === "starting" ? "Starting" : "Stopping") : running ? "Stop" : "Start";

  // the web/client service (frontend) to open in the browser
  const webSvc = wt.services.find((s) => s.kind === "web" && s.port != null) ?? wt.services.find((s) => s.port != null);
  const canOpenClient = !!webSvc?.port && isLive(webSvc.status);

  return (
    <div className="wm-wt">
      <div className="wm-wt-top">
        <span className="wm-wt-branch">{wt.branch}</span>
        <div className="wm-acts">
          <button
            className="wm-act"
            title={canOpenClient ? `Open client (localhost:${webSvc!.port})` : "Start the worktree to open the client"}
            onClick={() => canOpenClient && openPort(webSvc!.port!)}
            disabled={!canOpenClient}
          >
            <Globe size={15} />
          </button>
          <button className="wm-act" title="Open worktree" onClick={() => openWorktree(wt.wtKey, "editor")}>
            <External size={15} />
          </button>
          <button
            className={"wm-act" + (resetting ? " wm-act--busy" : "")}
            title="Reset database"
            onClick={() => !resetting && resetDb(wt.wtKey)}
            disabled={resetting}
          >
            {resetting ? <Spinner size={15} className="wm-spin" /> : <Database size={15} />}
          </button>
          <button
            className={"wm-toggle" + (busy ? " is-busy" : "")}
            onClick={() => !busy && toggleWorktree(wt.wtKey)}
            disabled={busy}
          >
            {label}
          </button>
        </div>
      </div>
      <div className="wm-svcs">
        {wt.services.map((s) => (
          <span className="wm-svc" key={s.svcKey}>
            <span className={"wm-svc-dot s-" + s.status} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Popover() {
  const tree = useStore((s) => s.tree);
  const flash = useStore((s) => s.flash);
  const openManager = useStore((s) => s.openManager);
  const quit = useStore((s) => s.quit);

  return (
    <div className="wm-pop">
      <button className={"wm-item" + (flash === "manager" ? " wm-item--flash" : "")} onClick={openManager}>
        <span className="wm-item-ic">
          <WindowIcon size={16} />
        </span>
        Open Manager
      </button>
      <button className={"wm-item" + (flash === "quit" ? " wm-item--flash" : "")} onClick={quit}>
        <span className="wm-item-ic">
          <Power size={16} />
        </span>
        Quit
      </button>
      <div className="wm-sep" />
      <div className="wm-groups">
        {tree.map((repo, ri) => (
          <div className={"wm-grp" + (ri ? " wm-grp--div" : "")} key={repo.repoId}>
            <RepoHeader repo={repo} />
            {repo.worktrees.map((wt) => (
              <WorktreeRow key={wt.wtKey} wt={wt} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
