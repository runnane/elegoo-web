# AGENTS.md

Guidance for coding agents (and humans) working in this repo. Follows the
[agents.md](https://agents.md) convention. Topic deep-dives live in
[`.agents/`](.agents/) and are **not** auto-loaded — open the relevant one on demand.

## What this is

A web frontend **and** a Node backend service for an **Elegoo Centauri Carbon 2
(CC2)** FDM printer. The service holds **one** MQTT connection to the printer and
fans that single state stream out to every consumer:

```
Printer MQTT ←→ MqttBridge (singleton) ←→ StateStore
                                             ↓
        ┌──────────┬──────────┬──────────────┼───────────┬──────────┐
     WebSocket   REST API   /mcp          Moonraker   OctoPrint  Telegram
    (browsers)  (+camera)  (MCP server)    (:7125)     (compat)    (bot)
```

Work is tracked in the **ELEG** project of our own control-plane portal, reached over
the `respawn-control` MCP server. [`.mcp.json`](.mcp.json) wires it up but deliberately
contains **no URL and no token** — this repository is public, so both come from the
environment:

```bash
export RESPAWN_MCP_URL='https://<portal-host>/mcp?modules=issues'
export RESPAWN_MCP_TOKEN='<api key>'
```

Set those in your shell profile (not in a file in this repo). With them unset the MCP
server simply fails to connect, and the `/`-commands below will tell you to fix it
rather than guessing at issue state.

**The thing on the other end is a physical machine with heaters and motors.** That
single fact is what makes this repo different from its siblings, and it has its own
rule below.

## Setup

```bash
pnpm install
cp .env.example .env       # set PRINTER_IP at minimum
pnpm dev                   # vite on :5173 + the service on :8088, concurrently
pnpm dev:web               # frontend only
pnpm dev:service           # service only (tsx watch)
```

Node ≥ 22, pnpm 10.x. There is no database and no container needed for development.

## Build / test / lint (run before finishing any change)

```bash
pnpm gates          # ⭐ everything, in CI's order (scripts/gates.sh)
pnpm gates --fix    # biome --write first, then the gates — commit what it rewrites
```

`pnpm gates` is the one to run: `biome ci src/` (**non-writing**, as CI does it),
`tsc` (the browser half), **`pnpm service:check`** (the server + telegram half —
the typecheck CI does *not* run), `vite build`, and `vitest run`. The individual
scripts still exist for a tight inner loop; details, traps and the known gaps are in
[`.claude/commands/local/gates.md`](.claude/commands/local/gates.md).

CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on `ubuntu-latest` —
which works here because **this repo is public** and public repos get free hosted
Actions minutes (the private siblings do not, hence their self-hosted runners).

## Non-negotiable conventions

- **Never command the live printer to test a change.** This is the analogue of the
  sibling ANS repo's live-infrastructure boundary, and it is stricter here because
  the consequences are physical: `set_temperature` heats a real nozzle, `move` and
  `home` drive real motors into whatever is on the bed, `start_print` starts a
  print, `emergency_stop` aborts someone's 14-hour job. Reads are fine and
  encouraged — `GET /api/health`, `/api/status`, `/api/metrics`, the MCP
  `printer://*` resources, `pnpm dev` against the live printer, watching the MQTT
  log. **Writes are for a human at the machine**, and that makes them *operator
  work* (see the rule below). If a change genuinely cannot be verified without a
  command, say so, give the exact command, and ask — never fire it and report the
  result.
- **TypeScript strict, ESM, and `.js` on every relative import.** `import { loadConfig }
  from './config.js'` — the extension is required, not decorative: production runs
  the TypeScript **directly** under `node --import tsx`, so the specifier has to be
  the one Node resolves. Dropping the `.js` works in vite and breaks the service.
- **There are three tsconfigs and CI only checks one of them.** `tsconfig.json`
  covers the browser half and **excludes `src/server` and `src/telegram`**;
  `tsconfig.server.json` covers those (via `pnpm service:check`). `pnpm build` runs
  the first one only, so the **entire backend can be type-broken while `pnpm build`
  and CI are green**. Always run `pnpm gates` (or `pnpm service:check` by hand)
  after touching `src/server/**` or `src/telegram/**`.
- **One MQTT connection, and it belongs to `MqttBridge`.** Never open a second
  client, from a route, a tool, the bot or a test — the printer's broker is small and
  a second registration fights the first. New consumers read from `StateStore` (or
  subscribe to its events) and publish through the bridge. `src/server/index.ts`
  wires exactly one of each; keep it that way.
- **The frontend is hand-written TypeScript + DOM.** No framework, no JSX, no
  component library: `src/main.ts` composes modules from `src/ui/*.ts`, styling is
  CSS custom properties in `src/styles/`. Match the surrounding idiom rather than
  introducing a framework in one card.
- **MCP tools and [`MCP.md`](MCP.md) change together.** `MCP.md` is the documented
  contract for the `/mcp` surface (resources, tools, parameters). A tool added,
  renamed, or given a new parameter without the doc edit in the same commit is drift
  in the only place agents look. Same for `README.md`'s environment-variable table
  when `src/server/config.ts` gains a key.
- **Secrets stay server-side and out of git.** `PRINTER_PASSWORD`,
  `TELEGRAM_BOT_TOKEN`, `AI_VLM_API_KEY` are read from the environment
  (`.env`, which is gitignored) at runtime — never hardcoded, never returned to the
  browser, never logged, and **placeholders only** in `.env.example`,
  `docker-compose.example.yml` and anything else committed. Mirrors the org
  data-protection policy: no real credentials or PII in committed files, issue
  comments, or outbound requests. (The vendor default `elegoo`/`123456` in the README
  is documentation of a published protocol default, not a secret.)
- **Conventional commits are the changelog.** There are no changesets here: release
  is `release-it` with `@release-it/conventional-changelog`, so the commit subject
  *is* the release note. `feat:` → minor, `fix:` → patch, and anything user-visible
  needs one of those rather than `chore:`.
- **Branch → commit → PR, always from fresh `main`.** Finished work never sits as
  uncommitted working-tree changes. Branch `<type>/<eleg-lower>-<kebab-title>`
  (e.g. `feat/eleg-12-layer-chart-zoom`), a conventional commit, one PR, and
  `gh pr create --base main` **explicitly** — `gh` otherwise defaults to the tracked
  branch, which is how a PR merges into a dead branch and never reaches `main`.
  Sync twice: before cutting the branch, and again (`git fetch` + rebase + re-run the
  gates) before opening the PR if `main` moved.

  **Preflight `git switch`, because this checkout is shared.** More than one agent
  works this machine. Check `git rev-parse --abbrev-ref HEAD`,
  `git status --porcelain` and `git worktree list` first; **if `HEAD` is already a
  topic branch, stop and report it** — that is someone else's work in flight, and
  `git switch` carries modified files across. Unrelated dirt is left alone; a dirty
  file *this* issue will touch is an overlap and also a reason to stop. Never stash,
  reset or `git checkout <file>` to clear your path. See
  [`shared/agent-isolation.md`](.claude/commands/shared/agent-isolation.md) and
  [`shared/pr-hygiene.md`](.claude/commands/shared/pr-hygiene.md).
- **One issue → one PR → one merge, and the status is automated.** The tracker's PR
  webhook moves ELEG issues off GitHub events: draft PR → `IN_PROGRESS`,
  opened/readied → `IN_REVIEW`, merged → `MERGED`, closed unmerged → `TODO`. Two
  consequences:
  - **The branch name is what makes it work.** The transition needs the issue key in
    the PR's **branch or title**; a key only in the body is recorded as an
    association and moves nothing. The `<type>/<eleg-lower>-…` convention satisfies
    this by construction.
  - **The automation never moves an issue backwards** out of `MERGED`,
    `IN_PRODUCTION`, `DONE` or `CANCELLED` — so a status you set wrongly by hand will
    not be corrected later. Comment on start and finish; let the automation move the
    status.

  A sub-issue's status also cascades to its parent (a child reaching `IN_PROGRESS`
  starts a `BACKLOG`/`TODO` ancestor; a parent whose every non-`CANCELLED` child is
  `DONE` becomes `DONE`), so don't hand-maintain an epic's status.
