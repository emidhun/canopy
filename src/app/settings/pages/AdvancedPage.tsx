// Advanced — diagnostics, experiments and reset.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { hasBackend } from "../../../ipc";
import { Copy, Logs, Refresh } from "../../../icons";
import { TRow, Adv, Soon } from "../primitives";
import type { PageProps } from "../types";

export default function AdvancedPage({ flash }: PageProps) {
  const [ver, setVer] = useState("—");
  useEffect(() => {
    if (hasBackend()) getVersion().then(setVer).catch(() => setVer("—"));
    else setVer("dev");
  }, []);
  return (
    <>
      <div className="sec">
        <div className="slab">Diagnostics</div>
        <div className="fgrid">
          <span className="lb">Version</span>
          <span style={{ font: "var(--fs-small) var(--mono)", color: "var(--text-secondary)" }}>{ver}</span>
          <span className="lb">Config</span>
          <div className="row"><input className="inp mono gr" value="~/Library/Application Support/Canopy/settings.json" readOnly />
            <button className="ico" title="Copy path" onClick={() => { navigator.clipboard?.writeText("~/Library/Application Support/Canopy/settings.json").then(() => flash("Path copied"), () => flash("Copy failed")); }}><Copy size={12} /></button></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" title="Copy diagnostics (coming soon)" onClick={() => flash("Diagnostics export isn't wired yet")}><Copy size={11} />Copy diagnostics</button>
          <button className="btn" title="Open logs (coming soon)" onClick={() => flash("Opening the log directory isn't wired yet")}><Logs size={11} />Open logs</button>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Experiments<span className="n">may change or disappear</span></div>
        <Soon>No experiments are wired up right now.</Soon>
        <div className="soonwrap">
          <TRow title="Parallel setup tasks" hint="Run independent setup tasks at the same time." on={false} disabled />
          <TRow title="Predictive worktree warmup" hint="Pre-install dependencies for branches you open often." on={false} disabled />
        </div>
      </div>
      <Adv label="Reset">
        <div className="row">
          <button className="btn" title="Clear caches (coming soon)" onClick={() => flash("Clearing caches isn't wired yet")}><Refresh size={11} />Clear caches</button>
          <span style={{ flex: 1 }} />
          <button className="btn danger" title="Reset all settings (coming soon)" onClick={() => flash("Resetting all settings isn't wired yet")}>Reset all settings</button>
        </div>
      </Adv>
    </>
  );
}
