// Per-worktree context: a title + markdown body + links that seed the agent and
// later become the PR body. Persisted per worktree in localStorage (keyed by
// wtKey). Whether this should instead live as a committed `.canopy/context.md`
// that travels with the branch is an open product question — see the handoff.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Chevron, Copy, Doc, Info, Link as LinkIcon, Plus, Sparkle } from "../icons";

export interface WtContext {
  title: string;
  body: string;
  links: { label: string; kind: string }[];
}

const EMPTY: WtContext = { title: "", body: "", links: [] };

function load(key: string): WtContext {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return EMPTY;
}

/** Load/save a worktree's context, reloading when the selected worktree changes. */
export function useWtContext(wtKey: string): [WtContext, (c: WtContext) => void] {
  const key = `canopy.ctx.${wtKey}`;
  const [ctx, setCtx] = useState<WtContext>(() => load(key));
  useEffect(() => setCtx(load(key)), [key]);
  const update = (c: WtContext) => {
    setCtx(c);
    try {
      localStorage.setItem(key, JSON.stringify(c));
    } catch {
      /* ignore */
    }
  };
  return [ctx, update];
}

export const isBlank = (c: WtContext) => !c.title.trim() && !c.body.trim() && c.links.length === 0;

/** Plain-text one-liner of the markdown body, for the lane summary preview. */
export function bodyPreview(body: string): string {
  return body
    .replace(/[#`\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tiny markdown renderer: `## ` headings, `- ` bullets, inline `code`. */
export function mdRender(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: ReactNode[] | null = null;
  const inline = (s: string) =>
    s.split(/(`[^`]+`)/g).map((p, j) =>
      p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
        <code key={j}>{p.slice(1, -1)}</code>
      ) : (
        <Fragment key={j}>{p}</Fragment>
      ),
    );
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (list) {
        out.push(<ul key={"u" + i}>{list}</ul>);
        list = null;
      }
      out.push(<h3 key={i}>{line.slice(3)}</h3>);
    } else if (line.startsWith("- ")) {
      (list = list || []).push(<li key={i}>{inline(line.slice(2))}</li>);
    } else if (line) {
      if (list) {
        out.push(<ul key={"u" + i}>{list}</ul>);
        list = null;
      }
      out.push(<p key={i}>{inline(line)}</p>);
    }
  });
  if (list) out.push(<ul key="ul-last">{list}</ul>);
  return out;
}

/** The full context editor, shown in a modal over the lane. */
export function ContextEditor({
  ctx,
  setCtx,
  onClose,
  onSeed,
  onToast,
}: {
  ctx: WtContext;
  setCtx: (c: WtContext) => void;
  onClose: () => void;
  onSeed: () => void;
  onToast: (m: string) => void;
}) {
  const [tab, setTab] = useState<"write" | "prev">("write");
  return (
    <div className="ctx-scrim" onMouseDown={onClose}>
      <div className="ctx-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ctx-card">
          <div className="ctx-head">
            <span className="cs-lbl">
              <Doc size={12} />
              Context
            </span>
            <span className="grow" />
            <div className="ctx-seg">
              <button className={tab === "write" ? "on" : ""} onClick={() => setTab("write")}>
                Write
              </button>
              <button className={tab === "prev" ? "on" : ""} onClick={() => setTab("prev")}>
                Preview
              </button>
            </div>
            <button className="ib" title="Collapse" onClick={onClose}>
              <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
                <Chevron size={14} />
              </span>
            </button>
          </div>

          <input
            className="ctx-title-in"
            value={ctx.title}
            placeholder="What is this worktree for?"
            onChange={(e) => setCtx({ ...ctx, title: e.target.value })}
          />

          {tab === "write" ? (
            <textarea
              className="ctx-md"
              value={ctx.body}
              spellCheck={false}
              placeholder={"## Problem\n…\n\n## Acceptance\n- …"}
              onChange={(e) => setCtx({ ...ctx, body: e.target.value })}
            />
          ) : (
            <div className="ctx-prev">{mdRender(ctx.body)}</div>
          )}

          <div className="ctx-links">
            {ctx.links.map((l) => (
              <span className="ctx-link" key={l.label} onClick={() => onToast("Opening " + l.label + "…")}>
                <span className="ic">
                  <LinkIcon size={11} />
                </span>
                {l.label}
              </span>
            ))}
            <span
              className="ctx-link add"
              onClick={() => {
                const label = window.prompt("Paste an issue or PR link (or a label)");
                if (label && label.trim()) {
                  const kind = /pull|\/pull\/|pr[\s#]/i.test(label) ? "pr" : "issue";
                  setCtx({ ...ctx, links: [...ctx.links, { label: label.trim(), kind }] });
                }
              }}
            >
              <Plus size={11} />
              Add link
            </span>
          </div>

          <div className="ctx-foot">
            <span className="hint">
              <Info size={12} />
              Seeds the agent · becomes the PR body
            </span>
            <span className="grow" />
            <button className="btn-sm" onClick={() => onToast("Context copied as PR body")}>
              <Copy size={12} />
              Use as PR body
            </button>
            <button className="btn-sm teal" onClick={onSeed}>
              <Sparkle size={12} />
              Start agent with this
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
