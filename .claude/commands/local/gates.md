---
description: LOCAL to elegoo-web — the gate command (which is what CI runs), why green still means very little here, and the printer boundary no gate can enforce.
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

Five checks — and since ELEG-5, **`ci.yml` runs this exact script as its only step**, so
this table is CI's step list too. Add a gate here and CI picks it up with no workflow edit.

| # | Check | Command | Notes |
| --- | --- | --- | --- |
| 1 | lint | `biome ci src/` | **non-writing**, as CI does it; covers formatting as well as lint |
| 2 | typecheck (browser) | `tsc` | `tsconfig.json` — **excludes `src/server`, `src/telegram`** |
| 3 | typecheck (service) | `tsc -p tsconfig.server.json` | `tsconfig.server.json` — the other half. See below |
| 4 | build | `vite build` | writes `dist/`, which is gitignored |
| 5 | tests | `vitest run` | ~350 ms; it prints its own count, so none is quoted here |

Grep the log for `✗` to get the failing gate, then read upward for that check's own
output.

## There are two typechecks, and `pnpm build` is only one of them

`tsconfig.json` **excludes `src/server` and `src/telegram`**, and `pnpm build` (`tsc &&
vite build`) runs only that config. So `pnpm build` passing says **nothing** about the
backend. Measured, by appending `const __probe: number = "not a number"` to
`src/server/config.ts`:

```
pnpm exec tsc        -> PASS   (the browser config never sees src/server)
pnpm build           -> PASS   (same config, so also blind)
pnpm service:check   -> FAIL   caught
pnpm gates           -> FAIL   caught
```

**This used to be a hole in CI and is not any more** (ELEG-5): CI ran `lint`,
`format:check`, `build`, `test`, so the entire backend was typechecked by nothing and a
type-broken service merged green. `ci.yml` now runs `pnpm gates`, which includes
`service:check`.

The trap that remains is the one the table above encodes: **`pnpm build` is not a
typecheck of the backend.** If you are running single checks by hand rather than
`pnpm gates`, run both typechecks — the second is the one that matters for
`src/server/**` and `src/telegram/**`.

Production is why this bites: the service runs the TypeScript **directly** under
`node --import tsx`, so there is no compile step between a type error and the running
service — the process just throws at runtime, restarts (`Restart=always`), and throws
again.

## `main` is green again — the two reds that used to be here are both fixed

**As of ELEG-4, CI passes on `main` for the first time since July** (run 31176229965,
`✓ ci in 8m57s`). So the old advice — "a red check is probably not yours" — no longer
applies by default: **a red check on your branch is now most likely yours.** Both
historical reds are kept below because their shapes recur, not because they are live.

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

Either way the habit stands: **read which step failed before attributing a red check** to
your branch or dismissing it. What has changed is the prior — a red check is now evidence
about your change rather than background noise.

One thing that did **not** change: the install step takes **~9 minutes** on a cold cache,
because `onlyBuiltDependencies` lets `onnxruntime-node`, `sharp`, `protobufjs` and
`esbuild` run native build scripts. A long-running install is not a hang.

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

The suite is **small and almost entirely pure functions**. `pnpm exec vitest list` prints
the current set — trust that over this page, which describes *shape* deliberately and
quotes no totals (ELEG-15):

- `src/__tests__/types.test.ts` — zone detection and sub-status classification.
- `src/server/__tests__/mcp-doc-parity.test.ts` — `MCP.md` lists exactly the registered
  tools and resources (ELEG-7). That is a **documentation** check. It will catch you
  renaming a tool without touching the doc; it will not notice that the tool stopped
  working.
- `src/server/__tests__/build-info.test.ts` — the deployed-commit stamp (ELEG-6).
- `src/server/__tests__/telegram-allowlist.test.ts` — who may issue bot commands (ELEG-3).
  A security boundary, so it asserts refusal as hard as it asserts admission.
- `src/server/__tests__/layer-tracking.test.ts` + `src/__tests__/layer-chart.test.ts` —
  the layer-time series and the chart's domain arithmetic (ELEG-16/18): the print-boundary
  rule, and that no point can map outside the plot rect.
- `src/__tests__/layer-chart-render.test.ts` — the **only** tests that run drawing code.
  No jsdom and no canvas: they hand the chart a recording 2D-context stub and assert on
  the ops it emitted (is there a `clip()` around the series, does a coordinate leave the
  plot rect, does the value label fit). Copy this shape for another canvas card; it needs
  no new dependency.
- `src/server/__tests__/state-store-restore.test.ts` — the only test that stands up a real
  `StateStore` (ELEG-18). The obstacle was assumed to be MQTT; it is not. The constructor
  only registers listeners, so an `EventEmitter` stub suffices — but it starts a chart
  interval, so `destroy()` in `afterEach` is required or vitest never exits.

Nothing tests the MQTT bridge, the state store's *event* handling, any REST route,
`/mcp`'s actual behaviour, the Moonraker/OctoPrint layers, the Telegram middleware wiring
or the AI monitor. The one render test asserts *geometry*, not appearance — there is still
no browser and no screenshot, so colour, font, overlap and layout are unchecked by any
gate.

**Do not write a test count into prose here or anywhere else.** It was "eleven" for a
while, then eighteen, and during one pass it got bumped twice in an afternoon — each bump
just restarting the same clock. `vitest` prints the real number every run, two lines above
the footer that used to assert it.

Note the split those last two demonstrate: a test importing `src/server/**` belongs under
`src/server/__tests__/`, because `tsconfig.json` excludes that directory and an import
from `src/__tests__/` drags Node-only modules into the browser typecheck.

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
