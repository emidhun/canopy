import { useEffect, useState } from "react";
import { getUptimeSec, useStore } from "../store";
import type { ServiceNode } from "../types";
import { fmtUptime } from "../types";
import { hasBackend, ipc } from "../ipc";
import { Power, Restart, Spinner } from "../icons";

const SLOTS = 7;

export default function ServiceCard({ svc }: { svc: ServiceNode }) {
  const stats = useStore((s) => s.stats[svc.svcKey]);
  const startService = useStore((s) => s.startService);
  const stopService = useStore((s) => s.stopService);
  const restartService = useStore((s) => s.restartService);
  const openPort = useStore((s) => s.openPort);
  const showToast = useStore((s) => s.showToast);
  const [editingPort, setEditingPort] = useState<string | null>(null);
  const [hist, setHist] = useState<number[]>([]);

  const busy = svc.status === "starting" || svc.status === "stopping";
  const running = svc.status === "running";

  useEffect(() => {
    if (!running) {
      setHist([]);
      return;
    }
    if (stats?.cpu == null) return;
    setHist((h) => [...h, stats.cpu].slice(-SLOTS));
  }, [stats?.cpu, running]);

  async function savePort() {
    const p = parseInt((editingPort ?? "").trim(), 10);
    if (!p || p === svc.port) {
      setEditingPort(null);
      return;
    }
    try {
      if (hasBackend()) await ipc.setServicePort(svc.svcKey, p);
      showToast(`${svc.name} port → ${p} (restarting if running)`);
      setEditingPort(null);
    } catch (e) {
      showToast(`Couldn't set port — ${e}`);
    }
  }

  const uptime = fmtUptime(stats?.uptimeSec ?? getUptimeSec(svc.svcKey));
  const data = running ? Array.from({ length: SLOTS }, (_, i) => hist[hist.length - SLOTS + i] ?? 0) : new Array(SLOTS).fill(0);
  const max = Math.max(12, ...data);

  return (
    <div className={"srv" + (running ? "" : " off")}>
      <span className={"sdot " + (busy ? "busy" : running ? "on" : "off")} />
      <span className="sname">{svc.name}</span>

      {svc.port ? (
        editingPort !== null ? (
          <input
            className="port-input"
            type="number"
            value={editingPort}
            autoFocus
            onChange={(e) => setEditingPort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") savePort();
              if (e.key === "Escape") setEditingPort(null);
            }}
            onBlur={savePort}
          />
        ) : (
          <span className="portwrap">
            <button
              className="port"
              disabled={!running}
              onClick={() => running && openPort(svc.port!)}
              title={running ? `Open localhost:${svc.port}` : "Not running"}
            >
              :{svc.port}
            </button>
            <button className="edit-port" title="Edit port" disabled={busy} onClick={() => setEditingPort(String(svc.port))}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          </span>
        )
      ) : (
        <span className="port off">no&nbsp;port</span>
      )}

      <div className="metrics">
        <div className="spark">
          {data.map((v, i) => (
            <i key={i} style={{ height: Math.max(2, Math.round((v / max) * 14)) + "px" }} />
          ))}
        </div>
        <div className="metric">
          <span className="v">{running && stats ? `${stats.cpu}%` : "—"}</span>
          <span className="k">cpu</span>
        </div>
        <div className="metric">
          <span className="v">{running && stats ? `${stats.memMb} MB` : "—"}</span>
          <span className="k">mem</span>
        </div>
        <div className="metric">
          <span className="v">{running ? uptime : "—"}</span>
          <span className="k">uptime</span>
        </div>
      </div>

      {running && (
        <button className="power" title={`Restart ${svc.name}`} disabled={busy} onClick={() => restartService(svc.svcKey)}>
          <Restart size={15} />
        </button>
      )}
      <button
        className="power"
        title={running ? `Stop ${svc.name}` : `Start ${svc.name}`}
        disabled={busy}
        onClick={() => (running ? stopService(svc.svcKey) : startService(svc.svcKey))}
      >
        {busy ? <Spinner size={15} /> : <Power size={16} />}
      </button>
    </div>
  );
}
