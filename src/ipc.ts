// Typed IPC surface — invoke wrappers + event payloads, mirroring src-tauri.
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { GitMeta, LogLine, RepoNode, SubmoduleStatus, SvcStatus } from "./types";

/** Window-scoped listen: registers with THIS window as the event target, so
 * the backend can `emit_filter` high-volume events (terminal:data,
 * service:log, service:stats) to only the windows that consume them. A
 * broadcast `emit` still reaches window-scoped listeners. */
const listen = <T,>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<T>(event, cb);

export interface ServiceCfg {
  id: string;
  name: string;
  kind: string;
  command: string;
  cwd: string;
  basePort: number | null;
  env: Record<string, string>;
}

export interface CustomCmd {
  label: string;
  command: string;
}

/** A coding-agent launcher available for one repository. The command is run
 * inside the selected worktree; when enabled, Canopy appends its structured
 * handoff as the command's first prompt argument. */
export interface AgentCfg {
  id: string;
  name: string;
  command: string;
  promptOnLaunch: boolean;
}

export interface RepoCfg {
  id: string;
  name: string;
  path: string;
  worktreeDir: string;
  resetDb: string;
  migrateDb: string;
  services: ServiceCfg[];
  customCommands: CustomCmd[];
  /** agent-lane CLI (empty = built-in default) */
  agentCommand: string;
  /** selectable coding-agent launchers; `agentCommand` remains as legacy data */
  agents: AgentCfg[];
}

export interface Settings {
  version: number;
  editor: { command: string };
  terminal: string;
  repos: RepoCfg[];
  showSwitchBranch: boolean;
  updates: { autoCheck: boolean };
  crashReports: { enabled: boolean };
}

/** Result of an update check. Canopy reports what exists; it never downloads
    or installs (release signing isn't set up — see updates.rs). */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  /** why the last check produced nothing — shown verbatim */
  error: string | null;
  checkedAt: number;
}

export type ProvisionFormat = "dotenv" | "json" | "yaml" | "text";

/** One file seeded + templated into every new worktree (Files-to-provision). */
export interface ProvisionEntry {
  path: string;
  format: ProvisionFormat;
  from: string;
  interpolate: boolean;
  /** ordered [key, value-template] pairs (ignored for `text`) */
  keys: [string, string][];
}

/** The repo's `.worktreemanager.json` as exchanged with Settings. `teardown` /
 * `migrate` are read-only there today — returned so preview/export match disk. */
export interface RepoConfigFile {
  provision: ProvisionEntry[];
  setup: string[];
  teardown: string[];
  migrate: string[];
}

export interface Branches {
  local: string[];
  remote: string[];
  tags: string[];
}

export interface RepoDetection {
  top: string;
  name: string;
  branch: string;
  origin: string;
  stack: string;
  scripts: { name: string; command: string }[];
}

