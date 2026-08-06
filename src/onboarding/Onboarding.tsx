// First-run onboarding wizard — 5 steps (Repository → Stack → Services →
// Commands → Review) + a success overlay. Ported from the v0.4 design handoff
// (Worktree Manager Onboarding.html) and wired to real IPC: detect_repo reads
// the repo's package.json scripts + git, and on finish we add_repo → save the
// service/command config to Settings + the repo's .worktreemanager.json.
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "../styles/onboarding.css";
import { errText, hasBackend, ipc, type ProvisionEntry, type RepoDetection, type ServiceCfg } from "../ipc";
import { useStore } from "../store";
import { Check, Cog, Fork, Globe, Package, Server, Spinner } from "../icons";

/* ── inline icons the shared set doesn't have ─────────────────────── */
const Folder = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
  </svg>
);
const ArrowRight = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
  </svg>
);
const ArrowLeft = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5" /><path d="M11 18l-6-6 6-6" />
  </svg>
);

const STEPS = [
  { t: "Repository", s: "Locate the repo" },
  { t: "Stack", s: "Detect the framework" },
  { t: "Services", s: "From package.json" },
  { t: "Commands", s: "DB, env & setup" },
  { t: "Review", s: "Confirm & add" },
];

const STACKS = [
  { id: "node", mono: "JS", name: "Node.js", desc: "package.json" },
  { id: "next", mono: "N", name: "Next.js", desc: "next.config" },
  { id: "nest", mono: "Ne", name: "NestJS", desc: "nest-cli.json" },
  { id: "rails", mono: "Rb", name: "Rails", desc: "Gemfile" },
  { id: "django", mono: "Dj", name: "Django", desc: "manage.py" },
  { id: "go", mono: "Go", name: "Go", desc: "go.mod" },
  { id: "rust", mono: "Rs", name: "Rust", desc: "Cargo.toml" },
  { id: "other", mono: "…", name: "Other", desc: "configure manually" },
];

type Kind = "web" | "server" | "worker";
interface WizSvc {
  id: string;
  on: boolean;
  name: string;
  kind: Kind;
  script?: string;
  cmd: string;
  port: string;
}
interface Cfg {
  resetDb: string;
  migrate: string;
  worktreeDir: string;
  env: { id: string; on: boolean; key: string; value: string }[];
  setup: { id: string; on: boolean; cmd: string }[];
}

let _uid = 0;
const uid = (p: string) => p + ++_uid;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const KIND_IC: Record<Kind, typeof Server> = { web: Globe, server: Server, worker: Cog };

/** Map detected package.json scripts + stack into service/command suggestions. */
function derive(det: RepoDetection): { services: WizSvc[]; cfg: Cfg } {
  const scripts = det.scripts ?? [];
  const find = (re: RegExp) => scripts.find((s) => re.test(s.name));

  // long-running candidates → services
  const services: WizSvc[] = [];
  let portBase = 3000;
  for (const { name, command } of scripts) {
    const n = name.toLowerCase();
    const isSvc = /^(start|dev|serve|develop|web|server|api|client|frontend|backend)(:dev|:watch)?$/.test(n) || /:dev$/.test(n);
    if (!isSvc) continue;
    const web = /front|web|client|ui|vite|next|--port|webpack (serve|dev)/.test(n + " " + command);
    services.push({
      id: uid("s"),
      on: services.filter((x) => x.on).length < 2,
      name: cap(name.replace(/[:_-]/g, " ")),
      kind: web ? "web" : "server",
      script: name,
      cmd: command,
      port: String((portBase += services.length ? 10 : 0)),
    });
  }
  if (!services.length) {
    services.push({ id: uid("s"), on: true, name: "Dev", kind: "server", cmd: "npm run dev", port: "3000" });
  }
  // a build/compile script → an optional worker
  const build = find(/^(build|compile|plugins?:build)$/i);
  if (build) {
    services.push({ id: uid("s"), on: false, name: cap(build.name.replace(/[:_-]/g, " ")), kind: "worker", script: build.name, cmd: build.command, port: "" });
  }

  const reset = find(/^(db:reset|reset:db|resetdb)$/i);
  const migrate = find(/^(db:migrate|migrate|migration:run)$/i);
  const create = find(/^(db:create|createdb)$/i);

  const setup: Cfg["setup"] = [{ id: uid("u"), on: true, cmd: "npm install" }];
  if (create && migrate) setup.push({ id: uid("u"), on: true, cmd: `npm run ${create.name} && npm run ${migrate.name}` });
  else if (create) setup.push({ id: uid("u"), on: true, cmd: `npm run ${create.name}` });
  else if (migrate) setup.push({ id: uid("u"), on: true, cmd: `npm run ${migrate.name}` });

  const cfg: Cfg = {
    resetDb: reset ? `npm run ${reset.name}` : "",
    migrate: migrate ? `npm run ${migrate.name}` : "",
    worktreeDir: det.top ? `${det.top}-worktrees` : "",
    env: [
      { id: uid("e"), on: true, key: "PORT", value: "${WT_SERVER_PORT}" },
      { id: uid("e"), on: true, key: "PG_DB", value: "${WT_DB_NAME}" },
    ],
    setup,
  };
  return { services, cfg };
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={"sw" + (on ? " on" : "")} onClick={onClick} aria-pressed={on} />;
}

