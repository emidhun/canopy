/* The service rail — everything the old service cards said, in one 34px row.

   Running services read as filled tokens; idle ones recede to text. A chip
   opens Service detail — the port override, metrics and failure live there.
   Log filtering is the log toolbar's own chip row, so one click never has to
   mean two things. */
import { Database, Play, Restart, Spinner, Stop } from "../../icons";
import { useStore } from "../../store";
import type { ServiceNode, WorktreeNode } from "../../types";
import { isLive } from "../../types";
import { svcDotClass } from "../nextAction";
import CommandButtons from "./CommandButtons";

export default function ServiceRail({
  wt,
  onOpenService,
  onDatabase,
}: {
  wt: WorktreeNode;
  onOpenService: (s: ServiceNode) => void;
  onDatabase: () => void;
}) {
  const stats = useStore((s) => s.stats);
  const startService = useStore((s) => s.startService);
  const stopService = useStore((s) => s.stopService);
  const restartService = useStore((s) => s.restartService);
  const openPort = useStore((s) => s.openPort);

  const empty = wt.services.length === 0 && !wt.dbName;

  const action = (s: ServiceNode) => {
    if (s.status === "error") return { title: `Restart ${s.name}`, icon: <Restart size={11} />, run: () => restartService(s.svcKey) };
    if (s.status === "stopped") return { title: `Start ${s.name}`, icon: <Play size={10} />, run: () => startService(s.svcKey) };
    if (s.status === "running") return { title: `Stop ${s.name}`, icon: <Stop size={9} />, run: () => stopService(s.svcKey) };
    return null;
  };

  return (
    <div className="cxs-rail">
      <div className="cxs-railscroll">
        {empty && <span className="cxs-railempty">No services configured for this worktree.</span>}
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
              (s.status === "error" ? " cxs-svc--error" : "")
            }
            onClick={() => onOpenService(s)}
            role="button"
            tabIndex={0}
            title={`${s.name} — ${s.status}`}
            onKeyDown={(e) => {
              // only when the CHIP itself has focus — this also receives keys
              // bubbling from the nested start/stop button, and preventDefault
              // there would suppress that button's own activation
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenService(s);
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
          <div className="cxs-svc cxs-svc--off cxs-svc--db" onClick={onDatabase} role="button" tabIndex={0} title="Database tools">
            <Database size={11} />
            <span className="nm">{wt.dbName}</span>
          </div>
        )}
      </div>

      {/* custom commands sit beside the runtime they operate on; the rail is
          overflow-visible so this menu can escape it, unlike the scroll area */}
      <CommandButtons wt={wt} />
    </div>
  );
}

export const anyLive = (wt: WorktreeNode) => wt.services.some((s) => isLive(s.status));
