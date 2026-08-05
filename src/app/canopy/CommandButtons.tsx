/* Custom commands (Settings → Commands) surfaced as real buttons in the rail —
   they belong beside the runtime they operate on, and the rail has room the
   worktree bar does not.

   The first command gets its own labelled run button; the rest collapse into a
   single "Commands" menu so the bar cannot grow without bound as the user adds
   more. Mirrors the design's CmdButtons (cx-app.jsx). The backend `CustomCmd`
   is `{ label, command }` with no group field, so the design's per-group
   headers only render if a group ever appears in the data. */
import { useEffect, useRef, useState } from "react";
import { Chevron, Play } from "../../icons";
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
  const box = useRef<HTMLDivElement>(null);
  const settingsRev = useStore((s) => s.settingsRev);
  const showToast = useStore((s) => s.showToast);
  // commands are repo-scoped; a worktree doesn't carry its repo id, so derive it
  // from the tree. The selector returns a primitive, so this only re-renders
  // when the owning repo actually changes.
  const repoId = useStore((s) => s.tree.find((r) => r.worktrees.some((w) => w.wtKey === wt.wtKey))?.repoId);

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

  // outside-click closes; the trigger lives inside `box`, so clicking it again
  // toggles rather than being swallowed as an outside click — a popover trigger
  // must be able to close its own popover
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [open]);

  if (cmds.length === 0) return null;

  const run = (c: CustomCmd) => {
    setOpen(false);
    showToast(`Running ${c.label} — ${wt.branch}`);
    if (!hasBackend()) return;
    ipc
      .runCustomCommand(wt.wtKey, c.command)
      .then(() => showToast(`${c.label} finished — ${wt.branch}`))
      .catch((e) => showToast(`${c.label} failed — ${String(e)}`));
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
        <button key={i} className="cxs-cmdb cxs-cmdb--run1" title={c.command} onClick={() => run(c)}>
          <Play size={10} />
          <span className="t">{c.label}</span>
        </button>
      ))}
      {rest.length > 0 && (
        <>
          <button
            className={"cxs-cmdb" + (open ? " is-on" : "")}
            title="Custom commands"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <Play size={10} />
            <span className="t">Commands</span>
            <Chevron size={11} />
          </button>
          {open && (
            <div className="cxs-cmdpop" role="menu">
              {Object.entries(groups).map(([g, list]) => (
                <div key={g || "_"}>
                  {g && <div className="cxs-cg">{g}</div>}
                  {list.map((c, i) => (
                    <button key={i} className="cxs-cmdrow" role="menuitem" onClick={() => run(c)}>
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