export default function Onboarding({ onClose, onCreateWorktree }: { onClose: () => void; onCreateWorktree: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const select = useStore((s) => s.select);
  const [step, setStep] = useState(0);
  const [path, setPath] = useState("");
  const [det, setDet] = useState<RepoDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detErr, setDetErr] = useState<string | null>(null);
  const [stack, setStack] = useState("node");
  const [services, setServices] = useState<WizSvc[]>([]);
  const [cfg, setCfg] = useState<Cfg>({ resetDb: "", migrate: "", worktreeDir: "", env: [], setup: [] });
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [step]);

  // brief "scanning" animation the first time we reach the Services step
  useEffect(() => {
    if (step === 2 && !scanned) {
      setScanning(true);
      const id = setTimeout(() => {
        setScanning(false);
        setScanned(true);
      }, 900);
      return () => clearTimeout(id);
    }
  }, [step, scanned]);

  async function runDetect(p: string) {
    const trimmed = p.trim();
    if (!trimmed || !hasBackend()) {
      if (!hasBackend()) setDetErr("Detection needs the desktop app");
      return;
    }
    setDetecting(true);
    setDetErr(null);
    try {
      const d = await ipc.detectRepo(trimmed);
      setDet(d);
      setStack(d.stack || "other");
      const { services: sv, cfg: cf } = derive(d);
      setServices(sv);
      setCfg(cf);
      setScanned(false);
    } catch (e) {
      setDet(null);
      setDetErr(errText(e));
    } finally {
      setDetecting(false);
    }
  }

  async function browse() {
    if (!hasBackend()) return showToast("Browse needs the desktop app");
    const picked = await openDialog({ directory: true, multiple: false, title: "Choose a git repository" });
    if (typeof picked === "string") {
      setPath(picked);
      runDetect(picked);
    }
  }

  async function finish() {
    if (!det || busy) return;
    if (!hasBackend()) {
      setDone(true);
      return;
    }
    setBusy(true);
    try {
      // register the repo (idempotent — ignore "already registered")
      await ipc.addRepo(det.top).catch((e) => {
        if (!errText(e).toLowerCase().includes("already")) throw e;
      });
      const settings = await ipc.getSettings();
      const repo = settings.repos.find((r) => r.path === det.top);
      if (!repo) throw new Error("repo not found after add");

      const svcCfgs: ServiceCfg[] = services
        .filter((s) => s.on)
        .map((s) => ({
          id: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "service",
          name: s.name,
          kind: s.kind,
          command: s.cmd,
          cwd: "",
          basePort: s.port.trim() ? parseInt(s.port, 10) || null : null,
          env: {},
        }));

      repo.services = svcCfgs;
      repo.resetDb = cfg.resetDb;
      repo.migrateDb = cfg.migrate;
      if (cfg.worktreeDir.trim()) repo.worktreeDir = cfg.worktreeDir.trim();
      await ipc.saveSettings(settings);

      // repo provisioning file (.worktreemanager.json): the root .env overrides
      // become a single dotenv "provision" entry; plus the setup commands.
      const envPairs = cfg.env.filter((e) => e.on && e.key.trim()).map((e) => [e.key, e.value] as [string, string]);
      const setupCmds = cfg.setup.filter((u) => u.on && u.cmd.trim()).map((u) => u.cmd);
      const provision: ProvisionEntry[] = envPairs.length
        ? [{ path: ".env", format: "dotenv", from: "", interpolate: false, keys: envPairs }]
        : [];
      await ipc.saveRepoConfig(repo.id, provision, setupCmds);

      setDone(true);
    } catch (e) {
      showToast(`Couldn't add repo — ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const canNext = step === 0 ? !!det : true;
  const next = () => (step < 4 ? setStep(step + 1) : finish());
  const back = () => setStep(Math.max(0, step - 1));

  const hitNames = new Set<string>();
  services.forEach((s) => s.script && hitNames.add(s.script));
  [cfg.resetDb, cfg.migrate].forEach((c) => {
    const m = c.match(/npm run (\S+)/);
    if (m) hitNames.add(m[1]);
  });

  return (
    <div className="ob-root">
      <div className="ob-tb" data-tauri-drag-region>
        <div className="ob-tb-title" data-tauri-drag-region>
          <span className="fork">
            <Fork size={15} />
          </span>
          Canopy — Add repository
        </div>
        <span className="sp" data-tauri-drag-region />
        <button className="ob-skip" onClick={onClose}>
          Skip setup
        </button>
      </div>

      <div className="ob-body">
        {/* stepper rail */}
        <div className="rail">
          <div className="rail-brand">
            <span className="fork-badge">
              <Fork size={18} />
            </span>
            <div>
              <h2>Welcome to Canopy</h2>
              <p>Let's add your first repo</p>
            </div>
          </div>
          <div className="steps">
            {STEPS.map((s, i) => (
              <div key={s.t} className={"step-item" + (i === step ? " active" : i < step ? " done" : "")}>
                <span className="step-num">{i < step ? <Check size={13} /> : i + 1}</span>
                <span className="step-lbl">
                  <span className="t">{s.t}</span>
                  <span className="s">{s.s}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="rail-foot">Worktrees let each branch run its own services on its own ports — no more stashing to switch tasks.</div>
        </div>

        {/* main */}
        <div className="ob-main">
          <div className="ob-scroll" ref={scrollRef}>
            <div className="ob-content">
              {step === 0 && (
                <div>
                  <div className="step-head">
                    <p className="kicker">Step 1 of 5</p>
                    <h1>Point Canopy at a repository</h1>
                    <p>Choose the git repo you want to manage worktrees for. Canopy verifies it and reads its remotes and scripts.</p>
                  </div>
                  <div className="field-col">
                    <label className="fld-label">
                      <Folder size={13} />
                      Repository path
                    </label>
                    <div className="input-row">
                      <input
                        className="input mono"
                        value={path}
                        placeholder="/Users/you/code/my-app"
                        spellCheck={false}
                        onChange={(e) => {
                          setPath(e.target.value);
                          setDet(null);
                        }}
                        onBlur={(e) => e.target.value.trim() && runDetect(e.target.value)}
                      />
                      <button className="btn ghost" onClick={browse}>
                        <Folder size={14} />
                        Browse
                      </button>
                    </div>
                  </div>

                  {detecting && (
                    <div className="scan">
                      <span className="sp">
                        <Spinner size={18} />
                      </span>
                      Verifying repository…
                    </div>
                  )}
                  {detErr && !detecting && (
                    <div className="scan" style={{ color: "var(--stop)" }}>
                      {detErr}
                    </div>
                  )}
                  {det && !detecting && (
                    <div className="detect-card" key={det.top}>
                      <span className="fork-badge">
                        <Fork size={18} />
                      </span>
                      <div className="info">
                        <h3>{det.name}</h3>
                        <div className="meta">
                          {det.branch && (
                            <span>
                              <span className="k">branch</span> {det.branch}
                            </span>
                          )}
                          {det.origin && (
                            <span>
                              <span className="k">origin</span> {det.origin}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="git-chip">
                        <Check size={13} />
                        Git repository
                      </span>
                    </div>
                  )}
                </div>
              )}

              {step === 1 && (
                <div>
                  <div className="step-head">
                    <p className="kicker">Step 2 of 5</p>
                    <h1>What's the stack?</h1>
                    <p>Canopy inspected the repo's manifests. Confirm the detected stack or pick another — it decides where we look for services and scripts.</p>
                  </div>
                  <div className="stack-grid">
                    {STACKS.map((s) => (
                      <button key={s.id} className={"stack-card" + (stack === s.id ? " sel" : "")} onClick={() => setStack(s.id)}>
                        {det?.stack === s.id && stack !== s.id && <span className="stack-badge">Detected</span>}
                        {stack === s.id && (
                          <span className="stack-check">
                            <Check size={18} />
                          </span>
                        )}
                        <span className="stack-mono">{s.mono}</span>
                        <div>
                          <h3>{s.name}</h3>
                          <p>{s.desc}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {step === 2 && (
                <div>
                  <div className="step-head">
                    <p className="kicker">Step 3 of 5</p>
                    <h1>{scanning ? "Reading your services" : "Services from package.json"}</h1>
                    {!scanning && (
                      <p>
                        Canopy mapped your <span style={{ fontFamily: "var(--mono)", color: "var(--dim)" }}>scripts</span> to long-running services. Toggle what Canopy should run per worktree.
                      </p>
                    )}
                  </div>

                  {det && det.scripts.length > 0 && (
                    <div className="pkg-peek">
                      <div className="bar">
                        <span className="ic">
                          <Package size={13} />
                        </span>
                        package.json — scripts
                      </div>
                      <div className="pkg-body">
                        <div className="ln">
                          <span className="pun">{"{"}</span>
                        </div>
                        {det.scripts.map((s, i) => (
                          <div className="ln" key={s.name}>
                            {"  "}
                            <span className={"key" + (hitNames.has(s.name) ? " hit" : "")}>"{s.name}"</span>
                            <span className="pun">: </span>
                            <span className="str">"{s.command}"</span>
                            <span className="pun">{i < det.scripts.length - 1 ? "," : ""}</span>
                          </div>
                        ))}
                        <div className="ln">
                          <span className="pun">{"}"}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {scanning ? (
                    <div className="scan">
                      <span className="sp">
                        <Spinner size={18} />
                      </span>
                      Scanning package.json and workspaces…
                    </div>
                  ) : (
                    <>
                      <div className="sug-head">
                        <h3>Suggested services</h3>
                        <span className="desc">
                          {services.filter((s) => s.on).length} of {services.length} on
                        </span>
                        <span className="line" />
                        <button
                          className="add-action"
                          onClick={() => setServices([...services, { id: uid("s"), on: true, name: "New service", kind: "server", cmd: "npm run dev", port: "" }])}
                        >
                          + Add manually
                        </button>
                      </div>
                      <div className="sug-list">
                        {services.map((s) => {
                          const Ic = KIND_IC[s.kind];
                          return (
                            <div className={"sug " + (s.on ? "on" : "off")} key={s.id}>
                              <span className="kind-ic">
                                <Ic size={16} />
                              </span>
                              <div className="body">
                                <div className="row1">
                                  <span className="name">{s.name}</span>
                                  <span className="tag">{s.kind}</span>
                                </div>
                                <div className="cmd">
                                  <b>from</b> {s.script ? `"${s.script}"` : "manual"} · {s.cmd}
                                </div>
                              </div>
                              <span className={"port" + (s.port ? "" : " none")}>{s.port ? ":" + s.port : "no port"}</span>
                              <Switch on={s.on} onClick={() => setServices(services.map((x) => (x.id === s.id ? { ...x, on: !x.on } : x)))} />
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}

              {step === 3 && (
                <div>
                  <div className="step-head">
                    <p className="kicker">Step 4 of 5</p>
                    <h1>Commands &amp; environment</h1>
                    <p>Pre-filled from your scripts. These run automatically whenever you create a new worktree — tweak or toggle any of them.</p>
                  </div>

                  <div className="cfg-group">
                    <div className="sug-head">
                      <h3>Database</h3>
                      <span className="desc">from db:* scripts</span>
                      <span className="line" />
                    </div>
                    <div className="cfg-two">
                      <div className="field-col">
                        <label className="fld-label">Reset DB</label>
                        <input className="input mono" value={cfg.resetDb} spellCheck={false} onChange={(e) => setCfg({ ...cfg, resetDb: e.target.value })} />
                      </div>
                      <div className="field-col">
                        <label className="fld-label">Migrate</label>
                        <input className="input mono" value={cfg.migrate} spellCheck={false} onChange={(e) => setCfg({ ...cfg, migrate: e.target.value })} />
                      </div>
                    </div>
                  </div>

                  <div className="cfg-group">
                    <div className="sug-head">
                      <h3>Env overrides</h3>
                      <span className="desc">per-worktree .env keys</span>
                      <span className="line" />
                    </div>
                    {cfg.env.map((e) => (
                      <div className="kv-line" key={e.id}>
                        <input
                          className="input mono"
                          value={e.key}
                          spellCheck={false}
                          style={{ opacity: e.on ? 1 : 0.5 }}
                          onChange={(ev) => setCfg({ ...cfg, env: cfg.env.map((x) => (x.id === e.id ? { ...x, key: ev.target.value } : x)) })}
                        />
                        <span className="kv-eq">=</span>
                        <input
                          className="input mono"
                          value={e.value}
                          spellCheck={false}
                          style={{ opacity: e.on ? 1 : 0.5 }}
                          onChange={(ev) => setCfg({ ...cfg, env: cfg.env.map((x) => (x.id === e.id ? { ...x, value: ev.target.value } : x)) })}
                        />
                        <Switch on={e.on} onClick={() => setCfg({ ...cfg, env: cfg.env.map((x) => (x.id === e.id ? { ...x, on: !x.on } : x)) })} />
                      </div>
                    ))}
                  </div>

                  <div className="cfg-group">
                    <div className="sug-head">
                      <h3>Setup commands</h3>
                      <span className="desc">run on worktree create</span>
                      <span className="line" />
                    </div>
                    {cfg.setup.map((u, i) => (
                      <div className="step-line" key={u.id}>
                        <span className="step-num2">{i + 1}</span>
                        <input
                          className="input mono"
                          value={u.cmd}
                          spellCheck={false}
                          style={{ opacity: u.on ? 1 : 0.5 }}
                          onChange={(ev) => setCfg({ ...cfg, setup: cfg.setup.map((x) => (x.id === u.id ? { ...x, cmd: ev.target.value } : x)) })}
                        />
                        <Switch on={u.on} onClick={() => setCfg({ ...cfg, setup: cfg.setup.map((x) => (x.id === u.id ? { ...x, on: !x.on } : x)) })} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {step === 4 && det && (
                <div>
                  <div className="step-head">
                    <p className="kicker">Step 5 of 5</p>
                    <h1>Review &amp; add</h1>
                    <p>Here's what Canopy will save. You can change any of this later in Settings.</p>
                  </div>
                  <div className="rev-card">
                    <div className="rev-top">
                      <span className="fork-badge">
                        <Fork size={17} />
                      </span>
                      <div>
                        <h3>
                          {det.name} <span style={{ color: "var(--faint)", fontWeight: 500, fontSize: 13 }}>· {(STACKS.find((s) => s.id === stack) || {}).name || "Custom"}</span>
                        </h3>
                        <div className="path">{det.top}</div>
                      </div>
                      <span className="sp" />
                      {det.branch && (
                        <span className="git-chip">
                          <Check size={13} />
                          {det.branch}
                        </span>
                      )}
                    </div>
                    <div className="rev-grid">
                      <div className="rev-cell">
                        <div className="lbl">Services · {services.filter((s) => s.on).length}</div>
                        <div className="rev-list">
                          {services
                            .filter((s) => s.on)
                            .map((s) => (
                              <div className="r" key={s.id}>
                                <span className="d" />
                                {s.name}
                                {s.port ? " · :" + s.port : ""}
                              </div>
                            ))}
                        </div>
                      </div>
                      <div className="rev-cell">
                        <div className="lbl">Worktree dir</div>
                        <div className="val">
                          <span className="mono">{cfg.worktreeDir}</span>
                        </div>
                      </div>
                      <div className="rev-cell">
                        <div className="lbl">DB commands</div>
                        <div className="val">
                          {(cfg.resetDb ? 1 : 0) + (cfg.migrate ? 1 : 0)} configured
                        </div>
                      </div>
                      <div className="rev-cell">
                        <div className="lbl">Env &amp; setup</div>
                        <div className="val">
                          {cfg.env.filter((e) => e.on).length} env overrides · {cfg.setup.filter((u) => u.on).length} setup steps
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="ob-foot">
            {step > 0 && (
              <button className="btn ghost" onClick={back} disabled={busy}>
                <ArrowLeft size={14} />
                Back
              </button>
            )}
            <div className="grow" />
            <div className="dots">
              {STEPS.map((_, i) => (
                <i key={i} className={i === step ? "on" : ""} />
              ))}
            </div>
            <div className="grow" />
            <button className="btn primary" onClick={next} disabled={!canNext || busy}>
              {busy ? (
                <>
                  <Spinner size={14} />
                  Adding…
                </>
              ) : step === 4 ? (
                <>
                  <Check size={14} />
                  Add repository
                </>
              ) : (
                <>
                  Continue
                  <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {done && (
        <div className="done-veil">
          <div className="done-card">
            <div className="done-ring">
              <Check size={30} />
            </div>
            <h2>{det?.name ?? "Repository"} is ready</h2>
            <p>Canopy is watching this repo. Create your first worktree to spin up an isolated branch with its own services.</p>
            <div className="done-actions">
              <button
                className="btn primary"
                onClick={() => {
                  onClose();
                  onCreateWorktree();
                }}
              >
                Create first worktree
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  if (det) {
                    // select the repo's main checkout so the main window has something to show
                    select(det.top);
                  }
                  onClose();
                }}
              >
                Go to Canopy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
