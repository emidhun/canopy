// Switch branch in place — check out a different branch in THIS worktree folder,
// so node_modules / build output are reused (no reinstall/setup). Two modes:
// switch to an existing branch, or create a new branch from a base.
import { useEffect, useRef, useState } from "react";
import { hasBackend, ipc } from "../ipc";
import { useStore } from "../store";
import type { RepoNode, WorktreeNode } from "../types";
import { Fork, Refresh, Search, Spinner } from "../icons";

type RefKind = "local" | "remote" | "tag";
interface BranchItem {
  name: string;
  kind: RefKind;
  inUse?: boolean; // checked out in another worktree → can't check out here
  current?: boolean;
}

/** Searchable ref picker (reuses the .bp-* styles), with in-use disabling. */
function Picker({
  value,
  items,
  onPick,
  placeholder,
  disabled,
}: {
  value: string;
  items: BranchItem[];
  onPick: (name: string, kind: RefKind) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const needle = q.toLowerCase();
  const filtered = items.filter((b) => b.name.toLowerCase().includes(needle)).slice(0, 60);

  return (
    <div className="bp" ref={boxRef}>
      <div className="bp-field" onClick={() => !disabled && setOpen(true)}>
        <Search size={13} />
        <input
          className="bp-input"
          value={open ? q : value || ""}
          placeholder={value || placeholder}
          disabled={disabled}
          onFocusCapture={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
        />
      </div>
      {open && (
        <div className="bp-list">
          {filtered.length === 0 ? (
            <div className="bp-empty">no matching branches</div>
          ) : (
            filtered.map((b) => (
              <button
                key={b.kind + ":" + b.name}
                className={"bp-item" + (b.name === value ? " sel" : "") + (b.inUse ? " dis" : "")}
                disabled={b.inUse}
                title={b.inUse ? "Checked out in another worktree" : undefined}
                onClick={() => {
                  if (b.inUse) return;
                  onPick(b.name, b.kind);
                  setQ("");
                  setOpen(false);
                }}
              >
                <span className="bp-name">{b.name}</span>
                {b.current && <span className="bp-tag cur">current</span>}
                {b.inUse && <span className="bp-tag warn">in worktree</span>}
                {b.kind !== "local" && !b.inUse && <span className="bp-tag">{b.kind}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function SwitchBranchModal({
  repo,
  wt,
  onClose,
}: {
  repo: RepoNode;
  wt: WorktreeNode;
  onClose: () => void;
}) {
  const showToast = useStore((s) => s.showToast);
  const current = wt.branch;

  const [branches, setBranches] = useState<{ local: string[]; remote: string[]; tags: string[] }>({
    local: [],
    remote: [],
    tags: [],
  });
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [target, setTarget] = useState<{ name: string; kind: RefKind } | null>(null);
  const [name, setName] = useState("");
  const [base, setBase] = useState<{ name: string; kind: RefKind }>({ name: current, kind: "local" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // branches checked out in OTHER worktrees of this repo (git blocks re-checkout)
  const inUse = new Set(repo.worktrees.filter((w) => w.wtKey !== wt.wtKey).map((w) => w.branch));

  useEffect(() => {
    if (!hasBackend()) return;
    ipc.listBranches(repo.repoId).then(setBranches).catch(() => {});
  }, [repo.repoId]);

  const localItems: BranchItem[] = branches.local.map((b) => ({
    name: b,
    kind: "local" as const,
    inUse: inUse.has(b) && b !== current,
    current: b === current,
  }));
  // a remote pick materializes as its short local name — so origin/foo is
  // blocked when local foo is checked out in another worktree
  const shortName = (r: string) => r.split("/").slice(1).join("/");
  const remoteItems: BranchItem[] = branches.remote.map((b) => ({
    name: b,
    kind: "remote" as const,
    inUse: inUse.has(shortName(b)) && shortName(b) !== current,
  }));
  const tagItems: BranchItem[] = (branches.tags ?? []).map((t) => ({ name: t, kind: "tag" as const }));
  const allItems = [...localItems, ...remoteItems, ...tagItems];

  const nextBranch = mode === "existing" ? target?.name ?? "" : name.trim();
  const canGo = mode === "existing" ? !!target && target.name !== current : !!name.trim();

  async function go() {
    setError(null);
    // resolve {branch, create, base} from the active mode + ref kind
    let payload: { branch: string; create: boolean; base?: string };
    if (mode === "existing") {
      if (!target) return setError("Pick a branch");
      if (target.kind === "remote") {
        // if the local branch already exists, check it out instead of `-b`
        // (which would fail with "branch already exists")
        const local = target.name.split("/").slice(1).join("/");
        payload = branches.local.includes(local)
          ? { branch: local, create: false }
          : { branch: local, create: true, base: target.name };
      } else if (target.kind === "tag") {
        payload = { branch: target.name, create: true, base: `refs/tags/${target.name}` };
      } else {
        payload = { branch: target.name, create: false };
      }
    } else {
      if (!name.trim()) return setError("Branch name required");
      const b = base.kind === "tag" ? `refs/tags/${base.name}` : base.name;
      payload = { branch: name.trim(), create: true, base: b };
    }

    setBusy(true);
    try {
      if (!hasBackend()) {
        showToast("Switch branch needs the desktop app");
        return;
      }
      await ipc.switchWorktreeBranch(wt.wtKey, payload.branch, payload.create, payload.base);
      showToast(`Switched to ${payload.branch} — deps reused`);
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
        <div className="modal-head">
          <span className="fork" style={{ color: "var(--accent)", display: "inline-flex" }}>
            <Fork size={15} />
          </span>
          Switch branch
        </div>

        <div className="modal-body">
          <div className="switch-reuse">
            <span className="sr-ic">
              <Refresh size={14} />
            </span>
            <span>
              In-place switch — same folder, so <code>node_modules</code> and build output are reused. Submodules are re-pinned to the target branch, which can take a moment on big repos.
            </span>
          </div>

          <div className="switch-line">
            <span className="sl-cur">
              <Fork size={12} /> {current}
            </span>
            <span className="sl-arrow">→</span>
            <span className={"sl-next" + (canGo ? "" : " empty")}>{nextBranch || "choose a branch"}</span>
          </div>

          <div className="modal-mode">
            <button className={"console-tab" + (mode === "existing" ? " sel" : "")} onClick={() => setMode("existing")} disabled={busy}>
              Switch to existing
            </button>
            <button className={"console-tab" + (mode === "new" ? " sel" : "")} onClick={() => setMode("new")} disabled={busy}>
              New branch
            </button>
          </div>

          {mode === "new" && (
            <>
              <label className="set-label">New branch name</label>
              <input
                className="set-input"
                placeholder="feat/my-thing"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                autoFocus
                spellCheck={false}
              />
            </>
          )}

          <label className="set-label">{mode === "existing" ? "Branch to check out" : "Base branch"}</label>
          {mode === "existing" ? (
            <Picker
              value={target?.name ?? ""}
              items={allItems}
              onPick={(name, kind) => setTarget({ name, kind })}
              placeholder="search branches, remotes, tags…"
              disabled={busy}
            />
          ) : (
            <Picker
              value={base.name}
              items={allItems}
              onPick={(name, kind) => setBase({ name, kind })}
              placeholder="search base…"
              disabled={busy}
            />
          )}

          {wt.git?.dirty && (
            <div className="switch-warn">
              This worktree has <b>uncommitted changes</b> — they'll be carried onto <code>{nextBranch || "the new branch"}</code>. Commit or
              stash first for a clean switch.
            </div>
          )}
          {error && <div className="modal-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="iconbtn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="iconbtn primary" onClick={go} disabled={busy || !canGo}>
            {busy ? <Spinner size={13} /> : null}
            {busy ? "Switching…" : "Switch branch"}
          </button>
        </div>
      </div>
    </div>
  );
}
