// Characterization tests for the pure helpers that back the Settings editors.
//
// These pin the behaviour that exists TODAY, before SettingsView.tsx is split
// into per-page files. Every assertion here was read off the pre-split
// implementation; if the split changes one of them, the split is wrong.
import { describe, expect, it } from "vitest";
import type { ProvisionEntry, RepoCfg } from "../../ipc";
import {
  buildConfig,
  cleanRepo,
  envToStr,
  fromCards,
  hlLine,
  migrateAgents,
  strToEnv,
  toCards,
  type FileCardT,
} from "./provision";

const card = (over: Partial<FileCardT> = {}): FileCardT => ({
  id: "f-1", path: ".env", format: "dotenv", from: "", interpolate: false, keys: [], ...over,
});

describe("toCards / fromCards", () => {
  it("round-trips a dotenv entry's path, format, from and keys", () => {
    const entries: ProvisionEntry[] = [
      { path: ".env", format: "dotenv", from: ".env.example", interpolate: false, keys: [["PG_DB", "${INT_DB_NAME}"]] },
    ];
    const out = fromCards(toCards(entries));
    expect(out).toEqual([
      { path: ".env", format: "dotenv", from: ".env.example", interpolate: false, keys: [["PG_DB", "${INT_DB_NAME}"]] },
    ]);
  });

  it("gives every card and key a distinct id so React keys stay stable", () => {
    const cards = toCards([
      { path: "a", format: "dotenv", from: "", interpolate: false, keys: [["K", "1"], ["J", "2"]] },
      { path: "b", format: "dotenv", from: "", interpolate: false, keys: [["K", "1"]] },
    ]);
    const ids = [...cards.map((c) => c.id), ...cards.flatMap((c) => c.keys.map((k) => k.id))];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tolerates an entry with no keys array", () => {
    const cards = toCards([{ path: "x", format: "text" } as unknown as ProvisionEntry]);
    expect(cards[0].keys).toEqual([]);
    expect(cards[0].from).toBe("");
  });

  it("drops cards with a blank path", () => {
    expect(fromCards([card({ path: "   " })])).toEqual([]);
  });

  it("trims path and from", () => {
    expect(fromCards([card({ path: "  .env  ", from: "  src.env  " })])).toEqual([
      { path: ".env", format: "dotenv", from: "src.env", interpolate: false, keys: [] },
    ]);
  });

  it("drops keys whose name is blank", () => {
    const out = fromCards([card({ keys: [{ id: "k1", k: "A", v: "1" }, { id: "k2", k: "   ", v: "2" }] })]);
    expect(out[0].keys).toEqual([["A", "1"]]);
  });

  it("a text card carries interpolate and never carries keys", () => {
    const out = fromCards([card({ format: "text", interpolate: true, keys: [{ id: "k1", k: "A", v: "1" }] })]);
    expect(out[0]).toMatchObject({ format: "text", interpolate: true, keys: [] });
  });

  it("a non-text card never carries interpolate", () => {
    const out = fromCards([card({ format: "json", interpolate: true })]);
    expect(out[0].interpolate).toBe(false);
  });
});

describe("buildConfig", () => {
  it("stamps the schema url and filters blank setup lines", () => {
    const cfg = buildConfig([], ["npm ci", "   ", "npm run build"], [], []);
    expect(cfg.$schema).toBe("canopy://worktree-manager/v1");
    expect(cfg.setup).toEqual(["npm ci", "npm run build"]);
  });

  it("omits teardown and migrate when they are empty", () => {
    const cfg = buildConfig([], [], [], []);
    expect(cfg).not.toHaveProperty("teardown");
    expect(cfg).not.toHaveProperty("migrate");
  });

  it("includes teardown and migrate when present", () => {
    const cfg = buildConfig([], [], ["npm run db:drop"], ["npm run db:migrate"]);
    expect(cfg.teardown).toEqual(["npm run db:drop"]);
    expect(cfg.migrate).toEqual(["npm run db:migrate"]);
  });

  it("writes mode:upsert and a keys object for a dotenv entry", () => {
    const cfg = buildConfig([card({ keys: [{ id: "k", k: "PORT", v: "3000" }] })], [], [], []);
    expect((cfg.provision as unknown[])[0]).toEqual({
      path: ".env", format: "dotenv", mode: "upsert", keys: { PORT: "3000" },
    });
  });

  it("writes interpolate instead of keys for a text entry, and omits a blank from", () => {
    const cfg = buildConfig([card({ path: "cfg.toml", format: "text", interpolate: true })], [], [], []);
    expect((cfg.provision as unknown[])[0]).toEqual({ path: "cfg.toml", format: "text", interpolate: true });
  });
});

