# Testing — what is covered, and what nothing covers

Be honest about the starting point: **the suite is small and almost entirely pure
functions.** `pnpm exec vitest list` prints the current set; the list below describes what
each file is *for*, and quotes no totals on purpose (ELEG-15 — a count in prose only ever
drifts).

- `src/__tests__/types.test.ts` — `detectZone`, `isFilamentChangeSubStatus`.
- `src/__tests__/layer-chart.test.ts` — the layer chart's window selection and domain
  arithmetic (ELEG-16/18).
- `src/__tests__/layer-chart-render.test.ts` — the only tests that run drawing code, via
  a recording 2D-context stub (ELEG-16). See below.
- `src/server/__tests__/layer-tracking.test.ts` — the print-boundary rule for the
  layer-time series (ELEG-16/18).
- `src/server/__tests__/state-store-restore.test.ts` — the only test that stands up a real
  `StateStore` (ELEG-18). See below.
- `src/server/__tests__/telegram-allowlist.test.ts` — who may issue bot commands (ELEG-3).
- `src/server/__tests__/mcp-doc-parity.test.ts` — `MCP.md` matches the registered tools
  and resources (ELEG-7). A *documentation* check.
- `src/server/__tests__/build-info.test.ts` — the deployed-commit stamp (ELEG-6).

Everything else in this repo — the MQTT bridge, the state store's *event* handling, every
REST route, the MCP server's behaviour, both compatibility layers, the Telegram middleware
wiring and the AI monitor — has **no test at all**.

So `pnpm gates` green means: it compiles, it is formatted, some pure functions still
work, and one chart still puts its ink inside its own axes. Read that sentence again
before quoting a green run as evidence in a closing comment.

## The state store is reachable after all

`.agents/testing.md` long said the store was the most bug-prone untested code here, with
the MQTT bridge as the obstacle. It is not one:
`src/server/__tests__/state-store-restore.test.ts` constructs a real `StateStore` with an
`EventEmitter` stub in place of the bridge — the constructor only registers listeners, and
nothing on the restore path calls it. No printer, no network, no MQTT.

One trap: the constructor starts a chart-sampling `setInterval`, so a test must call
`store.destroy()` (an `afterEach` is the obvious home) or vitest will never exit.

That opens the delta-merge tests this page has been asking for — a field absent from a
printer delta means *unchanged*, not *cleared*, and nothing enforces it.

## Testing canvas code without a browser

`src/__tests__/layer-chart-render.test.ts` is the pattern, and it needs no new
dependency: hand the render function a stub `getContext('2d')` that pushes every call
into an array, stub `document.getElementById` and `window.devicePixelRatio`, then assert
on the *operations*. It catches the things that are cheap to get wrong and invisible in a
diff — a missing `ctx.clip()`, a coordinate outside the plot rect, a label drawn past the
canvas edge (ELEG-16 had all three).

What it cannot tell you is whether the result **looks** right: colour, font, overlap and
layout need eyes on `pnpm dev:web`. This stub approach is still the right one for canvas
work — jsdom gives you a DOM, not a renderer, and `getContext('2d')` under it does
nothing useful.

**Where a new test file goes is decided by the typechecks, not by taste.** A test that
imports `src/server/**` belongs under `src/server/__tests__/` — `tsconfig.json` excludes
that directory, so importing server code from `src/__tests__/` drags Node-only modules
into the browser typecheck. Frontend tests go in `src/__tests__/`. `vitest.config.ts`
picks up both.

```bash
pnpm test              # vitest run
pnpm test:watch
pnpm test:coverage
pnpm gates             # the whole set — see .agents/gates.md
```

`vitest.config.ts` runs in the **node** environment by default and picks up
`src/**/*.test.ts` **and `test/**/*.test.ts`**, so a new suite can live in either place.

## There IS a DOM environment now — opt in per file (ELEG-61)

`jsdom` is a devDependency, and a test that needs `document` opts in with a **docblock on
its first line**:

```ts
// @vitest-environment jsdom
```

That is the whole mechanism. **There is no config change** — no `environment` key, no
glob, no setup file — which is deliberate: the pure tests keep running in the faster
`node` env, and there is nothing for the next person to find and misread. Copy the
docblock, not a config entry.

`src/__tests__/list-controls-dom.test.ts` is the pattern. Read its header before writing
another; the two things it establishes:

- **Assert the invariant *and* its counterfactual.** It asserts focus/caret/selection
  survive a list re-render, and then, in a separate `describe`, mounts the bar *inside*
  the re-rendered container and asserts focus **is** lost. A test that cannot go red is
  not coverage, so the failure mode is encoded permanently rather than demonstrated once
  by hand. Verified: moving the bar inside turns three of the focus tests red.
