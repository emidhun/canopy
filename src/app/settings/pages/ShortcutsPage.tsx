// Shortcuts — a reference of the real keybindings.
import { useState } from "react";
import { Search } from "../../../icons";

const KEYS: [string, string, string][] = [
  // global
  ["Command palette", "⌘ K", "Global"],
  ["New worktree", "⌘ N", "Global"],
  ["Add repository", "⇧ ⌘ N", "Global"],
  ["Toggle worktree list", "⌘ B", "Global"],
  ["Cross-worktree overview", "⌘ O", "Global"],
  ["Settings", "⌘ ,", "Global"],
  ["Increase text size", "⌘ +", "Global"],
  ["Decrease text size", "⌘ -", "Global"],
  ["Reset text size", "⌘ 0", "Global"],
  // worktree
  ["Run next action", "⏎", "Worktree"],
  ["Switch branch", "⌘ \\", "Worktree"],
  ["Sync submodules", "⇧ ⌘ S", "Worktree"],
  ["Pull everything", "⌘ ⏎", "Pull menu"],
  // layouts
  ["Runtime layout", "⌘ 1", "Worktree"],
  ["Split logs + agent", "⌘ 2", "Worktree"],
  ["Agent layout", "⌘ 3", "Worktree"],
  ["Terminal + logs layout", "⌘ 4", "Worktree"],
  ["Terminal layout", "⌘ 5", "Worktree"],
  // dialogs
  ["Confirm the primary action", "⌘ ⏎", "Dialogs"],
  ["Confirm a simple prompt", "⏎", "Dialogs"],
  ["Close the dialog", "esc", "Dialogs"],
  // lists and menus
  ["Move through a list", "↑ ↓", "Lists"],
  ["Choose the highlighted row", "⏎", "Lists"],
  ["Close a menu or popover", "esc", "Lists"],
  ["Add to the selection", "⌘ click", "Worktree list"],
  ["Select a range", "⇧ click", "Worktree list"],
  // settings
  ["Search all settings", "⌘ F", "Settings"],
  ["Save changes", "⌘ S", "Settings"],
  ["Toggle the JSON preview", "⌘ P", "Settings"],
  // menu-bar window
  ["Focus the search field", "⌘ K", "Menu bar"],
  ["New worktree", "⌘ N", "Menu bar"],
  ["Settings", "⌘ ,", "Menu bar"],
  ["Start or focus the highlighted worktree", "⏎", "Menu bar"],
  ["Clear the search field", "esc", "Menu bar"],
];

export default function ShortcutsPage() {
  const [q, setQ] = useState("");
  const rows = KEYS.filter(([a, b, c]) => !q || (a + b + c).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="sec">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="navsearch" style={{ margin: 0, flex: 1, maxWidth: 260 }}>
          <Search size={12} /><input placeholder="Filter shortcuts…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <table className="keys">
        <thead><tr><th>Command</th><th>Keys</th><th>Scope</th></tr></thead>
        {/* keyed by all three columns: the command name alone is not unique —
            "New worktree" and "Settings" each exist in two scopes (the main
            window and the menu bar) */}
        <tbody>{rows.map(([a, b, c]) => (
          <tr key={a + b + c}><td>{a}</td>
            <td><span className="kbdk">{b.split(" ").map((k, i) => <i key={i}>{k}</i>)}</span></td>
            <td style={{ color: "var(--text-tertiary)" }}>{c}</td></tr>))}</tbody>
      </table>
      {rows.length === 0 && <div className="srempty">No shortcuts match “{q}”.</div>}
      <div className="hint" style={{ marginTop: 12 }}>Shortcuts aren't remappable yet.</div>
    </div>
  );
}
