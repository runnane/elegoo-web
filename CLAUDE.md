# CLAUDE.md

Entry point for Claude Code, and **load-bearing** — measured 2026-08-14 on Claude
Code 2.1.232, a project-root `AGENTS.md` with no `CLAUDE.md` is not discovered.
Shrink this file, never delete it. The project conventions live in **AGENTS.md**,
imported below so they load every session.

@AGENTS.md

Topic deep-dives are in `.agents/` and are **not** auto-loaded — open the relevant one
on demand when working in that area:

- `.agents/gates.md` — the gate command (which is what CI runs), why green means very
  little here, and the printer boundary no gate can enforce
- `.agents/architecture.md` — one MQTT connection fanned out to WebSocket / REST /
  `/mcp` / Moonraker / OctoPrint / Telegram; which layer a change belongs in
- `.agents/deployment.md` — production is systemd `elegooweb.service` running from
  `/opt/elegooweb`, which is **not a git checkout**; what `IN_PRODUCTION` means here
- `.agents/testing.md` — what the suite covers (very little), how to probe a live
  printer **read-only**, and what nothing checks
- `.agents/security.md` — the exposure posture: the service is on the public internet
  with **no authentication**, and `/mcp` can drive the machine
- `.agents/mcp.md` — the `/mcp` surface, connecting a client, and the `MCP.md`
  doc-parity rule

## Commands — you invoke these

These come from the **userspace bundle** (`runnane/agent-userspace`), not from this repo
— ELEG-81 deleted the copies. Bare `/name` on a workstation, or `/agent-userspace:name`
when loaded with `--plugin-dir`. They read [`.agents/repo.json`](.agents/repo.json) to
learn this repo's gate command, tracker project, CI and release model, so they behave
correctly here without carrying a paragraph about ELEG.

- `/fix <ELEG-123>` — one issue end to end: branch, implement, gates, PR, tracker.
- `/auto <ELEG-1 ELEG-2 …>` — a given, ordered list, worked serially and autonomously.
- `/sweep` — discovers its own queue and fans out to subagents in worktrees.
- `/plan`, `/research` — think first, record the outcome on the issue.

Three skills load on their own when they apply, also from the bundle:
`gate-failures` (a gate went red), `pr-hygiene` (opening or verifying a PR) and
`agent-isolation` (whose checkout is this). This repo's own gate particulars — the exact
command, the gaps, the traps — are in [`.agents/gates.md`](.agents/gates.md).

## The hard rule that is specific to this repo

**Never command the live printer to test a change.** Reads are fine; `set_temperature`,
`move`, `home`, `start_print`, `pause_print`, `stop_print` and `emergency_stop` drive a
physical machine with heaters and motors. Those are operator actions — give the exact
command and ask, never fire it. See AGENTS.md.
