// Fixtures the Settings editors render against when there is no Tauri backend
// (browser preview / mock mode). Never used when hasBackend() is true.
import { type ProvisionEntry, type Settings } from "../../ipc";

export const MOCK: Settings = {
  version: 1, editor: { command: "code" }, terminal: "Terminal", showSwitchBranch: true,
  repos: [{
    id: "tooljet", name: "ToolJet", path: "~/ToolJetSpace/CE/ToolJet", worktreeDir: ".worktrees", resetDb: "", migrateDb: "",
    services: [
      { id: "fe", name: "Frontend", kind: "web", command: "pnpm --filter frontend dev", cwd: "frontend", basePort: 8232, env: { NODE_ENV: "development" }, health: "" },
      { id: "srv", name: "Server", kind: "server", command: "pnpm --filter server start:dev", cwd: "server", basePort: 3150, env: { LOG_LEVEL: "debug" }, health: "" },
    ],
    customCommands: [{ label: "Lint", command: "pnpm lint", group: "Checks" }, { label: "Unit tests", command: "pnpm test --run", group: "Checks" }],
    agentCommand: "claude",
    agents: [{ id: "a1", name: "Claude Code", command: "claude", promptOnLaunch: true }, { id: "a2", name: "Codex", command: "codex", promptOnLaunch: true }],
  }, {
    // a second repo, freshly added and not configured yet — it gives the repo
    // picker something to switch between, and it is what the per-repo scoping
    // of refused rows is tested against
    id: "canopy", name: "Canopy", path: "~/code/canopy", worktreeDir: ".worktrees", resetDb: "", migrateDb: "",
    services: [],
    customCommands: [],
    agentCommand: "claude",
    agents: [{ id: "c1", name: "Claude Code", command: "claude", promptOnLaunch: true }],
  }],
};
export const MOCK_CARDS: ProvisionEntry[] = [
  { path: ".env", format: "dotenv", from: ".env", interpolate: false, keys: [["PG_DB", "${INT_DB_NAME}"], ["PORT", "${WT_SERVICE_PORT}"]] },
  { path: "ee/.env", format: "dotenv", from: "ee/.env", interpolate: false, keys: [["LICENSE_KEY", ""]] },
];
export const MOCK_SETUP = ["pnpm install", "pnpm --filter server db:migrate", "pnpm build:plugins"];