- **There is no `localStorage`** — `bare`, `window.` and `globalThis.` are all
  `undefined` under jsdom 30 on Node 26. `ui-settings.ts` catches and falls back to
  defaults, so a persistence test would **pass for the wrong reason**. Give each case a
  unique list id instead, and do not assert persistence until **ELEG-64** lands.

What jsdom still does not give you: layout, paint, real fonts, or `getContext('2d')`.
Colour, overlap and appearance are still `pnpm dev:web` and eyes, and there is still no
browser or screenshot in any gate.

## The typechecks are the real safety net, and one of them is easy to miss

With almost no tests, `tsc` is doing most of the work — which is exactly why
`tsconfig.json` **excluding `src/server`** matters so much. `pnpm build` and CI both run
only that one, so **the whole backend can be type-broken while everything looks green.**
Run `pnpm service:check` (or just `pnpm gates`) after touching `src/server/**`. See
[`.agents/gates.md`](gates.md).

## Where a test is worth writing here

The high-value, low-friction targets are the pure and near-pure functions that already
carry the protocol's hard-won knowledge:

- **`src/types.ts`** — zone detection, status/sub-status classification, unit
  conversions. Cheap to test, and `types.test.ts` is the pattern to copy.
- **`src/server/state-store.ts` / `src/printer-state.ts`** — the delta **merge**. Feed
  it a sequence of captured status payloads and assert the merged result. This is the
  most bug-prone code in the repo (a field missing from a delta means *unchanged*, not
  *cleared*) and it is entirely untested.
- **`src/server/config.ts`** — `loadConfig()` already throws on a bad `PRINTER_IP` or
  port. Those refusals are worth pinning; they are the only validation in the service.
- **The compat layers** — `moonraker-compat.ts` / `octoprint-compat.ts` translate a
  state object into a fixed third-party JSON shape. Pure input → output, and a client
  like Mainsail breaks silently when a field's shape drifts.

**The pure-half / DOM-half split stays, even though jsdom now exists** —
`card-layout.ts` + `settings.ts`, `list-sort.ts` + `list-controls.ts`. **Put the
decisions in the pure half**: those tests are faster, they read better, and they do not
depend on an environment. What ELEG-61 changed is that the DOM half is no longer
*unreachable* — wiring, focus behaviour and event handling can now be asserted, and the
one invariant that had been held up by code review alone now has a test. Everything else
that renders is still asserted by nothing.

Build fixtures from **captured real payloads** (the debug panel exports the state tree,
and `${DATA_DIR}/state.json` is a real snapshot) rather than hand-writing an idealised
message — the CC2's actual payloads are the thing worth encoding. Strip anything
identifying before committing a fixture.

## Settling a protocol claim, read-only

Several ELEG issues have been filed against method numbers that turned out not to
exist, so it is worth writing down how to check one **without touching the machine**.

**`METHOD_NAMES` in `src/ui/log-methods.ts` is a display label, not a citation.** It is
the most readable list of methods in the repo, which is exactly why wrong numbers got
copied out of it into issues — ELEG-38 asked for a history delete on 1049 (really
`UpdateToken`, an auth-token write), ELEG-30 for AI detection on 2010/2011 (neither
exists), ELEG-32 for OTA on 1064 (really 1039). It also contradicted itself, listing
both 1038 and 1049 as history delete. ELEG-57 audits it.

The citable sources are `data/CC2_PROTOCOL_REFERENCE.md` (transcribed from the official
app, with the full method table, the `hh` error-code enum and per-method payloads) and
`data/CC2-OFFICIAL-APP-PATTERNS.md`. When those two agree, that is usually enough. When
they disagree with the running code — and they do, for 1062 and the 2006/2007 pair —
neither wins on authority, because the reference may describe a different firmware.

Then a **`Get…` method can simply be asked**, which is a read and therefore allowed:

```bash
# From the repo root, so `ws` resolves. Sends one Get and prints the reply.
node -e "
import('ws').then(({WebSocket}) => {
  const ws = new WebSocket('ws://localhost:8088/ws');
  ws.on('open', () => setTimeout(() =>
    ws.send(JSON.stringify({type:'command', method:1062, params:{}})), 500));
  ws.on('message', (r) => {
    const m = JSON.parse(r.toString());
    if (m.type === 'response' && m.method === 1062) { console.log(JSON.stringify(m.data)); ws.close(); }
  });
  setTimeout(() => process.exit(0), 8000);
});
"
```

