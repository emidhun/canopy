/* The logs pane — one stream for the whole worktree.

   The shipped app kept a tab per service; the redesign merges them and makes
   the service a filter instead, because what you actually want to read is "what
   happened here", in order, across processes. Recovery is offered inline, right
   where the failure is visible, so you never leave the thing you're reading to
   act on it. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Check, Restart, Search, Sliders, X } from "../../icons";
import { useStore } from "../../store";
import type { LogLevel, LogLine, ServiceNode, WorktreeNode } from "../../types";
import type { NextAction } from "../nextAction";
import { nextClass } from "../nextAction";

interface Row extends LogLine {
  svcKey: string;
  svc: string;
}

const LEVELS: [LogLevel, string, string][] = [
  ["err", "Errors", "var(--state-error)"],
  ["warn", "Warnings", "var(--state-attention)"],
  ["info", "Info", "var(--state-idle)"],
];

/** "ok" lines are informational — they ride with Info rather than earning a
    fourth filter nobody would think to turn off. */
const bucket = (lv: LogLevel): LogLevel => (lv === "ok" ? "info" : lv);

function LevelFilter({ lv, setLv }: { lv: Record<string, boolean>; setLv: (v: Record<string, boolean>) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [open]);

  const off = LEVELS.filter(([k]) => !lv[k]).length;
  return (
    <div className="cxs-fltwrap" ref={box}>
      <button className={"cxs-fchip" + (off ? " is-on" : "")} onClick={() => setOpen((o) => !o)} title="Filter levels">
        <Sliders size={11} />
        Levels
        {off > 0 && <span className="badge">{LEVELS.length - off}</span>}
      </button>
      {open && (
        <div className="cxs-fltpop">
          {LEVELS.map(([k, label, colour]) => (
            <button key={k} className={"cxs-fltrow" + (lv[k] ? " is-on" : "")} onClick={() => setLv({ ...lv, [k]: !lv[k] })}>
              <span className="bx">{lv[k] && <Check size={10} />}</span>
              <span className="d" style={{ background: colour }} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LogsPane({
  wt,
  filter,
  onFilter,
  na,
  onNext,
  onRestart,
}: {
  wt: WorktreeNode;
  filter: string;
  onFilter: (svcKey: string) => void;
  na: NextAction | null;
  onNext: () => void;
  onRestart: (s: ServiceNode) => void;
}) {
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const [lv, setLv] = useState<Record<string, boolean>>({ err: true, warn: true, info: true });
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const crashed = wt.services.find((s) => s.status === "error");

  useEffect(() => setQ(""), [wt.wtKey]);

  /* Merge every service's ring buffer into one stream. The buffers are
     independently capped, so sort by timestamp to interleave them; `t` is
     HH:MM:SS, which orders correctly as a string within a session. */
  const merged = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of wt.services) for (const l of logs[s.svcKey] ?? []) out.push({ ...l, svcKey: s.svcKey, svc: s.name });
    return out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  }, [logs, wt.services]);

  const shown = useMemo(() => {
    const needle = q.toLowerCase();
    return merged.filter(
      (l) => (filter === "all" || l.svcKey === filter) && lv[bucket(l.lv)] !== false && (!needle || l.text.toLowerCase().includes(needle)),
    );
  }, [merged, filter, lv, q]);

  useEffect(() => {
    if (follow && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [shown.length, follow]);

  // A worktree with nothing to run has nothing to read — offer the next step
  // instead. Declared after every hook so hook order stays stable across
  // worktree switches.
  if (wt.services.length === 0) {
    const Icon = na?.icon;
    return (
      <div className="cxs-empty">
        <span className="eic">{Icon && <Icon size={17} />}</span>
        <span className="et">No services yet</span>
        <span className="es">
          This worktree has no services configured, so there is nothing running and nothing to log.
        </span>
        {na && (
          <button className={nextClass(na.kind)} onClick={onNext} style={{ marginTop: 3 }}>
            {Icon && <Icon size={12} />}
            {na.label}
            {na.key && <span className="cx-k">{na.key}</span>}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="cxs-ltool">
        <div className="cxs-ltool-scroll">
          <button className={"cxs-fchip" + (filter === "all" ? " is-on" : "")} onClick={() => onFilter("all")}>
            All
          </button>
          {wt.services.map((s) => (
            <button key={s.svcKey} className={"cxs-fchip" + (filter === s.svcKey ? " is-on" : "")} onClick={() => onFilter(s.svcKey)}>
              <span
                className="d"
                style={{
                  background:
                    s.status === "running"
                      ? "var(--state-running)"
                      : s.status === "error"
                        ? "var(--state-error)"
                        : "var(--state-idle)",
                }}
              />
              {s.name}
            </button>
          ))}
        </div>
        <LevelFilter lv={lv} setLv={setLv} />
        <div className="cxs-lsearch">
          <Search size={11} />
          <input placeholder="Search logs…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={"cxs-fchip" + (follow ? " is-on" : "")} onClick={() => setFollow(!follow)} title="Follow tail">
          Follow
        </button>
        <button
          className="cx-ib"
          title="Clear"
          style={{ height: 22, minWidth: 22 }}
          onClick={() => wt.services.forEach((s) => clearLogs(s.svcKey))}
        >
          <X size={12} />
        </button>
      </div>

      {/* recovery offered right where the failure is visible */}
      {crashed && (
        <div className="cxs-fixbar">
          <span className="ic">
            <Alert size={14} />
          </span>
          <span className="tx">
            <b>{crashed.name} exited.</b> The stack trace is at the end of this log.
          </span>
          <button
            className="cx-btn cx-btn--sm cx-btn--jump"
            onClick={() => {
              onFilter(crashed.svcKey);
              setLv({ err: true, warn: false, info: false });
              setFollow(true);
              if (body.current) body.current.scrollTop = body.current.scrollHeight;
            }}
          >
            Jump to error
          </button>
          <button className="cx-btn cx-btn--sm cx-btn--fix" onClick={() => onRestart(crashed)}>
            <Restart size={11} />
            Restart
          </button>
        </div>
      )}

      <div className="cxs-pbody" ref={body} onWheel={() => setFollow(false)}>
        <div className="cx-logs cxs-logs">
          {shown.length === 0 ? (
            <div className="cxs-logempty">
              {merged.length === 0 ? "Nothing logged yet — start a service to see output here." : "No lines match these filters."}
            </div>
          ) : (
            shown.map((l, n) => (
              <div className={"cx-log" + (l.lv === "err" ? " cx-log--error" : l.lv === "warn" ? " cx-log--warn" : l.lv === "ok" ? " cx-log--ok" : "")} key={`${l.svcKey}-${n}-${l.t}`}>
                <span className="cx-log__t">{l.t}</span>
                <span className="cx-log__src">{l.svc}</span>
                <span className="cx-log__msg">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
