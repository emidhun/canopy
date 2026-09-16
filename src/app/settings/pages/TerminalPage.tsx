// Terminal — the shell Canopy opens inside a worktree.
import { Soon } from "../primitives";
import type { PageProps } from "../types";

export default function TerminalPage({ settings, patch, markDirty }: PageProps) {
  return (
    <>
      <div className="sec">
        <div className="slab">Terminal application</div>
        <div className="fgrid">
          <span className="lb">Program</span>
          <div className="row"><input className="inp mono gr" value={settings.terminal} placeholder="Terminal" onChange={(e) => { patch({ terminal: e.target.value }); markDirty("terminal"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Opened by “Open in terminal”.</span></div>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Embedded shell</div>
        <Soon>The embedded shell's program, font, scrollback and behaviour aren't configurable yet — it inherits your login shell.</Soon>
        <div className="soonwrap fgrid">
          <span className="lb">Program</span><input className="inp mono" disabled placeholder="/bin/zsh" />
          <span className="lb">Font</span><div className="row"><select className="inp gr" disabled><option>SF Mono</option></select><input className="inp mono" disabled defaultValue="12" style={{ width: 60 }} /></div>
          <span className="lb">Scrollback</span><input className="inp mono" disabled defaultValue="10000" style={{ width: 90 }} />
        </div>
      </div>
    </>
  );
}
