# This repo's gates

The gate command (which is what CI runs), why green still means very little here, and the
printer boundary no gate can enforce.

`.agents/repo.json` names this file as `gatesDoc`, which is how a repo-agnostic command
finds this repo's particulars without carrying them. Its counterpart is the
**`gate-failures` skill** in the userspace bundle: that one names no command or runner, so
it can be shared; this one is nothing but commands and runners, so it never leaves the
repo. Read them together the first time a gate fails in a pass.

## The command

```bash
pnpm gates          # scripts/gates.sh — the whole set, with a ✓/✗ summary
pnpm gates --fix    # biome check --write first; commit what it rewrites
```

Six checks — and since ELEG-5, **`ci.yml` runs this exact script as its only step**, so
this table is CI's step list too. Add a gate here and CI picks it up with no workflow edit.

| # | Check | Command | Notes |
| --- | --- | --- | --- |
| 1 | lint | `biome ci` | **non-writing**, as CI does it; covers formatting as well as lint |
| 2 | typecheck (browser) | `tsc` | `tsconfig.json` — **excludes `src/server`** |
| 3 | typecheck (service) | `tsc -p tsconfig.server.json` | `tsconfig.server.json` — the other half. See below |
| 4 | dead code | `knip --no-config-hints` | ELEG-65; scoped to unused **files**, not exports. See below |
| 5 | build | `vite build` | writes `dist/`, which is gitignored |
| 6 | tests | `vitest run` | ~350 ms; it prints its own count, so none is quoted here |

Grep the log for `✗` to get the failing gate, then read upward for that check's own
output.


## What the checks are scoped to, and the path-argument trap

**`biome.json`'s `includes` is the only place the lint scope is written** (ELEG-79).
Every biome invocation — the gate, `lint`, `format`, `check` — is passed **no path
argument**, deliberately.

A CLI path argument **silently overrides** `includes`: it narrows the file set and no
warning says so. Until ELEG-79 the gate ran `biome ci src/` while `includes` said
`src/**`, so the two agreed by accident and widening `includes` alone would have changed
nothing. Measured at the time — with `"*.config.ts"` added to `includes`:

```
pnpm exec biome ci src/   -> Checked 84 files, PASS   (path arg wins; config files unseen)
pnpm exec biome ci        -> Checked 87 files, FAIL   (real formatting drift in both)
```

Both root config files had genuine drift sitting there uncaught. So **do not reintroduce
a path argument** to any biome script; change `includes` instead, and the writing
(`--write`) and non-writing (`ci`) variants stay in agreement by construction rather than
by two edits remembered together.

`biome ci` also emits two `infos` about `biome.json` itself — a `$schema` version behind
the CLI, and the deprecated `recommended` field. Both are **infos, not errors**: they do
not affect the exit code. Do not read them as a red gate.

## Both root config files are typechecked, via `tsconfig.json`

`vite.config.ts` and `vitest.config.ts` are in `tsconfig.json`'s `include` (ELEG-79), so
`pnpm exec tsc` and `pnpm build` cover them. Before that they were in **no** tsconfig and
**no** biome scope: a type error in either was caught by nothing, and in
`vitest.config.ts` it surfaced as a *test* gate failure, which reads like a broken test
rather than a broken config.

The audit that stays accurate as the repo grows is one line — anything it lists must be
in a tsconfig `include` and matched by `biome.json`'s `includes`:

```bash
git ls-files '*.ts' '*.tsx' | grep -v '^src/'
```

## There are two typechecks, and `pnpm build` is only one of them

