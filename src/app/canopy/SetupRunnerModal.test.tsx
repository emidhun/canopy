// #60 — the setup runner's step list: a result per step, each step's own
// output on request, and a failure you can copy rather than retype.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupRunnerModal from "./SetupRunnerModal";
import { useStore } from "../../store";
import type { WorktreeNode } from "../../types";

const WT = { wtKey: "/r1/.worktrees/fix-a", repoId: "r1", branch: "fix-a", name: "fix-a", services: [] } as unknown as WorktreeNode;

const toasts: string[] = [];
const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  toasts.length = 0;
  writeText.mockClear();
  useStore.setState({
    showToast: (m: string) => { toasts.push(m); },
    ops: {
      [WT.wtKey]: {
        running: false,
        results: { 1: "1,842 packages" },
        lines: [
          { text: "setup [1/2]: pnpm install", lv: "out" },
          { text: "added 1842 packages in 41s", lv: "out" },
          { text: "setup [2/2]: pnpm db:migrate", lv: "out" },
          { text: "QueryFailedError: relation does not exist", lv: "err" },
          { text: "  at PostgresQueryRunner.query", lv: "err" },
        ],
      },
    },
  } as never);
});

const open = () => render(<SetupRunnerModal wt={WT} onClose={() => {}} onStartServices={() => {}} />);

/* userEvent.setup() installs its own navigator.clipboard, so ours has to be
   defined after it — and defined rather than assigned, since it is a getter. */
function userWithClipboard() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return user;
}

describe("the setup runner", () => {
  it("shows a result beside the step that produced one", async () => {
    open();
    expect(await screen.findByText("1,842 packages")).toBeInTheDocument();
  });

  it("expands a step to its own output, not the whole run", async () => {
    const user = userEvent.setup();
    open();
    const step = (await screen.findByText("pnpm install")).closest(".cx-step") as HTMLElement;
    await user.click(within(step).getByRole("button"));
    expect(within(step).getByText(/added 1842 packages/)).toBeInTheDocument();
    // the other step's output stays where it belongs
    expect(within(step).queryByText(/QueryFailedError/)).toBeNull();
  });

  it("opens the failed step without being asked", async () => {
    open();
    const failed = (await screen.findByText("pnpm db:migrate")).closest(".cx-step") as HTMLElement;
    expect(within(failed).getByText(/QueryFailedError/)).toBeInTheDocument();
  });

  it("copies the whole buffered log on failure, not just the visible tail", async () => {
    const user = userWithClipboard();
    open();
    await user.click(await screen.findByRole("button", { name: /copy log/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    // the first line is above the four-line preview, and is the one that explains it
    expect(copied).toContain("setup [1/2]: pnpm install");
    expect(copied).toContain("QueryFailedError");
    expect(toasts[toasts.length - 1]).toMatch(/Copied the setup log — 5 lines/);
  });

  it("copies one step's output on its own", async () => {
    const user = userWithClipboard();
    open();
    const step = (await screen.findByText("pnpm install")).closest(".cx-step") as HTMLElement;
    await user.click(within(step).getByRole("button"));
    await user.click(within(step).getByRole("button", { name: /copy this step/i }));
    expect(writeText.mock.calls[0][0]).toBe("added 1842 packages in 41s");
  });
});
