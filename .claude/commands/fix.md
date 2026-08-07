---
description: Implement a fix/feature for an ELEG issue end-to-end, verify, open a PR, and update the issue.
argument-hint: "<ELEG-123>"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, mcp__respawn-control__issues_get_issue, mcp__respawn-control__issues_list_attachments, mcp__respawn-control__issues_list_issues, mcp__respawn-control__issues_create_issue, mcp__respawn-control__issues_update_issue, mcp__respawn-control__issues_add_comment, mcp__respawn-control__issues_list_labels, mcp__respawn-control__issues_add_label
---

Implement the work for issue **$ARGUMENTS** in the **elegoo-web** project (key `ELEG`),
via the `respawn-control` MCP server. If those MCP tools are unavailable, stop and ask
the user to connect it — `.mcp.json` reads `RESPAWN_MCP_URL` and `RESPAWN_MCP_TOKEN`
from the environment, so an unset variable is the usual cause.

For several issues in one go: [`/auto`](auto.md) works a given list serially and
autonomously, [`/sweep`](sweep.md) discovers its own queue and fans out to subagents.
Both defer to this file for what "doing an issue" means.

**Every issue lands on its own branch as a pull request** — always branch, commit, and
open a PR (you do not need to ask). Never commit to `main`.

1. **Load the issue** with `issues_get_issue` (`$ARGUMENTS`), **passing
   `include: ["comments","links","attachments"]`** — without it the call returns only
   _counts_ for those, and you will silently work from the description alone. Read all
   of it: description, comments, children, links. **The comments are not optional
   context** — corrections, rejected approaches and the user's own decisions live there.
   If `counts.attachments` is non-zero, `issues_list_attachments` and `Read` each `url`
   (Read renders images); if you cannot render one, **say so** rather than proceeding as
   if it did not exist. If the issue is **blocked by** an unfinished issue, stop and
   report the blocker. "Finished" is `MERGED`, `IN_PRODUCTION`, `DONE` or `CANCELLED` — a
   blocker whose code has merged no longer blocks.

   **Is this issue actually repo work?** If finishing it requires a deploy, a
   `systemctl` action, or a command sent to the printer, that part is **operator work**
   and belongs in its own `OPERATOR:` issue — see step 6 and `AGENTS.md`. Decide this
   now, not after implementing.
2. **Mark it in progress + comment + branch.** `issues_update_issue` → status
   `IN_PROGRESS`, and add a **start comment** (`issues_add_comment`) saying work has
   begun and what the approach is — it is the only signal to anyone else that this issue
   is taken. Set `assignee: claude` if unset, and apply a fitting type (+ area) label
   (`issues_add_label`, reusing `issues_list_labels` rather than inventing a
   near-duplicate). Then **preflight the checkout before touching it** — more than one
   agent works this machine:
   ```bash
   git rev-parse --abbrev-ref HEAD    # must be main
   git status --porcelain             # whose changes are these?
   git worktree list                  # who else is in this repo right now?
   ```
   **If `HEAD` is not `main`, stop and report the branch it is on.** A topic branch here
   means another session's issue is in flight, and `git switch` carries modified files
   across — switching away can commit their half-finished work onto your branch, or
   yours onto theirs. Do not switch, stash or reset to clear your path.
   See [`shared/agent-isolation.md`](shared/agent-isolation.md).

   Then cut a branch off the latest `main`:
   ```bash
   git switch main && git pull --ff-only
   git switch -c <type>/<eleg-lower>-<kebab-title>   # e.g. feat/eleg-12-layer-chart-zoom
   ```
   `<type>` = `feat` / `fix` / `chore` / `docs`, matching the issue. Unrelated dirty
   files are left alone; a dirty file *this issue will touch* is an overlap — stop
   rather than build on a state you did not create.
3. **Implement** per `AGENTS.md` and the relevant `.agents/` deep-dives (they are not
   auto-loaded — open the ones that apply):
   - [`.agents/architecture.md`](../../.agents/architecture.md) — which layer the change
     belongs in. Protocol parsing in the bridge, derived state in the **store** (so the
     WebSocket, `/mcp` and Telegram all see the same numbers), never a second MQTT or
     camera connection.
   - [`.agents/mcp.md`](../../.agents/mcp.md) — a `/mcp` change edits `MCP.md` in the
     **same commit**; nothing verifies that doc.
   - [`.agents/security.md`](../../.agents/security.md) — before adding any endpoint.
     The service has no authentication, so a new route widens an unauthenticated
     surface; say so on the issue.
   - [`.agents/testing.md`](../../.agents/testing.md) — where a test is worth writing,
     and why `pnpm dev` on this host collides with production.
   - Relative imports need the **`.js` extension** (`./config.js`) — production runs the
     TypeScript directly, so the specifier must be the one Node resolves.
   - Add/adjust tests for the behaviour you changed, and update `README.md`'s env table
     if `config.ts` gained a key.
4. **No changeset — the commit subject is the changelog.** Release is `release-it` +
   conventional commits, so a user-visible change needs `feat:` or `fix:` (not
   `chore:`), written as the release note someone will read.