- **`IN_PRODUCTION` is real here, and merging is not it.** ELEG has
  `tracksProduction` on because production is a *separate step*: the service runs
  from **`/opt/elegooweb`**, which is **not a git checkout**, under systemd as user
  `elegooweb`. A merged PR changes nothing that is running. See
  [`.agents/deployment.md`](.agents/deployment.md) — and note that performing the
  deploy is operator work.
- **An issue is either repo work or operator work — never both.** Repo work is done
  when its PR merges; operator work is done when a human has run something against
  the live service or the printer and recorded the result. An issue holding both can
  never close cleanly. So when repo work needs a deploy or a printer command
  afterwards, **file that as its own `OPERATOR:`-titled issue**, self-contained: why
  it matters, the exact copy-pasteable commands, what to capture before, and how to
  verify at the *receiver* rather than at the exit code.

  **But "this is operator work" is never where you stop.** An `OPERATOR:` issue is a
  collaboration: say what needs running and why, work out **who can actually run
  it**, give the exact commands, then **ask for the output**, interpret it, and record
  the result on the issue either way.

  | Action | Who runs it |
  | --- | --- |
  | shell on this host, `systemctl`, reading `/opt/elegooweb`, `journalctl` | **them** — give exact commands, ask for output |
  | anything through an MCP tool or a tracker write | **you** — never "here are the MCP calls to make"; they have no client for it |
  | a printer command (temps, motion, print start/stop, emergency stop) | **them**, at or near the machine |

  And the distinction that decides most of these: **stopping something is not the same
  as starting it.** Stopping a runaway notification loop or disabling a feature flag is
  the safe, reversible direction; arming something — or touching the printer — is the
  direction that needs a human.
