---
description: Work an explicit list of ELEG issues back-to-back, autonomously — no questions, one PR each, split what's too big, log and skip what you can't decide.
argument-hint: "<ELEG-1 ELEG-2 ELEG-3 …>  (order = the order they get worked)"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, mcp__respawn-control__issues_get_issue, mcp__respawn-control__issues_list_attachments, mcp__respawn-control__issues_list_issues, mcp__respawn-control__issues_list_labels, mcp__respawn-control__issues_create_issue, mcp__respawn-control__issues_update_issue, mcp__respawn-control__issues_add_comment, mcp__respawn-control__issues_add_label
---

Work the issues in **$ARGUMENTS**, in the order given, one after another, via the
`respawn-control` MCP server. Each issue follows [`/fix`](fix.md) — read it, branch,
implement, verify with the full gate set, PR, start + closing comments, `IN_REVIEW`.
This command is the **autonomous, serial** wrapper around that: use it when someone
hands over a list and leaves.

Distinct from [`/sweep`](sweep.md): sweep *discovers* its own queue and fans out to
subagents in worktrees. This works a **given** list **inline and in order**, which is
what you want when the issues are coupled or when a human wants a predictable sequence.

## The contract: you do not ask

Assume the person who invoked this is unavailable. Every ambiguity is yours to resolve:

- **Decide, then record the decision** in the closing comment and the PR body, with the
  reasoning — that is what makes an unattended run auditable.
- **Never block the whole list on one issue.** If you genuinely cannot resolve something,
  write **why** on the issue, leave it `BACKLOG`, and move to the next one. A silent skip
  is a defect; a logged skip is a result.
- **File, don't defer in prose.** Deferred work becomes an issue (`issues_create_issue`,
  dedupe first).

**The one thing an unattended pass may never do here is touch the printer or
production.** No `set_temperature`/`move`/`home`/`start_print`/`stop_print`/
`emergency_stop`, no `sudo pnpm service:install`, no `systemctl restart elegooweb`, no
writing into `/opt/elegooweb`. An issue that needs one of those is **not workable
unattended**: split the repo half out, file the live half as an `OPERATOR:` issue with
exact commands, and say so in the report. That is a result, not a failure — and it is
better than the alternative, which is a nozzle heating up with nobody in the room.

## 0. Pre-flight (once, before the first issue)

```bash
git rev-parse --abbrev-ref HEAD    # must be main — see below before you switch
git status --porcelain             # whose changes are these?
git worktree list                  # who else is in this repo right now?
git switch main && git pull --ff-only
pnpm install --frozen-lockfile     # works again as of ELEG-4 — see the note below
gh pr list --state open            # anything already in flight?
gh pr list --state merged --limit 10 --json number,baseRefName,mergeCommit
```

**If `HEAD` is not `main`, stop before that `git switch` — do not run the rest of this
pass.** A topic branch in this checkout means another session's issue is in flight, and a
pass that works a whole *list* does that damage once per issue. `git switch` carries
modified files across, so switching away can end with their work committed onto your
branch. Report the branch you found; do not stash, reset or switch to clear your path.
Same for overlap: a dirty file that one of the listed issues will touch is a reason to
stop. Unrelated dirt is fine and gets left alone. See
[`shared/agent-isolation.md`](shared/agent-isolation.md).

