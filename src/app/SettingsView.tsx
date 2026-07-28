// Settings — repo-nav + tabbed repo-detail layout (design: "Canopy New Features").
// Left rail selects the Application (global) settings or a repository; the repo
// detail splits into General / Services / Commands / Files / Setup tabs. The
// Files tab is the new "Files to provision" UI backed by .worktreemanager.json.
import { useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  hasBackend,
  ipc,
  type ProvisionEntry,
  type ProvisionFormat,
  type AgentCfg,
  type RepoCfg,
  type ServiceCfg,
  type Settings,
} from "../ipc";
import { useStore } from "../store";
import { Braces, Cube, Database, Download, File, Fork, Plus, Server, Settings as Cog, Sparkle, Terminal, Upload } from "../icons";

const KINDS = ["web", "server", "worker"];
const FORMATS: { id: ProvisionFormat; label: string }[] = [
  { id: "dotenv", label: "dotenv" },
  { id: "json", label: "json" },
  { id: "yaml", label: "yaml" },
  { id: "text", label: "text" },
];
const VARS = ["${WT_DB_NAME}", "${WT_SLUG}", "${WT_INDEX}", "${WT_<SERVICE>_PORT}", "${WT_PATH}", "${REPO_PATH}"];

let _uid = 0;
const uid = (p: string) => `${p}-${++_uid}`;

function emptyService(): ServiceCfg {
  return { id: "", name: "", kind: "server", command: "", cwd: "", basePort: null, env: {} };
}

let agentSeq = 0;
function emptyAgent(): AgentCfg {
  // ids only need to be stable and unique within the repo — they key React rows
  // and let the lane remember which profile a running tab came from.
  return { id: `agent-${Date.now().toString(36)}-${agentSeq++}`, name: "", command: "", promptOnLaunch: true };
}

/** One-click starting points; the command is still fully editable afterwards. */
const PRESET_AGENTS = [
  { name: "Claude", command: "claude" },
  { name: "Codex", command: "codex" },
  { name: "Gemini", command: "gemini" },
];

/** Fold a pre-multi-agent `agentCommand` into the agents list so the editor has
    exactly one representation to work with. The legacy field is left in place
    for older builds reading the same settings file. */
function migrateAgents(r: RepoCfg): RepoCfg {
  if (r.agents?.length || !r.agentCommand?.trim()) return { ...r, agents: r.agents ?? [] };
  return { ...r, agents: [{ ...emptyAgent(), name: "Agent", command: r.agentCommand.trim() }] };
}

/* ── client-side provision model (adds stable ids for React keys) ── */
type KeyRow = { id: string; k: string; v: string };
type FileCardT = { id: string; path: string; format: ProvisionFormat; from: string; interpolate: boolean; keys: KeyRow[] };

function toCards(entries: ProvisionEntry[]): FileCardT[] {
  return entries.map((e) => ({
    id: uid("f"),
    path: e.path,
    format: e.format,
    from: e.from || "",
    interpolate: !!e.interpolate,
    keys: (e.keys || []).map(([k, v]) => ({ id: uid("k"), k, v })),
  }));
}

function fromCards(cards: FileCardT[]): ProvisionEntry[] {
  return cards
    .filter((c) => c.path.trim())
    .map((c) => ({
      path: c.path.trim(),
      format: c.format,
      from: c.from.trim(),
      interpolate: c.format === "text" ? c.interpolate : false,
      keys: c.format === "text" ? [] : (c.keys.filter((k) => k.k.trim()).map((k) => [k.k, k.v]) as [string, string][]),
    }));
}

/** Build the `.worktreemanager.json` object shown in the live preview — the
 * same shape the backend writer produces (incl. preserved teardown/migrate). */
function buildConfig(cards: FileCardT[], setup: string[], teardown: string[], migrate: string[]) {
  const cfg: Record<string, unknown> = {
    $schema: "canopy://worktree-manager/v1",
    provision: cards
      .filter((c) => c.path.trim())
      .map((c) => {
        const o: Record<string, unknown> = { path: c.path.trim(), format: c.format };
        if (c.from.trim()) o.from = c.from.trim();
        if (c.format === "text") {
          o.interpolate = c.interpolate;
        } else {
          o.mode = "upsert";
          o.keys = Object.fromEntries(c.keys.filter((k) => k.k.trim()).map((k) => [k.k, k.v]));
        }
        return o;
      }),
    setup: setup.filter((s) => s.trim()),
  };
  // preserved by the writer, read-only in this UI — shown so preview === disk
  if (teardown.length) cfg.teardown = teardown;
  if (migrate.length) cfg.migrate = migrate;
  return cfg;
}

