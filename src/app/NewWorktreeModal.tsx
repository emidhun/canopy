// New worktree flow — new branch from base, or check out an existing branch.
// Branch pickers are searchable; a Fetch button runs `git fetch --all --prune`.
// Streams create progress (incl. submodule clones) via worktree:op events.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { hasBackend, ipc } from "../ipc";
import { useStore } from "../store";
import { seedWtContext } from "./WorktreeContext";
import { Fork, Refresh, Search, Spinner } from "../icons";

interface OpEvent {
  wtKey: string;
  op: string;
  state: "progress" | "done" | "error";
  detail: string;
}

type RefKind = "local" | "remote" | "tag";

interface BranchItem {
  name: string;
  kind: RefKind;
}

/** Searchable ref dropdown — filters local + remote branches and tags as you type. */
function BranchPicker({
  value,
  items,
  onPick,
  disabled,
  placeholder,
}: {
  value: string;
  items: BranchItem[];
  onPick: (name: string, kind: RefKind) => void;
  disabled?: boolean;
  placeholder: string;
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
        {value && !open && <span className="bp-current">selected</span>}
      </div>
      {open && (
        <div className="bp-list">
          {filtered.length === 0 ? (
            <div className="bp-empty">no matching branches</div>
          ) : (
            filtered.map((b) => (
              <button
                key={b.kind + ":" + b.name}
                className={"bp-item" + (b.name === value ? " sel" : "")}
                onClick={() => {
                  onPick(b.name, b.kind);
                  setQ("");
                  setOpen(false);
                }}
              >
                <span className="bp-name">{b.name}</span>
                {b.kind !== "local" && <span className="bp-tag">{b.kind}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function NewWorktreeModal({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const tree = useStore((s) => s.tree);
  const select = useStore((s) => s.select);
  const showToast = useStore((s) => s.showToast);

  const repos = tree.map((r) => ({ id: r.repoId, name: r.name }));
  const [repo, setRepo] = useState(repoId || repos[0]?.id || "");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState(""); // new-branch name
  const [base, setBase] = useState(""); // base for new branch
  const [baseIsTag, setBaseIsTag] = useState(false);
  const [existing, setExisting] = useState<{ name: string; kind: RefKind } | null>(null);
  const [branches, setBranches] = useState<{ local: string[]; remote: string[]; tags: string[] }>({
    local: [],
    remote: [],
    tags: [],
  });
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pr, setPr] = useState("");
  const [prDescription, setPrDescription] = useState("");
  const [issue, setIssue] = useState("");
  const [issueDescription, setIssueDescription] = useState("");

  const localItems: BranchItem[] = branches.local.map((b) => ({ name: b, kind: "local" as const }));
  const remoteItems: BranchItem[] = branches.remote.map((b) => ({ name: b, kind: "remote" as const }));
  const tagItems: BranchItem[] = (branches.tags ?? []).map((t) => ({ name: t, kind: "tag" as const }));
  const allItems = [...localItems, ...remoteItems, ...tagItems];

  useEffect(() => {
    if (!hasBackend() || !repo) return;
    ipc
      .listBranches(repo)
      .then((b) => {
        setBranches(b);
        if (!base) setBase(b.local.includes("main") ? "main" : b.local[0] ?? "");
      })
      .catch(() => {});
  }, [repo]);

  useEffect(() => {
    if (!hasBackend()) return;
    let un: (() => void) | undefined;
    listen<OpEvent>("worktree:op", (e) => {
      if (e.payload.op !== "create") return;
      setProgress((p) => [...p.slice(-30), e.payload.detail]);
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  async function fetchAll() {
    if (!hasBackend() || fetching) return;
    setFetching(true);
    setError(null);
    try {
      const b = await ipc.fetchBranches(repo);
      setBranches(b);
      showToast(`Fetched — ${b.local.length} local, ${b.remote.length} remote, ${b.tags?.length ?? 0} tags`);
    } catch (e) {
      setError(`Fetch failed — ${String(e)}`);
    } finally {
      setFetching(false);
    }
  }

  async function create() {
    setError(null);
    // resolve to {branch, base, createBranch} from the active mode
    let payload: { branch: string; base?: string; createBranch: boolean };
    if (mode === "new") {
      if (!branch.trim()) return setError("Branch name required");
      // refs/tags/ keeps a tag base unambiguous vs a branch of the same name
      payload = { branch: branch.trim(), base: baseIsTag ? `refs/tags/${base}` : base, createBranch: true };
    } else {
      if (!existing) return setError("Pick a branch or tag");
      if (existing.kind === "remote") {
        // checking out a remote branch → create a local tracking branch.
        // strip the remote name (first path segment): origin/feature/x → feature/x
        const local = existing.name.split("/").slice(1).join("/");
        payload = { branch: local, base: existing.name, createBranch: true };
      } else if (existing.kind === "tag") {
        // checking out a tag → create a local branch named after it
        payload = { branch: existing.name, base: `refs/tags/${existing.name}`, createBranch: true };
      } else {
        payload = { branch: existing.name, createBranch: false };
      }
    }

    setBusy(true);
    setProgress([]);
    try {
      if (!hasBackend()) {
        showToast("New worktree needs the desktop app");
        return;
      }
      const wtPath = await ipc.createWorktree({ repoId: repo, ...payload });
      // The runtime details (ports/database) are derived from the authoritative
      // tree after creation; seed the human handoff now, keyed by the new path.
      seedWtContext(wtPath, { title: payload.branch, pr, prDescription, issue, issueDescription });
      showToast(`Worktree ready — ${payload.branch}`);
      select(wtPath);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const canCreate = mode === "new" ? !!branch.trim() : !!existing;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <span className="fork" style={{ color: "var(--accent)", display: "inline-flex" }}>
            <Fork size={15} />
          </span>
          New worktree
        </div>

        <div className="modal-body">
          <label className="set-label">Repository</label>
          <select className="set-input" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={busy}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>

          <div className="bp-head">
            <label className="set-label" style={{ flex: 1 }}>
              Branch
            </label>
            <button className="bp-fetch" onClick={fetchAll} disabled={busy || fetching} title="git fetch --all --prune">
              {fetching ? <Spinner size={13} /> : <Refresh size={13} />}
              {fetching ? "Fetching…" : "Fetch all"}
            </button>
          </div>

          <div className="modal-mode">
            <button className={"console-tab" + (mode === "new" ? " sel" : "")} onClick={() => setMode("new")} disabled={busy}>
              New branch
            </button>
            <button
              className={"console-tab" + (mode === "existing" ? " sel" : "")}
              onClick={() => setMode("existing")}
              disabled={busy}
            >
              Existing branch / tag
            </button>
          </div>

          {mode === "new" ? (
            <>
              <input
                className="set-input"
                placeholder="feature/my-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={busy}
                autoFocus
              />
              <label className="set-label">From base</label>
              <BranchPicker
                value={baseIsTag ? `${base} (tag)` : base}
                items={allItems}
                onPick={(name, kind) => {
                  setBase(name);
                  setBaseIsTag(kind === "tag");
                }}
                disabled={busy}
                placeholder="search base branch or tag…"
              />
            </>
          ) : (
            <BranchPicker
              value={existing?.name ?? ""}
              items={allItems}
              onPick={(name, kind) => setExisting({ name, kind })}
              disabled={busy}
              placeholder="search branches and tags…"
            />
          )}

          <details className="handoff-fields">
            <summary>Agent handoff <span>optional PR / issue context</span></summary>
            <label className="set-label">Pull request</label>
            <input className="set-input" value={pr} placeholder="https://github.com/org/repo/pull/123" onChange={(e) => setPr(e.target.value)} disabled={busy} />
            <textarea className="set-input handoff-desc" value={prDescription} placeholder="What the PR changes or needs reviewed" onChange={(e) => setPrDescription(e.target.value)} disabled={busy} />
            <label className="set-label">Issue</label>
            <input className="set-input" value={issue} placeholder="https://github.com/org/repo/issues/123" onChange={(e) => setIssue(e.target.value)} disabled={busy} />
            <textarea className="set-input handoff-desc" value={issueDescription} placeholder="Problem, acceptance criteria, and constraints" onChange={(e) => setIssueDescription(e.target.value)} disabled={busy} />
          </details>

          {busy && (
            <div className="modal-progress">
              <span style={{ color: "var(--accent)", display: "inline-flex" }}>
                <Spinner size={14} />
              </span>
              <div className="modal-progress-lines">
                {progress.length ? progress.slice(-4).map((l, i) => <div key={i}>{l}</div>) : <div>creating…</div>}
              </div>
            </div>
          )}
          {error && <div className="modal-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="iconbtn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="iconbtn primary" onClick={create} disabled={busy || !canCreate}>
            {busy ? "Creating…" : "Create worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}
