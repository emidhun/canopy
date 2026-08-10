/* Remove several worktrees at once — the bulk counterpart to
   RemoveWorktreeModal, reached from the sidebar's ⌘/⇧-click selection.

   Same contract: say what is lost, concretely (which of the selected worktrees
   have uncommitted changes), then one teal-red primary that names the action.
   No type-to-confirm — the list itself is the confirmation. */
import { useEffect, useMemo, useState } from "react";
import { errText, hasBackend, ipc } from "../ipc";
import { useStore } from "../store";
import type { WorktreeNode } from "../types";
import { Alert, Info, Spinner, Trash } from "../icons";
import { clear as clearSelection } from "./multiselect";
import Modal, { Hint, Spacer } from "./canopy/Modal";

export default function RemoveWorktreesModal({ wts, onClose }: { wts: WorktreeNode[]; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const [dropDb, setDropDb] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // wtKey → has uncommitted changes (undefined until the probe returns)
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  const withDb = useMemo(() => wts.filter((w) => w.dbName).length, [wts]);
  const dirtyCount = wts.filter((w) => dirty[w.wtKey]).length;

  useEffect(() => {
    if (!hasBackend()) return;
    let alive = true;
    Promise.all(
      wts.map((w) =>
        ipc
          .worktreeDirtyReport(w.wtKey)
          .then((r) => [w.wtKey, r.dirty] as const)
          .catch(() => [w.wtKey, false] as const),
      ),
    ).then((pairs) => {
      if (alive) setDirty(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [wts]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      if (!hasBackend()) {
        showToast("Removing worktrees needs the desktop app");
        return;
      }
      await ipc.removeWorktrees(
        wts.map((w) => w.wtKey),
        deleteBranch,
        dropDb,
      );
      showToast(`Removed ${wts.length} worktree${wts.length === 1 ? "" : "s"}`);
      clearSelection();
      onClose();
    } catch (e) {
      // batch is best-effort: some may have gone, some not. Surface the detail;
      // the tree already refreshed, so the sidebar reflects what actually left.
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      icon={Trash}
      danger
      title={`Remove ${wts.length} worktrees`}
      sub={dirtyCount > 0 ? `${dirtyCount} with uncommitted changes` : "all clean"}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>Branches are kept unless you tick it</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="cx-btn cx-btn--danger" onClick={remove} disabled={busy}>
            {busy ? (
              <>
                <Spinner size={12} />
                Removing…
              </>
            ) : (
              <>
                <Trash size={12} />
                Remove {wts.length} worktrees
              </>
            )}
          </button>
        </>
      }
    >
      {dirtyCount > 0 && (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>
              {dirtyCount} of these {dirtyCount === 1 ? "has" : "have"} uncommitted changes that will be lost.
            </b>{" "}
            Removal forces past a dirty tree; unpushed work in these worktrees and their submodules cannot be recovered.
          </div>
        </div>
      )}

      <div className="cxm-flist">
        {wts.map((w) => (
          <div className="cxm-frow" key={w.wtKey}>
            <span className="cxm-pth">
              <i>{w.branch}</i>
              {w.dbName && <span className="cxm-nt"> · {w.dbName}</span>}
            </span>
            {dirty[w.wtKey] && <span className="cxm-tg cxm-tg--warn">uncommitted</span>}
          </div>
        ))}
      </div>

      {withDb > 0 && (
        <label className="cxm-chk">
          <input type="checkbox" checked={dropDb} onChange={(e) => setDropDb(e.target.checked)} disabled={busy} />
          <span className="cxm-chk__tx">
            <b>Drop databases</b>
            <span>
              {withDb} of the {wts.length} have a database. Off leaves them on the server.
            </span>
          </span>
        </label>
      )}

      <label className="cxm-chk">
        <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} disabled={busy} />
        <span className="cxm-chk__tx">
          <b>Also delete the branches</b>
          <span>Deletes each worktree's local branch too. Unpushed commits on them would be lost.</span>
        </span>
      </label>

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
