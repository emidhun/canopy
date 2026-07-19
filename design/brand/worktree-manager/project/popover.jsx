// popover.jsx — Worktree Manager menu-bar popover (design-track deliverable, §6)
// Self-contained React component. Exports Popover + mock data to window.

const { useState, useRef, useEffect } = React;

/* ── Icons (Tabler, inline SVG, stroke = currentColor) ───────────── */
function svgProps(size) {
  return {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round",
    strokeLinejoin: "round",
  };
}
const CircleCheck = ({ size = 18 }) => (
  <svg {...svgProps(size)}>
    <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
    <path d="M9 12l2 2l4 -4" />
  </svg>
);
const CircleX = ({ size = 18 }) => (
  <svg {...svgProps(size)}>
    <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
    <path d="M10 10l4 4m0 -4l-4 4" />
  </svg>
);
const CheckFilled = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M17 3.34a10 10 0 1 1 -14.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 14.995 -8.336zm-1.293 5.953a1 1 0 0 0 -1.32 -.083l-.094 .083l-3.293 3.292l-1.293 -1.292l-.094 -.083a1 1 0 0 0 -1.403 1.403l.083 .094l2 2l.094 .083a1 1 0 0 0 1.226 0l.094 -.083l4 -4l.083 -.094a1 1 0 0 0 -.083 -1.32z" />
  </svg>
);
const XFilled = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M17 3.34a10 10 0 1 1 -14.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 14.995 -8.336zm-6.489 5.8a1 1 0 0 0 -1.218 1.567l1.292 1.293l-1.292 1.293l-.083 .094a1 1 0 0 0 1.497 1.32l1.293 -1.292l1.293 1.292l.094 .083a1 1 0 0 0 1.32 -1.497l-1.292 -1.293l1.292 -1.293l.083 -.094a1 1 0 0 0 -1.497 -1.32l-1.293 1.292l-1.293 -1.292l-.094 -.083z" />
  </svg>
);
const Dot = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="5" fill="currentColor" />
  </svg>
);
const Spinner = ({ size = 18 }) => (
  <svg {...svgProps(size)} className="wm-spin">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);
