/* Where creating a worktree ends and setting it up begins.

   The create dialog reports its own work — fetching, `git worktree add`,
   submodules, provisioning — as a four-line tail. The setup commands are a
   different shape entirely: a numbered step list with per-step output and a
   copyable failure, which the setup runner already renders and this tail can
   only flatten. So the first setup-phase line hands the stream over.

   Getting this predicate wrong is not cosmetic. Too eager and the dialog
   disappears while the worktree is still being checked out; too lax and the
   npm log lands back in the tail this change exists to empty. */
import { describe, expect, it } from "vitest";
import { isSetupStart } from "./NewWorktreeModal";

describe("the create/setup boundary", () => {
  it("hands over on the first line of the setup phase", () => {
    for (const line of [
      "setup [1/5]: npm --prefix frontend install --no-audit --no-fund",
      "setup [parallel]: running 3 tasks at once",
      // a disabled first task is still the setup phase starting
      "setup — skipped (disabled): pnpm db:migrate",
      "setup — continuing after failure: setup step failed: pnpm build",
    ]) {
      expect(isSetupStart(line), line).toBe(true);
    }
  });

  it("keeps everything creation does for itself", () => {
    for (const line of [
      "creating worktree for Enhance/override-codemirror-autocomplete-default-filter…",
      "fetching origin…",
      "git worktree add /Users/m/CE/ToolJet/.worktrees/appbuilder_sprint-10",
      "initializing 2 submodule(s)…",
      "submodule frontend/ee (sharing objects)",
      "provisioning 2 file(s)",
      "  → cypress-tests/cypress.env.json (json)",
      "starting services…",
      "worktree ready",
      // command output, which only ever arrives after the handoff
      "npm WARN ERESOLVE overriding peer dependency",
    ]) {
      expect(isSetupStart(line), line).toBe(false);
    }
  });

  it("does not hand over when no setup will run", () => {
    // run_setup is off for this repo: there are no commands to watch, so the
    // create dialog must see the creation through to "worktree ready" itself
    expect(isSetupStart("setup skipped — Run setup when you're ready")).toBe(false);
  });
});
