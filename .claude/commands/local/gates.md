---
description: LOCAL to elegoo-web — the gate command, the typecheck CI does not run, why green means very little here, the red main, and the printer boundary no gate can enforce.
---

# local: this repo's gates

The **repo-flavoured addon** to [`shared/gate-failures.md`](../shared/gate-failures.md).
That file is byte-identical across the sibling repos and therefore names no tool; this one
is owned by this repo alone, is never synced, and holds every particular the shared file
deliberately left out. Read them together the first time a gate fails in a pass.

## The command

```bash
pnpm gates          # scripts/gates.sh — the whole set, with a ✓/✗ summary
pnpm gates --fix    # biome check --write first; commit what it rewrites
```

Five checks, in CI's order, plus one CI does not run:

| # | Check | Command | Notes |
| --- | --- | --- | --- |
| 1 | lint | `biome ci src/` | **non-writing**, as CI does it |
| 2 | typecheck (browser) | `tsc` | `tsconfig.json` — **excludes `src/server`, `src/telegram`** |
| 3 | typecheck (service) | `tsc -p tsconfig.server.json` | **CI does not run this.** See below |
| 4 | build | `vite build` | writes `dist/`, which is gitignored |
| 5 | tests | `vitest run` | 6 tests, ~150 ms |

Grep the log for `✗` to get the failing gate, then read upward for that check's own
output.

## The whole backend is outside the typecheck CI runs

`tsconfig.json` **excludes `src/server` and `src/telegram`**, and `pnpm build` runs only
that config. CI runs `lint`, `format:check`, `build`, `test` — so **`src/server/**` and
`src/telegram/**` are typechecked by nothing in CI at all**, and a type-broken service
merges green.

That is why `pnpm gates` runs `service:check` even though CI does not: a green CI on a
backend change is close to meaningless without it. If you are running single checks by
hand rather than `pnpm gates`, run both typechecks.

Production makes this worse rather than better: the service runs the TypeScript
**directly** under `node --import tsx`, so there is no compile step between a type error
and the running service — the process just throws at runtime, restarts (`Restart=always`),
and throws again.

## `main` is red right now, and not because of you

Two independent failures, both pre-existing. Check whether they still are before
attributing a red check to your branch — the last CI run to be green was in July.

1. ~~**`pnpm install --frozen-lockfile` fails in CI**~~ — **fixed in ELEG-4.** The cause
   was never really the `overrides` block: it was that `ci.yml` asked
   `pnpm/action-setup@v4` for `version: latest`, so **CI silently moved to pnpm 11 while
   every developer here was on 10.x**. Two different reds came out of that one drift, and
   the second masked the first:
   `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (pnpm 11 stopped reading the `pnpm` field in
   `package.json`, so the effective overrides went empty while the lockfile still recorded
   them), and later `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` (a **pnpm 11 default policy
   that does not exist in 10.x** — `pnpm config get minimumReleaseAge` → `undefined`).

   The fix was both halves: the settings moved to `pnpm-workspace.yaml` (their documented
   new home, read by 10.x *and* 11.x), and the package manager is now pinned by
   `packageManager` in `package.json` with **no `version:` in the workflow**, so CI runs
   exactly what you run. **If you bump `packageManager` to 11.x, expect the release-age
   policy to bite** — that move is its own issue.

   The lasting lesson: `version: latest` on a package-manager action means CI drifts away
   from every developer without a commit. Don't reintroduce it. And still don't "fix" a
   lockfile complaint by deleting the lockfile — the `undici` override is a security pin.
2. **A formatting violation in `src/styles/main.css`** made `biome ci src/` red
   (`pnpm format:check` too). Fixed by the commit that added this file — but the shape is
   worth knowing, because biome reports a formatting violation as `Found 1 error.` with
   **no `✖` marker and no rule name**, which reads like a crash. `--reporter=summary`
   names the file.

So on this repo, right now: **a red CI check is not evidence about your change** until
you have looked at *which* step failed. And a green local `pnpm gates` is the substantive
evidence — say so explicitly in the closing comment rather than implying CI ran.

## CI works here, unlike in the private siblings

`.github/workflows/ci.yml` runs on `ubuntu-latest`, and that is deliberate: **this repo
is public**, and public repos get free unlimited hosted Actions minutes. The private
sibling repos are out of minutes and need self-hosted runners, so their "no check means
no runner" reasoning does **not** transfer here. If no run appears for a push here, it is
a GitHub problem or a workflow-trigger problem, not a runner problem.

## Warnings exit 0 here — the baseline is zero, keep it there

`biome.json` sets a number of rules to `warn` rather than `error`, including
`noExplicitAny`, `noUnusedVariables`, `noUnusedImports` and
`noUnusedFunctionParameters`. `biome ci` **exits 0** on warnings, so they cannot fail a
gate.

Measured on `main`: **zero warnings** across 60 files. That makes the honest rule simple —
your change should add none, and because the count is currently zero you can see that at a
glance instead of diffing against a baseline. (This is the opposite of the VTK sibling,
which made warnings hard errors; do not paste either repo's framing into the other.)

## biome does not reach `.claude/**` — measured

[`shared/agent-isolation.md`](../shared/agent-isolation.md) warns that a formatter reaching
`.claude/**` rewrites a `commands/shared/` file and breaks byte-identity with nobody having
edited a word — and the next drift check then reports it as *drift*, whose obvious repair
(re-copy) makes it recur.

**No exemption is needed here today.** `biome.json` scopes `files.includes` to `src/**`
with `!**/*.md`, and it was confirmed rather than assumed:

```
$ pnpm exec biome check .claude/commands/shared/pr-hygiene.md
Checked 0 files in 782µs.
  × No files were processed in the specified paths.
  i These paths were provided but ignored:
  - .claude/commands/shared/pr-hygiene.md