const GitFork = ({ size = 13 }) => (
  <svg {...svgProps(size)}>
    <path d="M7 8v1.5a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5 -2.5v-1.5" />
    <path d="M12 12v4" />
    <circle cx="7" cy="6" r="2.05" />
    <circle cx="17" cy="6" r="2.05" />
    <circle cx="12" cy="18" r="2.05" />
  </svg>
);
const WindowIcon = ({ size = 16 }) => (
  <svg {...svgProps(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 9h18" />
  </svg>
);
const PowerIcon = ({ size = 16 }) => (
  <svg {...svgProps(size)}>
    <path d="M7 6a7.75 7.75 0 1 0 10 0" />
    <path d="M12 4v8" />
  </svg>
);
const ExternalIcon = ({ size = 15 }) => (
  <svg {...svgProps(size)}>
    <path d="M12 6h-5a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-5" />
    <path d="M11 13l9 -9" /><path d="M15 4h5v5" />
  </svg>
);
const DatabaseIcon = ({ size = 15 }) => (
  <svg {...svgProps(size)}>
    <ellipse cx="12" cy="6" rx="7" ry="2.6" />
    <path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7 -1.2 7 -2.6v-6" />
    <path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7 -1.2 7 -2.6v-6" />
  </svg>
);

/* ── Mock worktree tree (realistic — 3 repos, mixed statuses) ────── */
const INITIAL_TREE = [
  {
    repo: "acme-web", path: "~/code/acme-web",
    worktrees: [
      { branch: "main", services: [
        { id: "aw-main-fe", name: "Frontend", status: "running" },
        { id: "aw-main-sv", name: "Server", status: "running" },
      ]},
      { branch: "feature/checkout", services: [
        { id: "aw-co-fe", name: "Frontend", status: "stopped" },
        { id: "aw-co-sv", name: "Server", status: "stopped" },
      ]},
    ],
  },
  {
    repo: "payments-api", path: "~/code/payments-api",
    worktrees: [
      { branch: "main", services: [
        { id: "pa-main-api", name: "API", status: "running" },
        { id: "pa-main-wrk", name: "Worker", status: "stopped" },
      ]},
      { branch: "hotfix/refund", services: [
        { id: "pa-hf-api", name: "API", status: "running" },
      ]},
    ],
  },
  {
    repo: "design-system", path: "~/dev/design-system",
    worktrees: [
      { branch: "main", services: [
        { id: "ds-sb", name: "Storybook", status: "running" },
      ]},
    ],
  },
];

const isLive = (s) => s === "running" || s === "starting";

/* ── Status icon ─────────────────────────────────────────────────── */
function StatusIcon({ status, iconStyle, accent }) {
  if (status === "starting" || status === "stopping")
    return <span className="wm-ic" style={{ color: accent }}><Spinner /></span>;
  const running = status === "running";
  const color = status === "error" ? "#e0533d" : running ? "var(--wm-run)" : "var(--wm-stop)";
  let glyph;
  if (iconStyle === "filled") glyph = running ? <CheckFilled /> : <XFilled />;
  else if (iconStyle === "dot") glyph = <Dot />;
  else glyph = running ? <CircleCheck /> : <CircleX />;
  return <span className="wm-ic" style={{ color }}>{glyph}</span>;
}

/* ── Group label, with treatment variants ───────────────────────── */
function GroupLabel({ repo, branch, treatment }) {
  if (treatment === "caps")
    return (
      <div className="wm-group wm-group--caps">
        {repo} <span className="wm-mid">·</span> {branch}
      </div>
    );
  if (treatment === "slash")
    return (
      <div className="wm-group">
        <span className="wm-fork"><GitFork /></span>
        <span>{repo}<span className="wm-slash">/</span>{branch}</span>
      </div>
    );
  if (treatment === "pill")
    return (
      <div className="wm-group wm-group--pill">
        <span className="wm-fork"><GitFork /></span>
        <span className="wm-repo">{repo}</span>
        <span className="wm-branchpill">{branch}</span>
      </div>
    );
  // default: fork glyph + middle dot
  return (
    <div className="wm-group">
      <span className="wm-fork"><GitFork /></span>
      <span>{repo} <span className="wm-mid">·</span> {branch}</span>
    </div>
  );
}

/* ── Service row ─────────────────────────────────────────────────── */
function ServiceRow({ svc, onToggle, treatment, iconStyle, accent }) {
  const busy = svc.status === "starting" || svc.status === "stopping";
  const running = isLive(svc.status);
  const label = svc.status === "starting" ? "Starting"
    : svc.status === "stopping" ? "Stopping"
    : running ? "Stop" : "Start";
  return (
    <div className="wm-row">
      <StatusIcon status={svc.status} iconStyle={iconStyle} accent={accent} />
      <span className="wm-name">{svc.name}</span>
      <button
        className={"wm-btn" + (busy ? " wm-btn--busy" : "")}
        onClick={() => !busy && onToggle(svc.id)}
        disabled={busy}
      >
        {label}
      </button>
    </div>
  );
}

/* ── Aggregate a worktree's status from its services ─────────────── */
function aggStatus(wt) {
  const ss = wt.services.map((s) => s.status);
  if (ss.some((s) => s === "starting")) return "starting";
  if (ss.some((s) => s === "stopping")) return "stopping";
  if (ss.some((s) => s === "error")) return "error";
  if (ss.some((s) => s === "running")) return "running";
  return "stopped";
}

/* ── Repo section header ─────────────────────────────────────────── */
function RepoHeader({ repo, path, treatment }) {
  if (treatment === "caps")
    return <div className="wm-group wm-group--caps">{repo}</div>;
  return (
    <div className="wm-group">
      <span className="wm-fork"><GitFork /></span>
      <span className="wm-repo">{repo}</span>
    </div>
  );
}

/* ── Worktree row — service chips + open / reset-db / start-stop ── */
function WorktreeRow({ wt, status, resetting, onToggle, onReset, onOpen, accent }) {
  const busy = status === "starting" || status === "stopping";
  const running = isLive(status) && !busy;
  const label = running ? "Stop" : "Start";
  return (
    <div className="wm-wt">
      <div className="wm-wt-top">
        <span className="wm-wt-branch">{wt.branch}</span>
        <div className="wm-acts">
          <button className="wm-act" title="Open worktree" onClick={onOpen}>
            <ExternalIcon />
          </button>
          <button className={"wm-act" + (resetting ? " wm-act--busy" : "")}
                  title="Reset database" onClick={() => !resetting && onReset()}
                  disabled={resetting}>
            {resetting ? <Spinner size={15} /> : <DatabaseIcon />}
          </button>
          <button className={"wm-toggle" + (running ? " is-running" : "") + (busy ? " is-busy" : "")}
                  onClick={() => !busy && onToggle()} disabled={busy}>
            {label}
          </button>
        </div>
      </div>
      <div className="wm-svcs">
        {wt.services.map((s) => (
          <span className="wm-svc" key={s.id}>
            <span className={"wm-svc-dot s-" + s.status} />{s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Popover ─────────────────────────────────────────────────────── */
function Popover({ tree, onToggle, onToggleWorktree, onReset, onOpen, resetting = {},
                   onOpenManager, onQuit,
                   granularity = "worktree", treatment = "fork",
                   density = "comfortable", iconStyle = "outline",
                   accent = "#58c2c8", separators = true, flash }) {
  return (
    <div className={"wm-pop wm-pop--" + density} style={{ "--wm-accent": accent }}>
      <button className={"wm-item" + (flash === "manager" ? " wm-item--flash" : "")}
              onClick={onOpenManager}>
        <span className="wm-item-ic"><WindowIcon /></span>Open Manager
      </button>
      <button className={"wm-item" + (flash === "quit" ? " wm-item--flash" : "")}
              onClick={onQuit}>
        <span className="wm-item-ic"><PowerIcon /></span>Quit
      </button>
      <div className="wm-sep" />
      <div className="wm-groups">
        {granularity === "worktree"
          ? tree.map((repo, ri) => (
              <div className={"wm-grp" + (separators && ri ? " wm-grp--div" : "")}
                   key={repo.repo}>
                <RepoHeader repo={repo.repo} path={repo.path} treatment={treatment} />
                {repo.worktrees.map((wt) => {
                  const key = repo.repo + "|" + wt.branch;
                  return (
                    <WorktreeRow key={wt.branch} wt={wt} status={aggStatus(wt)}
                                 resetting={!!resetting[key]}
                                 onToggle={() => onToggleWorktree(repo.repo, wt.branch)}
                                 onReset={() => onReset(repo.repo, wt.branch)}
                                 onOpen={() => onOpen(repo.repo, wt.branch)}
                                 accent={accent} />
                  );
                })}
              </div>
            ))
          : tree.map((repo, ri) =>
              repo.worktrees.map((wt, wi) => (
                <div className={"wm-grp" + (separators && (ri || wi) ? " wm-grp--div" : "")}
                     key={repo.repo + wt.branch}>
                  <GroupLabel repo={repo.repo} branch={wt.branch} treatment={treatment} />
                  {wt.services.map((svc) => (
                    <ServiceRow key={svc.id} svc={svc} onToggle={onToggle}
                                treatment={treatment} iconStyle={iconStyle} accent={accent} />
                  ))}
                </div>
              ))
            )}
      </div>
    </div>
  );
}

Object.assign(window, {
  Popover, INITIAL_TREE, isLive, aggStatus,
  GitFork, WindowIcon, PowerIcon,
});
