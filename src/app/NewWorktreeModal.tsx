/* New worktree — the creation dialog.

   Two modes: a new branch off a base, or checking out one that exists. The
   "You'll get" panel is the reassurance — it answers "where will this land?"
   while the name is still editable. The agent handoff is optional and
   collapsed, because most worktrees don't need one, but when it's filled in
   it seeds .canopy/context.md and later becomes the PR body. */
import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { errText, hasBackend, ipc, type Branches, type OpEvent } from "../ipc";
import { useStore } from "../store";
import { Alert, ChevRight, Fork, Info, Plus, Refresh, Spinner } from "../icons";
import Modal, { Hint, Spacer } from "./canopy/Modal";
import RefPick from "./canopy/RefPick";
import { seedWtContext } from "./WorktreeContext";

/** Mirrors `sanitize_branch` in commands.rs:605 exactly — alphanumerics, `-`
    and `.` survive, everything else becomes `_`, and CASE IS PRESERVED. An
    approximation here is worse than nothing: the panel exists to tell you
    where the worktree lands, so `Feature/foo` must read `Feature_foo`, not
    `feature-foo`. Rust's is_alphanumeric is Unicode-aware, hence \p{L}\p{N}. */
const sanitizeBranch = (b: string) => b.replace(/[^\p{L}\p{N}.-]/gu, "_");