describe("envToStr / strToEnv", () => {
  it("round-trips KEY=VALUE pairs", () => {
    expect(strToEnv(envToStr({ A: "1", B: "two" }))).toEqual({ A: "1", B: "two" });
  });

  it("treats a bare line as a key with an empty value", () => {
    expect(strToEnv("LONE")).toEqual({ LONE: "" });
  });

  it("keeps '=' inside the value", () => {
    expect(strToEnv("URL=postgres://x?a=b")).toEqual({ URL: "postgres://x?a=b" });
  });

  it("ignores blank lines, and trims the whole line before splitting on '='", () => {
    expect(strToEnv("  A=1  \n\n\n  B=2 ")).toEqual({ A: "1", B: "2" });
  });

  it("renders an undefined env as an empty string", () => {
    expect(envToStr(undefined as unknown as Record<string, string>)).toBe("");
  });
});

describe("migrateAgents", () => {
  const base = { id: "r", name: "R", path: "/r", worktreeDir: ".worktrees", resetDb: "", migrateDb: "", services: [], customCommands: [] };

  it("promotes a legacy agentCommand into a single agent row", () => {
    const out = migrateAgents({ ...base, agentCommand: "claude", agents: [] } as unknown as RepoCfg);
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0]).toMatchObject({ name: "Agent", command: "claude", promptOnLaunch: true });
  });

  it("leaves an existing agent list alone", () => {
    const agents = [{ id: "a", name: "Claude", command: "claude", promptOnLaunch: false }];
    const out = migrateAgents({ ...base, agentCommand: "codex", agents } as unknown as RepoCfg);
    expect(out.agents).toEqual(agents);
  });

  it("normalises a missing agents array to empty", () => {
    const out = migrateAgents({ ...base, agentCommand: "  " } as unknown as RepoCfg);
    expect(out.agents).toEqual([]);
  });
});

describe("hlLine", () => {
  it("escapes markup before wrapping tokens", () => {
    expect(hlLine('"k": "<script>"')).not.toContain("<script>");
    expect(hlLine('"k": "<script>"')).toContain("&lt;script&gt;");
  });

  it("wraps keys, string values and numbers in their own spans", () => {
    const out = hlLine('"port": 3000');
    expect(out).toContain('<span class="jk">"port"</span>');
    expect(out).toContain('<span class="jn">3000</span>');
    expect(hlLine('"name": "canopy"')).toContain('<span class="jv">"canopy"</span>');
  });
});

describe("cleanRepo", () => {
  const repo = (over: Partial<RepoCfg>): RepoCfg => ({
    id: "r", name: "R", path: "/r", worktreeDir: ".worktrees", resetDb: "", migrateDb: "",
    services: [], customCommands: [], agentCommand: "", agents: [], ...over,
  } as RepoCfg);

  it("drops services missing an id or a command", () => {
    const { repo: out } = cleanRepo(repo({ services: [
      { id: "ok", name: "Web", kind: "web", command: "npm start", cwd: "", basePort: null, env: {} },
      { id: "", name: "Half", kind: "web", command: "npm start", cwd: "", basePort: null, env: {} },
      { id: "nocmd", name: "Half", kind: "web", command: "  ", cwd: "", basePort: null, env: {} },
    ] }));
    expect(out.services.map((s) => s.id)).toEqual(["ok"]);
  });

  it("drops custom commands missing a label or a command", () => {
    const { repo: out } = cleanRepo(repo({ customCommands: [
      { label: "Lint", command: "npm run lint", group: "" },
      { label: "", command: "npm test", group: "" },
    ] }));
    expect(out.customCommands.map((c) => c.label)).toEqual(["Lint"]);
  });

  it("drops agents missing an id, name or command", () => {
    const { repo: out } = cleanRepo(repo({ agents: [
      { id: "a1", name: "Claude", command: "claude", promptOnLaunch: true },
      { id: "a2", name: "Nameless", command: "", promptOnLaunch: true },
    ] }));
    expect(out.agents.map((a) => a.id)).toEqual(["a1"]);
  });

  it("mirrors the surviving first agent's command into the legacy agentCommand", () => {
    const { repo: out } = cleanRepo(repo({
      agentCommand: "stale",
      agents: [{ id: "a1", name: "Claude", command: "claude", promptOnLaunch: true }],
    }));
    expect(out.agentCommand).toBe("claude");
  });

  it("empties agentCommand when no agent survives", () => {
    const { repo: out } = cleanRepo(repo({ agentCommand: "stale", agents: [] }));
    expect(out.agentCommand).toBe("");
  });

  it("reports what it dropped, so the caller can tell the user (#43)", () => {
    const { dropped } = cleanRepo(repo({
      services: [{ id: "", name: "Half", kind: "web", command: "x", cwd: "", basePort: null, env: {} }],
      customCommands: [{ label: "", command: "npm test", group: "" }],
      agents: [{ id: "a", name: "Named", command: "", promptOnLaunch: true }],
    }));
    expect(dropped).toEqual({ services: 1, customCommands: 1, agents: 1 });
  });

  it("reports nothing dropped when every row is complete", () => {
    const { dropped } = cleanRepo(repo({
      services: [{ id: "web", name: "Web", kind: "web", command: "npm start", cwd: "", basePort: null, env: {} }],
    }));
    expect(dropped).toEqual({ services: 0, customCommands: 0, agents: 0 });
  });
});