export const ipc = {
  getTree: () => invoke<RepoNode[]>("get_tree"),
  refresh: (wtKey?: string) => invoke<void>("refresh", { wtKey: wtKey ?? null }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (newSettings: Settings) => invoke<void>("save_settings", { newSettings }),
  addRepo: (path: string) => invoke<RepoCfg>("add_repo", { path }),
  detectRepo: (path: string) => invoke<RepoDetection>("detect_repo", { path }),
  removeRepo: (repoId: string) => invoke<void>("remove_repo", { repoId }),
  gitPull: (wtKey: string) => invoke<string>("git_pull", { wtKey }),
  submoduleStatus: (wtKey: string) => invoke<SubmoduleStatus[]>("submodule_status", { wtKey }),
  pullSubmodule: (wtKey: string, path: string) => invoke<string>("pull_submodule", { wtKey, path }),
  switchSubmoduleBranch: (wtKey: string, path: string, branch: string) =>
    invoke<void>("switch_submodule_branch", { wtKey, path, branch }),
  listSubmoduleBranches: (wtKey: string, path: string) => invoke<Branches>("list_submodule_branches", { wtKey, path }),
  fetchSubmodules: (wtKey: string) => invoke<number>("fetch_submodules", { wtKey }),
  switchWorktreeBranch: (wtKey: string, branch: string, create: boolean, base?: string) =>
    invoke<void>("switch_worktree_branch", { wtKey, branch, create, base: base ?? null }),
  listBranches: (repoId: string) => invoke<Branches>("list_branches", { repoId }),
  fetchBranches: (repoId: string) => invoke<Branches>("fetch_branches", { repoId }),
  getRepoConfig: (repoId: string) => invoke<RepoConfigFile>("get_repo_config", { repoId }),
  saveRepoConfig: (repoId: string, provision: ProvisionEntry[], setup: string[]) =>
    invoke<void>("save_repo_config", { repoId, provision, setup }),
  saveTextFile: (path: string, contents: string) => invoke<void>("save_text_file", { path, contents }),

  getLogs: (svcKey: string) => invoke<LogLine[]>("get_logs", { svcKey }),

  // embedded terminals (agent lane). `id` is opaque (e.g. `${wtKey}::shell`);
  // `data` on read events is base64 of the raw PTY bytes.
  terminalOpen: (id: string, cwd: string, cols: number, rows: number, command?: string) =>
    invoke<void>("terminal_open", { id, cwd, cols, rows, command: command ?? null }),
  terminalWrite: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
  terminalGetBuffer: (id: string) => invoke<TerminalSnapshot | null>("terminal_get_buffer", { id }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  /** write .canopy/context.md (creates the dir + a self-ignoring .gitignore, never clobbering it) */
  writeWorktreeContext: (wtPath: string, contents: string) =>
    invoke<void>("write_worktree_context", { wtPath, contents }),
  resolveAgentCommand: (wtKey: string) => invoke<string>("resolve_agent_command", { wtKey }),

  serviceStart: (svcKey: string) => invoke<void>("service_start", { svcKey }),
  serviceStop: (svcKey: string) => invoke<void>("service_stop", { svcKey }),
  serviceRestart: (svcKey: string) => invoke<void>("service_restart", { svcKey }),
  worktreeStartAll: (wtKey: string) => invoke<void>("worktree_start_all", { wtKey }),
  worktreeStopAll: (wtKey: string) => invoke<void>("worktree_stop_all", { wtKey }),
  resetDb: (wtKey: string) => invoke<void>("reset_db", { wtKey }),

  openInEditor: (wtKey: string) => invoke<void>("open_in_editor", { wtKey }),
  openFileInEditor: (wtKey: string, path: string) => invoke<void>("open_file_in_editor", { wtKey, path }),
  revealInFinder: (wtKey: string) => invoke<void>("reveal_in_finder", { wtKey }),
  openTerminal: (wtKey: string) => invoke<void>("open_terminal", { wtKey }),
  openPort: (port: number) => invoke<void>("open_port", { port }),
  showMainWindow: () => invoke<void>("show_main_window"),
  quitApp: () => invoke<void>("quit_app"),

  listDatabases: (wtKey: string) => invoke<string[]>("list_databases", { wtKey }),
  currentDatabase: (wtKey: string) => invoke<string | null>("current_database", { wtKey }),
  snapshotDatabase: (wtKey: string, name: string) => invoke<void>("snapshot_database", { wtKey, name }),
  exportDatabase: (wtKey: string, filePath: string) => invoke<void>("export_database", { wtKey, filePath }),
  restoreDatabase: (wtKey: string, filePath: string) => invoke<void>("restore_database", { wtKey, filePath }),
  switchDatabase: (wtKey: string, dbName: string) => invoke<void>("switch_database", { wtKey, dbName }),
  setServicePort: (svcKey: string, port: number) => invoke<void>("set_service_port", { svcKey, port }),
  runMigration: (wtKey: string) => invoke<void>("run_migration", { wtKey }),
  runCustomCommand: (wtKey: string, command: string) => invoke<void>("run_custom_command", { wtKey, command }),

  createWorktree: (args: { repoId: string; branch: string; base?: string; createBranch: boolean }) =>
    invoke<string>("create_worktree", { ...args, base: args.base ?? null }),
  runWorktreeSetup: (wtKey: string) => invoke<void>("run_worktree_setup", { wtKey }),
  worktreeDirtyReport: (wtKey: string) => invoke<{ dirty: boolean; details: string[]; total: number }>("worktree_dirty_report", { wtKey }),
  removeWorktree: (wtKey: string, deleteBranch: boolean, dropDb: boolean) =>
    invoke<void>("remove_worktree", { wtKey, deleteBranch, dropDb }),

  checkForUpdate: () => invoke<UpdateStatus>("check_for_update"),
  crashReportCount: () => invoke<number>("crash_report_count"),
  openCrashReports: () => invoke<void>("open_crash_reports"),
};

export interface GitEvent extends GitMeta {
  wtKey: string;
}
export interface StatusEvent {
  svcKey: string;
  status: SvcStatus;
  startedAt?: number;
  exitCode?: number;
}
export interface LogEvent {
  svcKey: string;
  lines: LogLine[];
}
export interface StatsEvent {
  entries: { svcKey: string; cpu: number; memMb: number; uptimeSec: number }[];
}
export interface ResetEvent {
  wtKey: string;
  state: "started" | "done" | "error";
  message?: string;
}
export interface OpEvent {
  wtKey: string;
  op: string;
  state: "progress" | "done" | "error";
  detail: string;
}
export interface TerminalDataEvent {
  id: string;
  /** base64 of raw PTY bytes */
  data: string;
  /** cumulative byte cursor after this chunk */
  seq: number;
}
export interface TerminalExitEvent {
  id: string;
}
/** Scrollback snapshot + the cursor it ends at (race-free rehydrate). */
export interface TerminalSnapshot {
  buffer: string;
  seq: number;
}

export const on = {
  treeChanged: (cb: (tree: RepoNode[]) => void): Promise<UnlistenFn> =>
    listen<RepoNode[]>("tree:changed", (e) => cb(e.payload)),
  worktreeGit: (cb: (e: GitEvent) => void): Promise<UnlistenFn> =>
    listen<GitEvent>("worktree:git", (e) => cb(e.payload)),
  serviceStatus: (cb: (e: StatusEvent) => void): Promise<UnlistenFn> =>
    listen<StatusEvent>("service:status", (e) => cb(e.payload)),
  serviceLog: (cb: (e: LogEvent) => void): Promise<UnlistenFn> =>
    listen<LogEvent>("service:log", (e) => cb(e.payload)),
  serviceStats: (cb: (e: StatsEvent) => void): Promise<UnlistenFn> =>
    listen<StatsEvent>("service:stats", (e) => cb(e.payload)),
  resetStatus: (cb: (e: ResetEvent) => void): Promise<UnlistenFn> =>
    listen<ResetEvent>("reset:status", (e) => cb(e.payload)),
  worktreeOp: (cb: (e: OpEvent) => void): Promise<UnlistenFn> =>
    listen<OpEvent>("worktree:op", (e) => cb(e.payload)),
  terminalData: (cb: (e: TerminalDataEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalDataEvent>("terminal:data", (e) => cb(e.payload)),
  terminalExit: (cb: (e: TerminalExitEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalExitEvent>("terminal:exit", (e) => cb(e.payload)),
};

/** Structured backend error — every command rejects with `{ code, message }`. */
export interface BackendError {
  code:
    | "git"
    | "db"
    | "setup"
    | "process"
    | "terminal"
    | "config"
    | "not_found"
    | "invalid_input"
    | "conflict"
    | "internal";
  message: string;
}

/** Human-readable message from any rejection (structured backend error, plain
 * string from a plugin, or an Error). Use instead of `String(e)`. */
export function errText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
  }
  return String(e);
}

/** The backend error code, when the rejection carries one. */
export function errCode(e: unknown): BackendError["code"] | null {
  if (e && typeof e === "object" && typeof (e as Record<string, unknown>).code === "string") {
    return (e as BackendError).code;
  }
  return null;
}

/** True when running inside the Tauri webview (false in a plain browser tab). */
export const hasBackend = () => "__TAURI_INTERNALS__" in window;
