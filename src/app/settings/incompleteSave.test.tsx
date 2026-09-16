// #43 end to end: a half-filled row blocks the save, is named, and is marked.
//
// The unit tests in incomplete.test.ts pin which rows count as incomplete and
// how they are phrased. This one proves the shell actually refuses the save
// and puts the offending row on screen.
//
// "Add agent" seeds the row with a name and no command — which is precisely
// the shape the issue reports as vanishing on save.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import { useStore } from "../../store";

const toasts: string[] = [];
beforeEach(() => {
  toasts.length = 0;
  vi.spyOn(useStore.getState(), "showToast").mockImplementation((m: string) => { toasts.push(m); });
});

const save = (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Meta>}s{/Meta}");

async function addHalfFilledAgent() {
  const user = userEvent.setup();
  const view = render(<SettingsView onClose={() => {}} />);
  await user.click((await screen.findAllByText("Agents"))[0]);
  await user.click(await screen.findByText(/Add agent/i));
  return { user, ...view };
}

describe("saving with an incomplete row", () => {
  it("refuses the save and names the row instead of dropping it", async () => {
    const { user } = await addHalfFilledAgent();
    await save(user);
    expect(toasts[toasts.length - 1]).toBe('Nothing saved — the agent "New agent" needs a command.');
  });

  it("marks the offending row in the editor", async () => {
    const { user, container } = await addHalfFilledAgent();
    await save(user);

    const marked = container.querySelector(".obj.incomplete");
    expect(marked).not.toBeNull();
    expect(within(marked as HTMLElement).getByText("needs a command")).toBeInTheDocument();
  });

  it("clears the mark as soon as the row is edited again", async () => {
    const { user, container } = await addHalfFilledAgent();
    await save(user);
    expect(container.querySelector(".obj.incomplete")).not.toBeNull();

    await user.type(screen.getByPlaceholderText("claude"), "c");
    expect(container.querySelector(".obj.incomplete")).toBeNull();
  });

  it("saves once the missing field is filled in", async () => {
    const { user } = await addHalfFilledAgent();
    await user.type(screen.getByPlaceholderText("claude"), "codex");
    await save(user);
    expect(toasts[toasts.length - 1]).not.toMatch(/Nothing saved/);
  });
});
