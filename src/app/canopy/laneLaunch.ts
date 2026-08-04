/* Launching agent + shell sessions, shared by the work surface and ⌘K.

   The logic is the agent lane's, lifted so both entry points behave
   identically: the handoff is written to .canopy/context.md first, then the
   agent runs as its OWN PTY with the prompt as its first argument. Running it
   as the session's command means the session ends — and the tab flips to
   "ended" — exactly when the agent exits. */
import { useCallback, useEffect, useState } from "react";
import { hasBackend, ipc, type AgentCfg } from "../../ipc";
import { nextTermId, useStore } from "../../store";
import type { RepoNode, WorktreeNode } from "../../types";
import { composeAgentPrompt, composeContextMd, runtimeFor, useWtContext } from "../WorktreeContext";

const defaultAgent = (legacy: string): AgentCfg => ({
  id: "default",
  name: "Claude",
  command: legacy.trim() || "claude",
  promptOnLaunch: true,
});
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export interface LaneLaunch {
  /** the repo's configured agent launchers (never empty — falls back to a default) */
  agents: AgentCfg[];
  startAgent: (profile?: AgentCfg) => Promise<void>;
  startShell: () => void;
}

export function useLaneLaunch(repo: RepoNode, wt: WorktreeNode): LaneLaunch {
  const showToast = useStore((s) => s.showToast);
  const openSession = useStore((s) => s.openSession);
  const settingsRev = useStore((s) => s.settingsRev);
  const [agents, setAgents] = useState<AgentCfg[]>([defaultAgent("")]);
  const [ctx] = useWtContext(wt.wtKey);

  useEffect(() => {
    if (!hasBackend()) return;
    let alive = true;
    ipc
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        const configured = settings.repos.find((r) => r.id === repo.repoId);
        const next = (configured?.agents ?? []).filter((a) => a.id.trim() && a.command.trim());
        setAgents(next.length ? next : [defaultAgent(configured?.agentCommand || "")]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo.repoId, settingsRev]);

  /** "Claude", then "Claude 2", … — tab labels stay tellable apart at a glance.
      Reads live store state, not this render's snapshot, so two launches in the
      same tick can't both claim the unsuffixed name. */
  const uniqueTitle = useCallback(
    (base: string) => {
      const live = useStore.getState().sessions[wt.wtKey] ?? [];
      const taken = new Set(live.map((s) => s.title));
      if (!taken.has(base)) return base;
      for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
    },
    [wt.wtKey],
  );

  const startAgent = useCallback(
    async (profile?: AgentCfg) => {
      const p = profile ?? agents[0];
      if (!p) return;
      const id = nextTermId(wt.wtKey, "agent");
      const title = uniqueTitle(p.name || "Agent");
      if (!hasBackend()) {
        openSession({ id, wtKey: wt.wtKey, kind: "agent", title, agentId: p.id, command: "agent" });
        showToast(`${title} — ${repo.name} · ${wt.branch}`);
        return;
      }
      try {
        const runtime = runtimeFor(repo, wt);
        // Always write the handoff: even a blank brief includes the branch,
        // database and resolved ports the agent needs to work safely.
        await ipc.writeWorktreeContext(wt.path, composeContextMd(ctx, runtime));
        const prompt = composeAgentPrompt(ctx, runtime);
        // A profile can opt out for CLIs that do not accept an initial
        // positional prompt; those still get CANOPY_CONTEXT_FILE.
        const command = p.promptOnLaunch ? `${p.command} ${shellQuote(prompt)}` : p.command;
        openSession({ id, wtKey: wt.wtKey, kind: "agent", title, agentId: p.id, command });
        showToast(`${title} started with this worktree's context`);
      } catch (e) {
        showToast(`Agent start failed — ${String(e)}`);
      }
    },
    [agents, ctx, openSession, repo, showToast, uniqueTitle, wt],
  );

  const startShell = useCallback(() => {
    const id = nextTermId(wt.wtKey, "shell");
    openSession({ id, wtKey: wt.wtKey, kind: "shell", title: uniqueTitle("Shell") });
  }, [openSession, uniqueTitle, wt.wtKey]);

  return { agents, startAgent, startShell };
}
