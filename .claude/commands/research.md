---
description: Research a question or ELEG issue, then record findings back on the issue.
argument-hint: "<ELEG-123 | question to investigate>"
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git diff:*), Bash(curl:*), WebSearch, WebFetch, mcp__respawn-control__issues_list_issues, mcp__respawn-control__issues_get_issue, mcp__respawn-control__issues_list_attachments, mcp__respawn-control__issues_create_issue, mcp__respawn-control__issues_add_comment
---

Research **$ARGUMENTS**, tracked in the **elegoo-web** project (key `ELEG`) via the
`respawn-control` MCP server. Read-only on the codebase — do not modify source. If the
MCP tools are unavailable, stop and ask the user to connect it (`.mcp.json` reads
`RESPAWN_MCP_URL` and `RESPAWN_MCP_TOKEN` from the environment).

1. **Scope the work.**
   - If `$ARGUMENTS` is an issue key (e.g. `ELEG-42`), load it with `issues_get_issue`
     **passing `include: ["comments","links","attachments"]`** — without it comments,
     links and attachments are returned as _counts only_. Read the comments before
     researching: they are where prior investigation and "we tried this, it didn't work"
     live, and re-deriving them is the specific waste this command exists to avoid. If
     `counts.attachments` is non-zero, `issues_list_attachments` and `Read` each `url`;
     say so if you cannot render one.
   - Otherwise create a tracking issue in `elegoo-web` via `issues_create_issue` (title
     `Research: …`, status `BACKLOG`) and use its key. Dedupe first.
2. **Investigate.** Use Read/Grep/Glob across the repo; consult the `.agents/`
   deep-dives for how things actually work here
   ([`architecture.md`](../../.agents/architecture.md),
   [`mcp.md`](../../.agents/mcp.md), [`security.md`](../../.agents/security.md),
   [`testing.md`](../../.agents/testing.md),
   [`deployment.md`](../../.agents/deployment.md)). Use WebSearch/WebFetch for
   external/library questions, preferring primary sources — the CC2 MQTT protocol is
   documented outside this repo (see `README.md`) and that reference answers more
   questions than reading our parser does.

   **Probe rather than infer, within the boundary.** Reads settle most questions in a
   minute and are encouraged: `curl -s localhost:8088/api/health`, `/api/status`,
   `/api/metrics`, an `initialize` + `tools/list` against `/mcp`, `journalctl -u
   elegooweb`, `diff`ing the checkout against `/opt/elegooweb`. **Anything that commands
   the printer is out of bounds** — temps, fans, motion, print start/stop, emergency
   stop. If the question can only be answered by commanding it, that is the finding:
   name the exact command and ask the user to run it.

   Two traps worth knowing before you conclude something is missing: a **stale MCP tool
   schema** in your client (captured at connect, never refreshed — check the live
   surface), and the fact that **`grep` proves presence, never absence** — a miss is not
   evidence.
3. **Synthesize.** Produce: the question, what you found (cite `path:line` and URLs),
   options with trade-offs, and a recommendation. Distinguish what you *verified* from
   what you *read*.
4. **Record in the tracker.**
   - Post the findings as a Markdown comment via `issues_add_comment`. Redact anything
     sensitive from pasted output — credentials, and any personal data (the camera
     endpoints return a live image of a room).
   - **Follow-up work must be filed, not mentioned** — hard rule: create sub-issues
     (`issues_create_issue`, `parent` = the issue key) for every piece of follow-up work,
     after deduping with `issues_list_issues {project: "elegoo-web", q: "<word>",
     order: "newest"}` and no `status` filter. Reference the keys in the comment; no
     inline "follow-up" prose without a key. A live apply is its own `OPERATOR:` issue.
   - If the research **refuted a premise** on the issue, say so plainly in the comment —
     that is the most valuable thing it can contain.
5. **Report** the issue key and a concise summary. Suggest `/plan <key>` next.
