/* Setup runner — the provisioning stream as a step list rather than a spinner.

   Steps come from the worktree:op buffer the store already folds; the backend
   emits ordered "[k/n]: cmd" markers. "Run in background" simply closes the
   dialog: the run is backend-owned and keeps going either way, which is why
   the button says what it does rather than "Hide". */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Cube, Play, Spinner } from "../../icons";
import { hasBackend, ipc } from "../../ipc";
import { useStore } from "../../store";
import type { WorktreeNode } from "../../types";
import Modal, { Hint, Spacer } from "./Modal";

/** "[2/5]: pnpm install" → { n: 2, of: 5, cmd: "pnpm install" } */
const STEP = /^\[(\d+)\/(\d+)\]:\s*(.*)$/;

export default function SetupRunnerModal({
  wt,
  onClose,
  onStartServices,
}: {
  wt: WorktreeNode;
  onClose: () => void;
  onStartServices: () => void;
}) {
  const op = useStore((s) => s.ops[wt.wtKey]);
  const showToast = useStore((s) => s.showToast);
  const startedAt = useRef(Date.now());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hasBackend()) {
      showToast("Setup runs in the desktop app");
      return;
    }
    ipc.runWorktreeSetup(wt.wtKey).catch((e) => {
      setFailed(true);
      showToast(`Setup failed — ${String(e)}`);
    });
    // launched once per open; the run is backend-owned from here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt.wtKey]);

  /* Rebuild the step list from the op buffer. Every marker seen is a step;
     the highest marker is the one in flight, everything before it is done. */
  const { steps, current, total } = useMemo(() => {
    const seen: { n: number; cmd: string }[] = [];
    let total = 0;
    for (const l of op?.lines ?? []) {
      const m = STEP.exec(l.text);
      if (!m) continue;
      total = Number(m[2]);
      const n = Number(m[1]);
      if (!seen.some((s) => s.n === n)) seen.push({ n, cmd: m[3] });
    }
    seen.sort((a, b) => a.n - b.n);
    return { steps: seen, current: seen.length ? seen[seen.length - 1].n : 0, total };
  }, [op]);

  const running = op?.running ?? true;
  const done = !running && !failed && steps.length > 0;
  const errored = failed || (op?.lines ?? []).some((l) => l.lv === "err");
  const elapsed = ((Date.now() - startedAt.current) / 1000).toFixed(1);

  return (
    <Modal
      icon={Cube}
      title={errored ? "Setup failed" : done ? "Setup complete" : "Running setup"}
      sub={wt.branch}
      busy={running && !errored}
      onClose={onClose}
      foot={
        <>
          <Hint icon={done ? Check : errored ? undefined : Spinner}>
            {errored
              ? "The failing step is shown above"
              : done
                ? `Took ${elapsed}s`
                : total
                  ? `Step ${Math.min(current, total)} of ${total}`
                  : "starting…"}
          </Hint>
          <Spacer />
          {running && !errored && (
            <button className="cx-btn cx-btn--ghost" onClick={onClose}>
              Run in background
            </button>
          )}
          {done ? (
            <button
              className="cx-btn cx-btn--primary"
              onClick={() => {
                onStartServices();
                onClose();
              }}
            >
              <Play size={12} />
              Start services
              <span className="cx-k">⏎</span>
            </button>
          ) : (
            <button className="cx-btn" onClick={onClose}>
              {errored ? "Close" : "Cancel"}
            </button>
          )}
        </>
      }
    >
      {steps.length === 0 && !errored && (
        <div className="cxm-prog" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">preparing…</div>
        </div>
      )}

      {steps.map((s) => {
        const state = s.n < current ? "done" : s.n === current && running ? "active" : errored && s.n === current ? "failed" : "done";
        return (
          <div className={`cx-step cx-step--${state}`} key={s.n}>
            <span className="cx-step__bullet">
              {state === "done" ? "✓" : state === "failed" ? "✕" : <Spinner size={10} />}
            </span>
            <span className="cx-step__text">{s.cmd}</span>
            {/* TODO(#60): the design shows a result per step ("1,842 packages",
                "37 migrations"). worktree:op carries step identity but no
                parsed result, so nothing is shown rather than invented. */}
          </div>
        );
      })}

      {/* the raw tail stays available — a failing step is read, not guessed at */}
      {errored && (
        <div className="cx-alert cx-alert--error" style={{ marginTop: "var(--sp-modal-head)" }}>
          <div>
            <b>Setup did not finish.</b>
            <pre>{(op?.lines ?? []).slice(-4).map((l) => l.text).join("\n")}</pre>
          </div>
        </div>
      )}

      {done && (
        <div className="cx-alert cx-alert--ok" style={{ marginTop: "var(--sp-modal-head)", marginBottom: 0 }}>
          <span className="cx-alert__ic">
            <Check size={13} />
          </span>
          <div>Provisioned and ready.</div>
        </div>
      )}
    </Modal>
  );
}