```

If `files.includes` is ever widened to `**`, add `!.claude/commands/shared/**` in the same
change — and do **not** exempt `commands/local/` or the command bodies, which are
repo-owned and should be formatted normally.

## There is a pre-commit hook, and it writes

`simple-git-hooks` installs `pre-commit`: `biome check --staged --write
--no-errors-on-unmatched`. So **committing can modify your staged files**, which matters
twice:

- A `git diff --cached` you took before the commit may not match what landed. Re-read
  after committing if the diff is the evidence you are quoting.
- If a mutation-testing script's pattern was copied out of a file *before* a commit
  reformatted it, the pattern silently no longer matches. Make any such script assert it
  applied (`if s.count(old) != 1: sys.exit("MUTATION DID NOT APPLY")`) — a `sed`/`perl`
  one-liner exits 0 having changed nothing. This is the repo-specific half of §6 of the
  [shared file](../shared/gate-failures.md).

`SKIP_SIMPLE_GIT_HOOKS=1` bypasses it, which you should not need.

## Green gates prove very little here — the honest list

The suite is **one file, six tests**, covering two pure functions. Nothing tests the MQTT
bridge, the state store, any REST route, `/mcp`, the Moonraker/OctoPrint layers, Telegram,
the AI monitor, or **any** frontend code. There is no browser test and no screenshot.

So the load-bearing gates are the two typechecks, and the failing-direction check matters
more here than in a repo with real coverage:

1. **Break the invariant and watch the named test go red** — and if there *is* no test
   that covers it, say that instead of implying the gates checked it.
2. **Grep the diff for `it(`/`test(` with no `expect(`.**
3. **Read the state-merge path by hand** when you touched it: a field absent from a
   printer delta means *unchanged*, not *cleared*, and no test enforces that.
4. **Look at the page** for any `src/ui/**` or `index.html` change. `pnpm dev:web`
   (vite :5173) with the API proxied at the running service is the cheap way, and it opens
   no second printer connection.
5. **Verify every identifier you introduced** — route path, MCP tool name, env var,
   message `type` on the WebSocket — exists on both sides. The `/ws` contract is
   unasserted, so a renamed message type is silent.

Undo each mutation with an inverse patch, **never `git checkout <file>`** — see
[`shared/gate-failures.md`](../shared/gate-failures.md) §6.

## The gate no script can run: the printer

`pnpm gates` cannot tell you whether a change does the right thing to a **physical
machine**, and the temptation after a green run is to "just try it". Don't:
`set_temperature`, `fan`, `move`, `home`, `start_print`, `pause_print`, `stop_print` and
`emergency_stop` reach real hardware. Reads are fine — `/api/health`, `/api/status`,
`/api/metrics`, the `printer://*` MCP resources, the MQTT log. Anything that commands the
printer is **operator work**: name the exact command, ask for the output, interpret it,
record it on the issue.

Two further collisions specific to running anything locally on this host, both in
[`.agents/testing.md`](../../../.agents/testing.md): production already holds ports **8088
and 7125**, and a second service process means **two MQTT registrations for one printer** —
which degrades *production*, not your dev window.

## Flake

There is no known flake: six pure-function tests, no network, no database, no browser. So
§4 of the shared file collapses to its last rule — **a failing test is real until shown
otherwise**. The probe, if you want it:

```bash
git stash push -u -m probe && git switch main
pnpm gates
git switch - && git stash pop
```

A failure on clean `main` is proof it is not yours **and is itself worth an issue** — see
the two known ones above before filing a third.
