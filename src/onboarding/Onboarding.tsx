// First run — one adaptive screen, not five steps. Ported from the redesign
// handoff (Canopy Onboarding.html / cxo-onboard.jsx).
//
// The shipped wizard walked Repository → Stack → Services → Commands → Review.
// Two of those didn't earn a screen: "Stack" asked you to confirm something
// already read from the repo's manifests, and "Review" restated the screens
// before it. Meanwhile the real value — detect_repo mapping package.json
// scripts to services — sat behind step 3. So now: an empty state that finally
// exists, one adaptive add screen (detection runs as you type; the stack is a
// chip; the derivation is shown, not asserted), honest provisioning narration
// over the real IPC calls, and a "ready" screen that ends on the next action.
//
// Backend honesty notes:
// • The empty state's "recently opened" list is omitted — Canopy has no MRU
//   store, so there is nothing real to list. TODO: file an issue + wire it.
// • Env template values use ${WT_SERVER_PORT} / ${WT_DB_NAME}, the variables the
//   Rust setup runner actually interpolates (state.rs:142, setup.rs). The
//   handoff/SettingsView names ${WT_SERVICE_PORT} / ${INT_DB_NAME} are NOT
//   substituted by the backend and would land in .env as dead literals.
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "../styles/onboarding.css";
import { errText, hasBackend, ipc, type ProvisionEntry, type RepoCfg, type RepoDetection, type ServiceCfg } from "../ipc";
import { useStore } from "../store";
import { Browser, Check, ChevRight, Chevron, Cube, Doc, Fork, Plus, Server, Spinner } from "../icons";

/* the one folder glyph the shared set doesn't carry */
const Folder = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
  </svg>
);

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
const KIND_IC: Record<Kind, typeof Server> = { web: Browser, server: Server, worker: Cube };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map detected package.json scripts + stack into service/command suggestions.
 * Port-derivation and env-template names mirror the Rust setup runner. */
