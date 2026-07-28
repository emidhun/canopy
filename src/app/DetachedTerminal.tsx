// The detached terminal window's contents. It attaches to the SAME backend PTY
// (by termId) as the inline lane pane, so the shell/agent keeps running and its
// output mirrors here — the PTY lives in Rust; this is just another view.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Fork, PopIn, Terminal as TerminalIcon } from "../icons";
import TerminalPane from "./TerminalPane";

export default function DetachedTerminal({
  termId,
  cwd,
  branch,
  title = "Terminal",
  command,
}: {
  termId: string;
  cwd: string;
  branch: string;
  /** the lane tab's label, so several detached windows stay tellable apart */
  title?: string;
  /** the agent command, used only if this window creates the PTY (attaching to
      an existing session ignores it — `terminal_open` is idempotent) */
  command?: string;
}) {
  const back = () => getCurrentWindow().close();
  return (
    <div className="detwin-body">
      <div className="detwin-bar" data-tauri-drag-region>
        <span className="dw-t" data-tauri-drag-region>
          <span className="fork">
            <TerminalIcon size={13} />
          </span>
          {title}
          <span className="br">— {branch}</span>
        </span>
        <span className="grow" data-tauri-drag-region />
        <button className="ib" title="Return to main window" onClick={back}>
          <PopIn size={13} />
        </button>
      </div>
      <div className="term" style={{ flex: 1, minHeight: 0 }}>
        <div className="term-body">
          <TerminalPane termId={termId} cwd={cwd} command={command} />
        </div>
      </div>
      <div className="lane-foot" style={{ justifyContent: "flex-end" }}>
        <span className="fork" style={{ color: "var(--accent)", marginRight: "auto", display: "inline-flex" }}>
          <Fork size={13} />
        </span>
        <span style={{ fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--mono)" }}>{cwd}</span>
      </div>
    </div>
  );
}
