/* Custom commands (Settings → Commands) surfaced as real buttons in the rail —
   they belong beside the runtime they operate on, and the rail has room the
   worktree bar does not.

   The first command gets its own labelled run button; the rest collapse into a
   single "Commands" popover so the bar cannot grow without bound as the user
   adds more. Mirrors the design's CmdButtons (cx-app.jsx). The backend
   `CustomCmd` is `{ label, command }` with no group field, so the design's
   per-group headers only render if a group ever appears in the data. */
import { useEffect, useRef, useState } from "react";
import { Chevron, Play, Spinner } from "../../icons";
import { hasBackend, ipc, type CustomCmd } from "../../ipc";
import { mockCustomCommands } from "../../mock";
import { useStore } from "../../store";
import type { WorktreeNode } from "../../types";

// CustomCmd has no `group` yet; read it defensively so grouping still works if
// one is ever added to the settings schema.
type Grouped = CustomCmd & { group?: string };

export default function CommandButtons({ wt }: { wt: WorktreeNode }) {
  const [open, setOpen] = useState(false);
  const [cmds, setCmds] = useState<CustomCmd[]>([]);
  // the shell-side op buffer is shared per worktree, so only one custom command
  // may run at a time — a second would interleave output and its completion
  // would flip the worktree to idle while the first is still running
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const settingsRev = useStore((s) => s.settingsRev);
  const showToast = useStore((s) => s.showToast);
  // commands are repo-scoped; a worktree doesn't carry its repo id, so derive it
  // from the tree. The selector returns a primitive, so this only re-renders
  // when the owning repo actually changes.
  const repoId = useStore((s) => s.tree.find((r) => r.worktrees.some((w) => w.wtKey === wt.wtKey))?.repoId);

  // WorktreeView is reused (no key) across repo switches, so drop the previous
  // repo's commands and close the menu the instant the repo changes — otherwise
  // a stale command could briefly show and be run against the new worktree
  useEffect(() => {
    setCmds([]);
    setOpen(false);
  }, [repoId]);

  // per-repo commands; reload when settings are saved
  useEffect(() => {
    if (!hasBackend()) {
      setCmds(mockCustomCommands());
      return;
    }
    if (!repoId) {
      setCmds([]);
      return;
    }
    let alive = true;
    ipc
      .getSettings()
      .then((s) => {
        if (alive) setCmds(s.repos.find((r) => r.id === repoId)?.customCommands ?? []);
      })
      .catch(() => alive && setCmds([]));
    return () => {
      alive = false;
    };
  }, [repoId, settingsRev]);

  // this is a plain popover of buttons (not an ARIA menu), so native Tab moves
  // between rows; add outside-click + Escape dismissal, move focus in on open,
  // and hand it back to the trigger on close
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k);
    box.current?.querySelector<HTMLElement>(".cxs-cmdrow")?.focus();
    return () => {
      document.removeEventListener("mousedown", d);
      document.removeEventListener("keydown", k);
    };
  }, [open]);

  if (cmds.length === 0) return null;

  const run = (c: CustomCmd) => {
    if (busy) return;
    setOpen(false);
    if (!hasBackend()) {
      showToast(`Running ${c.label} — ${wt.branch}`);
      return;
    }
    setBusy(true);
    showToast(`Running ${c.label} — ${wt.branch}…`);
    ipc
      .runCustomCommand(wt.wtKey, c.command)
      .then(() => showToast(`${c.label} finished — ${wt.branch}`))
      .catch((e) => showToast(`${c.label} failed — ${String(e)}`))
      .finally(() => setBusy(false));
  };

  const flat = cmds.slice(0, 1);
  const rest = cmds.slice(1);
  const groups = rest.reduce<Record<string, Grouped[]>>((a, c) => {
    const g = (c as Grouped).group || "";
    (a[g] ??= []).push(c);
    return a;
  }, {});

  return (
    <div className="cxs-cmds" ref={box}>
      {flat.map((c, i) => (
        <button key={i} className="cxs-cmdb cxs-cmdb--run1" title={c.command} onClick={() => run(c)} disabled={busy}>
          {busy ? <Spinner size={10} /> : <Play size={10} />}
          <span className="t">{c.label}</span>
        </button>
      ))}
      {rest.length > 0 && (
        <>
          <button
            ref={trigger}
            className={"cxs-cmdb" + (open ? " is-on" : "")}
            title="Custom commands"
            onClick={() => setOpen((o) => !o)}
            disabled={busy}
            aria-haspopup="true"
            aria-expanded={open}
          >
            <Play size={10} />
            <span className="t">Commands</span>
            <Chevron size={11} />
          </button>
          {open && (
            <div className="cxs-cmdpop">
              {Object.entries(groups).map(([g, list]) => (
                <div key={g || "_"}>
                  {g && <div className="cxs-cg">{g}</div>}
                  {list.map((c, i) => (
                    <button key={i} className="cxs-cmdrow" onClick={() => run(c)} disabled={busy}>
                      <Play size={10} />
                      <span className="l">{c.label}</span>
                      <span className="c">{c.command}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