function derive(det: RepoDetection): { services: WizSvc[]; cfg: Cfg } {
  const scripts = det.scripts ?? [];
  const find = (re: RegExp) => scripts.find((s) => re.test(s.name));

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

function Tgl({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={"tgl" + (on ? " on" : "")} role="switch" aria-checked={on} onClick={onClick}><i /></button>;
}

/* ── the stack: a chip, not a step ────────────────────────────────── */
function StackChip({ value, detected, onPick }: { value: string; detected?: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [open]);
  const s = STACKS.find((x) => x.id === value) || STACKS[7];
  return (
    <span className="stackwrap" ref={ref}>
      <button className="stackchip" onClick={() => setOpen((o) => !o)} title="Change the detected stack">
        <span className="mn">{s.mono}</span>
        {s.name}
        <Chevron size={10} />
      </button>
      {open && (
        <div className="stackmenu" role="listbox">
          {STACKS.map((x) => (
            <button key={x.id} className={"smi" + (x.id === value ? " on" : "")} role="option" aria-selected={x.id === value} onClick={() => { onPick(x.id); setOpen(false); }}>
              <span className="mn">{x.mono}</span>
              <span className="nm">{x.name}</span>
              {x.id === detected ? <span className="det">detected</span> : <span className="ds">{x.desc}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/* ── A · empty state — first launch used to say nothing ───────────── */
function EmptyState({ onAdd, onBrowse }: { onAdd: () => void; onBrowse: () => void }) {
  return (
    <div className="emptywrap">
      <div className="emptycard">
        <div className="emptyring"><Fork size={26} /></div>
        <h1>No repositories yet</h1>
        <p>Canopy runs each branch as its own worktree — separate checkout, separate services, separate database. Point it at a repo and it reads your scripts to work out what to run.</p>
        <div className="emptyacts">
          <button className="btn pri lg" onClick={onAdd}><Plus size={13} />Add a repository<span className="k">⌘N</span></button>
          <button className="btn lg" onClick={onBrowse}><Folder size={13} />Browse…</button>
        </div>
        <div className="whatnext">
          <div className="slab">What happens next</div>
          {[
            ["Canopy reads the repo", "git remotes, branches, and the scripts in your manifest."],
            ["It proposes what to run", "long-running scripts become services, with ports derived per worktree."],
            ["You create a worktree", "a branch checked out, provisioned and running in one action."],
          ].map(([t, d], i) => (
            <div className="wn" key={t}>
              <span className="n">{i + 1}</span>
              <span className="t"><b>{t}</b><span>{d}</span></span>
            </div>
          ))}
        </div>
        {/* The design shows a "Recently opened" list here. Canopy has no MRU
            store, so there is nothing real to list — omitted rather than
            fabricated. TODO: file an issue to persist opened-repo history. */}
      </div>
    </div>
  );
}

/* ── B · one adaptive add screen ──────────────────────────────────── */
type Phase = "idle" | "detecting" | "scanning" | "ready";
function AddScreen({
  det,
  detErr,
  phase,
  path,
  over,
  stack,
  services,
  cfg,
  onPath,
  onBrowse,
  onStack,
  setServices,
  setCfg,
  onSkip,
  onDone,
}: {
  det: RepoDetection | null;
  detErr: string | null;
  phase: Phase;
  path: string;
  over: boolean;
  stack: string;
  services: WizSvc[];
  cfg: Cfg;
  onPath: (v: string) => void;
  onBrowse: () => void;
  onStack: (id: string) => void;
  setServices: React.Dispatch<React.SetStateAction<WizSvc[]>>;
  setCfg: React.Dispatch<React.SetStateAction<Cfg>>;
  onSkip: () => void;
  onDone: () => void;
}) {
  const on = services.filter((s) => s.on);
  const hits = new Set<string>();
  services.forEach((s) => s.on && s.script && hits.add(s.script));
  [cfg.resetDb, cfg.migrate].forEach((c) => {
    const m = c.match(/npm run (\S+)/);
    if (m) hits.add(m[1]);
  });
  const patch = (id: string, p: Partial<WizSvc>) => setServices((ss) => ss.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const envOn = cfg.env.filter((e) => e.on).length;
  const setupOn = cfg.setup.filter((u) => u.on).length;

  return (
    <>
      <div className="obody">
        <div className="obinner">
          <div className="ohead">
            <h1>Add a repository</h1>
            <p>Canopy verifies the repo, reads its scripts, and proposes what to run per worktree. Everything here is editable later in Settings.</p>
          </div>

          {/* the drop target doubles as the path field */}
          <div className={"drop" + (over ? " over" : "") + (path ? " filled" : "")}>
            <div className="droprow">
              <span className="ic"><Folder size={14} /></span>
              <input
                className="inp mono"
                style={{ flex: 1 }}
                value={path}
                spellCheck={false}
                placeholder="~/code/my-app  ·  or drop a folder here"
                onChange={(e) => onPath(e.target.value)}
              />
              <button className="btn" onClick={onBrowse}><Folder size={12} />Browse…</button>
            </div>
            {!path && <div className="drophint">Drop a git repository, or <b>paste its path</b>.</div>}
          </div>

          {phase === "detecting" && (
            <div className="detect">
              <div className="scanning" style={{ borderTop: 0 }}>
                <span className="sp2 spin"><Spinner size={16} /></span>
                Verifying the repository…
              </div>
            </div>
          )}

          {detErr && phase === "idle" && path.trim() !== "" && (
            <div className="detect">
              <div className="scanning" style={{ borderTop: 0, color: "var(--red-text)" }}>{detErr}</div>
            </div>
          )}

          {(phase === "scanning" || phase === "ready") && det && (
            <div className="detect">
              <div className="dtop">
                <span className="badge"><Fork size={17} /></span>
                <span className="info">
                  <h3>{det.name}</h3>
                  <span className="meta">
                    <span><span className="k">path</span> {det.top}</span>
                    {det.branch && <span><span className="k">branch</span> {det.branch}</span>}
                  </span>
                </span>
                {/* was step 2 of 5; now a chip, already answered */}
                <StackChip value={stack} detected={det.stack} onPick={onStack} />
                <span className="okchip"><Check size={11} />Git repo</span>
              </div>

              {phase === "scanning" ? (
                <div className="scanning">
                  <span className="sp2 spin"><Spinner size={16} /></span>
                  Reading package.json and workspaces…
                </div>
              ) : (
                <>
                  <div className="dsec">
                    <div className="slab">
                      Services Canopy will run
                      <span className="n">{on.length} of {services.length} on</span>
                      <span className="ln" />
                      <button
                        className="btn sm gh"
                        onClick={() => setServices((ss) => ss.concat([{ id: uid("s"), on: true, name: "New service", kind: "server", cmd: "npm run dev", port: "" }]))}
                      >
                        <Plus size={10} />Add
                      </button>
                    </div>
                    {services.map((s) => {
                      const Ic = KIND_IC[s.kind];
                      return (
                        <div className={"svcrow " + (s.on ? "on" : "off")} key={s.id}>
                          <span className="kic"><Ic size={13} /></span>
                          <span className="bd">
                            <span className="r1"><span className="nm">{s.name}</span><span className="tag">{s.kind}</span></span>
                            <span className="cmd"><b>from</b> {s.script ? '"' + s.script + '"' : "manual"} · {s.cmd}</span>
                          </span>
                          {s.on ? (
                            <input className="inp mono pin" value={s.port} placeholder="—" spellCheck={false} onChange={(e) => patch(s.id, { port: e.target.value })} />
                          ) : (
                            <span className={"port" + (s.port ? "" : " none")}>{s.port ? ":" + s.port : "no port"}</span>
                          )}
                          <Tgl on={s.on} onClick={() => patch(s.id, { on: !s.on })} />
                        </div>
                      );
                    })}
                    <div className="hint">Ports are a base — each worktree gets <code>base + index × 10</code>, so five branches never collide.</div>
                  </div>

                  {/* the derivation, shown rather than asserted */}
                  {det.scripts.length > 0 && (
                    <div className="dsec">
                      <div className="slab">Where that came from<span className="ln" /></div>
                      <div className="peek">
                        <div className="bar"><Doc size={11} />package.json — scripts</div>
                        <div className="bd">
                          <div className="ln"><span className="pun">{"{"}</span></div>
                          {det.scripts.map((s, i) => (
                            <div className="ln" key={s.name}>
                              {"  "}
                              <span className={"key" + (hits.has(s.name) ? " hit" : "")}>"{s.name}"</span>
                              <span className="pun">: </span>
                              <span className="str">"{s.command}"</span>
                              <span className="pun">{i < det.scripts.length - 1 ? "," : ""}</span>
                            </div>
                          ))}
                          <div className="ln"><span className="pun">{"}"}</span></div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* pre-filled correctly, so collapsed — was a whole step */}
                  <details className="adv">
                    <summary>
                      <span className="cv"><ChevRight size={11} /></span>
                      Provisioning and setup
                      <span className="n">{envOn} env keys · {setupOn} setup steps · db commands found</span>
                    </summary>
                    <div className="advb">
                      <div className="slab" style={{ marginTop: 4 }}>Env written into each worktree's .env<span className="ln" /></div>
                      <div className="kv">
                        {cfg.env.map((e) => (
                          <div key={e.id} style={{ display: "contents" }}>
                            <input
                              className="inp mono"
                              value={e.key}
                              spellCheck={false}
                              style={{ opacity: e.on ? 1 : 0.5 }}
                              onChange={(ev) => setCfg((c) => ({ ...c, env: c.env.map((x) => (x.id === e.id ? { ...x, key: ev.target.value } : x)) }))}
                            />
                            <span className="eq">=</span>
                            <input
                              className="inp mono"
                              value={e.value}
                              spellCheck={false}
                              style={{ opacity: e.on ? 1 : 0.5 }}
                              onChange={(ev) => setCfg((c) => ({ ...c, env: c.env.map((x) => (x.id === e.id ? { ...x, value: ev.target.value } : x)) }))}
                            />
                            <Tgl on={e.on} onClick={() => setCfg((c) => ({ ...c, env: c.env.map((x) => (x.id === e.id ? { ...x, on: !x.on } : x)) }))} />
                          </div>
                        ))}
                      </div>

                      <div className="slab" style={{ marginTop: 13 }}>Setup, run in order on create<span className="ln" /></div>
                      {cfg.setup.map((u, i) => (
                        <div className="stepline" key={u.id}>
                          <span className="n2">{i + 1}</span>
                          <input
                            className="inp mono"
                            style={{ flex: 1, opacity: u.on ? 1 : 0.5 }}
                            value={u.cmd}
                            spellCheck={false}
                            onChange={(ev) => setCfg((c) => ({ ...c, setup: c.setup.map((x) => (x.id === u.id ? { ...x, cmd: ev.target.value } : x)) }))}
                          />
                          <Tgl on={u.on} onClick={() => setCfg((c) => ({ ...c, setup: c.setup.map((x) => (x.id === u.id ? { ...x, on: !x.on } : x)) }))} />
                        </div>
                      ))}

                      <div className="slab" style={{ marginTop: 13 }}>Database<span className="n">from db:* scripts</span><span className="ln" /></div>
                      <div className="kv">
                        <span style={{ font: "var(--fs-small) var(--sans)", color: "var(--text-tertiary)" }}>Migrate</span>
                        <span />
                        <input className="inp mono" value={cfg.migrate} spellCheck={false} onChange={(e) => setCfg((c) => ({ ...c, migrate: e.target.value }))} />
                        <span />
                        <span style={{ font: "var(--fs-small) var(--sans)", color: "var(--text-tertiary)" }}>Reset</span>
                        <span />
                        <input className="inp mono" value={cfg.resetDb} spellCheck={false} onChange={(e) => setCfg((c) => ({ ...c, resetDb: e.target.value }))} />
                        <span />
                        <span style={{ font: "var(--fs-small) var(--sans)", color: "var(--text-tertiary)" }}>Worktrees in</span>
                        <span />
                        <input className="inp mono" value={cfg.worktreeDir} spellCheck={false} onChange={(e) => setCfg((c) => ({ ...c, worktreeDir: e.target.value }))} />
                        <span />
                      </div>
                    </div>
                  </details>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* one action. no step dots, because there are no steps to count. */}
      <div className="ofoot">
        <button className="ob-skip" onClick={onSkip}>Skip for now</button>
        <span className="sp" />
        {phase === "ready" && det && (
          <span className="sum">
            <b>{det.name}</b> · {on.length} {on.length === 1 ? "service" : "services"} · {setupOn} setup steps
          </span>
        )}
        <button className="btn pri" disabled={phase !== "ready"} onClick={onDone}>
          <Check size={12} />Add repository<span className="k">⌘⏎</span>
        </button>
      </div>
    </>
  );
}

/* ── C · provisioning — narrates the real work ────────────────────── */
interface RunStep {
  t: string;
  run: () => Promise<string>;
}
function Provisioning({ name, steps, onDone, onError, onCancel }: { name: string; steps: RunStep[]; onDone: () => void; onError: (msg: string) => void; onCancel: () => void }) {
  const [n, setN] = useState(0);
  const [metas, setMetas] = useState<string[]>([]);
  const cancelled = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      for (let i = 0; i < steps.length; i++) {
        if (cancelled.current) return;
        try {
          // real work, but with a readable floor so narration doesn't flash past
          const [meta] = await Promise.all([steps[i].run(), delay(460)]);
          if (!alive || cancelled.current) return;
          setMetas((xs) => {
            const c = [...xs];
            c[i] = meta;
            return c;
          });
          setN(i + 1);
        } catch (e) {
          if (alive && !cancelled.current) onError(String(e));
          return;
        }
      }
      if (alive && !cancelled.current) {
        await delay(300);
        if (alive && !cancelled.current) onDone();
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="runwrap">
      <div className="runcard">
        <h2>Setting up {name}</h2>
        <p>Nothing is cloned or installed yet — that happens per worktree.</p>
        {steps.map((s, i) => (
          <div className={"stp " + (i < n ? "done" : i === n ? "act" : "pend")} key={s.t}>
            <span className="bl">{i < n ? "✓" : i === n ? <span className="spin"><Spinner size={11} /></span> : "○"}</span>
            <span className="tx">{s.t}</span>
            {i < n && metas[i] && <span className="mt">{metas[i]}</span>}
          </div>
        ))}
        {/* a first run must be escapable while its one long operation runs */}
        <div className="runcancel">
          <button
            className="btn"
            onClick={() => {
              cancelled.current = true;
              onCancel();
            }}
          >
            Cancel setup
          </button>
          <span>Nothing is cloned or installed — you can start over.</span>
        </div>
      </div>
    </div>
  );
}

/* ── D · ready — ends on the next action, not a dead end ──────────── */
function Ready({ det, services, cfg, onCreate, onGoToCanopy, onRestart }: { det: RepoDetection; services: WizSvc[]; cfg: Cfg; onCreate: () => void; onGoToCanopy: () => void; onRestart: () => void }) {
  const on = services.filter((s) => s.on);
  const svcSummary = on.map((s) => (s.port ? `${s.name} :${s.port}` : s.name)).join(" · ") || "none";
  const envOn = cfg.env.filter((e) => e.on).length;
  const setupOn = cfg.setup.filter((u) => u.on).length;
  return (
    <div className="runwrap">
      <div className="emptycard">
        <div className="donering"><Check size={26} /></div>
        <h1>{det.name} is ready</h1>
        <p>Canopy is watching this repo. Create a worktree to check out a branch with its own services, ports and database.</p>
        <div className="doneacts">
          <button className="btn pri lg" onClick={onCreate}><Plus size={13} />Create first worktree<span className="k">⌘N</span></button>
          <button className="btn lg" onClick={onGoToCanopy}>Go to Canopy</button>
        </div>
        <div className="donefacts">
          <div className="df"><div className="l">Services</div><div className="v">{svcSummary}</div></div>
          <div className="df"><div className="l">Worktrees in</div><div className="v">{cfg.worktreeDir || "—"}</div></div>
          <div className="df"><div className="l">On create</div><div className="v">{envOn} env keys · {setupOn} setup steps</div></div>
          <div className="df"><div className="l">Database</div><div className="v">one per worktree · <em>${"{WT_DB_NAME}"}</em></div></div>
        </div>
        <div className="hint" style={{ textAlign: "center", marginTop: 16 }}>
          Change any of this in Settings → <span style={{ color: "var(--text-secondary)" }}>{det.name}</span>.{" "}
          <a onClick={(e) => { e.preventDefault(); onRestart(); }}>Replay this flow</a>
        </div>
      </div>
    </div>
  );
}

/* ── shell ────────────────────────────────────────────────────────── */
type View = "empty" | "add" | "run" | "done";

export default function Onboarding({ onClose, onCreateWorktree }: { onClose: () => void; onCreateWorktree: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const select = useStore((s) => s.select);

  const [view, setView] = useState<View>("empty");
  const [path, setPath] = useState("");
  const [det, setDet] = useState<RepoDetection | null>(null);
  const [detErr, setDetErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [over, setOver] = useState(false);
  const [stack, setStack] = useState("node");
  const [services, setServices] = useState<WizSvc[]>([]);
  const [cfg, setCfg] = useState<Cfg>({ resetDb: "", migrate: "", worktreeDir: "", env: [], setup: [] });
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const detectSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flash = (m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  };

  useEffect(() => () => {
    clearTimeout(debounce.current);
    clearTimeout(toastTimer.current);
  }, []);

  /* Detection runs as you type — the shipped version waited for blur, so a
     pasted path did nothing until you clicked away. */
  async function detect(p: string) {
    const trimmed = p.trim();
    if (!trimmed) {
      setPhase("idle");
      setDet(null);
      setDetErr(null);
      return;
    }
    if (!hasBackend()) {
      setDetErr("Detection needs the desktop app");
      setPhase("idle");
      return;
    }
    const seq = ++detectSeq.current;
    setPhase("detecting");
    setDetErr(null);
    try {
      const d = await ipc.detectRepo(trimmed);
      if (seq !== detectSeq.current) return; // a newer keystroke superseded this
      setDet(d);
      setStack(d.stack || "other");
      const { services: sv, cfg: cf } = derive(d);
      setServices(sv);
      setCfg(cf);
      setPhase("scanning");
      // a brief, honest beat while we "read" the manifest we just parsed
      setTimeout(() => {
        if (seq === detectSeq.current) setPhase("ready");
      }, 650);
    } catch (e) {
      if (seq !== detectSeq.current) return;
      setDet(null);
      setDetErr(errText(e));
      setPhase("idle");
    }
  }

  function onPath(v: string) {
    setPath(v);
    setDet(null);
    setDetErr(null);
    clearTimeout(debounce.current);
    ++detectSeq.current; // invalidate any in-flight detect
    if (!v.trim()) {
      setPhase("idle");
      return;
    }
    setPhase("detecting");
    debounce.current = setTimeout(() => detect(v), 450);
  }

  async function browse() {
    if (!hasBackend()) return flash("Browse needs the desktop app");
    const picked = await openDialog({ directory: true, multiple: false, title: "Choose a git repository" });
    if (typeof picked === "string") {
      setPath(picked);
      detect(picked);
    }
  }

  /* real OS folder drop → the same path field (Tauri v2 webview drag-drop).
     Degrades silently: typing and Browse still work if the event never fires. */
  useEffect(() => {
    if (view !== "add" || !hasBackend()) return;
    let un: (() => void) | undefined;
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // not a real Tauri webview — typing / Browse still work
    }
    webview
      .onDragDropEvent((event) => {
        const pl = event.payload;
        if (pl.type === "over" || pl.type === "enter") setOver(true);
        else if (pl.type === "leave") setOver(false);
        else if (pl.type === "drop") {
          setOver(false);
          const p = pl.paths?.[0];
          if (p) {
            setPath(p);
            detect(p);
          }
        }
      })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => {
      un?.();
      setOver(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* Build the provisioning steps, each wired to a real IPC call so the
     narration reports what actually happened, not a canned script. */
  function startProvision() {
    if (!det) return;
    const on = services.filter((s) => s.on);
    const envPairs = cfg.env.filter((e) => e.on && e.key.trim()).map((e) => [e.key, e.value] as [string, string]);
    const setupCmds = cfg.setup.filter((u) => u.on && u.cmd.trim()).map((u) => u.cmd);

    if (!hasBackend()) {
      // browser preview: narrate the same shape without touching a backend
      const ports = on.map((s) => s.port).filter(Boolean);
      setRunSteps([
        { t: `Registering ${det.name}`, run: async () => "" },
        { t: `Saving ${on.length} ${on.length === 1 ? "service" : "services"}`, run: async () => (ports.length ? `ports ${ports.join(", ")}` : "") },
        { t: "Writing .worktreemanager.json", run: async () => `${envPairs.length} env ${envPairs.length === 1 ? "key" : "keys"}` },
        { t: "Reading branches", run: async () => "preview" },
      ]);
      setView("run");
      return;
    }

    // shared context threaded across the real steps
    const ctx: { repo: RepoCfg | null } = { repo: null };
    const steps: RunStep[] = [
      {
        t: `Registering ${det.name}`,
        run: async () => {
          await ipc.addRepo(det.top).catch((e) => {
            if (!String(e).toLowerCase().includes("already")) throw e;
          });
          const settings = await ipc.getSettings();
          const repo = settings.repos.find((r) => r.path === det.top);
          if (!repo) throw new Error("repo not found after add");
          ctx.repo = repo;
          return "";
        },
      },
      {
        t: `Saving ${on.length} ${on.length === 1 ? "service" : "services"}`,
        run: async () => {
          const settings = await ipc.getSettings();
          const repo = settings.repos.find((r) => r.path === det.top);
          if (!repo) throw new Error("repo not found");
          repo.services = on.map((s) => ({
            id: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "service",
            name: s.name,
            kind: s.kind,
            command: s.cmd,
            cwd: "",
            basePort: s.port.trim() ? parseInt(s.port, 10) || null : null,
            env: {},
          })) as ServiceCfg[];
          repo.resetDb = cfg.resetDb;
          repo.migrateDb = cfg.migrate;
          if (cfg.worktreeDir.trim()) repo.worktreeDir = cfg.worktreeDir.trim();
          await ipc.saveSettings(settings);
          ctx.repo = repo;
          const ports = on.map((s) => s.port.trim()).filter(Boolean);
          return ports.length ? `ports ${ports.join(", ")}` : "";
        },
      },
      {
        t: "Writing .worktreemanager.json",
        run: async () => {
          if (!ctx.repo) throw new Error("repo not resolved");
          const provision: ProvisionEntry[] = envPairs.length ? [{ path: ".env", format: "dotenv", from: "", interpolate: false, keys: envPairs }] : [];
          await ipc.saveRepoConfig(ctx.repo.id, provision, setupCmds);
          return `${envPairs.length} env ${envPairs.length === 1 ? "key" : "keys"} · ${setupCmds.length} setup`;
        },
      },
      {
        t: "Reading branches",
        run: async () => {
          if (!ctx.repo) return "";
          try {
            const b = await ipc.listBranches(ctx.repo.id);
            const n = b.local.length + b.remote.length;
            return `${n} ${n === 1 ? "branch" : "branches"}`;
          } catch {
            return "";
          }
        },
      },
    ];
    setRunSteps(steps);
    setView("run");
  }

  function goToCanopy() {
    if (det) select(det.top);
    onClose();
  }

  function restart() {
    setView("empty");
    setPath("");
    setDet(null);
    setDetErr(null);
    setPhase("idle");
    setServices([]);
    setCfg({ resetDb: "", migrate: "", worktreeDir: "", env: [], setup: [] });
  }

  // keyboard: ⌘N opens add from empty; ⌘⏎ adds when ready; Esc skips a step
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n" && view === "empty") {
        e.preventDefault();
        setView("add");
      } else if (mod && e.key === "Enter" && view === "add" && phase === "ready") {
        e.preventDefault();
        startProvision();
      } else if (e.key === "Escape" && (view === "empty" || view === "add")) {
        e.preventDefault();
        view === "empty" ? onClose() : setView("empty");
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });

  const title = view === "empty" || view === "done" ? "Canopy" : "Canopy — Add repository";

  return (
    <div className="ob-root">
      <div className="ob-tb" data-tauri-drag-region>
        <div className="ob-tb-title" data-tauri-drag-region>
          <span className="fork"><Fork size={15} /></span>
          {title}
        </div>
        <span className="sp" data-tauri-drag-region />
        {view === "empty" && <button className="ob-skip" onClick={onClose}>Skip setup</button>}
        {view === "add" && <button className="ob-skip" onClick={() => setView("empty")}>Back</button>}
      </div>

      {view === "empty" && <EmptyState onAdd={() => setView("add")} onBrowse={browse} />}
      {view === "add" && (
        <AddScreen
          det={det}
          detErr={detErr}
          phase={phase}
          path={path}
          over={over}
          stack={stack}
          services={services}
          cfg={cfg}
          onPath={onPath}
          onBrowse={browse}
          onStack={setStack}
          setServices={setServices}
          setCfg={setCfg}
          onSkip={() => setView("empty")}
          onDone={startProvision}
        />
      )}
      {view === "run" && (
        <Provisioning
          name={det?.name ?? "repository"}
          steps={runSteps}
          onDone={() => setView("done")}
          onError={(msg) => {
            showToast(`Couldn't add repo — ${msg}`);
            setView("add");
          }}
          onCancel={() => setView("add")}
        />
      )}
      {view === "done" && det && (
        <Ready
          det={det}
          services={services}
          cfg={cfg}
          onCreate={() => {
            onClose();
            onCreateWorktree();
          }}
          onGoToCanopy={goToCanopy}
          onRestart={restart}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
