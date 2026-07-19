# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead:

- Use GitHub's [private vulnerability reporting](https://github.com/emidhun/canopy/security/advisories/new), or
- Email **idhutest@gmail.com** with details and reproduction steps.

You'll get an acknowledgement within a few days. Please allow a reasonable window
for a fix before public disclosure.

## Scope notes

Canopy runs local shell commands **by design** (services, setup/teardown from
`.worktreemanager.json`). Reports along the lines of "a malicious repo config can
run commands" are expected behavior — treat repo configs like you treat a
`Makefile`. In-scope examples: command execution *outside* configured commands,
path traversal writing outside the worktree, privilege escalation, or leaking
secrets between worktrees.
