import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { hasBackend, ipc } from "../ipc";
import type { WorktreeNode } from "../types";
import { isLive } from "../types";

export default function Console({ wt }: { wt: WorktreeNode }) {
  const logsMap = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const opLog = useStore((s) => s.ops[wt.wtKey]);
  const clearOpLog = useStore((s) => s.clearOpLog);
  const [filter, setFilter] = useState<string>("all"); // "all" | "setup" | svcKey

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // reset to "all" + hydrate each service's ring buffer when the worktree changes
  useEffect(() => {
    setFilter("all");
    if (!hasBackend()) return;
    wt.services.forEach((s) =>
      ipc
        .getLogs(s.svcKey)
        .then((lines) => useStore.setState((st) => ({ logs: { ...st.logs, [s.svcKey]: lines } })))
        .catch(() => {}),
    );
  }, [wt.wtKey]);

  // switch to the Setup tab automatically when a setup/command run starts
  const opRunning = opLog?.running ?? false;
  useEffect(() => {
    if (opRunning) setFilter("setup");
  }, [opRunning]);

  const lines = useMemo(() => {
    if (filter === "setup") {
      return (opLog?.lines ?? []).map((l) => ({ ...l, svc: undefined as string | undefined }));
    }
    if (filter === "all") {
      const merged = wt.services.flatMap((s) =>
        (logsMap[s.svcKey] || []).map((l) => ({ ...l, svc: s.name })),
      );
      merged.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      return merged;
    }
    return (logsMap[filter] || []).map((l) => ({ ...l, svc: undefined as string | undefined }));
  }, [filter, logsMap, opLog, wt.services]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  function clear() {
    if (filter === "setup") {
      clearOpLog(wt.wtKey);
      if (!opRunning) setFilter("all");
    } else if (filter === "all") wt.services.forEach((s) => clearLogs(s.svcKey));
    else clearLogs(filter);
  }

  const hasOpLog = (opLog?.lines.length ?? 0) > 0 || opRunning;

  return (
    <div className="logpanel">
      <div className="logbar">
        Logs
        <button className={"filt" + (filter === "all" ? " on" : "")} onClick={() => setFilter("all")}>
          All
        </button>
        {wt.services.map((s) => (
          <button
            key={s.svcKey}
            className={"filt" + (filter === s.svcKey ? " on" : "")}
            onClick={() => setFilter(s.svcKey)}
          >
            <span className={"d" + (isLive(s.status) ? " run" : "")} />
            {s.name}
          </button>
        ))}
        {hasOpLog && (
          <button className={"filt" + (filter === "setup" ? " on" : "")} onClick={() => setFilter("setup")}>
            <span className={"d" + (opRunning ? " run" : "")} />
            Setup
          </button>
        )}
        <button className="clear" onClick={clear}>
          Clear
        </button>
      </div>
      <div className="logbody" ref={bodyRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <div className="log-empty">No output yet.</div>
        ) : (
          lines.map((l, i) => (
            <div className="logline" key={i}>
              <span className="t">{l.t} </span>
              {l.svc && <span className="tag">[{l.svc}] </span>}
              <span className={"lv-" + l.lv}>
                {l.lv === "err" ? "ERROR" : l.lv === "warn" ? "warn" : l.lv === "ok" ? "✓" : "›"}{" "}
              </span>
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
