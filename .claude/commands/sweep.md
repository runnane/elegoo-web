---
description: Work the ELEG issue queue in parallel — spawn subagents per issue (model sized to the work), two at a time, each on its own branch + PR, verify between batches, keep the tracker updated.
argument-hint: "[only: ELEG-1 ELEG-2 …]"
---

Orchestrate a sweep of the **elegoo-web** issue queue (project `elegoo-web`, key `ELEG`)
via the `respawn-control` MCP server. You are the **orchestrator**: you never implement
issues inline (except the noted cases) — you dispatch subagents, verify, open a PR per
issue, and keep the tracker truthful.

Given an explicit, ordered list of issues instead of a queue to discover — or coupled
issues where each needs the previous one merged first — use [`/auto`](auto.md), which
works a fixed list serially and inline.

**Every issue lands on its own branch as its own pull request.** Because each issue is
isolated on its own branch, subagents work in **separate git worktrees**, not a shared
tree.

## 1. Build the queue

- `issues_list_issues` for project `elegoo-web`, statuses `TODO`, `IN_PROGRESS`, and
  `BACKLOG`.
- **Eligible:** issues that are **unassigned or assigned `claude`**. Never touch an issue
  assigned to anyone else.
- Skip issues **blocked by** an unfinished issue (incoming `BLOCKS` link). Finished is
  `MERGED`, `IN_PRODUCTION`, `DONE` or `CANCELLED` — a blocker whose code has merged no
  longer blocks.
- **Skip anything `OPERATOR:`-titled, and anything whose completion needs a printer
  command or a deploy.** A sweep is unattended by construction: no subagent and no
  orchestrator commands the printer, restarts `elegooweb.service`, or writes into
  `/opt/elegooweb`. List these in the report as needing a human, with their commands.
- Epics (issues whose children cover the work): don't dispatch — close them yourself when
  every child is finished by that same definition.
- Order: `IN_PROGRESS` first, then `TODO` by priority, then `BACKLOG`.

## 2. Size each issue → pick the model

| Weight | Signals | Model |
| --- | --- | --- |
| trivial | doc/text tweak, config value, label fix | do it yourself inline (still on its own branch + PR) |
| light | well-specified single-surface change (one card, one route, one MCP tool) | `sonnet` |
| heavy | protocol/state-store work, a new subsystem, cross-cutting refactor, ambiguous spec | `opus` |

**Protocol and state-store work deserves `opus` even when the diff looks small.** The
delta-merge semantics (an absent field means *unchanged*) are the least-tested and
most-load-bearing logic in the repo, and a plausible-looking change there breaks
production silently.

System-state issues are **orchestrator-only** and, on this repo, mostly **not workable at
all in a sweep** — see the skip rule above.

## 3. Dispatch in pairs (one worktree + branch each)

Take **two issues at a time**, one background subagent each (single message, parallel
`Agent` calls, `isolation: 'worktree'` so each gets an isolated checkout off the current
`main`). The worktree is what makes parallel dispatch safe — without it two subagents
share one `HEAD` — and **you own its removal** once the PR is open (step 6 of §4). Before
dispatching a pair: `issues_update_issue` → `IN_PROGRESS`, assignee `claude`, and add a
**start comment**.

Every subagent prompt must include:

- The issue key + instruction to load it via `issues_get_issue` **passing
  `include: ["comments","links","attachments"]`**, and to read `AGENTS.md` plus the
  relevant `.agents/*` deep-dives.
- **The `include:` is not optional, and neither is reading what it returns.** Without it
  `issues_get_issue` returns comments, links and attachments as _counts only_, so the
  subagent works from the description alone and never learns what it missed. Comments are
  where corrections, rejected approaches and **the user's own instructions** live. If
  `counts.attachments` is non-zero it must `issues_list_attachments` and `Read` each
  `url`, and **say so** if it cannot render one.
- **The printer boundary, verbatim in every prompt:** *never* call a tool or endpoint that
  commands the printer (`set_temperature`, `fan`, `led`, `home`, `move`, `start_print`,
  `pause_print`, `resume_print`, `stop_print`, `emergency_stop`), never restart the
  service, never write to `/opt/elegooweb`. Reads are fine. If the change cannot be
  verified without one, report that instead of doing it.
- **Do not run `pnpm dev` / `pnpm dev:service`.** Production holds ports 8088 and 7125 on
  this host, and a second service process opens a **second MQTT registration to one
  printer**, degrading production rather than the worktree. `pnpm dev:web` (vite, :5173)
  is allowed and is the right tool for a UI change.
- **Branch:** create `<type>/<eleg-lower>-<kebab-title>` (feat/fix/chore/docs) in the
  worktree before implementing.
- Architecture rules: protocol parsing in the bridge, derived state in the **store**,
  REST/MCP/Telegram as consumers of it; `.js` extensions on relative imports; a `/mcp`
  change edits `MCP.md` in the same commit; a new endpoint is a new **unauthenticated**
  endpoint (`.agents/security.md`).
- **No changeset** — the conventional commit subject is the changelog (`feat:`/`fix:`).
- **Verify** in the worktree: `pnpm gates --fix` (biome ci + **both** typechecks + build +
  tests) and commit what biome rewrites. Report exactly what is and is not covered by a
  test.
