// Settings — the redesigned configuration editors (design: Canopy Settings.html).
//
// ONE navigation list: platform pages, the repository picker acting as the
// scope divider, then that repo's pages — nothing named twice. ⌘F searches
// every setting and jumps to it; ⌘P opens the .worktreemanager.json preview as
// a peer panel; unsaved changes are named per section in the nav and the bar.
//
// Backend honesty (design-build): pages with real wiring persist through
// getSettings/saveSettings (Repository, Services, Agents, Commands) and
// getRepoConfig/saveRepoConfig (Files, Setup), plus Appearance (theme, density
// and accent) which applies live through the appearance module (localStorage,
// not the Settings save step). Pages with no backend today (Terminal shell,
// Notifications, Advanced updates/crash, Security) render a "coming soon" banner
// with disabled controls rather than fake ones. Shortcuts is a static reference
// of the real keybindings.
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { errText, hasBackend, ipc, type AgentCfg, type CustomCmd, type ProvisionEntry, type ProvisionFormat, type RepoCfg, type ServiceCfg, type Settings } from "../ipc";
import { useStore } from "../store";
import Modal, { Hint, Spacer } from "./canopy/Modal";
import {
  Bell, Braces, Check, ChevRight, Chevron, Copy, Cube, Doc, Download, Finder, Fork, Keyboard,
  Logs, More, Play, Plus, Pull, Refresh, Search, Server, Settings as Cog, Shield, Sliders, Sparkle,
  Spinner, Terminal, Trash, X,
} from "../icons";
import { getAppearance, setAppearance, type Accent, type Density, type Theme } from "../appearance";

/* icons don't accept `style`; wrap when a glyph needs rotating */
const Rot = ({ children, deg }: { children: React.ReactNode; deg: number }) => (
  <span style={{ display: "inline-flex", transform: `rotate(${deg}deg)` }}>{children}</span>
);

type IconC = ComponentType<{ size?: number }>;
const ICONS: Record<string, IconC> = {
  sliders: Sliders, terminal: Terminal, bell: Bell, keyboard: Keyboard, cube: Cube, fork: Fork,
  server: Server, sparkle: Sparkle, code: Braces, doc: Doc, shield: Shield, settings: Cog,
};

type PageId =
  | "general" | "terminal" | "notifications" | "shortcuts" | "advanced"
  | "repo-general" | "services" | "agents" | "commands" | "files" | "setup" | "security";

type PageMeta = { id: PageId; ic: string; label: string; desc: string; title: string; blurb: string };

const PLATFORM: PageMeta[] = [
  { id: "general", ic: "sliders", label: "General", desc: "Appearance and behaviour", title: "General", blurb: "How Canopy looks and what it does on launch." },
  { id: "terminal", ic: "terminal", label: "Terminal", desc: "Shell, font, env", title: "Terminal", blurb: "The shell Canopy opens inside a worktree, and what it inherits." },
  { id: "notifications", ic: "bell", label: "Notifications", desc: "What interrupts you", title: "Notifications", blurb: "Canopy only interrupts you for things that need a decision." },
  { id: "shortcuts", ic: "keyboard", label: "Shortcuts", desc: "Keyboard map", title: "Keyboard shortcuts", blurb: "Every command is reachable from the keyboard." },
  { id: "advanced", ic: "cube", label: "Advanced", desc: "Diagnostics, experiments", title: "Advanced", blurb: "Diagnostics, experiments and reset." },
];
const REPOPAGES: PageMeta[] = [
  { id: "repo-general", ic: "fork", label: "General", desc: "Paths and defaults", title: "Repository", blurb: "Where this repo lives and what every new worktree starts with." },
  { id: "services", ic: "server", label: "Services", desc: "Runtimes, ports", title: "Services", blurb: "Long-running processes Canopy starts per worktree. Ports derive from the worktree index so they never collide." },
  { id: "agents", ic: "sparkle", label: "Agents", desc: "Coding agents", title: "Agents", blurb: "Which agent CLIs are available, and what context they inherit." },
  { id: "commands", ic: "code", label: "Commands", desc: "One-off scripts", title: "Custom commands", blurb: "Named scripts you can launch in any worktree from the + menu." },
  { id: "files", ic: "doc", label: "Files", desc: "Provisioned config", title: "Provisioned files", blurb: "Files seeded or templated into every new worktree — any path, any format." },
  { id: "setup", ic: "cube", label: "Setup", desc: "Tasks on create", title: "Setup", blurb: "Commands run in order the first time a worktree is created." },
  { id: "security", ic: "shield", label: "Security", desc: "Secrets, SSH", title: "Security", blurb: "How secrets are handled in provisioned files and exports." },
];
const ALLPAGES = [...PLATFORM, ...REPOPAGES];
const pageOf = (id: PageId): PageMeta => ALLPAGES.find((p) => p.id === id) || ALLPAGES[0];
const REPO_PAGE_IDS = new Set<PageId>(REPOPAGES.map((p) => p.id));

/* the searchable index — every setting, not just page names */
const INDEX: { page: PageId; label: string; hint: string }[] = (
  [
    ["general", "Editor command", "code, cursor, subl"], ["general", "Theme", "dark, match system"],
    ["general", "Density", "compact or comfortable"], ["general", "Accent colour", "teal, green, amber"],
    ["general", "Show switch-branch action", "worktree menu"],
    ["terminal", "Terminal application", "Terminal, iTerm"], ["terminal", "Shell program", "/bin/zsh"],
    ["terminal", "Font and size", "SF Mono, JetBrains"], ["terminal", "Inherit provisioned env", "ports, database"],
    ["notifications", "Service crash alerts", "interrupt when a service dies"],
    ["notifications", "Agent needs a decision", "blocked agent"],
    ["shortcuts", "Command palette", "⌘K"], ["shortcuts", "Save changes", "⌘S"],
    ["shortcuts", "Toggle worktree list", "⌘B"], ["shortcuts", "Layout presets", "⌘1 ⌘2 ⌘3 ⌘4 ⌘5"],
    ["shortcuts", "New worktree", "⌘N"], ["shortcuts", "Add repository", "⇧⌘N"],
    ["shortcuts", "Sync submodules", "⇧⌘S"], ["shortcuts", "Switch branch", "⌘\\"],
    ["shortcuts", "Pull everything", "⌘⏎"], ["shortcuts", "Run next action", "⏎"],
    ["shortcuts", "Cross-worktree overview", "⌘O"], ["shortcuts", "Open settings", "⌘,"],
    ["shortcuts", "Select several worktrees", "⌘click ⇧click"],
    ["advanced", "Diagnostics", "version, config path"], ["advanced", "Experiments", "parallel setup"],
    ["repo-general", "Repository path", "where the repo lives"], ["repo-general", "Worktree root", ".worktrees"],
    ["repo-general", "Remove repository", "stop tracking"],
    ["services", "Base port", "derived per worktree index"], ["services", "Service command", "how a service starts"],
    ["services", "Working directory", "cwd"], ["services", "Extra env", "KEY=VALUE"],
    ["agents", "Agent CLI", "claude, codex, aider"], ["agents", "Prompt on launch", "seed the handoff"],
    ["commands", "Custom command", "label and script"],
    ["files", "Provisioned file", "path and format"], ["files", "Template variables", "${INT_DB_NAME} ${WT_SERVICE_PORT}"],
    ["files", "dotenv format", ".env files"],
    ["setup", "Setup tasks", "install, migrate, build"],
    ["security", "Mask secrets", "hide token values"], ["security", "SSH key", "git credentials"],
  ] as [PageId, string, string][]
).map(([page, label, hint]) => ({ page, label, hint }));

const VARS: { t: string; d: string }[] = [
  { t: "${INT_DB_NAME}", d: "tj_history" },
  { t: "${INT_SLUG}", d: "fix-history-state" },
  { t: "${WT_INDEX}", d: "3" },
  { t: "${WT_SERVICE_PORT}", d: "8272" },
  { t: "${WT_PATH}", d: "~/ToolJet/.worktrees/…" },
  { t: "${REPO_PATH}", d: "~/ToolJet" },
];

/* ── client-side provision model (stable ids for React keys) ── */
let _uid = 0;
const uid = (p: string) => `${p}-${++_uid}`;
type KeyRow = { id: string; k: string; v: string };
type FileCardT = { id: string; path: string; format: ProvisionFormat; from: string; interpolate: boolean; keys: KeyRow[] };

