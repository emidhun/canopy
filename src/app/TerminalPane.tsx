// A live terminal pane: one xterm.js renderer bound to a backend PTY session.
//
// The PTY lives in Rust (keyed by `termId`); this component is the disposable
// view. On mount it opens/attaches the session, rehydrates scrollback, and
// streams bytes both ways. On unmount it disposes the widget but LEAVES the PTY
// running — switching worktrees or toggling the Agent/Shell tab keeps the shell
// (and any agent in it) alive; we rehydrate from the backend buffer on return.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { hasBackend, ipc, on } from "../ipc";

/** base64 (raw PTY bytes) → Uint8Array for xterm.write */
function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const THEME = {
  background: "#191a1d", // --panel-2
  foreground: "#cfd1d6",
  cursor: "#5cc7cd", // --accent
  cursorAccent: "#191a1d",
  selectionBackground: "rgba(92,199,205,.25)",
  black: "#191a1d",
  brightBlack: "#7c7e86",
};

export default function TerminalPane({
  termId,
  cwd,
  hidden,
  command,
}: {
  termId: string;
  cwd: string;
  hidden?: boolean;
  /** run this command instead of an interactive shell; the session ends (fires
      terminal:exit) when it exits — used to track agent lifecycle */
  command?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (!hasBackend()) {
      host.innerHTML =
        '<div style="padding:14px;font:12.5px var(--mono);color:var(--faint)">Terminal runs in the Canopy desktop app.</div>';
      return;
    }

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let hydrated = false;
    // xterm re-answers query escape sequences (Device Attributes, cursor-position
    // reports) it finds while replaying scrollback; those replies must NOT reach
    // the PTY or the shell prompt echoes them as junk ("1;2c22;3R…"). Suppressed
    // only while the snapshot write is parsing.
    let suppressOut = false;
    const pending: { seq: number; data: string }[] = [];
    const writeChunk = (b64: string) => termRef.current?.write(decode(b64));

    // fit only when the host is actually laid out — fitting a zero-size or
    // display:none element leaves xterm's renderer without dimensions and throws
    // asynchronously on the next write.
    const safeFit = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    requestAnimationFrame(safeFit);

    // keystrokes (and terminal reports) → PTY. The PTY echoes; no local echo.
    const onDataDisp = term.onData((data) => {
      if (suppressOut) return;
      ipc.terminalWrite(termId, data).catch(() => {});
    });

    // Register listeners BEFORE opening so no output is missed, then rehydrate
    // against the snapshot cursor: replay the snapshot, then apply only queued
    // live events past its seq — no double-render, no gap.
    (async () => {
      unlistenData = await on.terminalData((e) => {
        if (e.id !== termId) return;
        if (!hydrated) pending.push({ seq: e.seq, data: e.data });
        else writeChunk(e.data);
      });
      unlistenExit = await on.terminalExit((e) => {
        if (e.id === termId) termRef.current?.write("\r\n\x1b[38;5;244m[process exited]\x1b[0m\r\n");
      });
      if (disposed) return;

      try {
        await ipc.terminalOpen(termId, cwd, term.cols, term.rows, command);
        const snap = await ipc.terminalGetBuffer(termId);
        if (disposed || !termRef.current) return;
        const baseline = snap?.seq ?? 0;
        if (snap?.buffer) {
          suppressOut = true;
          termRef.current.write(decode(snap.buffer), () => {
            suppressOut = false;
          });
        }
        for (const p of pending) if (p.seq > baseline) writeChunk(p.data);
        pending.length = 0;
        hydrated = true;
      } catch (err) {
        termRef.current?.write(`\r\n\x1b[31mterminal error: ${String(err)}\x1b[0m\r\n`);
      }
    })();

    // keep the PTY sized to the widget
    const ro = new ResizeObserver(() => {
      if (hidden || !host.clientWidth || !host.clientHeight) return;
      safeFit();
      ipc.terminalResize(termId, term.cols, term.rows).catch(() => {});
    });
    ro.observe(host);

    return () => {
      disposed = true;
      unlistenData?.();
      unlistenExit?.();
      onDataDisp.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, cwd, command]);

  // re-fit when the pane becomes visible (tab toggle) or the lane resizes
  useEffect(() => {
    if (hidden) return;
    const id = requestAnimationFrame(() => {
      const host = hostRef.current;
      if (!host || !fitRef.current || !termRef.current || !host.clientWidth || !host.clientHeight) return;
      try {
        fitRef.current.fit();
        ipc.terminalResize(termId, termRef.current.cols, termRef.current.rows).catch(() => {});
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [hidden, termId]);

  return <div ref={hostRef} className="xterm-host" />;
}