`tsconfig.json` **excludes `src/server`**, and `pnpm build` (`tsc &&
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
`src/server/**`.

Production is why this bites: the service runs the TypeScript **directly** under
`node --import tsx`, so there is no compile step between a type error and the running
service — the process just throws at runtime, restarts (`Restart=always`), and throws
again.

### And neither typecheck proves an import specifier actually resolves

Both tsconfigs set `moduleResolution: "bundler"`, which **accepts extensionless relative
specifiers that Node rejects**. So `./allowlist` instead of `./allowlist.js` under
`src/server/**` passes `service:check`, passes `vite build`, passes CI — and then throws
`ERR_MODULE_NOT_FOUND` at the running service, which restarts and throws again. This is
the enforcement gap behind the `.js`-on-every-relative-import rule in `AGENTS.md`: the
rule is real, and **no gate checks it.**

If you move or rename a file under `src/server/**`, resolve it under real Node before
you trust the green run (ELEG-23):

```bash
node --import tsx -e "await import('./src/server/<the-importer>.ts'); console.log('resolved')"
```

Pick an importer that has **no import-time side effects** — check the module scope first.
`config.ts` and `allowlist.ts` are safe (a logger at most). **Do not import
`src/server/index.ts`**, which wires the MQTT bridge and would open a second connection
to the printer against the running service.

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

## Running the gates concurrently — the split RCP needs, this repo does not (ELEG-78)

The bundle's `/auto --parallel N` carries a gate split: **subagents run the fast gate; the
orchestrator runs anything binding a fixed port or a fixed database name, serially,
itself.** That rule has a specific cause, and the cause is absent here — so do not port the
ceremony along with the command.

RCP's hazard is Playwright: it binds a fixed port and `reuseExistingServer` will **adopt**
a server another worktree already started, so two concurrent runs silently test each
other's build and both report plausible, wrong results. A per-repo lock does not help,
because the adoption happens outside it.

**Measured here:** the five gates are `biome ci`, `tsc`, `tsc -p tsconfig.server.json`,
`vite build` and `vitest run`. None starts a server, none binds a port, none touches a
database. `package.json` has no `playwright` or `puppeteer` dependency and there is no e2e
or browser-driving test of any kind. `vitest run` is in-process and finishes in a few
hundred milliseconds.

Three consequences, all of them the *opposite* of RCP's:

- **There is nothing for the orchestrator to run serially.** Every worktree runs the whole
  of `pnpm gates` concurrently and the results are independent.
- **There is no fast gate to split off, and adding one would be inventing a field.**
  `.agents/repo.json` lists `gates.all` and `gates.fix` and no `gates.quick`; absent means
  absent. `pnpm gates` *is* the fast gate here.
- **N is not capped by test-server adoption**, because nothing serialises behind the
  orchestrator. The real ceilings are CI (a public repo on `ubuntu-latest`, so minutes are
  free but runs still queue) and the reviewer's own capacity to verify N branches — which
  is a human limit, not a mechanical one, and the bundle's "3 is a sane ceiling" is about
  exactly that. Treat it as advice here rather than as a hardware constraint.

**What does not relax, and is the reason this section is not simply "parallelism is free
here":**

- **The printer boundary.** `pnpm gates` cannot touch the printer, so more concurrency adds
  no hardware risk *from the gates* — but N agents is N chances for one of them to decide a
  `Set…` would settle a question. The boundary is per-agent and does not scale with
  cleverness. See "The gate no script can run" below.
- **This repo is public.** More agents writing concurrently is more chances for a hostname,
  an address or a capture to reach a commit, a branch name or a generated file. ELEG-82 is
  what that looks like when a single developer does it unhurried.
- **Green still proves very little**, exactly as the honest list below says. Running five
  green gates in parallel produces five results that each mean as little as one does.

## Warnings exit 0 here — the baseline is zero, keep it there

`biome.json` sets a number of rules to `warn` rather than `error`, including
`noExplicitAny`, `noUnusedVariables`, `noUnusedImports` and
`noUnusedFunctionParameters`. `biome ci` **exits 0** on warnings, so they cannot fail a
gate.

Measured on this branch: **zero warnings** across the 87 files `biome ci` now checks. That makes the honest rule simple —
your change should add none, and because the count is currently zero you can see that at a
glance instead of diffing against a baseline. (This is the opposite of the VTK sibling,
which made warnings hard errors; do not paste either repo's framing into the other.)

### `vite build` exits 0 on its own warnings too — and one of them is dated (ELEG-87)

biome is not the only gate that warns without failing. **`vite build` exits 0 while
printing warnings about your config**, so a green `pnpm gates` says nothing about
whether `vite.config.ts` still loads under the loader vite is moving to:

```
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`,
    which is planned to become the default in a future major version of Vite:
  - `__dirname` (vite.config.ts:25:29). Use `import.meta.dirname` instead
```

The useful part is that **you do not have to wait for the default to flip to find
out.** vite 8.2.1 has a CLI flag for it, so the future default is testable today:

```bash
npx vite build --configLoader native    # exit 1 today = a red build after the bump
```

That turns "this will break later" from a forecast into a measurement, and it is the
only check that actually proves a config fix. ELEG-87 used it in both directions:
`__dirname` gave `ReferenceError: __dirname is not defined` and exit 1, and
`import.meta.dirname` built clean with **byte-identical output hashes** to the bundle
loader — which is the stronger claim, because it shows both loaders resolve the
config the same way rather than merely not crashing.

Two traps worth keeping:

- **The warning names only the first occurrence.** `vite.config.ts` had two
  `__dirname` uses; fixing the one the warning pointed at just moved the warning to
  the other line, and the native build still failed. **Grep the file, do not trust
  the line number.**
- **Never reach for `VITE_CONFIG_NATIVE_IGNORE_WARNING=true`.** It silences the
  notice and keeps the breakage, so the bump lands with no warning at all.

The general shape, which is the reason this sits in this file: **a gate that exits 0
while printing a dated notice is a gate that will go red on a day nobody connects to
the change that caused it.** Read the build log, not just the exit code.

## biome does not reach the instruction files — measured

**The original reason for this section is gone; the measurement is worth keeping.** It used
to be about protecting `commands/shared/` byte-identity from a formatter. ELEG-81 deleted
that tier — the shared rules are skills in the userspace bundle now — so nothing here has
to stay identical with anything.

What remains true: `biome.json` scopes `files.includes` to `src/**` and `*.config.ts` with
`!**/*.md`, so no markdown in this repo is formatted at all, including `AGENTS.md` and `.agents/**`. Confirmed
rather than assumed:

```
$ pnpm exec biome check .agents/gates.md
Checked 0 files in 782µs.
  × No files were processed in the specified paths.
  i These paths were provided but ignored:
  - .agents/gates.md
```

So hand-formatting here is fine — unlike VTK, where root `*.md` **is** formatted and
`--error-on-warnings` turns a formatting complaint into a hard gate failure.

If `files.includes` is ever widened to `**`, decide deliberately whether the instruction
files should be formatted. There is no longer any byte-identity to protect, so the only
question is whether you want a formatter reflowing prose nobody edited.

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

## Unreachable code is now gated — knip, after it had bitten four times

**This is now gate 4** (`knip`, ELEG-65). Before it, nothing noticed a module that
nothing imports: neither typecheck complains — an unimported file typechecks fine on its
own — and `vite build` tree-shakes it out **silently**, so the bundle is correct and the
file survives in the tree looking perfectly legitimate.

Four modules were found that way, and every one of them by a human reading, never by a
check:

- `src/telegram/**` — a whole standalone bot with its own `MqttBridge`, no npm script and
  no way to start it. It also meant ELEG-3's security fix had to be applied twice.
  Deleted in **ELEG-23**.
- `src/ui/system-info.ts` — a near-duplicate `renderSystemInfo` targeting the same
  `#system-info` element as the live one in `service-status.ts`. `main.ts` imports the
  other one via `dashboard.ts`, so this copy had never run. It had drifted, too: it was
  missing the `if (!container) return` guard, so it would have thrown if it ever had.
  Deleted in **ELEG-55**.
- `src/mqtt-client.ts` — a browser-side `CC2MqttClient`, i.e. **a second MQTT client
  implementation**, superseded by `ws-client.ts`, whose own header comment says it
  *"provides the same interface as the old CC2MqttClient"*. Found by knip's first run in
  **ELEG-65** and deleted there.
- `src/persistence.ts` — client-side localStorage chart persistence, superseded when
  chart history moved server-side (`main.ts` still carries the comment *"Load chart
  history from service (replaces localStorage persistence)"*). Also **ELEG-65**.

The last two are the argument for the gate rather than the vigilance: they had been dead
for the life of the repo, through several passes of people reading this very file, and
knip found them in under a second. Note also that two of the four were *second copies of
something live* — which is why this matters beyond tidiness. A dead duplicate rots
(ELEG-55's had already lost a guard) and it reads as live code to whoever edits next; and
a security fix applied to the reachable copy only is a fix that looks done and is not.

### Why it is scoped to `files`, and what that gives up

`knip.json` sets `"include": ["files"]`. Measured on the first run, the unscoped default
also reported **21 unused exports and 19 unused exported types**, and they are
overwhelmingly false positives here:

- `src/ui/dashboard.ts` re-exports a barrel, so a live function is reported **twice** —
  once at its definition and once at the re-export.
- `src/types.ts` is a shared type module; an interface used only as a structural shape is
  not an "unused export" in any sense that matters.

A dead-code check that cries wolf gets ignored, which is worse than not having one — so
the gate is the deterministic, quiet signal, and the noisier one stays available
on demand:

```bash
pnpm exec knip --include exports,types   # report only; deliberately NOT a gate
```

That is a judgement call and it does give something up: a genuinely unused export will
not fail the gate. The two known classes of defect were both whole unreachable *files*,
which is what this gates.

### Acceptance — it was checked against the cases it exists for

ELEG-65 required this, and it would have been dishonest to skip: a dead-code check that
would not have caught the two known cases is not worth adding. Both were restored from
the commit **before** each deletion (`git checkout 1fbb3d0^ -- src/telegram`,
`git checkout dd31334^ -- src/ui/system-info.ts`) and knip run against the result:

```
Unused files (8)
src/telegram/allowlist.ts
src/telegram/bot.ts
src/telegram/camera.ts
src/telegram/commands.ts
src/telegram/config.ts
src/telegram/mqtt-bridge.ts
src/telegram/notifications.ts
src/ui/system-info.ts
```

Exit 1, all seven telegram files including the duplicate `mqtt-bridge.ts`, plus
`system-info.ts`. Restored into the *current* tree rather than checking out the old
commits wholesale, which is the stricter test: today's tree has more live code that could
have accidentally imported them.

### Two traps if you change `knip.json`

- **`--no-config-hints` is deliberate.** With `src/main.ts` and `src/server/index.ts`
  listed explicitly, knip prints a "redundant entry pattern" hint on every run because it
  auto-detects both. The entries are kept explicit anyway — auto-detection reads
  `package.json`'s scripts, so removing the `service` script would silently narrow what is
  checked — and the hint is suppressed rather than the config weakened.
- **The test files are entry points.** `src/__tests__/**/*.test.ts` is in `entry`; without
  it every test file is itself "unused" and the gate is instantly useless.

## Dependency advisories are deliberately NOT a gate

`pnpm audit` is not in `scripts/gates.sh` and should not be added to it (ELEG-63). The
gate set is otherwise deterministic and offline; `pnpm audit` queries a third-party
advisory feed, so the same commit passes today and fails tomorrow because someone
published. That would turn a PR red for a reason unrelated to the PR — and "a red check
on your branch is yours" is a signal this repo spends real effort keeping true.

Advisories live in [`.github/workflows/audit.yml`](../../../.github/workflows/audit.yml)
instead: weekly, on changes to the lockfile/manifest, and on demand. **It never fails the
job.** Do not make it a required check.

Two things to know when it reports something:

- **The fix is almost always a floor in `overrides:` in `pnpm-workspace.yaml`**, not a
  manifest bump. Every one of the 38 advisories open at ELEG-63 was transitive.
- **Dependabot will not do it for you**, even though it is enabled on this repo. It bumps
  what it finds in a manifest; it does not write pnpm overrides. It had opened zero PRs
  for those 38. Enabled ≠ covered.

An override is a floor, not a pin: `pnpm why <pkg>` tells you whether the parent's own
range has caught up, at which point delete the line rather than leave a number nobody can
date.

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
