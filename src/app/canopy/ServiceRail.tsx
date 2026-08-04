/* The service rail — everything the old service cards said, in one 38px row.

   Running services read as filled tokens; idle ones recede to text. Selecting
   a chip filters the log stream below it, so the rail and the log toolbar are
   two views of one selection rather than two competing controls. */
import { Database, Play, Restart, Spinner, Stop } from "../../icons";
import { useStore } from "../../store";
import type { ServiceNode, WorktreeNode } from "../../types";
import { isLive } from "../../types";
import { svcDotClass } from "../nextAction";

export default function ServiceRail({
  wt,
  filter,
  onFilter,
  onDatabase,
}: {
  wt: WorktreeNode;
  /** svcKey of the service the logs are filtered to, or "all" */
  filter: string;
  onFilter: (svcKey: string) => void;
  onDatabase: () => void;
}) {
  const stats = useStore((s) => s.stats);
  const startService = useStore((s) => s.startService);
  const stopService = useStore((s) => s.stopService);
  const restartService = useStore((s) => s.restartService);
  const openPort = useStore((s) => s.openPort);

  if (wt.services.length === 0 && !wt.dbName) {
    return (
      <div className="cxs-rail">
        <span className="cxs-railempty">No services configured for this worktree.</span>
      </div>
    );
  }

  const action = (s: ServiceNode) => {
    if (s.status === "error") return { title: `Restart ${s.name}`, icon: <Restart size={11} />, run: () => restartService(s.svcKey) };
    if (s.status === "stopped") return { title: `Start ${s.name}`, icon: <Play size={10} />, run: () => startService(s.svcKey) };
    if (s.status === "running") return { title: `Stop ${s.name}`, icon: <Stop size={9} />, run: () => stopService(s.svcKey) };
    return null;
  };

  return (
    <div className="cxs-rail">
      {wt.services.map((s) => {
        const st = stats[s.svcKey];
        const live = s.status === "running";
        const act = action(s);
        return (
          <div
            key={s.svcKey}
            className={
              "cxs-svc" +
              (live ? "" : " cxs-svc--off") +
              (s.status === "error" ? " cxs-svc--error" : "") +
              (filter === s.svcKey ? " is-on" : "")
            }
            onClick={() => onFilter(filter === s.svcKey ? "all" : s.svcKey)}
            role="button"
            tabIndex={0}
            title={`${s.name} — ${s.status}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFilter(filter === s.svcKey ? "all" : s.svcKey);
              }
            }}
          >
            <span className={svcDotClass(s)} />
            <span className="nm">{s.name}</span>
            {s.port != null && (
              <span
                className="pt"
                title={live ? `Open http://localhost:${s.port}` : `port ${s.port}`}
                onClick={(e) => {
                  if (!live) return;
                  e.stopPropagation();
                  openPort(s.port as number);
                }}
              >
                :{s.port}
              </span>
            )}
            {live && st && (
              <>
                <span className="st">{st.cpu.toFixed(0)}%</span>
                <span className="st">{Math.round(st.memMb)}mb</span>
              </>
            )}
            {s.status === "starting" || s.status === "stopping" ? (
              <span className="act">
                <Spinner size={10} />
              </span>
            ) : (
              act && (
                <button
                  className="act"
                  title={act.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    act.run();
                  }}
                >
                  {act.icon}
                </button>
              )
            )}
          </div>
        );
      })}

      {wt.dbName && (
        <div className="cxs-svc cxs-svc--off" onClick={onDatabase} role="button" tabIndex={0} title="Database tools">
          <Database size={11} />
          <span className="nm" style={{ color: "var(--text-secondary)" }}>
            {wt.dbName}
          </span>
        </div>
      )}
    </div>
  );
}

export const anyLive = (wt: WorktreeNode) => wt.services.some((s) => isLive(s.status));