export default function NewWorktreeModal({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const tree = useStore((s) => s.tree);
  const select = useStore((s) => s.select);
  const showToast = useStore((s) => s.showToast);

  const repos = tree.map((r) => ({ id: r.repoId, name: r.name }));
  const [repo, setRepo] = useState(repoId || repos[0]?.id || "");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [existing, setExisting] = useState("");
  const [existingKind, setExistingKind] = useState<"local" | "remote" | "tags" | "new">("local");
  const [branches, setBranches] = useState<Branches | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pr, setPr] = useState("");
  const [prDescription, setPrDescription] = useState("");
  const [issue, setIssue] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  /** the repo's configured worktree dir; blank means `${repo.path}-worktrees` */
  const [worktreeDir, setWorktreeDir] = useState<string | null>(null);

  const activeRepo = tree.find((r) => r.repoId === repo);
  // git refuses to check the same branch out twice; show them, disabled
  const inUse = useMemo(() => new Set((activeRepo?.worktrees ?? []).map((w) => w.branch)), [activeRepo]);

  useEffect(() => {
    if (!hasBackend() || !repo) {
      setBranches({ local: [], remote: [], tags: [] });
      return;
    }
    // refs are repo-scoped: carrying a base/branch across a repo switch lets
    // Create submit something that doesn't exist in the selected repository
    setBranches(null);
    setBase("");
    setExisting("");
    setExistingKind("local");
    // The repo's configured default base wins when it still exists; falling
    // back to `main` keeps the previous behaviour for repos that have none.
    Promise.all([ipc.listBranches(repo), ipc.getSettings().catch(() => null)])
      .then(([b, st]) => {
        setBranches(b);
        const configured = st?.repos.find((r) => r.id === repo)?.defaultBase?.trim();
        setBase(
          configured && b.local.includes(configured)
            ? configured
            : b.local.includes("main")
              ? "main"
              : (b.local[0] ?? ""),
        );
      })
      .catch(() => setBranches({ local: [], remote: [], tags: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // read the repo's worktreeDir so the destination shown is the real one
  useEffect(() => {
    if (!hasBackend() || !repo) return;
    let alive = true;
    ipc
      .getSettings()
      .then((st) => alive && setWorktreeDir(st.repos.find((r) => r.id === repo)?.worktreeDir ?? ""))
      .catch(() => alive && setWorktreeDir(null));
    return () => {
      alive = false;
    };
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
      showToast(`Fetched — ${b.local.length} local, ${b.remote.length} remote, ${b.tags.length} tags`);
    } catch (e) {
      setError(`Fetch failed — ${errText(e)}`);
    } finally {
      setFetching(false);
    }
  }

  const branch = mode === "new" ? name.trim() : existing;
  const ok = !!branch;
  // create_worktree: `${worktree_dir || repo.path + "-worktrees"}/${sanitize_branch(branch)}`
  const destination =
    ok && worktreeDir !== null && activeRepo
      ? `${worktreeDir.trim() || `${activeRepo.path}-worktrees`}/${sanitizeBranch(branch)}`
      : null;

  async function create() {
    if (!ok) return;
    setBusy(true);
    setProgress([]);
    setError(null);
    try {
      if (!hasBackend()) {
        showToast("New worktree needs the desktop app");
        return;
      }
      // `git worktree add <path> origin/foo` checks out the remote-tracking ref
      // DETACHED. A remote pick has to become a real local branch tracking it —
      // reuse the local one if it already exists, otherwise create it.
      const localOf = (ref: string) => ref.replace(/^[^/]+\//, "");
      const payload =
        mode === "new"
          ? { branch, base: base || undefined, createBranch: true }
          : existingKind === "tags"
            ? // checking out a tag → create a local branch named after it
              { branch: existing, base: `refs/tags/${existing}`, createBranch: true }
            : existingKind === "remote"
              ? { branch: localOf(existing), base: existing, createBranch: !branches?.local.includes(localOf(existing)) }
              : { branch: existing, createBranch: false };

      const wtPath = await ipc.createWorktree({ repoId: repo, ...payload });
      // seed the human handoff now, keyed by the new path — the runtime
      // details are read back from the authoritative tree afterwards
      seedWtContext(wtPath, { title: branch, pr, prDescription, issue, issueDescription });
      showToast(`Worktree ready — ${branch}`);
      select(wtPath);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      icon={Fork}
      title="New worktree"
      sub={activeRepo?.name}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>Ports and database are derived automatically</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="cx-btn cx-btn--primary" onClick={create} disabled={busy || !ok}>
            {busy ? (
              <>
                <Spinner size={12} />
                Creating…
              </>
            ) : (
              <>
                <Plus size={12} />
                Create worktree
                <span className="cx-k">⌘⏎</span>
              </>
            )}
          </button>
        </>
      }
    >
      <div className="cxm-fld">
        <div className="cxm-flab">
          <Fork size={11} />
          Repository &amp; branch
          <button
            className="cx-btn cx-btn--ghost cxm-opt"
            style={{ height: "var(--h-session)", padding: "0 var(--sp-3)", fontSize: "var(--fs-micro)" }}
            onClick={fetchAll}
            disabled={busy || fetching}
          >
            {fetching ? <Spinner size={10} /> : <Refresh size={10} />}
            Fetch all
          </button>
        </div>

        <div className="cxm-grid2" style={{ marginBottom: "var(--sp-row)" }}>
          <select className="cx-input" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={busy}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <div className="cx-seg">
            <button className={mode === "new" ? "is-on" : ""} onClick={() => setMode("new")} disabled={busy}>
              New branch
            </button>
            <button className={mode === "existing" ? "is-on" : ""} onClick={() => setMode("existing")} disabled={busy}>
              Existing
            </button>
          </div>
        </div>

        {mode === "new" ? (
          <>
            <div className="cxm-sfld">
              <div className="cxm-flab cxm-flab--f">Branch name</div>
              <input
                className="cx-input cx-input--mono"
                placeholder="feat/my-branch"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="cxm-sfld">
              <div className="cxm-flab cxm-flab--f">Created from</div>
              <RefPick
                value={base}
                branches={branches}
                placeholder="search a base branch or tag…"
                onPick={(n) => setBase(n)}
              />
            </div>
          </>
        ) : (
          <div className="cxm-sfld">
            <div className="cxm-flab cxm-flab--f">Branch to check out</div>
            <RefPick
              value={existing}
              branches={branches}
              placeholder="search branches and tags…"
              inUse={inUse}
              onPick={(n, k) => {
                setExisting(n);
                setExistingKind(k);
              }}
            />
          </div>
        )}
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab">You'll get</div>
        <dl className="cx-kv">
          <dt>Path</dt>
          <dd title={destination ?? undefined}>{destination ?? "—"}</dd>
          {/* TODO(#58): ports and the database name are assigned inside
              create_worktree. Deriving them here would duplicate backend logic
              that can drift, and a wrong port is worse than a blank one. */}
          <dt>Ports</dt>
          <dd title="Assigned at creation">—</dd>
          <dt>Database</dt>
          <dd title="Assigned at creation">—</dd>
        </dl>
      </div>

      <details className="cxm-disc">
        <summary>
          <span className="cv">
            <ChevRight size={11} />
          </span>
          Agent handoff
          <span className="sub">optional PR / issue context</span>
        </summary>
        <div className="cxm-disc__body">
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">Pull request</div>
            <input
              className="cx-input"
              placeholder="https://github.com/org/repo/pull/123"
              value={pr}
              onChange={(e) => setPr(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">What it changes</div>
            <textarea
              className="cx-input"
              placeholder="Seeds the agent, and later becomes the PR body"
              value={prDescription}
              onChange={(e) => setPrDescription(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">Issue</div>
            <input
              className="cx-input"
              placeholder="https://github.com/org/repo/issues/42"
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">Problem</div>
            <textarea
              className="cx-input"
              value={issueDescription}
              onChange={(e) => setIssueDescription(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
      </details>

      {busy && (
        <div className="cxm-prog">
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">
            {progress.length ? progress.slice(-4).map((l, i) => <div key={i}>{l}</div>) : <div>creating…</div>}
          </div>
        </div>
      )}

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
