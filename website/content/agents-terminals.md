---
title: Terminals and agents
description: Real shells per worktree, coding agents that start knowing where they are, and the handoff Canopy writes for them.
---

# Terminals and agents

A worktree can hold as many shell and agent sessions as you like. Each is a real PTY in the Rust
backend, running in the worktree's directory, on its pinned toolchain, through your login shell.
Sessions keep running when you switch worktree, and they survive a webview reload.

## Terminals

!shot layout-terminal | The Terminal pane with no session open.

Open one with `⌘5` (Terminal), `⌘4` (Terminal + Logs), the sidebar row's terminal button, the overview
row's terminal button, or `⌘K → Open terminal here`.

Each tab is a login shell in the worktree root. **+** adds another, and tabs are named `Shell`,
`Shell 2`, and so on. Closing a tab kills its PTY. Idle shell sessions are swept after an hour of
inactivity, which keeps memory and threads in check across a long day of visiting many worktrees.
Agent sessions are exempt.

## Agents

An agent here is a coding-agent CLI (Claude Code, Codex, Aider, whatever you use) launched as its own
PTY with Canopy's structured handoff as its first prompt.

You configure the launchers per repository in [Settings → Agents](settings-repository.html): a name,
the command, and whether to prompt on launch. The first profile is the default. Configure more than
one and starting an agent asks which; with one, it stays a single click.

!shot layout-agent | The Agent pane: the context bar above, and the empty state below.

Start one with `⌘3` then **Start agent**, the next-action button when it reads *Start agent*,
`⌘K → Start agent here`, or **Start agent** from the context editor (`⌘⏎`).

### What launching actually does

1. Reads the worktree's persisted context, so an edit you made a moment ago is included.
2. Writes the full handoff to `<worktree>/.canopy/context.md`, creating the directory and a
   self-ignoring `.gitignore` beside it, and never overwriting one that's already there.
3. Composes a compact prompt and runs `<your command> '<prompt>'` as the session's command, unless the
   profile has **Prompt on launch** off. That's for CLIs that take no positional prompt, and they still
   get the file.

The agent is the session's command, so the tab flips to "ended" exactly when the agent exits. If an
agent dies within 2.5 seconds of starting, Canopy tells you: *"Claude exited immediately — check the
agent command"*, because that nearly always means the command is wrong.

The composed prompt looks like this:

```text
Work on <task title>. Read the complete Canopy handoff at
<worktree>/.canopy/context.md before making changes. Worktree: <repo>/<branch>;
database: <db name>; ports: Frontend:3010, Server:4010.
```

## The context editor

⋯ → **Context…**, or the context bar at the top of the Agent pane.

!shot modal-context | Context: a task, references, the runtime the agent inherits, and links.

| Section | What it's for |
|---|---|
| **Task** | A title plus a markdown body, with **Write** and **Preview** tabs. This is the brief. |
| **References** | A pull-request URL and what it changes; an issue URL and the problem. Carried over from the New worktree dialog if you filled that in. |
| **Runtime the agent inherits** | Read-only: the branch, every service port, and the database name. |
| **Links** | Free-form links. Type one and press `⏎`. |

Two ways out: **Copy as PR body** puts the whole composed markdown on the clipboard, the same document
the agent read, and **Start agent** (`⌘⏎`) launches with this context.

The context bar in the Agent pane shows the current title, or *"No task set — the agent still inherits
branch, ports and database"* when there isn't one. That's literally true: a blank brief still produces
a handoff with the runtime facts in it.

### The handoff file

`.canopy/context.md` is assembled in this order: the title as an `H1`, the body, a **Pull request**
section, an **Issue** section, a **Worktree** section (repository, branch, path, database, ports), then
**Files** and **Links** lists when they aren't empty.

Context is stored per worktree in the webview's `localStorage` under `canopy.ctx.<worktree path>`, so
it's per machine. Whether it should instead be a committed file that travels with the branch is still
an open question in the project.

## Sessions and detached windows

The tab strip holds one chip per session, with a state dot (running or idle), the title, and a close
button. The pop-out control sits to the right.

**Pop out** opens the session in its own small always-on-top window (560×360, undecorated, resizable)
titled `<session> — <branch>`. The inline pane shows a placeholder saying *"Running in a detached
window"*, with **Bring back**. Closing a popped-out tab takes its window with it, so you never end up
with a window attached to a PTY that's gone.

**Restart** on an ended session re-docks it first if it was detached, then creates a fresh PTY, so the
tab can't claim to be running while nothing is.

An ended session keeps its output readable, with a bar offering **Restart** and **Close**.

## Common layouts

| Layout | Keys | Why |
|---|---|---|
| Agent | `⌘3` | The agent takes the window. |
| Split | `⌘2` | Logs beside the agent, so you watch the app react to what it changes. |
| Terminal + logs | `⌘4` | Your own commands beside the service output. |
| Terminal | `⌘5` | Just the shell. |

The Agent tab shows a pip when an agent session is live, so you can see it from a layout that isn't
currently showing that pane.

## What isn't there yet

:::warn Coming soon
- **Waiting detection.** Canopy can't yet tell an agent that's working from one blocked on a prompt;
  `LaneSession` only knows whether the process is running. Every "waiting" render path exists
  ([issue #54](https://github.com/emidhun/canopy/issues/54)).
- **Per-agent context toggles and a concurrency limit** appear in Settings → Agents as coming soon.
  Today Canopy seeds the worktree context by default.
- **Embedded-shell settings** (program, font, scrollback) aren't configurable. The shell is your login
  shell.
:::
