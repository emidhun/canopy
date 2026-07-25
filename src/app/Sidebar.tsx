import { useStore } from "../store";
import { isLive } from "../types";
import { Fork, Plus, Search, Sparkle } from "../icons";

export default function Sidebar({ onAdd }: { onAdd: () => void }) {
  const tree = useStore((s) => s.tree);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const selKey = useStore((s) => s.selKey);
  const select = useStore((s) => s.select);
  const agents = useStore((s) => s.agents);

  const q = query.toLowerCase();
  const total = tree.reduce((n, r) => n + r.worktrees.length, 0);

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span className="sb-title">
          Worktrees<span className="num">{total}</span>
        </span>
      </div>
      <div className="sb-search">
        <span className="mag">
          <Search size={13} />
        </span>
        <input placeholder="Filter worktrees…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="wt-list">
        {tree.map((repo) => {
          const wts = repo.worktrees.filter((w) => !q || `${repo.name} ${w.branch}`.toLowerCase().includes(q));
          if (!wts.length) return null;
          return (
            <div key={repo.repoId}>
              <div className="sb-group">
                <span className="fork">
                  <Fork size={12} />
                </span>
                {repo.name}
                <span className="gcount">{repo.worktrees.length}</span>
              </div>
              {wts.map((w) => {
                const tcount = w.services.length;
                const running = w.services.filter((s) => isLive(s.status)).length;
                const dot = running === 0 ? "off" : running === tcount ? "on" : "part";
                const statusText = running > 0 ? `${running} running` : "idle";
                const agent = agents[w.wtKey] ?? "off";
                return (
                  <button
                    key={w.wtKey}
                    className={"wt" + (w.wtKey === selKey ? " active" : "") + (running === 0 ? " idle" : "")}
                    onClick={() => select(w.wtKey)}
                  >
                    <span className={"d " + dot} />
                    <span className="txt">
                      <div className="b">{w.branch}</div>
                      <div className="r">{statusText}</div>
                    </span>
                    {agent === "running" && (
                      <span className="ag-pip busy" title="Agent working">
                        <Sparkle size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="sb-foot">
        <button className="newbtn" onClick={onAdd}>
          <Plus size={14} />
          New worktree
        </button>
      </div>
    </aside>
  );
}