- **Follow-ups become issues — never inline TODO text.** Any deferred work,
  degradation or "later" item is filed via `issues_create_issue`, after a **duplicate
  search**: `issues_list_issues {project: "elegoo-web", q: "<distinctive word>",
  order: "newest"}` with **no** `status` filter (a duplicate that is already `DONE` is
  still a duplicate). Paging the project instead does not work. This applies
  everywhere — issue comments, code, docs, chat output. Never write "follow-up:",
  "TODO:" or "worth doing later" as prose without an issue key attached.
- **Never leave an issue partly implemented — split it instead.** If an issue is too
  big, or part of it is blocked, decompose the **entire** scope into sub-issues
  (`issues_create_issue` with `parent`), each independently completable, so the
  original becomes a small epic that finishes when its last child does. A remainder
  that exists only as prose in a comment is the failure mode this prevents.
- **Reading an issue means reading all of it.** `issues_get_issue` is slim by default
  — comments, links and attachments come back as *counts*. Always pass
  `include: ["comments","links","attachments"]` before acting on one, and actually
  fetch any attachment. Decisions get recorded as comments; an issue still
  `blockedBy` an open one is not ready to start.
- **An issue's stated blocker is a claim, not a fact.** "This needs X", "the firmware
  doesn't expose that", "the printer can't do it" is what someone believed when they
  filed it. Before accepting the scope a blocker implies — and especially before
  deferring — spend the two minutes that settle it: read the MQTT log, grep the
  protocol handling, check the file is actually in this tree. Then **record the
  outcome on the issue either way**.
- **Comment on the issue when you start and when you finish** (`issues_add_comment`):
  on pickup, that work has begun and what the approach is; at the end, what changed
  (files, surfaces, config), what you ran, and the PR URL.
- **Label issues where a label adds value.** Type — `bug` / `feature` /
  `improvement` / `chore` / `docs` / `tests` — and optionally area — `UI` / `API` /
  `MCP` / `infra` / `monitoring`. Reuse the project's existing labels
  (`issues_list_labels`) rather than inventing near-duplicates, and don't force one
  when none fits.
- **The full text goes in the description; the title is a summary of it.** `title` is
  capped at 200 characters and `description` at 20 000. Never truncate a long report
  into the title and pass the truncated string as the description — everything past
  the cut is lost permanently, and that exact shape is refused with a 400.
- **Capture durable learnings — don't relearn them.** A gotcha, a workflow step, a
  project constraint: write it down in the same change. Project facts → this file or
  the relevant [`.agents/`](.agents/) deep-dive. Workflow / how-to-run steps → the
  matching command under [`.claude/commands/`](.claude/commands/) (repo particulars go
  in `local/gates.md`). Cross-session context → persistent memory. Prefer updating the
  existing entry over adding a near-duplicate.

## This file is the source of truth for conventions

[`CLAUDE.md`](CLAUDE.md) exists only to import this file so it loads every session,
plus a pointer at the `.agents/` deep-dives. Put project conventions **here** (or in
the relevant deep-dive), not there — a rule that lives in only one of the two will be
missed by whichever tool reads the other.

## The agent tooling is shared across five sibling repos

