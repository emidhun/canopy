/* Service detail — opened from a chip in the service rail.

   Carries what ServiceCard used to: the cpu/mem/uptime trio with a CPU
   sparkline, the port override (Esc reverts), and Restart / Stop. When the
   process died, the failure leads — red marks the problem, and the button
   that fixes it stays teal, because restarting is constructive. */
import { useMemo, useState } from "react";
import { Alert, Info, Restart, Server, Stop } from "../../icons";
import { hasBackend, ipc } from "../../ipc";
import { useStore } from "../../store";
import { fmtUptime, type ServiceNode, type WorktreeNode } from "../../types";
import Modal, { Hint, Spacer } from "./Modal";

export default function ServiceDetailModal({
  wt,
  svc,
  onClose,
}: {
  wt: WorktreeNode;
  svc: ServiceNode;
  onClose: () => void;
}) {
  const stats = useStore((s) => s.stats[svc.svcKey]);
  const history = useStore((s) => s.cpuHistory[svc.svcKey]);
  const exitCode = useStore((s) => s.exitCodes[svc.svcKey]);
  const logs = useStore((s) => s.logs[svc.svcKey]);
  const tree = useStore((s) => s.tree);
  const restartService = useStore((s) => s.restartService);
  const stopService = useStore((s) => s.stopService);
  const showToast = useStore((s) => s.showToast);

  const opened = String(svc.port ?? "");
  const [port, setPort] = useState(opened);
  const changed = port !== opened;

  /* Clash detection needs only the tree — every other worktree's ports are
     already known here, so this is real rather than a backend gap. */
  const clash = useMemo(() => {
    const n = Number(port);
    if (!n) return null;
    for (const r of tree)
      for (const w of r.worktrees)
        for (const s of w.services)
          if (s.svcKey !== svc.svcKey && s.port === n) return `${w.branch} · ${s.name}`;
    return null;
  }, [port, tree, svc.svcKey]);

  const valid = /^\d{2,5}$/.test(port) && !clash;
  const crashed = svc.status === "error";
  const tail = (logs ?? []).filter((l) => l.lv === "err").slice(-2);

  const max = Math.max(12, ...(history ?? [0]));

  const save = async () => {
    if (changed) {
      if (!hasBackend()) {
        showToast("Port changes need the desktop app");
        return;
      }
      try {
        await ipc.setServicePort(svc.svcKey, Number(port));
        showToast(`${svc.name} port → ${port}`);
      } catch (e) {
        showToast(String(e));
        return;
      }
    } else {
      restartService(svc.svcKey);
    }
    onClose();
  };

  return (
    <Modal
      icon={Server}
      title={svc.name}
      sub={crashed ? `${wt.branch} · exited${exitCode != null ? ` with code ${exitCode}` : ""}` : `${wt.branch} · ${svc.status}`}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>{changed ? "Saves the port, then restarts" : "Port is derived from the worktree index"}</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose}>
            Close
          </button>
          <button className="cx-btn cx-btn--primary" onClick={save} disabled={!valid}>
            <Restart size={12} />
            {changed ? "Save & restart" : "Restart"}
            <span className="cx-k">⏎</span>
          </button>
        </>
      }
    >
      {crashed && (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>Exited{exitCode != null ? ` with code ${exitCode}` : ""}.</b>
            {tail.length > 0 && <pre>{tail.map((l) => l.text).join("\n")}</pre>}
          </div>
        </div>
      )}

      <div className="cxm-fld">
        <div className="cxm-flab">{crashed ? "Last samples before exit" : "Now"}</div>
        <div className="cxm-mrow">
          {history && history.length > 0 && (
            <div className="cx-spark" title="recent CPU">
              {history.map((v, i) => (
                <i key={i} style={{ height: Math.max(2, Math.round((v / max) * 14)) }} />
              ))}
            </div>
          )}
          <div className="cxm-met">
            <span className="v">{stats ? `${stats.cpu.toFixed(1)}%` : "—"}</span>
            <span className="k">cpu</span>
          </div>
          <div className="cxm-met">
            <span className="v">{stats ? `${Math.round(stats.memMb)} MB` : "—"}</span>
            <span className="k">mem</span>
          </div>
          <div className="cxm-met">
            <span className="v">{fmtUptime(stats?.uptimeSec)}</span>
            <span className="k">uptime</span>
          </div>
          <Spacer />
          {svc.status === "running" && (
            <button
              className="cx-btn cx-btn--sm"
              onClick={() => {
                stopService(svc.svcKey);
                onClose();
              }}
            >
              <Stop size={10} />
              Stop
            </button>
          )}
        </div>
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab cxm-flab--f">
          <Server size={11} />
          Port
        </div>
        <input
          className="cx-input cx-input--mono"
          value={port}
          spellCheck={false}
          onChange={(e) => setPort(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setPort(opened);
            }
          }}
        />
        {clash ? (
          <div className="cxm-fhint cxm-fhint--bad">Port {port} is already used by {clash}.</div>
        ) : changed ? (
          <div className="cxm-fhint cxm-fhint--warn">Overrides the assigned port. Esc reverts to {opened}.</div>
        ) : (
          <div className="cxm-fhint">Assigned from the worktree index. Change it only if something else holds the port.</div>
        )}
      </div>

      {/* TODO(#59): the design shows the resolved environment (PORT,
          DATABASE_URL, TOOLJET_HOST) here. No IPC exposes it, and guessing
          the values would defeat the panel's entire purpose — it exists to
          answer "why is this talking to the wrong database?". Omitted until
          service_env lands. */}
    </Modal>
  );
}
