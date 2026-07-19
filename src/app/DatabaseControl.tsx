// Database row: a name picker (click to switch, searchable) on the left and a
// "⋯" actions menu on the right (Run migration · Save snapshot · Export · Restore · Reset).
import { useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { hasBackend, ipc } from "../ipc";
import { useStore } from "../store";
import type { WorktreeNode } from "../types";
import { Database, External, More, Pull, Restart, Spinner } from "../icons";

function defaultSnapName(db: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${db}_snap_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export default function DatabaseControl({ wt }: { wt: WorktreeNode }) {
  const showToast = useStore((s) => s.showToast);
  const resetDb = useStore((s) => s.resetDb);
  const resetting = useStore((s) => !!s.resetting[wt.wtKey]);
  const [open, setOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const [dbs, setDbs] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [snapOpen, setSnapOpen] = useState(false);
  const [snapName, setSnapName] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  const dbName = wt.dbName;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setOpsOpen(false);
        setSnapOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function togglePicker() {
    const next = !open;
    setOpen(next);
    setOpsOpen(false);
    setSnapOpen(false);
    if (next && hasBackend()) ipc.listDatabases(wt.wtKey).then(setDbs).catch((e) => showToast(`${e}`));
  }

  function toggleOps() {
    setOpsOpen((o) => !o);
    setOpen(false);
    setSnapOpen(false);
  }

  async function switchTo(name: string) {
    setOpen(false);
    if (name === dbName) return;
    setBusy(true);
    showToast(`Switching to ${name}…`);
    try {
      await ipc.switchDatabase(wt.wtKey, name);
      showToast(`Now using ${name}`);
    } catch (e) {
      showToast(`Switch failed — ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function runMigration() {
    setOpsOpen(false);
    if (migrating) return;
    setMigrating(true);
    showToast("Running migration…");
    try {
      if (hasBackend()) await ipc.runMigration(wt.wtKey);
      showToast("Migration complete");
    } catch (e) {
      showToast(`Migration failed — ${e}`);
    } finally {
      setMigrating(false);
    }
  }

  function openSnap() {
    if (!dbName || busy) return;
    setOpen(false);
    setOpsOpen(false);
    setSnapName(defaultSnapName(dbName));
    setSnapOpen(true);
  }

  async function confirmSnap() {
    const name = snapName.trim();
    if (!name || busy) return;
    setSnapOpen(false);
    setBusy(true);
    showToast(`Saving snapshot ${name}…`);
    try {
      if (hasBackend()) await ipc.snapshotDatabase(wt.wtKey, name);
      showToast(`Snapshot ${name} created`);
    } catch (e) {
      showToast(`Snapshot failed — ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportToFile() {
    setOpsOpen(false);
    if (!dbName || busy) return;
    if (!hasBackend()) return showToast("Export needs the desktop app");
    const path = await saveDialog({ defaultPath: `${dbName}.dump`, title: "Export database" });
    if (typeof path !== "string") return;
    setBusy(true);
    showToast(`Exporting ${dbName}…`);
    try {
      await ipc.exportDatabase(wt.wtKey, path);
      showToast(`Exported ${dbName}`);
    } catch (e) {
      showToast(`Export failed — ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function restoreFromFile() {
    setOpsOpen(false);
    if (!dbName || busy) return;
    if (!hasBackend()) return showToast("Restore needs the desktop app");
    const path = await openDialog({
      multiple: false,
      title: "Restore database from a .dump file",
      filters: [{ name: "Postgres dump", extensions: ["dump", "backup", "sql"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    showToast(`Restoring ${dbName} from file…`);
    try {
      await ipc.restoreDatabase(wt.wtKey, path);
      showToast(`Restored ${dbName}`);
    } catch (e) {
      showToast(`Restore failed — ${e}`);
    } finally {
      setBusy(false);
    }
  }

  if (!dbName) {
    return (
      <div className="dbrow">
        <span className="log-empty" style={{ fontSize: 12.5, marginLeft: 8 }}>
          No database configured for this worktree.
        </span>
      </div>
    );
  }

  const filtered = dbs.filter((d) => d.toLowerCase().includes(q.toLowerCase())).slice(0, 80);

  return (
    <div className="dbrow" ref={boxRef}>
      <div className="picker">
        <button onClick={togglePicker} title="Switch database">
          <span className="db-glyph">{busy ? <Spinner size={13} /> : <Database size={14} />}</span>
          <span className="nm">{dbName}</span>
          <span className="caret">▾</span>
        </button>
        {open && (
          <div className="menu down">
            <input className="search" placeholder="Search databases…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
            <div className="list">
              {filtered.length === 0 ? (
                <div className="log-empty" style={{ padding: "7px 9px", fontSize: 12 }}>
                  no databases
                </div>
              ) : (
                filtered.map((d) => (
                  <button key={d} className={"opt" + (d === dbName ? " active" : "")} onClick={() => switchTo(d)}>
                    {d}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div className="spacer" />

      <div className="more">
        <button className={opsOpen ? "on" : ""} title="Database actions" onClick={toggleOps}>
          <More size={17} />
        </button>
        {opsOpen && (
          <div className="menu down-right">
            <button className="item" onClick={runMigration} disabled={migrating}>
              <span className="mi">{migrating ? <Spinner size={14} /> : <Restart size={14} />}</span>
              Run migration
            </button>
            <button className="item" onClick={openSnap}>
              <span className="mi">
                <Pull size={14} />
              </span>
              Save snapshot…
            </button>
            <button className="item" onClick={exportToFile}>
              <span className="mi">
                <External size={14} />
              </span>
              Export to file…
            </button>
            <button className="item" onClick={restoreFromFile}>
              <span className="mi">
                <Restart size={14} />
              </span>
              Restore from file…
            </button>
            <div className="sep" />
            <button
              className="item danger"
              disabled={resetting}
              onClick={() => {
                setOpsOpen(false);
                resetDb(wt.wtKey);
              }}
            >
              <span className="mi">{resetting ? <Spinner size={14} /> : <Restart size={14} />}</span>
              Reset database
            </button>
          </div>
        )}
        {snapOpen && (
          <div className="snap-pop">
            <label>Snapshot name</label>
            <input
              className="set-input"
              placeholder="snapshot name"
              value={snapName}
              autoFocus
              onChange={(e) => setSnapName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSnap();
                if (e.key === "Escape") setSnapOpen(false);
              }}
            />
            <div className="row">
              <button className="ghostbtn" onClick={() => setSnapOpen(false)}>
                Cancel
              </button>
              <button className="primary" onClick={confirmSnap} disabled={!snapName.trim()}>
                Create
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
