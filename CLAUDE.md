# CLAUDE.md

Entry point for Claude Code. The project conventions live in **AGENTS.md**,
imported below so they load every session.

@AGENTS.md

Topic deep-dives are in `.agents/` and are **not** auto-loaded — open the relevant one
on demand when working in that area:

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

`.claude/commands/*.md`, run as `/name`:

- `/fix <ELEG-123>` — one issue end to end: branch, implement, gates, PR, tracker.
- `/auto <ELEG-1 ELEG-2 …>` — a given, ordered list, worked serially and autonomously.
- `/sweep` — discovers its own queue and fans out to subagents in worktrees.
- `/plan`, `/research` — think first, record the outcome on the issue.

Two reference files are read **on demand**, at the moment they apply:

- `/shared:gate-failures` — what to do when a gate goes red (byte-identical across the
  sibling repos, so it names no tool).
- `/local:gates` — this repo's exact gate command, its gaps and its traps.
- `/shared:pr-hygiene`, `/shared:agent-isolation` — PR/tracker rules and the
  one-checkout-one-agent rules, also byte-identical across the siblings.

## The hard rule that is specific to this repo

**Never command the live printer to test a change.** Reads are fine; `set_temperature`,
`move`, `home`, `start_print`, `pause_print`, `stop_print` and `emergency_stop` drive a
physical machine with heaters and motors. Those are operator actions — give the exact
command and ask, never fire it. See AGENTS.md.
