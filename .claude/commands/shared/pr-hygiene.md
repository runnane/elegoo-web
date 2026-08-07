---
description: SHARED (byte-identical in RCP/ANS/SPND/VTK) — branch, PR and tracker hygiene: --base main, MERGED never means landed, which key goes in a PR title, one issue one PR.
---

# shared: branch, PR and tracker hygiene

**This file is byte-identical in all four sibling repos** (RCP, ANS, SPND, VTK) and is
verified that way — `/sync-commands` compares `sha256sum`. Do not edit it in one repo
alone.

It genuinely is common: the four repos share **one tracker and one PR webhook**, so the
rules below are properties of that shared automation rather than of any repo's tooling.
Whatever is repo-specific — which gates must be green, whether CI runs at all, whether
`main` is the deploy target — is in [`local/gates.md`](../local/gates.md).

## `--base main` is not optional

`gh pr create` defaults to the **tracked branch**, not to `main`. A branch cut off another
feature branch therefore opens a PR *against that branch*, and merging it lands the work
nowhere. Always pass `--base main` explicitly.

## `MERGED` does not mean the work is on `main`

A PR reading `MERGED` only means it merged into **its own base**. Two PRs once both read
`MERGED` while `main` was missing both features entirely. Verify:

```
git merge-base --is-ancestor <merge-sha> origin/main
```

Do this in pre-flight for recent merges too — if earlier work is stranded, land it first,
or every branch you cut silently drops it.

## The branch name is what drives the tracker

A status transition needs the issue key in the PR's **branch or title**. A key that appears
only in the body is recorded as an *association* and moves nothing — deliberately, because
PR bodies routinely name other issues. Keep cutting branches as
`<type>/<key-lower>-<kebab-title>` and it is automatic.

Two consequences follow, and both have bitten:

- **Never put an epic's key in a PR title.** The webhook moves it to `MERGED` off the
  title and cannot know the epic has ten other children. Epic keys go in the **body only**.
- **A PARTIALLY-completing PR must not carry the parent's key in its title** either. Put
  the *child's* key in the title and the parent's in the body. This is the case that
  catches you out, because the issue *feels* finished when you close the branch: one split
  issue shipped half its scope, the PR title marked the parent `MERGED`, and its remaining
  child was still `BACKLOG`. It had to be corrected by hand.

## One issue → one PR → one merge

An issue is finished by a *single* PR. Never land a follow-up commit or a second PR against
an issue that already has one, and never close an issue with unworked action points left
over — **split it** so each remaining piece is its own issue with its own PR. If you
realise mid-flight that the PR will not cover the whole issue, split *before* merging.

This is not only hygiene: the mapping from an issue to its PR has to be single-valued for a
transition to be decidable at all. A second PR touching an already-merged issue is an
ambiguity the automation cannot resolve, and a "mostly done" issue is one it will happily
mark shipped.

## Do not drag an issue backwards

The automation never moves an issue backwards out of `MERGED`, `IN_PRODUCTION`, `DONE` or
`CANCELLED` — but nothing stops *you*. If you merge immediately, the webhook has already
moved the issue by the time you get there, so setting `IN_REVIEW` afterwards drags it back.
Either set it **before** you merge, or skip it and let the hook do its job — then verify the
issue reads `MERGED`, which is the check that actually matters.

Equally: a status *you* set wrongly will **not** be corrected by the next delivery. Comment
on start and finish regardless; the automation moves the status, not the narrative.

## A child's status moves its parent — so do not hand-maintain an epic

A child reaching `IN_PROGRESS` or later moves its `BACKLOG`/`TODO` ancestors to
`IN_PROGRESS`; a parent whose every non-`CANCELLED` child is `DONE` becomes `DONE`. Both
cascade up the whole chain. So set the children and let the parent follow. Three corollaries
worth knowing: **cancelling a child is not starting a parent**, an epic that has reached
`MERGED` is never pulled back to `DONE`, and a parent whose children are *all* cancelled
counts as a leaf and stays put.

## Statuses are per project

The status enum is global but a project's **enabled** set is not — `IN_PRODUCTION` exists
only where the project tracks a deploy. Read the project's `enabledStatuses` rather than
assuming; setting a status the project does not use is refused, not silently accepted.

## Verify the PR actually landed clean

Before calling an issue done: mergeable, checks in whatever state `local/gates.md` says is
achievable in this repo, and `merged ≠ on main` — check the ancestor, per above.
