# Copilot instructions

See [`AGENTS.md`](../AGENTS.md) in the repo root. That is the single source of truth for
this repo's conventions, with topic deep-dives in [`../.agents/`](../.agents/) and the
machine-readable facts in [`../.agents/repo.json`](../.agents/repo.json).

This file is a pointer, not a second copy. It used to carry its own 298-line description
of the architecture, the key files and the conventions — a full parallel copy that would
drift the way every such copy in this repo set has. SPND-1 and IPADR-7 are the worked
examples: in both, the stale second copy was actively advising the wrong fix by the time
anyone read it.

Two notes for anyone tempted to grow this file back:

- **This repo is public.** Nothing here may carry credentials, keys, customer or employee
  data, contract terms, pricing, security configuration, or infrastructure detail that
  could aid an attacker. Where a fixture would otherwise contain such data, **generate**
  it rather than sanitise it — sanitising is a process that fails silently once.
- The printer's `elegoo`/`123456` login is a **published vendor default**, documented as
  such in the README and in `AGENTS.md`, not a secret. Real credentials —
  `PRINTER_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `AI_VLM_API_KEY` — come from the environment
  at runtime and are never committed.
