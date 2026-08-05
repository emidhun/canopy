/* Database tools — the searchable switcher plus the real action set.

   Snapshots are a NAME prompt defaulting to {db}_snap_<timestamp>, not a
   managed list, and restore reads a dump from disk — that is what the backend
   actually does, so that is what the dialog offers. Confirmations are past
   tense and unremarkable: "Snapshot … created", "Now using tj_main". */
import { useEffect, useState } from "react";
import { Database, Download, Info, Refresh, Restart, Pull } from "../../icons";
import { hasBackend, ipc } from "../../ipc";
import { useStore } from "../../store";
import type { WorktreeNode } from "../../types";
import Modal, { Hint, Spacer } from "./Modal";

const snapDefault = (db: string) => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${db}_snap_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

export default function DatabaseModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const resetDb = useStore((s) => s.resetDb);
  const [dbs, setDbs] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(wt.dbName);
  const [q, setQ] = useState("");
  const [snap, setSnap] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hasBackend()) return;
    ipc.listDatabases(wt.wtKey).then(setDbs).catch(() => {});
    ipc.currentDatabase(wt.wtKey).then(setCurrent).catch(() => {});
  }, [wt.wtKey]);

  const list = dbs.filter((d) => d.toLowerCase().includes(q.toLowerCase()));

  const switchTo = async (name: string) => {
    if (name === current || !hasBackend()) return;
    setBusy(true);
    try {
      await ipc.switchDatabase(wt.wtKey, name);
      setCurrent(name);
      showToast(`Now using ${name}`);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ── the snapshot name prompt is its own step, not a separate dialog ── */
  if (snap !== null) {
    return (
      <Modal
        icon={Database}
        title="Save snapshot"
        sub={current ?? undefined}
        narrow
        onClose={() => setSnap(null)}
        foot={
          <>
            <Spacer />
            {/* the snapshot is backend-owned and can take a while; dismissing
                lets it finish rather than holding the dialog hostage */}
            <button className="cx-btn cx-btn--ghost" onClick={() => setSnap(null)}>
              {busy ? "Run in background" : "Cancel"}
            </button>
            <button
              className="cx-btn cx-btn--primary"
              disabled={!snap.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  if (hasBackend()) await ipc.snapshotDatabase(wt.wtKey, snap.trim());
                  showToast(`Snapshot ${snap.trim()} created`);
                  setSnap(null);
                } catch (e) {
                  showToast(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create
              <span className="cx-k">⏎</span>
            </button>
          </>
        }
      >
        <div className="cxm-fld">
          <div className="cxm-flab cxm-flab--f">Snapshot name</div>
          <input
            className="cx-input cx-input--mono"
            value={snap}
            autoFocus
            spellCheck={false}
            onChange={(e) => setSnap(e.target.value)}
          />
          <div className="cxm-fhint">Copies {current} as it is right now. Restore it later from the actions list.</div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      icon={Database}
      title="Database"
      sub={current ? `${current} · isolated to this worktree` : "not configured"}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>Each worktree gets its own database</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="cx-btn cx-btn--primary"
            onClick={async () => {
              try {
                if (hasBackend()) await ipc.runMigration(wt.wtKey);
                showToast("Running migration…");
                onClose();
              } catch (e) {
                showToast(String(e));
              }
            }}
          >
            <Restart size={12} />
            Run migration
            <span className="cx-k">⏎</span>
          </button>
        </>
      }
    >
      <div className="cxm-fld">
        <div className="cxm-flab">
          <Database size={11} />
          Switch database
        </div>
        <div className="cxm-pick-f" style={{ marginBottom: "var(--sp-tight)" }}>
          <input placeholder="Search databases…" value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="cxm-dbl">
          {list.length === 0 ? (
            <div className="cxm-pick-e">{dbs.length ? `No databases match “${q}”.` : "No databases found."}</div>
          ) : (
            list.map((d) => (
              <button key={d} className={"cxm-dbo" + (d === current ? " is-on" : "")} onClick={() => switchTo(d)}>
                <span className="ic">
                  <Database size={11} />
                </span>
                {d}
                {d === current && <span className="cx-tag" style={{ marginLeft: "auto" }}>current</span>}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab">Actions</div>
        <button className="cxm-act" onClick={() => setSnap(snapDefault(current ?? "db"))}>
          <span className="ic">
            <Pull size={13} />
          </span>
          Save snapshot…
          <span className="sub">{current}_snap_…</span>
        </button>
        <button
          className="cxm-act"
          onClick={async () => {
            if (!hasBackend()) return showToast("Export needs the desktop app");
            const { save } = await import("@tauri-apps/plugin-dialog");
            const path = await save({ defaultPath: `${current}.dump`, title: "Export database" });
            if (!path) return;
            try {
              await ipc.exportDatabase(wt.wtKey, path);
              showToast(`Exported ${current}`);
              onClose();
            } catch (e) {
              showToast(String(e));
            }
          }}
        >
          <span className="ic">
            <Download size={12} />
          </span>
          Export to file…
          <span className="sub">{current}.dump</span>
        </button>
        <button
          className="cxm-act"
          onClick={async () => {
            if (!hasBackend()) return showToast("Restore needs the desktop app");
            const { open } = await import("@tauri-apps/plugin-dialog");
            const path = await open({ title: "Restore database", multiple: false });
            if (!path || typeof path !== "string") return;
            try {
              await ipc.restoreDatabase(wt.wtKey, path);
              showToast(`Restoring ${current} from file…`);
              onClose();
            } catch (e) {
              showToast(String(e));
            }
          }}
        >
          <span className="ic">
            <Refresh size={12} />
          </span>
          Restore from file…
          <span className="sub">.dump · .backup · .sql</span>
        </button>
        <button
          className="cxm-act cxm-act--danger"
          onClick={() => {
            resetDb(wt.wtKey);
            onClose();
          }}
        >
          <span className="ic">
            <Restart size={12} />
          </span>
          Reset database
          <span className="sub">drops and re-seeds</span>
        </button>
      </div>
    </Modal>
  );
}
