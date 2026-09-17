// Setup — the commands run in order the first time a worktree is created.
import { Chevron, Play, Plus, Trash } from "../../../icons";
import { Rot, Toggle, Adv, Soon } from "../primitives";
import type { PageProps } from "../types";

export default function SetupPage({ setup, setSetup, markDirty, flash }: PageProps) {
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= setup.length) return; const n = setup.slice(); [n[i], n[j]] = [n[j], n[i]]; setSetup(n); markDirty("setup"); };
  return (
    <div className="sec">
      <div className="slab">Setup tasks<span className="n">run in order when a worktree is created</span></div>
      {setup.length === 0 ? (
        <div className="empty"><p>No setup tasks. Add commands like <code>pnpm install</code> — they run in order the first time a worktree is created.</p>
          <button className="btn sm" onClick={() => { setSetup([""]); markDirty("setup"); }}><Plus size={10} />Add task</button></div>
      ) : (
        <div className="objs">
          {setup.map((t, i) => (
            <div className="obj" key={i}>
              <div className="ohead" style={{ cursor: "default" }}>
                <span className="num" style={{ width: 16, height: 16, borderRadius: 4, display: "grid", placeItems: "center", font: "var(--fw-bold) var(--fs-label) var(--sans)", background: "var(--btn)", color: "var(--text-tertiary)", flex: "none" }}>{i + 1}</span>
                <input className="inp mono gr" value={t} style={{ height: 25 }} placeholder="pnpm install" onChange={(e) => { setSetup(setup.map((x, j) => (j === i ? e.target.value : x))); markDirty("setup"); }} />
                <Toggle on disabled />
                <span className="oacts" style={{ opacity: 1 }}>
                  <span className="ico" title="Move up" onClick={() => move(i, -1)}><Rot deg={180}><Chevron size={11} /></Rot></span>
                  <span className="ico" title="Move down" onClick={() => move(i, 1)}><Chevron size={11} /></span>
                  <span className="ico bad" title="Remove" onClick={() => { setSetup(setup.filter((_, j) => j !== i)); markDirty("setup"); }}><Trash size={11} /></span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => { setSetup(setup.concat([""])); markDirty("setup"); }}><Plus size={11} />Add task</button>
        <button className="btn" title="Dry run (coming soon)" onClick={() => flash("Dry-running setup isn't wired yet")}><Play size={11} />Dry run</button>
      </div>
      <Adv n="not wired yet">
        <Soon>The per-task enable toggle, working directory and the on-failure/timeout policy aren't stored yet — every task runs, in order, from the worktree root.</Soon>
        <div className="soonwrap fgrid">
          <span className="lb">On failure</span><select className="inp" disabled><option>Stop and report</option></select>
          <span className="lb">Timeout</span><input className="inp mono" disabled defaultValue="600" style={{ width: 80 }} />
        </div>
      </Adv>
    </div>
  );
}