**`main` is green, and that changes what a red check means.** `--frozen-lockfile` used to
fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` — newer pnpm ignores the `pnpm` field in
`package.json`, so the lockfile's recorded `overrides` no longer matched — and that
failed CI *before it ran a single gate*. **ELEG-4 fixed it**, so the install is clean and
CI runs the gate set. Keep the lesson (CI can be red for a reason no gate would ever
show you) and drop the licence that came with it: **a red check on your branch is yours
until you have read which step failed and shown otherwise.** Never dismiss one on the
strength of a note in a command file — this paragraph was that note, and it outlived the
bug by a month. [`local/gates.md`](local/gates.md) keeps the history and the current
gaps, and it is still true that green there proves very little.

**Check that recently-merged PRs actually reached `main`.** A PR reading `MERGED` only
means it merged into *its own base* — verify with
`git merge-base --is-ancestor <sha> origin/main`. If work is stranded, land it first, or
every branch you cut silently drops it. Why `--base main` is never optional:
[`shared/pr-hygiene.md`](shared/pr-hygiene.md).

## 1. Plan the pass before touching code

Load every issue up front — `issues_get_issue` **with
`include: ["comments","links","attachments"]`**, because without it comments, links and
attachments come back as _counts only_ and the whole pass is planned from descriptions
alone. Where `counts.attachments` is non-zero, `issues_list_attachments` and `Read` each
`url`; say so if one won't render.

Then sort out four things:

- **Weight.** Anything that is really an epic is not implementable in one pass. Plan to
  **split** it (step 4), not to start it.
- **Coupling.** Issues that share plumbing get worked in dependency order, and the
  earlier PR gets **merged before** the next branch is cut.
- **Genuine overlap.** Two issues that are one change land as **one branch and one PR
  naming both keys**, with a closing comment on each.
- **Live-apply content.** Flag every issue whose completion needs a deploy or a printer
  command *now*, so the split happens before you implement rather than after.

Announce the order and the split/skip intentions before starting, then work it.

## 2. Per issue: /fix, with these additions

- **A one-line issue is not a spec.** Write the description you are implementing to
  (`issues_update_issue`) **before** you start, including the decisions you are making
  and what is out of scope, and say in the comment that you filled it in.
- **Set `assignee: claude` and a priority** if unset, and apply the type (+ area) labels
  — `issues_add_label`, reusing `issues_list_labels`.
- **Gates are non-negotiable**: `pnpm gates --fix` per issue, and commit whatever biome
  rewrites. Redirect the run to a file rather than piping it through `tail` — the
  evidence is the log, and a re-run destroys the only copy of it.
- **Green gates are necessary and nowhere near sufficient in this repo — and pretending
  otherwise is the main risk of an unattended pass.** The suite is small and almost
  entirely **pure functions**, plus one that is a *documentation* check (`MCP.md` matches
  the registered tools) rather than a behavioural one. The MQTT bridge, the state store's
  event handling, every REST route, `/mcp`'s behaviour, both compat layers, the Telegram
  middleware wiring and the AI monitor have **no test at all**, and there is no browser
  check. CI runs `pnpm gates` — the same gates you just ran locally — so a green CI adds
  confirmation, not coverage. (No count quoted on purpose: vitest prints one every run,
  and every number ever written here went stale — ELEG-15. `local/gates.md` has the
  per-file breakdown.) Five items, seconds each:

  1. **Break the invariant and watch the named test go red.** If no test covers it —
     which is the common case — **write that sentence in the closing comment** rather
     than reporting "gates green" and letting it read as coverage.
  2. **Grep the diff for `it(`/`test(` blocks with no `expect(`.**
  3. **Read the state-merge path by hand** if you touched it: a field absent from a
     printer delta means *unchanged*, not *cleared*.
  4. **Look at the page** for any `src/ui/**` or `index.html` change — `pnpm dev:web`
     only, which opens no printer connection. Nothing else will catch a card that
     renders empty.
  5. **Verify every identifier you introduced** — route path, MCP tool name, env var,
     WebSocket message `type` — exists on both sides. The `/ws` contract is unasserted,
     so a rename is silent, and `MCP.md` is verified by nothing.

  Undo each mutation with an inverse patch, **never `git checkout <file>`** — see
  [`shared/gate-failures.md`](shared/gate-failures.md) §6.

- **Merging as you go is part of this mode**, because later issues need the earlier work
  on `main`. List every merge in the final report. Check `gh pr checks` before merging —
  and since ELEG-4 landed there is **no standing pre-existing red to hide behind**, so
  treat a failure as yours and read which step failed before concluding anything else.
- **Read the two reference files on demand.** They are deliberately *not* inlined here:

  | Read | When |
  | --- | --- |
  | [`shared/gate-failures.md`](shared/gate-failures.md) | the **first time a gate goes red** in the pass, before you re-run anything |
  | [`local/gates.md`](local/gates.md) | alongside it — this repo's exact commands, the reds that have since been fixed, and why green means little |
  | [`shared/pr-hygiene.md`](shared/pr-hygiene.md) | before opening the **first PR** of the pass, and again before any PR that only *partly* completes an issue |

  `shared/*` is byte-identical across the sibling repos and names no tool; `local/*` is
  this repo's flavour and is never synced. Both are invocable directly
  (`/shared:gate-failures`, `/local:gates`, `/shared:pr-hygiene`).

  The three things from those files most likely to bite *this* command: **capture which
  check failed before re-running anything**; **do not set `IN_REVIEW` after merging** (the
  webhook already moved the issue to `MERGED`, and setting it drags it backwards); and **a
  partially-completing PR must not carry the parent issue's key in its title** (child's
  key in the title, parent's in the body).

## 3. Writing to the tracker goes through MCP, not curl

Bulk-label and comment through the MCP tools. Never go hunting for an API token to do it
with `curl`.

## 4. Too big → split the *whole* scope

Never ship half. Decompose into children (`issues_create_issue` with `parent`), each
independently completable, then comment on the parent with:

- a table of child → slice, so the mapping is legible at a glance;
- an explicit statement that **nothing** remains as prose — every part of the parent's
  description now lives in a child;
- the non-obvious things you noticed *while* splitting and wrote into children;
- ordering/risk notes — and put every live-apply slice last, alone, and
  `OPERATOR:`-titled.

Leave the parent open as a mini-epic. Never mark it done.

## 5. Capture what you learned, in the same run

If the pass taught you something durable, write it down before reporting: project facts
→ `AGENTS.md` / `.agents/*`, gate particulars → [`local/gates.md`](local/gates.md),
workflow steps → the relevant command file, cross-session context → memory. A lesson
that only appears in the final chat message is lost.

## 6. Report

One table of what shipped (issue → PR → one-line outcome), then, plainly:

- **what was split** and into which keys;
- **what was skipped and why** — never omit this section, and list every issue that
  turned out to need a printer command or a deploy;
- **judgement calls made without asking**, so they can be overridden;
- **what each change was actually verified by**, distinguishing "a test covers this" from
  "the gates passed and nothing covers this";
- **what needs a human next**: the `OPERATOR:` issues you filed, with their commands;
- final gate status on `main`, and whether CI ran at all.