- **Commit** on the branch with a conventional message ending in
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do **not** push
  or open the PR — the orchestrator does that after full verification. Report the branch
  name + a summary back.
- **Follow-ups become issues, never inline text.** Deferred work is reported to the
  orchestrator, who files it after a duplicate check (`issues_list_issues {project, q,
  order: "newest"}`, no `status` filter). A "follow-up:" line without an issue key is a
  defect.
- **An issue that's too big gets split, never half-shipped.** A subagent that finds its
  issue doesn't fit reports the decomposition instead of delivering part of it.
- Org policy: placeholders only in committed files — **this repo is public**, so a
  committed secret is a published secret. Camera images and print reports are personal
  data; never commit one as a fixture.

Because branches are isolated, two issues touching the same file (`src/main.ts`,
`src/types.ts`, `src/server/index.ts`, `src/server/rest-api.ts`, `README.md`, `MCP.md`)
no longer race — overlap surfaces as a normal merge conflict on the **second** PR.

## 4. Verify + open a PR per issue (orchestrator)

When both agents of a pair report back — never while one is still running:

1. In each issue's worktree run `pnpm gates --fix` and **commit whatever biome
   rewrites**. On failure, bounce back to a `SendMessage`-resumed agent; don't open a PR
   on a red build. A fresh worktree can use `pnpm install --frozen-lockfile` again — the
   `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` that forced a plain `pnpm install` was fixed by
   ELEG-4. See [`local/gates.md`](local/gates.md).
2. **Re-run the verification yourself, and correct the subagent's account of what it
   proves.** Green gates in this repo mean "it compiles, it is formatted, and two pure
   functions still work" — six tests, no browser check, no server-side coverage at all. A
   subagent's report of "verified" is very often just that. Five items:

   1. **Break the invariant and watch the named test go red** — and where no test covers
      it, make sure the closing comment *says* so instead of implying coverage.
   2. **Grep the diff for `it(`/`test(` blocks with no `expect(`.**
   3. **Read the state-merge path yourself** if it was touched.
   4. **Look at the page** for any UI change. Nothing else catches a card that renders
      empty, and no subagent report substitutes for looking.
   5. **Verify every identifier the subagent introduced** — route path, MCP tool name,
      env var, `/ws` message `type` — exists on both sides. A plausible invented one is
      the failure mode here, and `MCP.md` is checked by nothing.

   Undo each mutation with an inverse patch, **never `git checkout <file>`** — see
   [`shared/gate-failures.md`](shared/gate-failures.md) §6.

   **Check, don't assume the subagent is wrong either** — the point is independent
   verification of the specific claim, not distrust. Phrases like *"verified by code
   logic"* mean it re-read what it just wrote; treat them as "not verified".
3. Push the branch and open its PR: `git push -u origin HEAD` then
   `gh pr create --base main` (title = commit subject; body = summary + `ELEG-…` +
   follow-up keys + verification results, ending with
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`).
4. **Check the PR landed clean.** `gh pr view <n> --json mergeable,mergeStateStatus`: if
   `CONFLICTING`/`DIRTY`, rebase that branch on the latest `main`, resolve, re-verify,
   force-push. `gh pr checks <n>`: read **which step** failed. CI on this repo is green
   on `main` (since ELEG-1 and ELEG-4), so there is no standing red to attribute a
   failure to — it is the branch's until reading the step says otherwise.
5. Per issue: add a closing **verification comment** (what you ran, what it proves and
   what it cannot, surface recap, follow-up **issue keys**, **PR URL**, mergeable + CI
   status) and `issues_update_issue` → `IN_REVIEW` — which opening the PR already did, so
   this is a confirmation and a no-op if the automation fired. **`MERGED`** arrives on
   merge; never set it by hand, and not `DONE`. **Never set `IN_PRODUCTION`** — that
   needs a deploy a sweep does not do. The automation needs the issue key in the PR
   **branch or title**.
6. **Remove the worktree.** Once the PR is open the branch carries the work, and the
   worktree is pure liability: invisible in `git status`, in a diff and in a PR —
   `git worktree list` is the only place it exists — and each one costs a full
   `node_modules` (this repo's includes `sharp`, `three` and
   `@huggingface/transformers`, so it is large).
   ```bash
   git worktree list                    # confirm what you are about to remove
   git worktree remove <path>           # refuses if it holds uncommitted changes
   ```
   **If it refuses, do not force it.** Commit whatever is there onto its own branch first
   (an explicit `wip:` commit is fine) and only then remove — a teardown is not the moment
   to decide a subagent's uncommitted edits were worthless. See
   [`shared/agent-isolation.md`](shared/agent-isolation.md).
7. Update `TODO.md` if a roadmap item moved; close any epic whose children are all merged.
8. Dispatch the next pair. Repeat until the queue is empty.

## 5. Report

End with: issues completed (one-line outcome + **PR URL** each), issues skipped and why
(assigned to others, blocked, **or needing a printer command / deploy**), what each change
was actually verified by, and follow-ups filed (issue keys only, deduplicated).

**A sweep is not finished while one of its worktrees still exists.** Run
`git worktree list` as the last act and paste it into the report: it should show the
primary checkout and nothing this pass created. A leftover worktree is not a tidiness
problem — it is unreviewed work sitting where no one will look for it.