/* ── JSON syntax highlight for the preview panel ── */
function highlightJson(str: string): string {
  let s = str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/"([^"]*)":/g, '<span class="j-key">"$1"</span>:');
  s = s.replace(/: "([^"]*)"/g, (_m, val: string) => {
    const inner = val.replace(/\$\{[^}]+\}/g, (v) => `<span class="j-var">${v}</span>`);
    return `: <span class="j-str">"${inner}"</span>`;
  });
  s = s.replace(/: (true|false)/g, ': <span class="j-bool">$1</span>');
  return s;
}

/* ── One provisioned-file card ── */
function FileCard({ card, patch, remove }: { card: FileCardT; patch: (c: FileCardT) => void; remove: () => void }) {
  const isText = card.format === "text";
  const set = <K extends keyof FileCardT>(f: K, v: FileCardT[K]) => patch({ ...card, [f]: v });
  const editKey = (id: string, f: "k" | "v", v: string) =>
    patch({ ...card, keys: card.keys.map((k) => (k.id === id ? { ...k, [f]: v } : k)) });
  const addKey = () => patch({ ...card, keys: [...card.keys, { id: uid("k"), k: "", v: "" }] });
  const rmKey = (id: string) => patch({ ...card, keys: card.keys.filter((k) => k.id !== id) });

  const fmtHint = {
    dotenv: "KEY = value lines",
    json: "dotted keys → nested (development.database)",
    yaml: "dotted keys → nested (development.database)",
    text: "no keys",
  }[card.format];

  return (
    <div className="fcard">
      <div className="fcard-head">
        <span className="fcard-ic">
          <File size={15} />
        </span>
        <input
          className="input mono fcard-path"
          value={card.path}
          spellCheck={false}
          placeholder="path/to/file"
          onChange={(e) => set("path", e.target.value)}
        />
        <div className="fmt-wrap">
          <select className="fmt-select" value={card.format} onChange={(e) => set("format", e.target.value as ProvisionFormat)}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <button className="del" title="Remove file" onClick={remove}>
          ✕
        </button>
      </div>

      <div className="fcard-sub">
        <label className="from-lbl">Copy from</label>
        <input
          className="input mono from-in"
          value={card.from}
          spellCheck={false}
          placeholder={`${card.path || "path/to/file"}  (default: same path)`}
          onChange={(e) => set("from", e.target.value)}
        />
      </div>

      <div className={"mode-note " + (isText ? "is-text" : "is-keys")}>
        <span className="mode-pill">{isText ? "copy + interpolate" : "seed if missing · upsert keys"}</span>
        {isText ? (
          <span>
            Copies the whole file, then interpolates every <code>{"${VAR}"}</code>. Nothing else to configure.
          </span>
        ) : (
          <span>
            Seeds the file if it doesn't exist, then upserts <b>only</b> the keys below — every other line is preserved.
          </span>
        )}
      </div>

      {!isText && (
        <div className="keys">
          <div className="keys-head">
            <span>
              Set keys <span className="keys-hint">· {fmtHint}</span>
            </span>
            <button className="add-action sm" onClick={addKey}>
              <Plus size={12} />
              Add key
            </button>
          </div>
          {card.keys.length === 0 ? (
            <div className="empty">
              <span>No keys — file is seeded but nothing is upserted.</span>
            </div>
          ) : (
            <div className="pk-grid">
              {card.keys.map((k) => (
                <div className="pk-line" key={k.id}>
                  <input
                    className="input mono"
                    value={k.k}
                    placeholder="key"
                    spellCheck={false}
                    onChange={(e) => editKey(k.id, "k", e.target.value)}
                  />
                  <span className="kv-eq">=</span>
                  <input
                    className="input mono"
                    value={k.v}
                    placeholder="${WT_...}"
                    spellCheck={false}
                    onChange={(e) => editKey(k.id, "v", e.target.value)}
                  />
                  <button className="del" title="Remove key" onClick={() => rmKey(k.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type TabId = "general" | "services" | "agents" | "commands" | "files" | "setup";

export default function SettingsView({ onClose }: { onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const tree = useStore((s) => s.tree);
  const bumpSettings = useStore((s) => s.bumpSettings);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string>("app"); // "app" or repo.id
  const [tab, setTab] = useState<TabId>("general");
  // per-repo .worktreemanager.json (provisioned files + setup commands)
  const [cardsByRepo, setCardsByRepo] = useState<Record<string, FileCardT[]>>({});
  const [setupByRepo, setSetupByRepo] = useState<Record<string, string[]>>({});
  // teardown/migrate are read-only here — kept so preview/export match disk
  const [extrasByRepo, setExtrasByRepo] = useState<Record<string, { teardown: string[]; migrate: string[] }>>({});
  // only repos whose config the user actually edited get written on Save —
  // otherwise Save would reformat every registered repo's checked-in file
  const dirtyRepos = useRef<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hasBackend()) {
      setSettings({ version: 1, editor: { command: "code" }, terminal: "Terminal", repos: [], showSwitchBranch: true });
      return;
    }
    ipc
      .getSettings()
      .then((s) => {
        setSettings({ ...s, repos: s.repos.map(migrateAgents) });
        if (s.repos[0]) setSelected(s.repos[0].id);
        s.repos.forEach((r) => {
          ipc
            .getRepoConfig(r.id)
            .then((c) => {
              setCardsByRepo((m) => ({ ...m, [r.id]: toCards(c.provision) }));
              setSetupByRepo((m) => ({ ...m, [r.id]: c.setup }));
              setExtrasByRepo((m) => ({ ...m, [r.id]: { teardown: c.teardown || [], migrate: c.migrate || [] } }));
            })
            .catch(() => {});
        });
      })
      .catch((e) => showToast(`Failed to load settings: ${e}`));
  }, []);

  if (!settings) return <div className="main" />;

  const patch = (p: Partial<Settings>) => setSettings({ ...settings, ...p });
  const repoIndex = settings.repos.findIndex((r) => r.id === selected);
  const repo = repoIndex >= 0 ? settings.repos[repoIndex] : null;
  const wtCount = (repoId: string) => tree.find((r) => r.repoId === repoId)?.worktrees.length ?? 0;

  const patchRepo = (p: Partial<RepoCfg>) =>
    patch({ repos: settings.repos.map((r, ri) => (ri === repoIndex ? { ...r, ...p } : r)) });
  const cards = (repo && cardsByRepo[repo.id]) || [];
  const setup = (repo && setupByRepo[repo.id]) || [];
  const extras = (repo && extrasByRepo[repo.id]) || { teardown: [], migrate: [] };
  const setCards = (next: FileCardT[]) => {
    if (!repo) return;
    dirtyRepos.current.add(repo.id);
    setCardsByRepo((m) => ({ ...m, [repo.id]: next }));
  };
  const setSetup = (next: string[]) => {
    if (!repo) return;
    dirtyRepos.current.add(repo.id);
    setSetupByRepo((m) => ({ ...m, [repo.id]: next }));
  };

  async function addRepo() {
    if (!hasBackend()) {
      showToast("Folder picker needs the desktop app");
      return;
    }
    const dir = await openDialog({ directory: true, multiple: false, title: "Select a git repository" });
    if (typeof dir !== "string") return;
    try {
      const added = await ipc.addRepo(dir);
      const fresh = await ipc.getSettings();
      setSettings(fresh);
      setSelected(added.id);
      setTab("general");
      showToast("Repository added — configure it below");
    } catch (e) {
      showToast(String(e));
    }
  }

  async function save() {
    if (!settings) return;
    const cleaned: Settings = {
      ...settings,
      repos: settings.repos.map((r) => ({
        ...r,
        services: r.services.filter((s) => s.id.trim() && s.command.trim()),
        customCommands: (r.customCommands || []).filter((c) => c.label.trim() && c.command.trim()),
        agents: (r.agents || []).filter((a) => a.id.trim() && a.name.trim() && a.command.trim()),
      })),
    };
    setSaving(true);
    try {
      if (hasBackend()) {
        await ipc.saveSettings(cleaned);
        // write .worktreemanager.json ONLY for repos the user actually edited,
        // and surface every failure — a silent catch here rewrote team repos
        // and lied about broken saves.
        const failures: string[] = [];
        await Promise.all(
          cleaned.repos
            .filter((r) => dirtyRepos.current.has(r.id))
            .map((r) =>
              ipc
                .saveRepoConfig(r.id, fromCards(cardsByRepo[r.id] || []), (setupByRepo[r.id] || []).filter((c) => c.trim()))
                .then(() => dirtyRepos.current.delete(r.id))
                .catch((e) => failures.push(`${r.name}: ${e}`)),
            ),
        );
        if (failures.length) {
          showToast(`Saved app settings, but repo config failed — ${failures.join(" · ")}`);
          return; // keep the view open so nothing is silently lost
        }
      }
      bumpSettings(); // the agent lane re-reads its launcher list off this
      showToast("Settings saved");
      onClose();
    } catch (e) {
      showToast(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  /* ── Files tab actions ── */
  const addFile = () =>
    setCards([...cards, { id: uid("f"), path: "", format: "dotenv", from: "", interpolate: false, keys: [{ id: uid("k"), k: "", v: "" }] }]);
  const patchCard = (id: string, next: FileCardT) => setCards(cards.map((c) => (c.id === id ? next : c)));
  const removeCard = (id: string) => setCards(cards.filter((c) => c.id !== id));

  const configJson = () => JSON.stringify(buildConfig(cards, setup, extras.teardown, extras.migrate), null, 2);
  const copyPreview = () => {
    try {
      navigator.clipboard.writeText(configJson());
      showToast("Copied .worktreemanager.json");
    } catch {
      showToast("Copy failed");
    }
  };
  // native save dialog + backend write — anchor downloads are ignored by the webview
  const exportJson = async () => {
    if (!hasBackend()) {
      showToast("Export needs the desktop app");
      return;
    }
    try {
      const path = await saveDialog({
        title: "Export repo config",
        defaultPath: `${repo?.path || ""}/.worktreemanager.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await ipc.saveTextFile(path, configJson() + "\n");
      showToast(`Exported ${path}`);
    } catch (e) {
      showToast(`Export failed: ${e}`);
    }
  };
  const importJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(String(r.result));
        const list: ProvisionEntry[] = Array.isArray(parsed.provision)
          ? parsed.provision.map((o: Record<string, unknown>) => ({
              path: String(o.path || ""),
              format: (["dotenv", "json", "yaml", "text"].includes(o.format as string) ? o.format : "dotenv") as ProvisionFormat,
              from: String(o.from || ""),
              interpolate: !!o.interpolate,
              keys: o.keys && typeof o.keys === "object" ? Object.entries(o.keys as object).map(([k, v]) => [k, String(v)] as [string, string]) : [],
            }))
          : [];
        setCards(toCards(list));
        if (Array.isArray(parsed.setup)) setSetup(parsed.setup.filter((x: unknown) => typeof x === "string"));
        setTab("files");
        showToast(list.length ? `Imported ${list.length} file${list.length > 1 ? "s" : ""}` : "No provision entries found");
      } catch {
        showToast(`Couldn't parse ${f.name} — invalid JSON`);
      }
    };
    r.readAsText(f);
    e.target.value = "";
  };

  const TABS: { id: TabId; label: string; ic: typeof Cog; count?: number; isNew?: boolean }[] = [
    { id: "general", label: "General", ic: Cog },
    { id: "services", label: "Services", ic: Server, count: repo?.services.length },
    { id: "agents", label: "Agents", ic: Sparkle, count: repo?.agents?.length, isNew: true },
    { id: "commands", label: "Commands", ic: Terminal, count: repo?.customCommands?.length },
    { id: "files", label: "Files", ic: File, count: cards.length, isNew: true },
    { id: "setup", label: "Setup", ic: Cube, count: setup.length },
  ];

  return (
    <div className="main">
      <div className="wt-header">
        <div className="wt-title-row">
          <div className="wt-titleblock">
            <h1 className="wt-h1">
              <span className="fork">
                <Fork size={17} />
              </span>
              <span>Settings</span>
            </h1>
            <div className="wt-path">repositories, services, and provisioning</div>
          </div>
          <div className="wt-actions">
            <button className="iconbtn" onClick={onClose}>
              Cancel
            </button>
            <button className="iconbtn primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      <div className="set-split">
        {/* left rail: Application + repositories */}
        <div className="repo-nav">
          <div className="rn-head">Application</div>
          <button className={"rn-item" + (selected === "app" ? " on" : "")} onClick={() => setSelected("app")}>
            <span className="fork-badge sm">
              <Cog size={13} />
            </span>
            <span className="rn-txt">
              <span className="rn-name">General</span>
              <span className="rn-path">editor · terminal · features</span>
            </span>
          </button>

          <div className="rn-head" style={{ marginTop: 8 }}>
            Repositories
          </div>
          {settings.repos.map((r) => (
            <button
              key={r.id}
              className={"rn-item" + (selected === r.id ? " on" : "")}
              onClick={() => {
                setSelected(r.id);
                setTab("general");
              }}
            >
              <span className="fork-badge sm">
                <Fork size={13} />
              </span>
              <span className="rn-txt">
                <span className="rn-name">{r.name}</span>
                <span className="rn-path">{r.path}</span>
              </span>
              <span className="rn-count">{wtCount(r.id)}</span>
            </button>
          ))}
          <button className="rn-add" onClick={addRepo}>
            <Plus size={13} />
            Add repository
          </button>
        </div>

        {/* right: application pane or repo detail */}
        {selected === "app" || !repo ? (
          <div className="repo-detail">
            <div className="rd-head">
              <span className="fork-badge">
                <Cog size={16} />
              </span>
              <div className="rd-titles">
                <h2>Application</h2>
                <span className="rd-path">Global preferences — apply everywhere</span>
              </div>
            </div>
            <div className="rd-body">
              <div className="rd-pane">
                <div className="cfg-rows">
                  <div className="cfg-row">
                    <label className="fld-label">Editor command</label>
                    <input
                      className="input"
                      value={settings.editor.command}
                      placeholder="code"
                      onChange={(e) => patch({ editor: { command: e.target.value } })}
                    />
                  </div>
                  <div className="cfg-row">
                    <label className="fld-label">Terminal app</label>
                    <input
                      className="input"
                      value={settings.terminal}
                      placeholder="Terminal"
                      onChange={(e) => patch({ terminal: e.target.value })}
                    />
                  </div>
                </div>
                <div className="subsec">
                  <div className="subsec-head">
                    <span className="lead">
                      <span className="ic">
                        <Cog size={14} />
                      </span>
                      <h3>Features</h3>
                    </span>
                    <span className="line" />
                  </div>
                  <label className="set-check">
                    <input
                      type="checkbox"
                      checked={settings.showSwitchBranch ?? true}
                      onChange={(e) => patch({ showSwitchBranch: e.target.checked })}
                    />
                    Show the “Switch branch” action in the worktree header
                  </label>
                </div>
                {settings.repos.length === 0 && (
                  <div className="empty" style={{ marginTop: 20 }}>
                    <span>No repositories yet — add your first repo from the left rail.</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="repo-detail">
            <div className="rd-head">
              <span className="fork-badge">
                <Fork size={16} />
              </span>
              <div className="rd-titles">
                <input
                  className="repo-name"
                  value={repo.name}
                  onChange={(e) => patchRepo({ name: e.target.value })}
                  style={{ width: "100%" }}
                />
                <span className="rd-path">{repo.path}</span>
              </div>
              <span className="rd-head-grow" />
              <div className="rd-config">
                <span className="rd-config-lbl" title="These actions read/write the whole repo config">
                  <Braces size={12} />
                  .worktreemanager.json
                </span>
                <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={importJson} />
                <button className="btn sm ghost" title="Import a .worktreemanager.json" onClick={() => fileRef.current?.click()}>
                  <Upload size={13} />
                  Import
                </button>
                <button className="btn sm ghost" title="Export the repo config" onClick={exportJson}>
                  <Download size={13} />
                  Export
                </button>
                <button
                  className="btn sm ghost"
                  title="Remove this repository from Canopy (files on disk are untouched)"
                  onClick={async () => {
                    // removal applies immediately (not on Save) — confirm first
                    if (!window.confirm(`Remove "${repo.name}" from Canopy?\n\nWorktrees and files on disk are not touched.`)) return;
                    if (hasBackend()) await ipc.removeRepo(repo.id).catch((e) => showToast(String(e)));
                    const remaining = settings.repos.filter((r) => r.id !== repo.id);
                    setSettings({ ...settings, repos: remaining });
                    setSelected(remaining[0]?.id ?? "app");
                  }}
                >
                  Remove
                </button>
              </div>
            </div>

            <div className="rd-tabs">
              {TABS.map((t) => {
                const Ic = t.ic;
                return (
                  <button key={t.id} className={"rd-tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
                    <Ic size={14} />
                    {t.label}
                    {typeof t.count === "number" && <span className="rd-tabcount">{t.count}</span>}
                    {t.isNew && <span className="rd-tabdot" title="New" />}
                  </button>
                );
              })}
            </div>

            <div className="rd-body">
              {tab === "general" && (
                <div className="rd-pane">
                  <div className="cfg-rows">
                    <div className="cfg-row">
                      <label className="fld-label">Worktree dir</label>
                      <input
                        className="input mono"
                        value={repo.worktreeDir}
                        placeholder="/path/for/new/worktrees"
                        onChange={(e) => patchRepo({ worktreeDir: e.target.value })}
                      />
                    </div>
                    <div className="cfg-row">
                      <label className="fld-label">
                        <Database size={12} /> Reset DB cmd
                      </label>
                      <input
                        className="input mono"
                        value={repo.resetDb}
                        placeholder="cd server && npm run db:reset"
                        onChange={(e) => patchRepo({ resetDb: e.target.value })}
                      />
                    </div>
                    <div className="cfg-row">
                      <label className="fld-label">
                        <Database size={12} /> Migrate cmd
                      </label>
                      <input
                        className="input mono"
                        value={repo.migrateDb || ""}
                        placeholder="npm run db:migrate (else .worktreemanager.json migrate)"
                        onChange={(e) => patchRepo({ migrateDb: e.target.value })}
                      />
                    </div>
                    <div className="cfg-row">
                      <label className="fld-label">
                        <Sparkle size={12} /> Coding agents
                      </label>
                      <span className="cfg-xref">
                        {repo.agents?.length
                          ? `${repo.agents.length} configured — ${repo.agents.map((a) => a.name || "unnamed").join(", ")}`
                          : "None configured yet — the lane falls back to claude."}
                        <button className="btn sm ghost" onClick={() => setTab("agents")}>
                          <Sparkle size={13} /> Manage agents
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {tab === "agents" && (
                <div className="rd-pane">
                  <div className="pane-title">
                    <div>
                      <h3>
                        Coding agents <span className="newpill">NEW</span>
                      </h3>
                      <p>
                        Launchers in the agent lane's <b>+</b> menu — run as many at once as you like, each in its own tab. Commands run in the
                        worktree with <span className="mono">$CANOPY_CONTEXT_FILE</span> exported.
                      </p>
                    </div>
                    <div className="pane-actions">
                      {PRESET_AGENTS.map((p) => (
                        <button
                          key={p.name}
                          className="btn sm ghost"
                          title={`Add ${p.name} (${p.command})`}
                          onClick={() => patchRepo({ agents: [...(repo.agents || []), { ...emptyAgent(), ...p }] })}
                        >
                          <Plus size={13} />
                          {p.name}
                        </button>
                      ))}
                      <button className="btn sm primary" onClick={() => patchRepo({ agents: [...(repo.agents || []), emptyAgent()] })}>
                        <Plus size={13} />
                        Add agent
                      </button>
                    </div>
                  </div>
                  {(repo.agents || []).length === 0 ? (
                    <div className="empty">
                      <span>
                        No agents configured — the lane falls back to <code>claude</code>. Add one above, or e.g. <code>Codex</code> ={" "}
                        <code>codex</code>.
                      </span>
                    </div>
                  ) : (
                    <div className="set-svc-table">
                      {(repo.agents || []).map((a, ai) => {
                        const cur = repo.agents || [];
                        const upd = (p: Partial<AgentCfg>) => patchRepo({ agents: cur.map((x, i) => (i === ai ? { ...x, ...p } : x)) });
                        return (
                          <div className="agent-row" key={a.id || ai}>
                            <span className="ag-ic">
                              <Sparkle size={13} />
                            </span>
                            <input className="input" value={a.name} placeholder="Claude" onChange={(e) => upd({ name: e.target.value })} />
                            <input
                              className="input mono"
                              value={a.command}
                              placeholder="claude --permission-mode acceptEdits"
                              onChange={(e) => upd({ command: e.target.value })}
                            />
                            <label className="set-check compact" title="Pass the worktree handoff (task, PR, issue, ports, database) as the CLI's first prompt argument">
                              <input type="checkbox" checked={a.promptOnLaunch !== false} onChange={(e) => upd({ promptOnLaunch: e.target.checked })} />
                              Send prompt
                            </label>
                            <button className="del" title="Remove agent" onClick={() => patchRepo({ agents: cur.filter((_, i) => i !== ai) })}>
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {tab === "services" && (
                <div className="rd-pane">
                  <div className="pane-title">
                    <div>
                      <h3>Services</h3>
                      <p>Dev processes Canopy starts per worktree, each on a derived port.</p>
                    </div>
                    <div className="pane-actions">
                      <button className="btn sm primary" onClick={() => patchRepo({ services: [...repo.services, emptyService()] })}>
                        <Plus size={13} />
                        Add service
                      </button>
                    </div>
                  </div>
                  {repo.services.length === 0 ? (
                    <div className="empty">
                      <span>No services yet — add one to run it per worktree.</span>
                    </div>
                  ) : (
                    <div className="set-svc-table">
                      <div className="set-svc-cols set-svc-cols--head">
                        <span>id</span>
                        <span>name</span>
                        <span>kind</span>
                        <span>command</span>
                        <span>cwd</span>
                        <span>port</span>
                        <span />
                      </div>
                      {repo.services.map((svc, si) => {
                        const patchSvc = (p: Partial<ServiceCfg>) =>
                          patchRepo({ services: repo.services.map((s, i) => (i === si ? { ...s, ...p } : s)) });
                        return (
                          <div className="set-svc-cols" key={si}>
                            <input className="set-input" value={svc.id} placeholder="frontend" onChange={(e) => patchSvc({ id: e.target.value })} />
                            <input className="set-input" value={svc.name} placeholder="Frontend" onChange={(e) => patchSvc({ name: e.target.value })} />
                            <select className="set-input" value={svc.kind} onChange={(e) => patchSvc({ kind: e.target.value })}>
                              {KINDS.map((k) => (
                                <option key={k}>{k}</option>
                              ))}
                            </select>
                            <input className="set-input" value={svc.command} placeholder="npm start" onChange={(e) => patchSvc({ command: e.target.value })} />
                            <input className="set-input" value={svc.cwd} placeholder="frontend" onChange={(e) => patchSvc({ cwd: e.target.value })} />
                            <input
                              className="set-input"
                              value={svc.basePort ?? ""}
                              placeholder="3000"
                              onChange={(e) => patchSvc({ basePort: e.target.value ? parseInt(e.target.value, 10) || null : null })}
                            />
                            <button className="ghostbtn" onClick={() => patchRepo({ services: repo.services.filter((_, i) => i !== si) })}>
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {tab === "commands" && (
                <div className="rd-pane">
                  <div className="pane-title">
                    <div>
                      <h3>Custom commands</h3>
                      <p>
                        Buttons in the worktree header — run in the worktree root on the pinned Node with <span className="mono">$WT_PATH</span>,{" "}
                        <span className="mono">$WTM_REPO</span> exposed.
                      </p>
                    </div>
                    <div className="pane-actions">
                      <button
                        className="btn sm primary"
                        onClick={() => patchRepo({ customCommands: [...(repo.customCommands || []), { label: "", command: "" }] })}
                      >
                        <Plus size={13} />
                        Add command
                      </button>
                    </div>
                  </div>
                  {(repo.customCommands || []).length === 0 ? (
                    <div className="empty">
                      <span>
                        No custom commands. Add e.g. <code>Lint</code> = <code>npm run lint</code>.
                      </span>
                    </div>
                  ) : (
                    <div className="set-svc-table">
                      {(repo.customCommands || []).map((cc, ci) => {
                        const cur = repo.customCommands || [];
                        const upd = (p: Partial<typeof cc>) =>
                          patchRepo({ customCommands: cur.map((c, i) => (i === ci ? { ...c, ...p } : c)) });
                        return (
                          <div className="set-env-row" key={ci}>
                            <input className="input" value={cc.label} placeholder="Lint" onChange={(e) => upd({ label: e.target.value })} />
                            <span className="set-env-eq">=</span>
                            <input className="input mono" value={cc.command} placeholder="npm run lint" onChange={(e) => upd({ command: e.target.value })} />
                            <button className="del" onClick={() => patchRepo({ customCommands: cur.filter((_, i) => i !== ci) })}>
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {tab === "files" && (
                <div className="rd-pane">
                  <div className="pane-title">
                    <div>
                      <h3>
                        Files to provision <span className="newpill">NEW</span>
                      </h3>
                      <p>
                        Seeded &amp; templated into every new worktree — any path, any format. Replaces the old <b>Env overrides</b>; the root{" "}
                        <span className="mono">.env</span> is now just one entry.
                      </p>
                    </div>
                    <div className="pane-actions">
                      <button className="btn sm primary" onClick={addFile}>
                        <Plus size={13} />
                        Add file
                      </button>
                    </div>
                  </div>

                  <div className="var-strip">
                    <span className="var-lbl">Template vars</span>
                    {VARS.map((v) => (
                      <code className="var-chip" key={v}>
                        {v}
                      </code>
                    ))}
                  </div>

                  {cards.length === 0 ? (
                    <div className="empty">
                      <span>No files provisioned yet — add one to seed it into every new worktree.</span>
                    </div>
                  ) : (
                    <div className="prov-list">
                      {cards.map((c) => (
                        <FileCard key={c.id} card={c} patch={(next) => patchCard(c.id, next)} remove={() => removeCard(c.id)} />
                      ))}
                    </div>
                  )}

                  <div className="preview-block">
                    <div className="pb-head">
                      <span className="lead">
                        <Braces size={13} />
                        <span>
                          <code>.worktreemanager.json</code> preview
                        </span>
                      </span>
                      <button className="add-action" onClick={copyPreview}>
                        Copy
                      </button>
                    </div>
                    <div className="prov-preview">
                      <div className="pp-bar">
                        <span className="pp-ic">
                          <Braces size={13} />
                        </span>
                        .worktreemanager.json
                      </div>
                      <pre className="pp-body" dangerouslySetInnerHTML={{ __html: highlightJson(configJson()) }} />
                    </div>
                  </div>
                </div>
              )}

              {tab === "setup" && (
                <div className="rd-pane">
                  <div className="pane-title">
                    <div>
                      <h3>Setup commands</h3>
                      <p>
                        Written to <span className="mono">.worktreemanager.json</span> — run on worktree create and via the header’s Setup action.
                        Available vars: <span className="mono">$WTM_REPO</span>, <span className="mono">$WTM_WORKTREE</span>.
                      </p>
                    </div>
                    <div className="pane-actions">
                      <button className="btn sm primary" onClick={() => setSetup([...setup, ""])}>
                        <Plus size={13} />
                        Add command
                      </button>
                    </div>
                  </div>
                  {setup.length === 0 ? (
                    <div className="empty">
                      <span>
                        No setup commands. Add e.g. <code>npm --prefix server install</code>.
                      </span>
                    </div>
                  ) : (
                    <div className="set-svc-table">
                      {setup.map((cmd, ci) => (
                        <div className="set-cmd-row" key={ci}>
                          <span className="set-cmd-num">{ci + 1}</span>
                          <input
                            className="input mono"
                            value={cmd}
                            placeholder="npm --prefix frontend install --no-audit"
                            onChange={(e) => setSetup(setup.map((c, i) => (i === ci ? e.target.value : c)))}
                          />
                          <button className="del" onClick={() => setSetup(setup.filter((_, i) => i !== ci))}>
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
