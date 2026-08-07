---
description: Plan an ELEG issue — read it (or create one), explore the code, propose an implementation plan, and record it back on the issue.
argument-hint: "<ELEG-123 | short description of the work>"
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git log:*), Bash(git diff:*), mcp__respawn-control__issues_list_projects, mcp__respawn-control__issues_list_issues, mcp__respawn-control__issues_get_issue, mcp__respawn-control__issues_list_attachments, mcp__respawn-control__issues_create_issue, mcp__respawn-control__issues_update_issue, mcp__respawn-control__issues_add_comment, mcp__respawn-control__issues_link_issues
---

You are planning work tracked in the **elegoo-web** project (key `ELEG`) of our issue
tracker, reached via the `respawn-control` MCP server. Plan only — do not modify source
in this command.

Input: **$ARGUMENTS**

If the MCP tools are not available, stop and tell the user to connect it (`.mcp.json`
reads `RESPAWN_MCP_URL` and `RESPAWN_MCP_TOKEN` from the environment) — do not guess at
issue state.

1. **Resolve the target issue.**
   - If the input matches an issue key (e.g. `ELEG-42`), load it with `issues_get_issue`
     **passing `include: ["comments","links","attachments"]`** — without it comments,
     links and attachments come back as _counts only_ and you will plan against the
     description alone. **Read the comments before writing a plan**: a plan that
     contradicts a decision already recorded there is worse than no plan. If
     `counts.attachments` is non-zero, `issues_list_attachments` and `Read` each `url`;
     say so if you cannot render one.
   - Otherwise treat it as new work: draft a crisp title + Markdown description and
     `issues_create_issue` in project `elegoo-web` (status `BACKLOG`). Report the new
     key. Dedupe first with `issues_list_issues {project: "elegoo-web", q: "<word>",
     order: "newest"}` — a search, not a page-through, and with no `status` filter.
2. **Test the issue's premises before planning around them.** A stated blocker — "the
   firmware doesn't expose that", "the printer can't do it", "this needs the other repo"
   — is what someone believed when they filed it. Two minutes usually settles it: grep
   the protocol handling, read the MQTT log, check the file is actually in this tree,
   check `MCP.md` against `src/server/mcp-server.ts`. **Record the outcome on the issue
   either way** — a premise confirmed is worth as much as one refuted.
3. **Understand the codebase.** Explore with Read/Grep/Glob. Read `AGENTS.md` and the
   relevant deep-dives, which are not auto-loaded:
   [`architecture.md`](../../.agents/architecture.md) (which layer the change belongs
   in), [`mcp.md`](../../.agents/mcp.md), [`security.md`](../../.agents/security.md)
   (the service has no auth — a new endpoint is a new unauthenticated endpoint),
   [`testing.md`](../../.agents/testing.md) (what is actually covered: almost nothing),
   [`deployment.md`](../../.agents/deployment.md) (whether the plan needs a deploy).
4. **Write the plan.** Cover: goal, files to change (`path:line`), approach, edge cases,
   test strategy, and a definition of done (`pnpm gates` green, `MCP.md`/`README.md`
   updated if a documented surface moved, a conventional commit subject that reads as a
   release note).

   Two things this repo's plans must state explicitly:
   - **How it will be verified without commanding the printer.** If the honest answer is
     "it can't be", the plan says so and names the operator step.
   - **Whether it needs a deploy to take effect.** Production is a separate,
     non-git tree; a plan that ends at "merge" for something that must be running is
     incomplete.
5. **Record it back in the tracker.**
   - Post the full plan as a Markdown comment via `issues_add_comment`.
   - For decomposed work, create sub-issues with `issues_create_issue` and `parent` set
     to the issue key; add `BLOCKS` links where order matters (`issues_link_issues`).
     Hard rule: anything deferred or out-of-scope in the plan is filed as an issue too
     (after a duplicate check) — never left as inline "later"/"follow-up" prose.
   - **Repo work and operator work are separate issues.** A live apply — deploy,
     restart, printer command, or a change to how the service is exposed (which lives in
     the `~/ansible` repo, not this one) — is its own `OPERATOR:`-titled issue with the
     exact commands and what to read afterwards to prove it worked.
   - **If the plan doesn't fit one deliverable, split the whole scope, not part of it.**
     Every piece of the parent's scope must land in some child, each independently
     completable, so the parent becomes a small epic that finishes when its last child
     does. A plan whose leftovers live only in a comment is a plan to leave an issue
     half-implemented.
   - Set the issue to `TODO` via `issues_update_issue` once planned.
6. **Report**: the issue key, a short summary of the plan, any sub-issue keys created,
   and any premise you checked and found false. Suggest `/fix <key>` as the next step.
