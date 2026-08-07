---
description: SHARED (byte-identical in RCP/ANS/SPND/VTK) — one checkout one agent, commit only in the repo you were invoked in, and tear down the worktree you created.
---

# shared: agent isolation

**This file is byte-identical in all four sibling repos** (RCP, ANS, SPND, VTK) and is
verified that way — `/sync-commands` compares `sha256sum`. Do not edit it in one repo
alone.

**"Do not edit" includes tooling.** A formatter or linter that reaches `.claude/**` will
rewrite this file and break byte-identity with nobody having edited a word — and the next
drift check then reports it as *drift* rather than as *a formatter having touched it*,
which is worse, because the obvious repair is to re-copy and the problem recurs on the
next run. Any repo whose formatter reaches here must exempt `commands/shared/` — and must
**not** exempt `commands/local/` or the command bodies, which are repo-owned and should be
formatted normally.

It genuinely is common: every one of these repos is worked by more than one agent, some of
them concurrently, and all four sit in sibling directories on one machine. Nothing below
depends on a language, a runner or a gate — only on `git` and on who is holding the tree.

## 1. One checkout, one agent, one branch

**Before cutting a branch, establish that nobody else is working in this checkout.** Three
commands, none of which mutate anything:

```
git rev-parse --abbrev-ref HEAD    # must be the default branch
git status --porcelain             # whose changes are these?
git worktree list                  # who else is in this repo right now?
```

**If `HEAD` is already a topic branch, stop and say so, naming the branch.** A topic branch
checked out in the shared tree means someone else's issue is in flight. Do not switch away
from it — `git switch` **carries modified files across**, so switching mid-flight can end
with one agent's half-finished work committed onto another agent's branch, and neither
notices until review.

A dirty tree is not automatically a refusal — on a shared machine there is often unrelated
work sitting there, and a command that refuses on any dirt at all is a command nobody can
run. Refuse on **`HEAD`**, and on **overlap**: if a modified file is one this task will
touch, stop rather than build on top of a state you did not create.

**Refuse; never tidy.** Do not stash, reset, checkout or discard to clear your path. Those
destroy work that belongs to someone who is still using it, and `git checkout <file>` in
particular is unrecoverable — there is no reflog for the working tree.

## 2. An agent commits only in the repo it was invoked in

A lesson learned here that belongs in a sibling repo is **ported by filing a linked issue
in that repo's project** — not by opening its checkout and editing it. The sibling repo has
its own gates, its own reviewer and quite possibly its own agent working in it right now;
an edit arriving from outside is invisible to all three.

**The one exception is a task whose entire purpose is cross-repo synchronisation** — the
byte-identical tier above cannot be maintained any other way. When that is the task:

- one **worktree per repo**, so no sibling's primary checkout is disturbed;
- one branch and one PR per repo, each with its own issue key;
- run each repo's own gates in its own tree, because they are not the same gates.

If you find yourself editing a sibling checkout and the task was *not* cross-repo sync, the
port is a filed issue, not a diff.

## 3. Whoever creates a worktree removes it

Teardown is part of the task, not cleanup for later. A worktree is invisible in every
normal view of the repo — it does not appear in `git status`, in a diff, in a file tree or
in a PR. `git worktree list` is the only place it exists.

This is not hypothetical housekeeping. One of these repos accumulated **eight abandoned
worktrees totalling 7.4 GB** (each carrying its own dependency tree), and four of them held
uncommitted files — including, in two cases, **unlanded work for issues that were still
open**, plus a database migration that existed nowhere else. It was found five days later
by someone running `git worktree list` for an unrelated reason. A stale migration sitting
in an abandoned worktree is also the standing cause of the "migration tool demands a reset"
class of failure, because the branch is gone but the schema-history row is not.

So:

- remove the worktree once its PR is open — the branch carries the work from then on;
- **never remove a worktree with uncommitted changes.** Commit them onto their own branch
  first, even as an explicit `wip:` commit; a worktree removal is not the moment to decide
  someone else's edits were worthless;
- a parallel dispatch is not finished while one of its worktrees still exists.

## 4. Refusing is cheap; guessing is not

Every rule above resolves to *stop and report* rather than *proceed carefully*. That is
deliberate. A refusal costs one message and a human glance. Its alternatives cost a branch
with two agents' work tangled together, or a discarded change nobody can recover — and both
of those are found later, by someone who was not there when it happened.