function toCards(entries: ProvisionEntry[]): FileCardT[] {
  return entries.map((e) => ({
    id: uid("f"), path: e.path, format: e.format, from: e.from || "", interpolate: !!e.interpolate,
    keys: (e.keys || []).map(([k, v]) => ({ id: uid("k"), k, v })),
  }));
}
function fromCards(cards: FileCardT[]): ProvisionEntry[] {
  return cards.filter((c) => c.path.trim()).map((c) => ({
    path: c.path.trim(), format: c.format, from: c.from.trim(),
    interpolate: c.format === "text" ? c.interpolate : false,
    keys: c.format === "text" ? [] : (c.keys.filter((k) => k.k.trim()).map((k) => [k.k, k.v]) as [string, string][]),
  }));
}
function buildConfig(cards: FileCardT[], setup: string[], teardown: string[], migrate: string[]) {
  const cfg: Record<string, unknown> = {
    $schema: "canopy://worktree-manager/v1",
    provision: cards.filter((c) => c.path.trim()).map((c) => {
      const o: Record<string, unknown> = { path: c.path.trim(), format: c.format };
      if (c.from.trim()) o.from = c.from.trim();
      if (c.format === "text") o.interpolate = c.interpolate;
      else { o.mode = "upsert"; o.keys = Object.fromEntries(c.keys.filter((k) => k.k.trim()).map((k) => [k.k, k.v])); }
      return o;
    }),
    setup: setup.filter((s) => s.trim()),
  };
  if (teardown.length) cfg.teardown = teardown;
  if (migrate.length) cfg.migrate = migrate;
  return cfg;
}

let agentSeq = 0;
const emptyAgent = (): AgentCfg => ({ id: `agent-${Date.now().toString(36)}-${agentSeq++}`, name: "", command: "", promptOnLaunch: true, waitingPatterns: "" });
const emptyService = (): ServiceCfg => ({ id: uid("svc"), name: "", kind: "worker", command: "", cwd: "", basePort: null, env: {} });
function migrateAgents(r: RepoCfg): RepoCfg {
  if (r.agents?.length || !r.agentCommand?.trim()) return { ...r, agents: r.agents ?? [] };
  return { ...r, agents: [{ ...emptyAgent(), name: "Agent", command: r.agentCommand.trim() }] };
}
const envToStr = (env: Record<string, string>) => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join("\n");
const strToEnv = (s: string): Record<string, string> =>
  Object.fromEntries(s.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf("="); return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)]; }));

/* JSON preview highlight — escape first, then wrap tokens (values are escaped
   so this is safe to inject) */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function hlLine(line: string): string {
  let s = esc(line);
  s = s.replace(/"([^"]*)"(\s*:)/g, '<span class="jk">"$1"</span>$2');
  s = s.replace(/:\s*"([^"]*)"/g, (_m, v: string) => `: <span class="jv">"${v}"</span>`);
  s = s.replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="jn">$1</span>');
  return s;
}

const MOCK: Settings = {
  version: 1, editor: { command: "code" }, terminal: "Terminal", showSwitchBranch: true,
  repos: [{
    id: "tooljet", name: "ToolJet", path: "~/ToolJetSpace/CE/ToolJet", worktreeDir: ".worktrees", resetDb: "", migrateDb: "",
    services: [
      { id: "fe", name: "Frontend", kind: "web", command: "pnpm --filter frontend dev", cwd: "frontend", basePort: 8232, env: { NODE_ENV: "development" } },
      { id: "srv", name: "Server", kind: "server", command: "pnpm --filter server start:dev", cwd: "server", basePort: 3150, env: { LOG_LEVEL: "debug" } },
    ],
    customCommands: [{ label: "Lint", command: "pnpm lint", group: "Checks" }, { label: "Unit tests", command: "pnpm test --run", group: "Checks" }],
    agentCommand: "claude",
    agents: [
      { id: "a1", name: "Claude Code", command: "claude", promptOnLaunch: true, waitingPatterns: "" },
      { id: "a2", name: "Codex", command: "codex", promptOnLaunch: true, waitingPatterns: "" },
    ],
  }],
};
const MOCK_CARDS: ProvisionEntry[] = [
  { path: ".env", format: "dotenv", from: ".env", interpolate: false, keys: [["PG_DB", "${INT_DB_NAME}"], ["PORT", "${WT_SERVICE_PORT}"]] },
  { path: "ee/.env", format: "dotenv", from: "ee/.env", interpolate: false, keys: [["LICENSE_KEY", ""]] },
];
const MOCK_SETUP = ["pnpm install", "pnpm --filter server db:migrate", "pnpm build:plugins"];

/* ══════════════════════════ shared little controls ══════════════════════ */
function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return <button className={"tgl" + (on ? " on" : "")} role="switch" aria-checked={on} disabled={disabled} onClick={onClick}><i /></button>;
}
function TRow({ title, hint, on, onToggle, disabled }: { title: string; hint?: string; on: boolean; onToggle?: () => void; disabled?: boolean }) {
  return (
    <div className="tglrow">
      <span className="tt"><b>{title}</b>{hint && <span>{hint}</span>}</span>
      <Toggle on={on} onClick={onToggle} disabled={disabled} />
    </div>
  );
}
function Adv({ n, label = "Advanced", children }: { n?: string; label?: string; children: React.ReactNode }) {
  return (
    <details className="adv">
      <summary><span className="cv"><ChevRight size={11} /></span>{label}{n && <span className="n">{n}</span>}</summary>
      <div className="advb">{children}</div>
    </details>
  );
}
function Soon({ children }: { children: React.ReactNode }) {
  return (
    <div className="soon">
      <span className="ic"><Cube size={14} /></span>
      <span><b>Coming soon.</b> {children}</span>
    </div>
  );
}
function InsertVar({ onPick }: { onPick: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [open]);
  return (
    <span className="varwrap" ref={ref}>
      <button className="btn sm gh" onClick={() => setOpen((o) => !o)}><Plus size={10} />Insert variable<span className="k">⌘/</span></button>
      {open && (
        <div className="varmenu">
          <div className="vh">Template variables</div>
          {VARS.map((v) => (
            <button className="vitem" key={v.t} onClick={() => { onPick(v.t); setOpen(false); }}><code>{v.t}</code><span>{v.d}</span></button>
          ))}
        </div>
      )}
    </span>
  );
}

type PageProps = {
  repo: RepoCfg | null;
  patchRepo: (p: Partial<RepoCfg>) => void;
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  markDirty: (id: PageId) => void;
  flash: (m: string) => void;
  cards: FileCardT[];
  setCards: (c: FileCardT[]) => void;
  setup: string[];
  setSetup: (s: string[]) => void;
  onRemoveRepo: () => void;
  onExportJson: () => void;
  onImportJson: () => void;
  onCopyJson: () => void;
  selKey: string | null;
};

/* ══════════════════════════ real: Services ═════════════════════════════ */
function ServicesPage({ repo, patchRepo, markDirty }: PageProps) {
  const [open, setOpen] = useState<string | null>(repo?.services[0]?.id ?? null);
  if (!repo) return null;
  const svcs = repo.services;
  const patch = (id: string, p: Partial<ServiceCfg>) => { patchRepo({ services: svcs.map((s) => (s.id === id ? { ...s, ...p } : s)) }); markDirty("services"); };
  return (
    <div className="sec">
      <div className="slab">Services<span className="n">ports derive from the worktree index</span></div>
      <div className="objs">
        {svcs.map((s) => (
          <div className={"obj" + (open === s.id ? " open" : "")} key={s.id}>
            <button className="ohead" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="cv"><ChevRight size={11} /></span>
              <span className="nm">{s.name || "New service"}</span>
              <span className="tag">{s.kind}</span>
              <span className="gr" />
              <span className="mono" style={{ maxWidth: 210 }}>{s.command}</span>
              {s.basePort != null && <span className="port">:{s.basePort}</span>}
              <span className="oacts">
                <span className="ico" title="Duplicate" onClick={(e) => { e.stopPropagation(); patchRepo({ services: svcs.concat([{ ...s, id: uid("svc"), name: s.name + " copy" }]) }); markDirty("services"); }}><Copy size={11} /></span>
                <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); patchRepo({ services: svcs.filter((x) => x.id !== s.id) }); markDirty("services"); }}><Trash size={11} /></span>
              </span>
            </button>
            {open === s.id && (
              <div className="obody">
                <div className="fgrid">
                  <span className="lb">Name</span><input className="inp" value={s.name} onChange={(e) => patch(s.id, { name: e.target.value })} />
                  <span className="lb">Command</span><input className="inp mono" value={s.command} onChange={(e) => patch(s.id, { command: e.target.value })} />
                  <span className="lb">Directory</span><input className="inp mono" value={s.cwd} placeholder="repo root" onChange={(e) => patch(s.id, { cwd: e.target.value })} />
                  <span className="lb">Base port</span>
                  <div className="row">
                    <input className="inp mono" value={s.basePort ?? ""} style={{ width: 84 }} inputMode="numeric"
                      onChange={(e) => patch(s.id, { basePort: e.target.value.trim() === "" ? null : Number(e.target.value) || 0 })} />
                    {s.basePort != null && <span className="hint" style={{ marginTop: 0 }}>+ index × 10 → <span className="tokchip" style={{ fontFamily: "var(--mono)" }}>{s.basePort + 30}</span> on index 3</span>}
                  </div>
                  <span className="lb">Kind</span>
                  <select className="inp" value={s.kind} onChange={(e) => patch(s.id, { kind: e.target.value })}>
                    <option value="web">web</option><option value="server">server</option><option value="worker">worker</option>
                  </select>
                </div>
                <Adv n="env, health">
                  <div className="fgrid">
                    <span className="lb">Extra env</span>
                    <textarea className="inp" value={envToStr(s.env)} placeholder="KEY=VALUE (one per line)" onChange={(e) => patch(s.id, { env: strToEnv(e.target.value) })} />
                    <span className="lb">Health check</span>
                    <input className="inp mono" disabled title="Health checks aren't wired yet" placeholder="coming soon" />
                  </div>
                </Adv>
              </div>
            )}
          </div>
        ))}
      </div>
      <button className="btn" style={{ marginTop: 8 }} onClick={() => { const s = { ...emptyService(), name: "New service", basePort: 4000 }; patchRepo({ services: svcs.concat([s]) }); setOpen(s.id); markDirty("services"); }}>
        <Plus size={11} />Add service</button>
    </div>
  );
}

