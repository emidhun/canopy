// General — appearance and launch behaviour.
import { useEffect, useState } from "react";
import { getAppearance, setAppearance, type Accent, type Density, type Theme } from "../../../appearance";
import { TRow, Adv, Soon } from "../primitives";
import type { PageProps } from "../types";

export const ACCENT_SWATCHES: { id: Accent; name: string; color: string }[] = [
  { id: "teal", name: "Teal", color: "#5cc7cd" },
  { id: "green", name: "Green", color: "#4cc266" },
  { id: "amber", name: "Amber", color: "#e6ad5f" },
  { id: "violet", name: "Violet", color: "#c77ecd" },
];


export default function GeneralPage({ settings, patch, markDirty }: PageProps) {
  // Appearance applies live and persists to localStorage (not the Settings save
  // step); mirror it here and re-read when another window changes it.
  const [appr, setAppr] = useState(getAppearance());
  const change = (p: Partial<{ theme: Theme; density: Density; accent: Accent }>) => setAppr(setAppearance(p));
  useEffect(() => {
    const h = () => setAppr(getAppearance());
    window.addEventListener("canopy:appearance", h);
    return () => window.removeEventListener("canopy:appearance", h);
  }, []);
  return (
    <>
      <div className="sec">
        <div className="slab">Editor</div>
        <div className="fgrid">
          <span className="lb">Command</span>
          <div className="row"><input className="inp mono gr" value={settings.editor.command} placeholder="code" onChange={(e) => { patch({ editor: { command: e.target.value } }); markDirty("general"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Used for “Open in editor”.</span></div>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Behaviour</div>
        <TRow title="Show the Switch-branch action" hint="Offer “Switch branch…” in the worktree menu and ⌘\." on={settings.showSwitchBranch !== false} onToggle={() => { patch({ showSwitchBranch: !(settings.showSwitchBranch !== false) }); markDirty("general"); }} />
      </div>
      <div className="sec">
        <div className="slab">Appearance<span className="n">applied instantly, saved on this machine</span></div>
        <div className="fgrid">
          <span className="lb">Theme</span>
          <select className="inp" value={appr.theme} onChange={(e) => change({ theme: e.target.value as Theme })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Match system</option>
          </select>
          <span className="lb">Density</span>
          <select className="inp" value={appr.density} onChange={(e) => change({ density: e.target.value as Density })}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
          <span className="lb">Accent</span>
          <div className="row">{ACCENT_SWATCHES.map((a) => (
            <button key={a.id} className="ico" title={a.name} aria-pressed={appr.accent === a.id} onClick={() => change({ accent: a.id })}
              style={{ background: a.color, borderColor: appr.accent === a.id ? "var(--text-primary)" : "transparent", width: 22, height: 22 }} />))}</div>
        </div>
      </div>
      <Adv n="not wired yet">
        <Soon>Automatic updates and crash reporting aren't configurable from here yet.</Soon>
      </Adv>
    </>
  );
}