`~/dev/respawn-control` (**RCP**), `~/ansible` (**ANS**), `~/dev/spond-js` (**SPND**),
`~/dev/vaulali-trial-klubb-webpage` (**VTK**) and this repo (**ELEG**) run the **same
agent workflow against the same tracker** — `/plan`, `/research`, `/fix`, `/auto`,
`/sweep`, one PR per issue, follow-ups-become-issues. They are meant to stay in sync
**in every direction**: when any side learns something, it reaches the others *adapted
to their gates*, never pasted.

**How it reaches them: by a filed issue, not by editing their checkout.** An agent
commits only in the repo it was invoked in. A lesson that belongs in a sibling is
ported by filing a linked issue in that repo's project — that repo has its own gates,
its own reviewer, and quite possibly its own agent working in it right now.

**Three tiers, by who owns the bytes:**

- **`.claude/commands/shared/*.md` — byte-identical in every sibling**, verified with
  `sha256sum`. They name **no** command, runner or linter; that is what makes
  byte-identity achievable. **Never edit one in a single repo** — a shared file edited
  in one place is the bug, not the fix, and that includes a *formatter* reaching
  `.claude/**`, which rewrites the bytes with nobody having edited a word. (biome is
  scoped to `src/**` here, so it does not — re-check if `files.includes` is ever
  widened.)
- **`.claude/commands/local/*.md` — the repo-flavoured addon**, owned by this repo and
  **never synced**. `local/gates.md` holds the exact gate command, the known gaps and
  the traps. A difference here is not drift.
- **The command bodies stay repo-flavoured** and merely *point* at both, on demand.

**Adapt, don't copy.** What changes in translation to this repo:

| Elsewhere | Here (ELEG) |
| --- | --- |
| `pnpm gates` = build / biome / vitest / knip / playwright (RCP) | `biome ci` / `tsc` / **`service:check`** / `vite build` / `vitest run` — no knip, **no e2e, no browser test at all** |
| changesets on every user-visible change (RCP, SPND, VTK) | none — `release-it` + conventional commits are the changelog |
| ANS's live-infrastructure boundary (never `ansible-playbook` at a host) | the **physical-printer** boundary — never command the machine to test |
| no live-host concept (SPND) | production is systemd on *this* host, from a non-git `/opt/elegooweb` |

## Where things are

| Area | Path |
| --- | --- |
| Service entry point (wires everything) | `src/server/index.ts` |
| MQTT bridge (the single connection) | `src/server/mqtt-bridge.ts` |
| Shared state + events | `src/server/state-store.ts` |
| REST API + camera proxy | `src/server/rest-api.ts` |
| MCP server (`/mcp`) | `src/server/mcp-server.ts` (documented in `MCP.md`) |
| Moonraker / OctoPrint compat | `src/server/{moonraker-compat,moonraker-server,octoprint-compat}.ts` |
| AI print monitor | `src/server/ai-monitor.ts` |
| Telegram bot | `src/server/telegram.ts`, `src/telegram/**` |
| Config / env parsing | `src/server/config.ts` |
| Frontend entry | `src/main.ts`, `index.html` |
| Frontend cards / views | `src/ui/*.ts` |
| Shared types | `src/types.ts` |
| Tests | `src/__tests__/**` |
| systemd unit + installer | `contrib/` |
| Roadmap | `TODO.md` |

## Deep dives

- [.agents/architecture.md](.agents/architecture.md) — the fan-out, the two HTTP
  servers, state flow, and which layer a change belongs in.
- [.agents/deployment.md](.agents/deployment.md) — `/opt/elegooweb`, the systemd unit,
  the cloudflare tunnel, and what `IN_PRODUCTION` means here.
- [.agents/testing.md](.agents/testing.md) — what the suite actually covers (very
  little), how to probe safely against a live printer, and what nothing checks.
- [.agents/security.md](.agents/security.md) — the exposure posture, the
  unauthenticated control surface, secrets, and the org policy.
- [.agents/mcp.md](.agents/mcp.md) — the `/mcp` surface, how to connect a client, and
  the doc-parity rule.

## Definition of done

`pnpm gates` green (biome + both typechecks + build + tests), `MCP.md` / `README.md`
updated if a documented surface changed, `TODO.md` updated if a roadmap item moved, a
conventional commit subject that reads as a release note, no secrets committed, the
issue commented and its PR open.