/* ══════════════════════════ real: Agents ═══════════════════════════════ */
function AgentsPage({ repo, patchRepo, markDirty, flash }: PageProps) {
  if (!repo) return null;
  const agents = repo.agents || [];
  const patch = (id: string, p: Partial<AgentCfg>) => { patchRepo({ agents: agents.map((a) => (a.id === id ? { ...a, ...p } : a)) }); markDirty("agents"); };
  const makeDefault = (id: string) => { const a = agents.find((x) => x.id === id); if (!a) return; patchRepo({ agents: [a, ...agents.filter((x) => x.id !== id)] }); markDirty("agents"); flash(`${a.name || a.command} is now the default agent`); };
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="sec">
        <div className="slab">Agent CLIs<span className="n">the first is the default</span></div>
        <div className="objs">
          {agents.map((a, i) => (
            <div className={"obj" + (open === a.id ? " open" : "")} key={a.id}>
              <button className="ohead" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <span className="cv"><ChevRight size={11} /></span>
                <Sparkle size={12} />
                <span className="nm">{a.name || "Untitled"}</span>
                {i === 0 && <span className="tag" style={{ color: "var(--action-primary)", background: "var(--accent-dim)" }}>default</span>}
                <span className="gr" />
                <span className="mono">{a.command}</span>
                <span className="oacts">
                  {i !== 0 && <span className="ico" title="Make default" onClick={(e) => { e.stopPropagation(); makeDefault(a.id); }}><Check size={11} /></span>}
                  <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); patchRepo({ agents: agents.filter((x) => x.id !== a.id) }); markDirty("agents"); }}><Trash size={11} /></span>
                </span>
              </button>
              {open === a.id && (
                <div className="obody">
                  <div className="fgrid">
                    <span className="lb">Name</span><input className="inp" value={a.name} placeholder="Claude Code" onChange={(e) => patch(a.id, { name: e.target.value })} />
                    <span className="lb">Command</span><input className="inp mono" value={a.command} placeholder="claude" onChange={(e) => patch(a.id, { command: e.target.value })} />
                  </div>
                  <div className="tglrow" style={{ borderTop: 0 }}>
                    <span className="tt"><b>Prompt on launch</b><span>Append Canopy's structured handoff as the first prompt.</span></span>
                    <Toggle on={a.promptOnLaunch} onClick={() => patch(a.id, { promptOnLaunch: !a.promptOnLaunch })} />
                  </div>
                  <div className="fgrid">
                    <span className="lb">Waiting phrases</span>
                    <textarea
                      className="inp mono"
                      rows={3}
                      value={a.waitingPatterns}
                      placeholder={"Do you want to proceed?\nApprove this edit"}
                      onChange={(e) => patch(a.id, { waitingPatterns: e.target.value })}
                    />
                  </div>
                  <div className="hint">
                    One phrase per line. Canopy already recognises the common prompt shapes —
                    add a line only when this CLI asks in a way it misses.
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => { const a = { ...emptyAgent(), name: "New agent" }; patchRepo({ agents: agents.concat([a]) }); setOpen(a.id); markDirty("agents"); }}>
          <Plus size={11} />Add agent</button>
      </div>
      <div className="sec">
        <div className="slab">Context handed to every agent</div>
        <Soon>The per-agent context toggles and concurrency limit aren't wired yet — Canopy currently seeds the worktree context by default.</Soon>
        <div className="soonwrap">
          <TRow title="Worktree context" hint="Task title, description and linked PR or issue." on disabled />
          <TRow title="Runtime facts" hint="Branch, ports, database name and running services." on disabled />
          <TRow title="Recent failing logs" hint="The last 40 error lines, when a service is unhealthy." on={false} disabled />
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════ real: Commands ═════════════════════════════ */
function CommandsPage({ repo, patchRepo, markDirty, flash, selKey }: PageProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [ran, setRan] = useState<{ i: number; state: "running" | "done" } | null>(null);
  if (!repo) return null;
  const cmds = repo.customCommands || [];
  const patch = (i: number, p: Partial<CustomCmd>) => { patchRepo({ customCommands: cmds.map((c, j) => (j === i ? { ...c, ...p } : c)) }); markDirty("commands"); };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= cmds.length) return; const n = cmds.slice(); [n[i], n[j]] = [n[j], n[i]]; patchRepo({ customCommands: n }); markDirty("commands"); };
  const test = (i: number, cmd: string) => {
    if (!hasBackend() || !selKey) { flash("Open a worktree to test a command"); return; }
    setRan({ i, state: "running" });
    ipc.runCustomCommand(selKey, cmd).then(() => setRan({ i, state: "done" })).catch((e) => { setRan(null); flash(`Command failed — ${errText(e)}`); });
  };
  // Existing groups become suggestions: grouping is only useful when names
  // match exactly, and free typing is how you end up with "Build" and "build".
  const groupNames = Array.from(new Set(cmds.map((c) => (c.group ?? "").trim()).filter(Boolean)));
  return (
    <>
      <div className="sec">
        <div className="slab">Database operations<span className="n">used by “Reset database” and “Run migrations” on a worktree</span></div>
        <div className="fgrid">
          <span className="lb">Reset command</span>
          <input className="inp mono" value={repo.resetDb || ""} placeholder="pnpm db:reset" spellCheck={false} onChange={(e) => { patchRepo({ resetDb: e.target.value }); markDirty("commands"); }} />
          <span className="lb">Migrate command</span>
          <input className="inp mono" value={repo.migrateDb || ""} placeholder="pnpm db:migrate" spellCheck={false} onChange={(e) => { patchRepo({ migrateDb: e.target.value }); markDirty("commands"); }} />
        </div>
      </div>
      <div className="sec">
        <datalist id="cx-cmd-groups">{groupNames.map((g) => <option key={g} value={g} />)}</datalist>
        <div className="slab">Custom commands<span className="n">launchers in the agent lane's + menu</span></div>
        {cmds.length === 0 ? (
          <div className="empty">
            <p>No commands yet. Add one like <code>Lint</code> = <code>pnpm lint</code> — it appears in every worktree's + menu.</p>
            <button className="btn sm" onClick={() => { patchRepo({ customCommands: [{ label: "", command: "", group: "" }] }); markDirty("commands"); }}><Plus size={10} />Add command</button>
          </div>
        ) : (
          <div className="objs">
            {cmds.map((c, i) => (
              <div className={"obj" + (open === i ? " open" : "")} key={i}>
                <button className="ohead" onClick={() => setOpen(open === i ? null : i)}>
                  <span className="cv"><ChevRight size={11} /></span>
                  <span className="nm">{c.label || "Untitled"}</span>
                  <span className="gr" />
                  <span className="mono" style={{ maxWidth: 250 }}>{c.command}</span>
                  <span className="oacts">
                    <span className="ico" title="Run once to test" onClick={(e) => { e.stopPropagation(); setOpen(i); test(i, c.command); }}>{ran && ran.i === i && ran.state === "running" ? <Spinner size={11} /> : <Play size={10} />}</span>
                    <span className="ico" title="Move up" onClick={(e) => { e.stopPropagation(); move(i, -1); }}><Rot deg={180}><Chevron size={11} /></Rot></span>
                    <span className="ico" title="Move down" onClick={(e) => { e.stopPropagation(); move(i, 1); }}><Chevron size={11} /></span>
                    <span className="ico" title="Duplicate" onClick={(e) => { e.stopPropagation(); patchRepo({ customCommands: cmds.concat([{ ...c, label: c.label + " copy" }]) }); markDirty("commands"); }}><Copy size={11} /></span>
                    <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); patchRepo({ customCommands: cmds.filter((_, j) => j !== i) }); markDirty("commands"); }}><Trash size={11} /></span>
                  </span>
                </button>
                {open === i && (
                  <div className="obody">
                    <div className="fgrid">
                      <span className="lb">Label</span><input className="inp" value={c.label} placeholder="Lint" onChange={(e) => patch(i, { label: e.target.value })} />
                      <span className="lb">Command</span><input className="inp mono" value={c.command} placeholder="pnpm lint" onChange={(e) => patch(i, { command: e.target.value })} />
                      <span className="lb">Group</span>
                      <input className="inp" value={c.group ?? ""} placeholder="ungrouped" list="cx-cmd-groups"
                        title="Commands sharing a group get a header in the rail's Commands menu"
                        onChange={(e) => patch(i, { group: e.target.value })} />
                    </div>
                    {ran && ran.i === i && (
                      <div className="testout">
                        <div className="th">{ran.state === "running" ? <><Spinner size={10} />running in the current worktree…</> : <><span className="ok">✓</span>finished</>}</div>
                      </div>
                    )}
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn sm" onClick={() => test(i, c.command)}><Play size={10} />Test in current worktree</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {cmds.length > 0 && (
          <button className="btn" style={{ marginTop: 8 }} onClick={() => { patchRepo({ customCommands: cmds.concat([{ label: "", command: "", group: "" }]) }); setOpen(cmds.length); markDirty("commands"); }}><Plus size={11} />Add command</button>
        )}
      </div>
    </>
  );
}

/* ══════════════════════════ real: Files ════════════════════════════════ */
const FMTS: ProvisionFormat[] = ["dotenv", "json", "yaml", "text"];

/** A path inside the repo is stored RELATIVE to it — that is what provisioning
    resolves against, and an absolute path would break the moment the repo moves
    or the config is shared. Anything outside stays absolute. */
function repoRelative(picked: string, repoPath: string | undefined): string {
  const root = (repoPath || "").replace(/\/+$/, "");
  if (root && picked.startsWith(root + "/")) return picked.slice(root.length + 1);
  return picked;
}

/** Guess the format from the file the user picked, so choosing `config.json`
    does not silently keep the dotenv parser. */
function formatOf(path: string): ProvisionFormat | null {
  const f = path.toLowerCase();
  if (/\.ya?ml$/.test(f)) return "yaml";
  if (f.endsWith(".json")) return "json";
  if (/(^|\/)\.env(\.|$)/.test(f)) return "dotenv";
  return null;
}

function FilesPage({ repo, cards, setCards, markDirty, flash }: PageProps) {
  const [selId, setSelId] = useState<string | null>(cards[0]?.id ?? null);
  const sel = cards.find((c) => c.id === selId) || cards[0] || null;
  const keyRef = useRef<number | null>(null);
  const patch = (p: Partial<FileCardT>) => { if (!sel) return; setCards(cards.map((c) => (c.id === sel.id ? { ...c, ...p } : c))); markDirty("files"); };
  const setKey = (i: number, which: 0 | 1, val: string) => sel && patch({ keys: sel.keys.map((k, j) => (j === i ? (which ? { ...k, v: val } : { ...k, k: val }) : k)) });
  const insert = (tok: string) => {
    const i = keyRef.current;
    if (i == null || !sel) { flash("Select a value field first, then insert"); return; }
    patch({ keys: sel.keys.map((k, j) => (j === i ? { ...k, v: (k.v || "") + tok } : k)) });
  };
  /* Both file fields are pickable. Typing `ee/.env` from memory is how you end
     up provisioning a path that does not exist — and on macOS a dotfile cannot
     be reached by the picker at all unless it starts inside the repo, which is
     why the dialog opens there. */
  const browse = async (which: "path" | "from") => {
    if (!sel) return;
    if (!hasBackend()) { flash("Choosing a file needs the desktop app"); return; }
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        defaultPath: repo?.path || undefined,
        title: which === "path" ? "Choose the file to provision" : "Choose the source file",
      });
      if (typeof picked !== "string") return;
      const rel = repoRelative(picked, repo?.path);
      const fmt = which === "path" ? formatOf(rel) : null;
      patch(which === "path" ? { path: rel, ...(fmt ? { format: fmt } : {}) } : { from: rel });
    } catch (e) {
      flash(`Could not open the file picker — ${errText(e)}`);
    }
  };
  return (
    <>
      <div className="sec">
        <div className="slab">Provisioned files<span className="n">{cards.length} configured</span></div>
        <div className="objs">
          {cards.map((f) => (
            <div className={"obj" + (sel && f.id === sel.id ? " open" : "")} key={f.id}>
              <button className="ohead" onClick={() => setSelId(f.id)}>
                <span className="cv" style={{ transform: sel && f.id === sel.id ? "rotate(90deg)" : "none" }}><ChevRight size={11} /></span>
                <Doc size={12} />
                <span className="mono">{f.path || "new file"}</span>
                <span className="gr" />
                <span className="tag">{f.format}</span>
                <span className="port">{f.keys.length} {f.keys.length === 1 ? "key" : "keys"}</span>
                <span className="oacts">
                  <span className="ico" title="Duplicate" onClick={(e) => { e.stopPropagation(); const n = { ...f, id: uid("f"), path: f.path + ".copy", keys: f.keys.map((k) => ({ ...k, id: uid("k") })) }; setCards(cards.concat([n])); markDirty("files"); }}><Copy size={11} /></span>
                  <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); const rest = cards.filter((x) => x.id !== f.id); setCards(rest); if (sel?.id === f.id) setSelId(rest[0]?.id ?? null); markDirty("files"); }}><Trash size={11} /></span>
                </span>
              </button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => { const n: FileCardT = { id: uid("f"), path: "", format: "dotenv", from: "", interpolate: false, keys: [] }; setCards(cards.concat([n])); setSelId(n.id); markDirty("files"); }}><Plus size={11} />Add file</button>
          <span className="hint" style={{ marginTop: 0 }}>Any path, any format. Env overrides take precedence.</span>
        </div>
      </div>

      {sel && (
        <div className="sec">
          <div className="slab"><Braces size={11} />Editing <span className="tokchip" style={{ fontFamily: "var(--mono)", letterSpacing: 0, textTransform: "none", fontSize: "var(--fs-small)" }}>{sel.path || "new file"}</span></div>
          <div className="steps">
            <div className={"stp" + (sel.path ? " done" : "")}><span className="num">1</span><span className="st"><b>File</b><span>path and format</span></span></div>
            <div className="sbody">
              <div className="row">
                <input className="inp mono gr" value={sel.path} placeholder=".env or config/app.json" onChange={(e) => patch({ path: e.target.value })} />
                <button className="ico" title="Browse for the file to provision" onClick={() => browse("path")}><Finder size={12} /></button>
                <select className="inp" value={sel.format} onChange={(e) => patch({ format: e.target.value as ProvisionFormat })}>
                  {FMTS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="hint">Relative to each worktree's root. Browsing inside the repository stores the path relative to it.</div>
            </div>

            <div className={"stp" + (sel.from ? " done" : "")}><span className="num">2</span><span className="st"><b>Source</b><span>where to copy from</span></span></div>
            <div className="sbody">
              <div className="row">
                <input className="inp mono gr" value={sel.from} placeholder="same path in the repo root" onChange={(e) => patch({ from: e.target.value })} />
                <button className="ico" title="Browse for a source file" onClick={() => browse("from")}><Finder size={12} /></button>
              </div>
              <div className="hint">Leave empty to read the same path from the repo root.</div>
            </div>

            <div className="stp done"><span className="num">3</span><span className="st"><b>Strategy</b><span>how it is applied</span></span></div>
            <div className="sbody">
              {/* the backend derives strategy from the format (keyed → upsert,
                  text → copy + interpolate); an independent mode isn't stored yet */}
              <div className="strat">
                {([["seed", "Seed if missing", "create only when the file does not exist"], ["upsert", "Upsert keys", "add or update named keys, leave the rest alone"], ["replace", "Copy + interpolate", "overwrite the whole file from source"]] as [string, string, string][]).map(([v, t, d]) => {
                  const cur = sel.format === "text" ? "replace" : "upsert";
                  return (
                    <label key={v} className={cur === v ? "on" : ""}>
                      <input type="radio" name={"mode-" + sel.id} checked={cur === v} disabled readOnly />
                      <b>{t}</b><span>{d}</span>
                    </label>
                  );
                })}
              </div>
              <div className="hint">Derived from the format for now — an independent strategy isn't stored yet.</div>
            </div>

            <div className={"stp" + ((sel.format === "text" ? sel.interpolate : sel.keys.length) ? " done" : "")}>
              <span className="num">4</span><span className="st"><b>Values</b><span>{sel.format === "text" ? "interpolate the copy" : "keys to set (upsert)"}</span></span>
            </div>
            <div className="sbody">
              {sel.format === "text" ? (
                <div className="tglrow" style={{ borderTop: 0, paddingTop: 0 }}>
                  <span className="tt"><b>Interpolate template variables</b><span>Replace <code>${"{VARIABLE}"}</code> tokens while copying the file.</span></span>
                  <Toggle on={sel.interpolate} onClick={() => patch({ interpolate: !sel.interpolate })} />
                </div>
              ) : (
                <>
                  <div className="row" style={{ marginBottom: 7 }}>
                    <span className="lb">{sel.keys.length} {sel.keys.length === 1 ? "key" : "keys"}</span>
                    <span style={{ flex: 1 }} />
                    <InsertVar onPick={insert} />
                  </div>
                  {sel.keys.length === 0 ? (
                    <div className="empty"><p>No keys yet. The file is provisioned as-is.</p>
                      <button className="btn sm" onClick={() => patch({ keys: [{ id: uid("k"), k: "", v: "" }] })}><Plus size={10} />Add key</button></div>
                  ) : (
                    <div className="kvg">
                      <span className="kvhead">Key</span><span /><span className="kvhead">Value</span><span />
                      {sel.keys.map((k, i) => (
                        <div key={k.id} style={{ display: "contents" }}>
                          <input className="inp mono" value={k.k} placeholder="KEY" onChange={(e) => setKey(i, 0, e.target.value)} />
                          <span className="eq">=</span>
                          <input className="inp mono" value={k.v} placeholder="value or ${VARIABLE}" onFocus={() => { keyRef.current = i; }} onChange={(e) => setKey(i, 1, e.target.value)} />
                          <button className="ico bad" title="Remove key" onClick={() => patch({ keys: sel.keys.filter((_, j) => j !== i) })}><X size={11} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  {sel.keys.length > 0 && (
                    <button className="btn sm gh" style={{ marginTop: 7 }} onClick={() => patch({ keys: sel.keys.concat([{ id: uid("k"), k: "", v: "" }]) })}><Plus size={10} />Add key</button>
                  )}
                </>
              )}
            </div>
          </div>
          <Adv n="not wired yet">
            <Soon>The on-conflict policy, when-to-apply trigger and file mode aren't stored yet — keys are upserted on create and reset.</Soon>
            <div className="soonwrap fgrid">
              <span className="lb">On conflict</span><select className="inp" disabled><option>Keep existing value</option></select>
              <span className="lb">Apply on</span><select className="inp" disabled><option>Create and reset</option></select>
              <span className="lb">File mode</span><input className="inp mono" disabled defaultValue="0644" style={{ width: 90 }} />
            </div>
          </Adv>
        </div>
      )}
    </>
  );
}

/* ══════════════════════════ real: Setup ════════════════════════════════ */
function SetupPage({ setup, setSetup, markDirty, flash }: PageProps) {
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= setup.length) return; const n = setup.slice(); [n[i], n[j]] = [n[j], n[i]]; setSetup(n); markDirty("setup"); };
  return (
    <div className="sec">
      <div className="slab">Setup tasks<span className="n">run in order when a worktree is created</span></div>
      {setup.length === 0 ? (
        <div className="empty"><p>No setup tasks. Add commands like <code>pnpm install</code> — they run in order the first time a worktree is created.</p>
          <button className="btn sm" onClick={() => { setSetup([""]); markDirty("setup"); }}><Plus size={10} />Add task</button></div>
      ) : (
        <div className="objs">
          {setup.map((t, i) => (
            <div className="obj" key={i}>
              <div className="ohead" style={{ cursor: "default" }}>
                <span className="num" style={{ width: 16, height: 16, borderRadius: 4, display: "grid", placeItems: "center", font: "var(--fw-bold) var(--fs-label) var(--sans)", background: "var(--btn)", color: "var(--text-tertiary)", flex: "none" }}>{i + 1}</span>
                <input className="inp mono gr" value={t} style={{ height: 25 }} placeholder="pnpm install" onChange={(e) => { setSetup(setup.map((x, j) => (j === i ? e.target.value : x))); markDirty("setup"); }} />
                <Toggle on disabled />
                <span className="oacts" style={{ opacity: 1 }}>
                  <span className="ico" title="Move up" onClick={() => move(i, -1)}><Rot deg={180}><Chevron size={11} /></Rot></span>
                  <span className="ico" title="Move down" onClick={() => move(i, 1)}><Chevron size={11} /></span>
                  <span className="ico bad" title="Remove" onClick={() => { setSetup(setup.filter((_, j) => j !== i)); markDirty("setup"); }}><Trash size={11} /></span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => { setSetup(setup.concat([""])); markDirty("setup"); }}><Plus size={11} />Add task</button>
        <button className="btn" title="Dry run (coming soon)" onClick={() => flash("Dry-running setup isn't wired yet")}><Play size={11} />Dry run</button>
      </div>
      <Adv n="not wired yet">
        <Soon>The per-task enable toggle, working directory and the on-failure/timeout policy aren't stored yet — every task runs, in order, from the worktree root.</Soon>
        <div className="soonwrap fgrid">
          <span className="lb">On failure</span><select className="inp" disabled><option>Stop and report</option></select>
          <span className="lb">Timeout</span><input className="inp mono" disabled defaultValue="600" style={{ width: 80 }} />
        </div>
      </Adv>
    </div>
  );
}

/* ══════════════════════════ real: Repository ═══════════════════════════ */
function RepoGeneralPage({ repo, patchRepo, markDirty, flash, onRemoveRepo, onExportJson, onImportJson }: PageProps) {
  const [confirm, setConfirm] = useState(false);
  if (!repo) return null;
  return (
    <>
      <div className="sec">
        <div className="slab">Repository</div>
        <div className="fgrid">
          <span className="lb">Name</span><input className="inp" value={repo.name} onChange={(e) => { patchRepo({ name: e.target.value }); markDirty("repo-general"); }} />
          <span className="lb">Path</span>
          <div className="row"><input className="inp mono gr" value={repo.path} readOnly />
            <button className="ico" title="Reveal in Finder (coming soon)" onClick={() => flash("Revealing a repo in Finder isn't wired yet")}><Finder size={12} /></button></div>
          <span className="lb">Worktree root</span><input className="inp mono" value={repo.worktreeDir} placeholder=".worktrees" onChange={(e) => { patchRepo({ worktreeDir: e.target.value }); markDirty("repo-general"); }} />
          <span className="lb">Default base</span>
          <select className="inp" disabled title="Not stored per repo yet"><option>main</option></select>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Defaults for new worktrees</div>
        <Soon>These defaults aren't stored per repo yet — Canopy runs setup and provisions files on create today.</Soon>
        <div className="soonwrap">
          <TRow title="Run setup automatically" hint="Provision files and run setup tasks as soon as the worktree is created." on disabled />
          <TRow title="Start services after setup" hint="Boot the service list once provisioning finishes." on={false} disabled />
          <TRow title="Create an isolated database" hint="One database per worktree, named from the branch slug." on disabled />
        </div>
      </div>
      <div className="sec">
        <div className="slab">Configuration file</div>
        <div className="row">
          <button className="btn" title="Export .worktreemanager.json" onClick={onExportJson}><Download size={11} />Export config</button>
          <button className="btn" title="Import a .worktreemanager.json" onClick={onImportJson}><Pull size={11} />Import config</button>
          <span className="hint" style={{ marginTop: 0 }}>Import replaces this repo's provisioned files and setup — review, then Save.</span>
        </div>
      </div>
      <Adv label="Danger zone">
        <div className="row">
          <button className="btn danger" onClick={() => setConfirm(true)}><Trash size={11} />Remove repository</button>
          <span className="hint" style={{ marginTop: 0 }}>Stops tracking {repo.name} in Canopy. Your files are untouched.</span>
        </div>
      </Adv>
      {confirm && (
        <Modal
          danger
          icon={Trash}
          title="Remove repository"
          sub={repo.name}
          onClose={() => setConfirm(false)}
          foot={
            <>
              <Hint>You can add it again anytime.</Hint>
              <Spacer />
              <button className="cx-btn cx-btn--ghost" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="cx-btn cx-btn--danger" onClick={() => { setConfirm(false); onRemoveRepo(); }}>
                <Trash size={12} />Remove repository
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: "var(--fs-body)", lineHeight: 1.55, color: "var(--text-secondary)" }}>
            Canopy will stop tracking <b style={{ color: "var(--text-primary)" }}>{repo.name}</b> and remove its
            configuration here — its services, custom commands and agents.
          </p>
          <p style={{ margin: "10px 0 0", fontSize: "var(--fs-small)", lineHeight: 1.55, color: "var(--text-tertiary)" }}>
            The repository, its worktrees and its <span style={{ fontFamily: "var(--mono)" }}>.worktreemanager.json</span>{" "}
            (provisioned files and setup) on disk are not touched.
          </p>
        </Modal>
      )}
    </>
  );
}

/* ══════════════════════════ platform pages ═════════════════════════════ */
const ACCENT_SWATCHES: { id: Accent; name: string; color: string }[] = [
  { id: "teal", name: "Teal", color: "#5cc7cd" },
  { id: "green", name: "Green", color: "#4cc266" },
  { id: "amber", name: "Amber", color: "#e6ad5f" },
  { id: "violet", name: "Violet", color: "#c77ecd" },
];

function GeneralPage({ settings, patch, markDirty }: PageProps) {
  // Appearance applies live and persists to localStorage (not the Settings save
  // step); mirror it here and re-read when another window changes it.
  const [appr, setAppr] = useState(getAppearance());
  const change = (p: Partial<{ theme: Theme; density: Density; accent: Accent }>) => setAppr(setAppearance(p));
  useEffect(() => {
    const h = () => setAppr(getAppearance());
    window.addEventListener("canopy:appearance", h);
    return () => window.removeEventListener("canopy:appearance", h);
  }, []);
  return (
    <>
      <div className="sec">
        <div className="slab">Editor</div>
        <div className="fgrid">
          <span className="lb">Command</span>
          <div className="row"><input className="inp mono gr" value={settings.editor.command} placeholder="code" onChange={(e) => { patch({ editor: { command: e.target.value } }); markDirty("general"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Used for “Open in editor”.</span></div>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Behaviour</div>
        <TRow title="Show the Switch-branch action" hint="Offer “Switch branch…” in the worktree menu and ⌘\." on={settings.showSwitchBranch !== false} onToggle={() => { patch({ showSwitchBranch: !(settings.showSwitchBranch !== false) }); markDirty("general"); }} />
      </div>
      <div className="sec">
        <div className="slab">Appearance<span className="n">applied instantly, saved on this machine</span></div>
        <div className="fgrid">
          <span className="lb">Theme</span>
          <select className="inp" value={appr.theme} onChange={(e) => change({ theme: e.target.value as Theme })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Match system</option>
          </select>
          <span className="lb">Density</span>
          <select className="inp" value={appr.density} onChange={(e) => change({ density: e.target.value as Density })}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
          <span className="lb">Accent</span>
          <div className="row">{ACCENT_SWATCHES.map((a) => (
            <button key={a.id} className="ico" title={a.name} aria-pressed={appr.accent === a.id} onClick={() => change({ accent: a.id })}
              style={{ background: a.color, borderColor: appr.accent === a.id ? "var(--text-primary)" : "transparent", width: 22, height: 22 }} />))}</div>
        </div>
      </div>
      <Adv n="not wired yet">
        <Soon>Automatic updates and crash reporting aren't configurable from here yet.</Soon>
      </Adv>
    </>
  );
}

function TerminalPage({ settings, patch, markDirty }: PageProps) {
  return (
    <>
      <div className="sec">
        <div className="slab">Terminal application</div>
        <div className="fgrid">
          <span className="lb">Program</span>
          <div className="row"><input className="inp mono gr" value={settings.terminal} placeholder="Terminal" onChange={(e) => { patch({ terminal: e.target.value }); markDirty("terminal"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Opened by “Open in terminal”.</span></div>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Embedded shell</div>
        <Soon>The embedded shell's program, font, scrollback and behaviour aren't configurable yet — it inherits your login shell.</Soon>
        <div className="soonwrap fgrid">
          <span className="lb">Program</span><input className="inp mono" disabled placeholder="/bin/zsh" />
          <span className="lb">Font</span><div className="row"><select className="inp gr" disabled><option>SF Mono</option></select><input className="inp mono" disabled defaultValue="12" style={{ width: 60 }} /></div>
          <span className="lb">Scrollback</span><input className="inp mono" disabled defaultValue="10000" style={{ width: 90 }} />
        </div>
      </div>
    </>
  );
}

function NotificationsPage() {
  return (
    <div className="sec">
      <div className="slab">Notify me when</div>
      <Soon>Notification preferences aren't stored yet. Canopy surfaces service crashes and blocked agents in the in-app attention queue regardless.</Soon>
      <div className="soonwrap">
        <TRow title="A service crashes" hint="The only notification on by default — it needs you." on disabled />
        <TRow title="An agent needs a decision" hint="An agent is blocked waiting on input." on disabled />
        <TRow title="Setup finishes" hint="Provisioning and setup tasks completed." on={false} disabled />
      </div>
    </div>
  );
}

/* Every binding the app actually listens for, grouped by where it applies.
   This table is a reference, so it is only worth having if it is exhaustive
   and true — an entry here without a listener behind it is worse than a gap.
   Sources: App.tsx (global + worktree), SettingsView (settings), Modal's
   usePrimaryAction (dialogs), Palette / SearchOverlay (lists), SidebarNav
   (selection chords) and Popover.tsx (the menu-bar window). */
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
function ShortcutsPage() {
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

function AdvancedPage({ flash }: PageProps) {
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

function SecurityPage() {
  return (
    <>
      <div className="sec">
        <div className="slab">Secrets in provisioned files</div>
        <Soon>Secret masking and export policies aren't stored yet. Provisioned key values are written to the worktree as configured.</Soon>
        <div className="soonwrap">
          <TRow title="Mask values that look like secrets" hint="Tokens and keys render as •••• in previews and logs." on disabled />
          <TRow title="Keep secrets out of exports" hint="Export the key names but not their values." on disabled />
        </div>
      </div>
      <div className="sec">
        <div className="slab">Git credentials</div>
        <div className="soonwrap fgrid">
          <span className="lb">SSH key</span><input className="inp mono" disabled placeholder="~/.ssh/id_ed25519" />
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════ search overlay ═════════════════════════════ */
function SearchOverlay({ onClose, onGo }: { onClose: () => void; onGo: (r: { page: PageId; label: string }) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const ql = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const hit = (s: { page: PageId; label: string; hint: string }) => (s.label + " " + s.hint + " " + pageOf(s.page).title).toLowerCase().includes(ql);
    return (ql ? INDEX.filter(hit) : INDEX.slice(0, 8)).slice(0, 40);
  }, [ql]);
  useEffect(() => setI(0), [ql]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(x + 1, rows.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
      if (e.key === "Enter" && rows[i]) { e.preventDefault(); onGo(rows[i]); }
    };
    document.addEventListener("keydown", k, true);
    return () => document.removeEventListener("keydown", k, true);
  }, [rows, i, onClose, onGo]);
  const hl = (text: string) => {
    if (!ql) return text;
    const idx = text.toLowerCase().indexOf(ql);
    if (idx < 0) return text;
    return <>{text.slice(0, idx)}<em>{text.slice(idx, idx + ql.length)}</em>{text.slice(idx + ql.length)}</>;
  };
  return (
    <div className="sr" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="srp">
        <div className="srf">
          <Search size={15} />
          <input autoFocus value={q} placeholder="Search all settings…" onChange={(e) => setQ(e.target.value)} />
          {q && <button className="ib" onClick={() => setQ("")}><X size={12} /></button>}
        </div>
        <div className="srl">
          {rows.length === 0 && <div className="srempty">No setting matches “{q}”.</div>}
          {!ql && rows.length > 0 && <div className="srg">Common settings</div>}
          {rows.map((r, n) => {
            const p = pageOf(r.page);
            const Ic = ICONS[p.ic] || Sliders;
            return (
              <button key={r.page + r.label} className={"sri" + (n === i ? " on" : "")} onMouseEnter={() => setI(n)} onClick={() => onGo(r)}>
                <span className="ic"><Ic size={13} /></span>
                <span className="st"><b>{hl(r.label)}</b><span>{hl(r.hint)}</span></span>
                <span className="where">{p.title}</span>
              </button>
            );
          })}
        </div>
        <div className="srfoot">
          <span><span className="kbd">↑↓</span>navigate</span>
          <span><span className="kbd">⏎</span>go to setting</span>
          <span><span className="kbd">esc</span>close</span>
          <span style={{ marginLeft: "auto" }}>{INDEX.length} settings</span>
        </div>
      </div>
    </div>
  );
}

function Preview({ cards, setup, extras, onClose }: { cards: FileCardT[]; setup: string[]; extras: { teardown: string[]; migrate: string[] }; onClose: () => void }) {
  const json = JSON.stringify(buildConfig(cards, setup, extras.teardown, extras.migrate), null, 2);
  const lines = json.split("\n");
  return (
    <div className="ppreview">
      <div className="pvhead">
        <button className="ib pvback" title="Back to the editor" onClick={onClose}><Rot deg={180}><ChevRight size={12} /></Rot></button>
        <b>Preview</b><span className="fn">.worktreemanager.json</span>
        <button className="ib" title="Close preview" onClick={onClose}><X size={12} /></button>
      </div>
      <div className="pvbody">
        {lines.map((ln, n) => (
          <div className="cl" key={n}><span className="ln">{n + 1}</span><span className="tx" dangerouslySetInnerHTML={{ __html: hlLine(ln) }} /></div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════ shell ══════════════════════════════════ */
export default function SettingsView({ onClose }: { onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const tree = useStore((s) => s.tree);
  const bumpSettings = useStore((s) => s.bumpSettings);
  const settingsRev = useStore((s) => s.settingsRev);
  const selKey = useStore((s) => s.selKey);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState<PageId>("general");
  const [repoId, setRepoId] = useState<string>("");
  const [repoMenu, setRepoMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [preview, setPreview] = useState(false);
  const [navQ, setNavQ] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<PageId>>(new Set());

  const [cardsByRepo, setCardsByRepo] = useState<Record<string, FileCardT[]>>({});
  const [setupByRepo, setSetupByRepo] = useState<Record<string, string[]>>({});
  const [extrasByRepo, setExtrasByRepo] = useState<Record<string, { teardown: string[]; migrate: string[] }>>({});
  const dirtyRepos = useRef<Set<string>>(new Set());
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [moreMenu, setMoreMenu] = useState(false);

  const flash = (m: string) => showToast(m);
  const markDirty = (id: PageId) => {
    setDirty((d) => new Set(d).add(id));
    if ((id === "files" || id === "setup") && repoId) dirtyRepos.current.add(repoId);
  };

  function load() {
    if (!hasBackend()) {
      setSettings({ ...MOCK, repos: MOCK.repos.map(migrateAgents) });
      setRepoId(MOCK.repos[0].id);
      setCardsByRepo({ [MOCK.repos[0].id]: toCards(MOCK_CARDS) });
      setSetupByRepo({ [MOCK.repos[0].id]: MOCK_SETUP });
      setDirty(new Set());
      dirtyRepos.current = new Set();
      return;
    }
    ipc.getSettings().then((s) => {
      setSettings({ ...s, repos: s.repos.map(migrateAgents) });
      if (s.repos[0]) setRepoId(s.repos[0].id);
      setDirty(new Set());
      dirtyRepos.current = new Set();
      s.repos.forEach((r) => {
        ipc.getRepoConfig(r.id).then((c) => {
          setCardsByRepo((m) => ({ ...m, [r.id]: toCards(c.provision) }));
          setSetupByRepo((m) => ({ ...m, [r.id]: c.setup }));
          setExtrasByRepo((m) => ({ ...m, [r.id]: { teardown: c.teardown || [], migrate: c.migrate || [] } }));
        }).catch(() => {});
      });
    }).catch((e) => showToast(`Failed to load settings: ${e}`));
  }
  useEffect(load, []);

  // Sync (and Save) bump settingsRev. When it changes while Settings is open,
  // re-read each repo's `.worktreemanager.json` from disk so Setup, Files and
  // Migrate reflect edits made outside the app — but never clobber a repo the
  // user is mid-edit on (still in dirtyRepos with unsaved changes).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (!hasBackend() || !settings) return;
    settings.repos.forEach((r) => {
      if (dirtyRepos.current.has(r.id)) return;
      ipc.getRepoConfig(r.id).then((c) => {
        setCardsByRepo((m) => ({ ...m, [r.id]: toCards(c.provision) }));
        setSetupByRepo((m) => ({ ...m, [r.id]: c.setup }));
        setExtrasByRepo((m) => ({ ...m, [r.id]: { teardown: c.teardown || [], migrate: c.migrate || [] } }));
      }).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRev]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "f") { e.preventDefault(); setSearch(true); }
      else if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty.size) save(); }
      // ⌘P previews the repo's config file — it has nothing to show from a
      // platform page, where the panel would render blank
      else if (meta && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (REPO_PAGE_IDS.has(page) && repoId) setPreview((v) => !v);
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, settings, repoId, page, cardsByRepo, setupByRepo]);

  useEffect(() => {
    if (!repoMenu) return;
    const d = (e: MouseEvent) => { if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) setRepoMenu(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setRepoMenu(false); };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", d); document.removeEventListener("keydown", k); };
  }, [repoMenu]);

  useEffect(() => {
    if (!moreMenu) return;
    const d = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreMenu(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreMenu(false); };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", d); document.removeEventListener("keydown", k); };
  }, [moreMenu]);

  if (!settings) return <div className="cxset-root" />;

  const repo = settings.repos.find((r) => r.id === repoId) || null;
  const repoIndex = settings.repos.findIndex((r) => r.id === repoId);
  const wtCount = (id: string) => tree.find((r) => r.repoId === id)?.worktrees.length ?? 0;
  const patch = (p: Partial<Settings>) => setSettings({ ...settings, ...p });
  const patchRepo = (p: Partial<RepoCfg>) => patch({ repos: settings.repos.map((r, ri) => (ri === repoIndex ? { ...r, ...p } : r)) });
  const cards = (repo && cardsByRepo[repo.id]) || [];
  const setup = (repo && setupByRepo[repo.id]) || [];
  const extras = (repo && extrasByRepo[repo.id]) || { teardown: [], migrate: [] };
  const setCards = (next: FileCardT[]) => { if (repo) setCardsByRepo((m) => ({ ...m, [repo.id]: next })); };
  const setSetup = (next: string[]) => { if (repo) setSetupByRepo((m) => ({ ...m, [repo.id]: next })); };
  const isRepoPage = REPO_PAGE_IDS.has(page);
  const p = pageOf(page);

  async function save() {
    if (!settings) return;
    const cleaned: Settings = {
      ...settings,
      repos: settings.repos.map((r) => {
        const agents = (r.agents || []).filter((a) => a.id.trim() && a.name.trim() && a.command.trim());
        return {
          ...r,
          services: r.services.filter((s) => s.id.trim() && s.command.trim()),
          customCommands: (r.customCommands || []).filter((c) => c.label.trim() && c.command.trim()),
          agents,
          agentCommand: agents[0]?.command ?? "",
        };
      }),
    };
    setSaving(true);
    try {
      if (hasBackend()) {
        await ipc.saveSettings(cleaned);
        const failures: string[] = [];
        await Promise.all(
          cleaned.repos.filter((r) => dirtyRepos.current.has(r.id)).map((r) =>
            ipc.saveRepoConfig(r.id, fromCards(cardsByRepo[r.id] || []), (setupByRepo[r.id] || []).filter((c) => c.trim()))
              .then(() => dirtyRepos.current.delete(r.id))
              .catch((e) => failures.push(`${r.name}: ${e}`)),
          ),
        );
        if (failures.length) { showToast(`Saved app settings, but repo config failed — ${failures.join(" · ")}`); setSaving(false); return; }
      }
      bumpSettings();
      const n = dirty.size;
      setDirty(new Set());
      showToast(n <= 1 ? "Settings saved" : `Saved ${n} sections`);
    } catch (e) {
      showToast(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function addRepo() {
    if (!hasBackend()) { showToast("Folder picker needs the desktop app"); return; }
    const dir = await openDialog({ directory: true, multiple: false, title: "Select a git repository" });
    if (typeof dir !== "string") return;
    try {
      const added = await ipc.addRepo(dir);
      const fresh = await ipc.getSettings();
      setSettings({ ...fresh, repos: fresh.repos.map(migrateAgents) });
      setRepoId(added.id);
      setPage("repo-general");
      showToast("Repository added — configure it below");
    } catch (e) { showToast(errText(e)); }
  }

  async function removeRepo() {
    if (!repo) return;
    if (!hasBackend()) { showToast("Removing a repository needs the desktop app"); return; }
    try {
      await ipc.removeRepo(repo.id);
      const fresh = await ipc.getSettings();
      setSettings({ ...fresh, repos: fresh.repos.map(migrateAgents) });
      setRepoId(fresh.repos[0]?.id ?? "");
      setPage("general");
      showToast(`Removed ${repo.name}`);
    } catch (e) { showToast(errText(e)); }
  }

  const goTo = (r: { page: PageId; label: string }) => {
    setPage(r.page); setSearch(false);
    setFlashId(r.page + "-" + r.label); setTimeout(() => setFlashId(null), 1200);
    showToast(`Jumped to ${r.label}`);
  };

  /* ── .worktreemanager.json import / export (mirrors the previous repo
        config editor: native save + backend write out, FileReader in) ── */
  const configJson = () => JSON.stringify(buildConfig(cards, setup, extras.teardown, extras.migrate), null, 2);
  const copyJson = () => {
    if (!repo) return;
    navigator.clipboard?.writeText(configJson()).then(() => showToast("Copied .worktreemanager.json"), () => showToast("Copy failed"));
  };
  const exportJson = async () => {
    if (!repo) return;
    if (!hasBackend()) { showToast("Export needs the desktop app"); return; }
    try {
      const path = await saveDialog({ title: "Export repo config", defaultPath: `${repo.path || ""}/.worktreemanager.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await ipc.saveTextFile(path, configJson() + "\n");
      showToast(`Exported ${path}`);
    } catch (e) { showToast(`Export failed: ${e}`); }
  };
  const importJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !repo) return;
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
        markDirty("files");
        if (Array.isArray(parsed.setup)) { setSetup(parsed.setup.filter((x: unknown) => typeof x === "string")); markDirty("setup"); }
        setPage("files");
        showToast(list.length ? `Imported ${list.length} file${list.length > 1 ? "s" : ""} — review, then Save` : "No provision entries found");
      } catch {
        showToast(`Couldn't parse ${f.name} — invalid JSON`);
      }
    };
    r.readAsText(f);
    e.target.value = "";
  };
  const triggerImport = () => { if (!hasBackend()) { showToast("Import needs the desktop app"); return; } fileRef.current?.click(); };
  // read the repo's OWN .worktreemanager.json by its known path — a file picker
  // can't reach it on macOS (dotfiles are hidden), but the backend reads it
  // directly, so this imports the hidden config without a picker
  const reloadFromRepo = async () => {
    if (!repo) return;
    if (!hasBackend()) { showToast("Reading the config file needs the desktop app"); return; }
    try {
      const c = await ipc.getRepoConfig(repo.id);
      setCards(toCards(c.provision)); markDirty("files");
      setSetup(c.setup); markDirty("setup");
      setExtrasByRepo((m) => ({ ...m, [repo.id]: { teardown: c.teardown || [], migrate: c.migrate || [] } }));
      setPage("files");
      showToast(`Loaded ${repo.name}'s .worktreemanager.json — review, then Save`);
    } catch (e) { showToast(`Couldn't read the config file: ${e}`); }
  };

  const pageProps: PageProps = { repo, patchRepo, settings, patch, markDirty, flash, cards, setCards, setup, setSetup, onRemoveRepo: removeRepo, onExportJson: exportJson, onImportJson: triggerImport, onCopyJson: copyJson, selKey };
  const body = () => {
    if (isRepoPage && !repo) {
      return (
        <div className="empty">
          <p>No repository selected. Add a git repository and Canopy will track every worktree in it.</p>
          <button className="btn sm" onClick={addRepo}><Plus size={10} />Add repository</button>
        </div>
      );
    }
    switch (page) {
      case "services": return <ServicesPage {...pageProps} />;
      case "agents": return <AgentsPage {...pageProps} />;
      case "commands": return <CommandsPage {...pageProps} />;
      case "files": return <FilesPage {...pageProps} />;
      case "setup": return <SetupPage {...pageProps} />;
      case "repo-general": return <RepoGeneralPage {...pageProps} />;
      case "terminal": return <TerminalPage {...pageProps} />;
      case "notifications": return <NotificationsPage />;
      case "shortcuts": return <ShortcutsPage />;
      case "advanced": return <AdvancedPage {...pageProps} />;
      case "security": return <SecurityPage />;
      default: return <GeneralPage {...pageProps} />;
    }
  };

  const navRow = (item: PageMeta) => {
    if (navQ && !(item.label + " " + item.desc).toLowerCase().includes(navQ.toLowerCase())) return null;
    const Ic = ICONS[item.ic] || Sliders;
    const isDirty = dirty.has(item.id);
    const count = item.id === "services" ? repo?.services.length
      : item.id === "agents" ? repo?.agents?.length
      : item.id === "commands" ? repo?.customCommands?.length
      : item.id === "files" ? cards.length
      : item.id === "setup" ? setup.length
      : undefined;
    return (
      <button key={item.id} className={"nrow" + (page === item.id ? " sel" : "")} onClick={() => setPage(item.id)}>
        <span className="ic"><Ic size={13} /></span>
        <span className="lb">{item.label}</span>
        {isDirty && <span className="dot" title="Unsaved changes" />}
        {count != null && !isDirty && <span className="ct">{count}</span>}
      </button>
    );
  };

  const dirtyNames = [...dirty].map((d) => pageOf(d).title);
  const noNavMatch = navQ && !ALLPAGES.some((x) => (x.label + " " + x.desc).toLowerCase().includes(navQ.toLowerCase()));

  return (
    <div className="cxset-root">
      <div className="tbar">
        <div className="ttl"><span className="ic"><Cog size={13} /></span>Settings</div>
        <span className="sp" />
        <button className="ib" onClick={() => setSearch(true)} title="Search all settings (⌘F)"><Search size={13} />Search<span className="k">⌘F</span></button>
        {/* The JSON preview belongs to a REPOSITORY's config, so it is offered
            on the repo pages that have one (below) — not from the title bar,
            where it sat over platform pages it has nothing to do with. */}
        <button className="ib" onClick={onClose} title="Close settings"><X size={14} /></button>
      </div>

      <div className="body">
        <div className="nav">
          <div className="navsearch">
            <Search size={12} />
            <input placeholder="Filter pages…" value={navQ} onChange={(e) => setNavQ(e.target.value)} />
            {navQ && <button className="ib" style={{ height: 18, minWidth: 18 }} onClick={() => setNavQ("")}><X size={11} /></button>}
          </div>
          <div className="navlist">
            <div className="navgrp">Canopy</div>
            {PLATFORM.map(navRow)}
            <div style={{ position: "relative" }} ref={repoMenuRef}>
              {repo && (
                <button className="repopick" onClick={() => setRepoMenu((m) => !m)} title="Switch repository">
                  <span className="ic"><Fork size={12} /></span>
                  <span className="rn">{repo.name}</span>
                  <span className="rc">{wtCount(repo.id)} wt</span>
                  <Chevron size={11} />
                </button>
              )}
              {repoMenu && (
                <div className="varmenu" style={{ left: 6, right: "auto", top: 30, width: 204 }}>
                  <div className="vh">Repository</div>
                  {settings.repos.map((r) => (
                    <button className="vitem" key={r.id} onClick={() => { setRepoId(r.id); setRepoMenu(false); }} style={{ color: r.id === repoId ? "var(--action-primary)" : "var(--text-primary)" }}>
                      <Fork size={11} />
                      <span style={{ color: "inherit", fontSize: "var(--fs-body)" }}>{r.name}</span>
                      <span>{wtCount(r.id)} wt</span>
                    </button>
                  ))}
                  {settings.repos.length === 0 && <button className="vitem" onClick={() => { setRepoMenu(false); addRepo(); }}><span>Add a repository…</span></button>}
                </div>
              )}
            </div>
            {repo && REPOPAGES.map(navRow)}
            {noNavMatch && <div className="srempty" style={{ padding: "16px 8px", fontSize: "var(--fs-small)" }}>No page matches.<br />Try ⌘F to search settings.</div>}
          </div>
        </div>

        <div className="page">
          <div className="phead">
            <div className="pt">
              <h2>{p.title}
                {isRepoPage && repo && <span className="sub">{repo.name}</span>}
                {dirty.has(page) && <span className="dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--action-primary)" }} title="Unsaved changes" />}
              </h2>
              <p>{p.blurb} {isRepoPage && <a role="button" tabIndex={0} onClick={() => flash("Documentation isn't wired yet")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flash("Documentation isn't wired yet"); } }}>Learn more</a>}</p>
            </div>
            <div className="pa">
              {isRepoPage && repo && (
                <button className={"btn sm" + (preview ? " pri" : "")} onClick={() => setPreview((v) => !v)}><Braces size={11} />{preview ? "Hide" : "Preview"} JSON<span className="k">⌘P</span></button>
              )}
              {/* .worktreemanager.json is a property of one repository. On the
                  platform pages there is no repo in scope, so the menu had
                  nothing true to act on — it is not offered there. */}
              {isRepoPage && repo && (
                <div style={{ position: "relative" }} ref={moreRef}>
                  <button className={"ib" + (moreMenu ? " on" : "")} title="More — the repo's .worktreemanager.json" onClick={() => setMoreMenu((m) => !m)} aria-haspopup="menu" aria-expanded={moreMenu}><More size={15} /></button>
                  {moreMenu && (
                    <div className="varmenu" style={{ top: 30, width: 244 }}>
                      <div className="vh">.worktreemanager.json</div>
                      <button className="vitem" onClick={() => { copyJson(); setMoreMenu(false); }}><Copy size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Copy JSON</span></button>
                      <button className="vitem" onClick={() => { exportJson(); setMoreMenu(false); }}><Download size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Export config…</span></button>
                      <button className="vitem" onClick={() => { reloadFromRepo(); setMoreMenu(false); }} title="Reads the repo's own .worktreemanager.json by path (it's hidden, so a file picker can't see it)"><Refresh size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Load from repo file</span></button>
                      <button className="vitem" onClick={() => { triggerImport(); setMoreMenu(false); }}><Pull size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Import from file…</span></button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="pbody">
            <div className={"pmain" + (flashId?.startsWith(page + "-") ? " flashrow" : "")}>{body()}</div>
            {preview && isRepoPage && repo && (
              <Preview cards={cards} setup={setup} extras={extras} onClose={() => setPreview(false)} />
            )}
          </div>
        </div>
      </div>

      {dirty.size > 0 ? (
        <div className="dirty">
          <span className="dd" />
          <span className="dt"><b>Unsaved changes</b> in <span className="sect">{dirtyNames.join(", ")}</span></span>
          <span style={{ flex: 1 }} />
          <button className="btn gh" disabled={saving} onClick={load}>Discard</button>
          <button className="btn pri" disabled={saving} onClick={save}>{saving ? <Spinner size={11} /> : <Check size={11} />}Save changes<span className="k">⌘S</span></button>
        </div>
      ) : (
        <div className="statusline">
          {/* name the file only where it IS the file being edited */}
          <span className="mono">{isRepoPage && repo ? ".worktreemanager.json" : "Canopy settings"}</span>
          <span className="sdiv" />
          <span>All changes saved</span>
          <span style={{ flex: 1 }} />
          {isRepoPage && repo && <span>{wtCount(repo.id)} worktrees · {cards.length} provisioned files · {repo.services.length} services</span>}
        </div>
      )}

      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={importJson} />
      {search && <SearchOverlay onClose={() => setSearch(false)} onGo={goTo} />}
    </div>
  );
}
