// Remove-worktree confirm: shows dirty state (incl. submodules) and warns that
// the worktree's private submodule clones die with it.
import { useEffect, useState } from "react";
import { hasBackend, ipc } from "../ipc";
import { useStore } from "../store";
import type { WorktreeNode } from "../types";
import { Spinner } from "../icons";

export default function RemoveWorktreeModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const [report, setReport] = useState<{ dirty: boolean; details: string[] } | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [dropDb, setDropDb] = useState(true); // default on
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend()) {
      setReport({ dirty: false, details: [] });
      return;
    }
    ipc.worktreeDirtyReport(wt.wtKey).then(setReport);
  }, [wt.wtKey]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      if (!hasBackend()) {
        showToast("Remove needs the desktop app");
        return;
      }
      await ipc.removeWorktree(wt.wtKey, deleteBranch, dropDb);
      showToast(`Worktree removed — ${wt.branch}`);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal">
        <div className="modal-head">Remove worktree — {wt.branch}</div>
        <div className="modal-body">
          <div style={{ fontSize: 12.5, color: "var(--dim)", lineHeight: 1.55 }}>
            Deletes <span className="gitnum">{wt.path}</span> including its private submodule checkouts. Unpushed
            commits inside submodules are lost.
          </div>
          {!report ? (
            <div className="modal-progress">
              <Spinner size={14} />
              <div className="modal-progress-lines">checking for uncommitted changes…</div>
            </div>
          ) : report.dirty ? (
            <div className="modal-dirty">
              ● uncommitted changes:{"\n"}
              {report.details.join("\n")}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--run)" }}>○ clean — no uncommitted changes</div>
          )}
          {wt.dbName && (
            <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--dim)", cursor: "pointer" }}>
              <input type="checkbox" checked={dropDb} onChange={(e) => setDropDb(e.target.checked)} />
              Drop database <span className="gitnum">{wt.dbName}</span>
            </label>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--dim)", cursor: "pointer" }}>
            <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
            Also delete branch <span className="gitnum">{wt.branch}</span>
          </label>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="iconbtn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="iconbtn"
            style={{ background: "var(--stop)", color: "#fff", fontWeight: 600 }}
            onClick={remove}
            disabled={busy || !report}
          >
            {busy ? "Removing…" : "Remove worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}