That is how 1062 was shown to return `{"error_code": 1100}` on this firmware — an
undocumented code, and the reason `systemInfo` has always been `null` (ELEG-55).

**Only `Get…` methods.** A `Set…` is a write to a physical machine and must never be
fired to find out what it does; resolve those from a vendor-app capture instead
(`POST /api/debug/capture` records passively — see ELEG-56 for the shape).

## Do not test against the printer

This is the repo's hard boundary and it is restated here because "just try it" is the
instinct a test failure produces: the printer is a physical machine. Reads are fine.
`set_temperature`, `fan`, `move`, `home`, `start_print`, `pause_print`, `stop_print`
and `emergency_stop` are **not test tools** — they heat a real nozzle, drive real
motors into whatever is on the bed, or abort a job that has been running for hours.
Verifying one of those is operator work: give the exact command, ask for the output,
interpret it. See [`AGENTS.md`](../AGENTS.md).

## `pnpm dev` on this host collides with production — three ways

Production runs on this same machine (see [deployment.md](deployment.md)), and it holds
**both** service ports:

```
LISTEN 0.0.0.0:8088      elegooweb.service   (SERVICE_PORT)
LISTEN 0.0.0.0:7125      elegooweb.service   (MOONRAKER_PORT)
```

So `pnpm dev` / `pnpm dev:service` with default config **fails to bind**, and if you
free the ports you hit the worse problem: a second process connecting to the printer's
MQTT broker means **two registrations for one printer**. The broker is small and the
two clients fight — which looks like flapping state or dropped updates in *production*,
not in your dev window.

**The third collision is the Telegram bot, and it bites even on free ports.** Your
checkout's `.env` holds the **production** `TELEGRAM_BOT_TOKEN`, and a bot token supports
exactly one long-poller. Start the service locally and grammy dies with:

```
GrammyError: Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates
request; make sure that only one bot instance is running)
```

— but not before *your* poller has kicked the production one off the token. The live
service recovers (`Restart=always`, and grammy retries), so the damage is a gap in
notifications rather than anything lasting. It also takes your dev process down, which is
how you find out. Measured while verifying ELEG-24.

So when you must run the service locally, blank the integrations rather than only moving
the ports:

```bash
TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID= AI_ENABLED=false CAMERA_ENABLED=false \
  SERVICE_PORT=18096 MOONRAKER_PORT=17122 PRINTER_IP=192.0.2.99 DATA_DIR=/tmp/probe \
  pnpm exec tsx src/server/index.ts
```

`PRINTER_IP` on TEST-NET (`192.0.2.0/24`) is the important part: it means the MQTT
connection attempt goes nowhere instead of becoming the second registration described
above. The service starts and serves HTTP happily without a printer, which is enough to
probe headers, routes and status codes.

Prefer `pnpm dev:web` (vite on :5173, frontend only) whenever the change is frontend-only.
`vite.config.ts` proxies the API to the running service, which means **the dev frontend
can be pointed at production state without a second connection at all.** That is the
safest way to work here.

**When you do probe a local server, prove the request landed.** `curl … | grep -i
'^access-control-allow-origin'` printing nothing means "header absent" *or* "server never
came up", and those look identical. Print the status line too — a check that passes
because nothing answered is worse than no check.

## What nothing checks — say so instead of implying otherwise

- **Layout and appearance.** No browser test, no screenshot, no playwright. jsdom (above)
  can now assert *wiring* — that an element exists, keeps focus, responds to a click —
  but it does no layout and no paint, so a card that renders empty, overlaps, or throws
  in the console is still invisible to every gate. Look at the page.
- **The WebSocket contract.** `ws-transport.ts` broadcasts and `ws-client.ts` consumes;
  nothing asserts they agree. Renaming a message `type` on one side is silent.
- **The MCP surface's *behaviour*.** `mcp-doc-parity.test.ts` does check that `MCP.md`
  lists exactly the registered tools and resources, by standing the server up and asking
  it — so a renamed tool without a doc edit is caught. But that is a **documentation**
  check: it never invokes a handler, so a tool that is listed, documented and completely
  broken passes (see [mcp.md](mcp.md)).
- **The compatibility layers against a real client.** Mainsail/Fluidd/KlipperScreen
  compatibility is only ever proven by pointing one of them at `:7125`.
- **Anything about the deployed service.** The gates run in the checkout;
  `/opt/elegooweb` is a different tree.

When you close an issue, state what you actually ran and what it can and cannot prove.
"`pnpm gates` green" is true and weak here; "gates green, and I read the state-merge
path by hand because nothing tests it" is the honest version.
