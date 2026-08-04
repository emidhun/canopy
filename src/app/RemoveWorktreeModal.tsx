/* Remove worktree — the destructive dialog.

   Warnings say what is lost, concretely: the count, then the actual file list.
   Never "This action cannot be undone." The primary is armed only once the
   branch name is typed back, because the cost here is unrecoverable work in
   private submodule clones, not just a directory. */
import { useEffect, useState } from "react";
import { hasBackend, ipc } from "../ipc";
import { useStore } from "../store";
import type { WorktreeNode } from "../types";
import { Alert, Info, Spinner, Trash } from "../icons";
import Modal, { Hint, Spacer } from "./canopy/Modal";

export default function RemoveWorktreeModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const [report, setReport] = useState<{ dirty: boolean; details: string[] } | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [dropDb, setDropDb] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend()) {
      setReport({ dirty: false, details: [] });
      return;
    }
    ipc
      .worktreeDirtyReport(wt.wtKey)
      .then(setReport)
      .catch(() => setReport({ dirty: false, details: [] }));
  }, [wt.wtKey]);

  const armed = confirm.trim() === wt.branch;
  const ahead = wt.git?.ahead ?? 0;

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
    <Modal
      icon={Trash}
      danger
      title="Remove worktree"
      sub={wt.branch}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>The branch itself is kept unless you tick it</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="cx-btn cx-btn--danger" onClick={remove} disabled={busy || !armed || !report}>
            {busy ? (
              <>
                <Spinner size={12} />
                Removing…
              </>
            ) : (
              <>
                <Trash size={12} />
                Remove worktree
              </>
            )}
          </button>
        </>
      }
    >
      {!report ? (
        <div className="cxm-prog" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">checking for uncommitted changes…</div>
        </div>
      ) : report.dirty ? (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>
              {report.details.length} uncommitted change{report.details.length === 1 ? "" : "s"} will be lost.
            </b>
            <pre>{report.details.join("\n")}</pre>
          </div>
        </div>
      ) : (
        <div className="cx-alert cx-alert--ok">
          <span className="cx-alert__ic">
            <Info size={13} />
          </span>
          <div>Clean — nothing uncommitted in the worktree or its submodules.</div>
        </div>
      )}

      <p
        style={{
          fontSize: "var(--fs-body)",
          color: "var(--text-secondary)",
          lineHeight: "var(--lh-body)",
          margin: "0 0 var(--sp-modal-head)",
        }}
      >
        Deletes <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-small)" }}>{wt.path}</span> and its private
        submodule checkouts. Unpushed commits inside submodules cannot be recovered.
      </p>

      {wt.dbName && (
        <label className="cxm-chk">
          <input type="checkbox" checked={dropDb} onChange={(e) => setDropDb(e.target.checked)} disabled={busy} />
          <span className="cxm-chk__tx">
            <b>Drop database</b>
            <span className="mono">{wt.dbName}</span>
          </span>
        </label>
      )}

      <label className="cxm-chk">
        <input
          type="checkbox"
          checked={deleteBranch}
          onChange={(e) => setDeleteBranch(e.target.checked)}
          disabled={busy}
        />
        <span className="cxm-chk__tx">
          <b>Also delete the branch</b>
          <span>
            {ahead > 0
              ? `${ahead} commit${ahead === 1 ? "" : "s"} not on origin — they would be lost too.`
              : `${wt.branch} is kept unless you tick this.`}
          </span>
        </span>
      </label>

      <div className="cxm-fld" style={{ marginTop: "var(--sp-modal-head)" }}>
        <div className="cxm-flab cxm-flab--f">
          Type{" "}
          <span style={{ fontFamily: "var(--mono)", textTransform: "none", letterSpacing: 0, color: "var(--red-text)" }}>
            {wt.branch}
          </span>{" "}
          to confirm
        </div>
        <input
          className="cx-input cx-input--mono"
          value={confirm}
          spellCheck={false}
          placeholder={wt.branch}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
        />
      </div>

      {error && (
        <div className="cx-alert cx-alert--error" style={{ marginTop: "var(--sp-modal-head)" }}>
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>{error}</div>
        </div>
      )}
    </Modal>
  );
}