5. **Verify — all green before you commit.**
   ```bash
   pnpm gates --fix     # biome --write first, then biome ci + both typechecks + build + tests
   ```
   `--fix` runs the **writing** biome pass first and you must **commit what it
   rewrites** — CI's check is non-writing, so an uncommitted auto-fix fails it. Re-run
   after your final edit so formatting is in the commit.

   **Then be honest about what that proved.** Six tests cover two pure functions;
   nothing covers the server, `/mcp`, the compat layers or any UI. So: break the
   invariant your change claims to protect and watch the *named* test go red — and if no
   test covers it, **say that** instead of implying the gates checked it. Look at the
   page for any UI change (`pnpm dev:web`, vite on :5173, which opens no printer
   connection). Verify every identifier you introduced exists on both sides — the `/ws`
   message contract is unasserted. Details and traps:
   [`local/gates.md`](local/gates.md); when a gate goes red:
   [`shared/gate-failures.md`](shared/gate-failures.md).

   **Never command the printer to verify.** Reads are fine; temps, motion, print
   start/stop and emergency stop are operator actions — name the command and ask.
6. **File follow-ups as issues first** — hard rule: any deferred work or degradation you
   noticed becomes an `issues_create_issue` (dedupe first with `issues_list_issues
   {project: "elegoo-web", q: "<word>", order: "newest"}` and no `status` filter — a
   search, not a page-through); never leave it as inline "follow-up:"/"TODO" prose in
   comments, code, or your report. Anything needing a live apply — a deploy, a restart, a
   printer command — is filed as its own `OPERATOR:` issue with the exact commands and
   what to read afterwards.

   **If the issue itself is too big to finish, split it — don't ship half.** Decompose
   the *whole* remaining scope into sub-issues (`issues_create_issue` with `parent` =
   this issue), each independently completable; the parent becomes a small epic that
   completes when its last child does. Set the child you are delivering to
   `IN_PROGRESS`, leave the parent open, and never let a remainder live only as prose.
7. **Commit + open the PR.** Stage only this issue's files (never `git add -A` blindly if
   unrelated changes exist). **Re-sync with `main` first**: `git fetch origin` and check
   whether `origin/main` moved while you worked (`git log --oneline HEAD..origin/main`).
   If it did, rebase and re-run the gates before pushing.

   Note the **pre-commit hook writes**: `biome check --staged --write` runs on commit, so
   a diff you captured beforehand may not be what landed.
   ```bash
   git commit -m "<type>(<scope>): <summary> (ELEG-…)" -m "<body>" \
     -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
   git push -u origin HEAD
   gh pr create --base main --title "<same subject>" --body "<summary + ELEG-… + follow-up keys + verification results>"
   ```
   End the PR body with:
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

   **`--base main` is not optional** — `gh` otherwise defaults to whatever branch is
   tracked, and the PR then merges into a dead branch and never reaches `main`. The rest
   of that rule is in [`shared/pr-hygiene.md`](shared/pr-hygiene.md).
8. **Check the PR landed clean — don't assume it did.**
   - **Merge conflicts:** `gh pr view <n> --json mergeable,mergeStateStatus`. If
     `CONFLICTING`/`DIRTY`, rebase on the latest `main`, resolve, re-verify, force-push.
   - **CI status:** `gh pr checks <n>`. **`main` is currently red for two pre-existing
     reasons** (a `--frozen-lockfile` config mismatch that fails CI before any gate
     runs, and the formatting violation fixed by ELEG-1) — so read *which step* failed
     before attributing it to your branch, and never dismiss a red check without
     looking. `local/gates.md` has the detail.
   - **Merged ≠ on `main`.** A PR reading `MERGED` only merged into *its base*. Confirm:
     `git fetch origin && git merge-base --is-ancestor <sha> origin/main`.
   - **Offer to watch** pending checks rather than leaving the user to find out.
9. **Close the loop in the tracker:**
   - `issues_add_comment` summarising what changed (files touched, tests added, **what
     you ran and what it can and cannot prove**, follow-up issue keys, **the PR URL**).
   - `issues_update_issue` → `IN_REVIEW`. **Opening the PR already did this** (the
     webhook drives draft → `IN_PROGRESS`, opened/readied → `IN_REVIEW`, merged →
     `MERGED`, closed unmerged → `TODO`), so setting it is a confirmation — harmless, and
     it tells you immediately if the automation did *not* fire. `MERGED` arrives on its
     own; do **not** set it by hand, and do not set `DONE`, which is for issues that
     close without shipping code.
   - **`IN_PRODUCTION` is real in this project and is not yours to set on merge.** The
     service runs from `/opt/elegooweb`, which is not a git checkout, so a merge changes
     nothing that is running. See [`.agents/deployment.md`](../../.agents/deployment.md).
   - **The automation depends on the branch name.** A transition needs the issue key in
     the PR's **branch or title**; a key only in the body moves nothing.
10. **Report** the issue key, the branch + PR URL, the check results, what the gates do
    and do not cover for this change, and the PR's mergeable + CI status.
