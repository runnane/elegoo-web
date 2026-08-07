# Testing — what is covered, and what nothing covers

Be honest about the starting point: **the suite is six files, 39 tests**, all but three
over pure functions.

- `src/__tests__/types.test.ts` — `detectZone`, `isFilamentChangeSubStatus`.
- `src/__tests__/layer-chart.test.ts` — the layer chart's window selection and domain
  arithmetic (ELEG-16).
- `src/__tests__/layer-chart-render.test.ts` — the only tests that run drawing code, via
  a recording 2D-context stub (ELEG-16). See below.
- `src/server/__tests__/layer-tracking.test.ts` — the print-boundary rule for the
  layer-time series (ELEG-16).
- `src/server/__tests__/mcp-doc-parity.test.ts` — `MCP.md` matches the registered tools
  and resources (ELEG-7). A *documentation* check.
- `src/server/__tests__/build-info.test.ts` — the deployed-commit stamp (ELEG-6).

Everything else in this repo — the MQTT bridge, the state store's wiring, every REST
route, the MCP server's behaviour, both compatibility layers, the Telegram bot and the
AI monitor — has **no test at all**.

So `pnpm gates` green means: it compiles, it is formatted, some pure functions still
work, and one chart still puts its ink inside its own axes. Read that sentence again
before quoting a green run as evidence in a closing comment.

## Testing canvas code without a browser

`src/__tests__/layer-chart-render.test.ts` is the pattern, and it needs no new
dependency: hand the render function a stub `getContext('2d')` that pushes every call
into an array, stub `document.getElementById` and `window.devicePixelRatio`, then assert
on the *operations*. It catches the things that are cheap to get wrong and invisible in a
diff — a missing `ctx.clip()`, a coordinate outside the plot rect, a label drawn past the
canvas edge (ELEG-16 had all three).

What it cannot tell you is whether the result **looks** right: colour, font, overlap and
layout need eyes on `pnpm dev:web`. Reach for jsdom only if you need real layout — it is
a dependency and an environment switch, not a free upgrade.

**Where a new test file goes is decided by the typechecks, not by taste.** A test that
imports `src/server/**` belongs under `src/server/__tests__/` — `tsconfig.json` excludes
that directory, so importing server code from `src/__tests__/` drags Node-only modules
into the browser typecheck. Frontend tests go in `src/__tests__/`. `vitest.config.ts`
picks up both.

```bash
pnpm test              # vitest run
pnpm test:watch
pnpm test:coverage
pnpm gates             # the whole set — see .claude/commands/local/gates.md
```

`vitest.config.ts` runs in the **node** environment and picks up
`src/**/*.test.ts` **and `test/**/*.test.ts`**, so a new suite can live in either
place. There is no jsdom/happy-dom and no browser: a test that touches `document`
needs a new environment configured, which is a decision to make deliberately rather
than by adding a `// @vitest-environment` line and moving on.

## The typechecks are the real safety net, and one of them is easy to miss

With almost no tests, `tsc` is doing most of the work — which is exactly why
`tsconfig.json` **excluding `src/server` and `src/telegram`** matters so much. `pnpm
build` and CI both run only that one, so **the whole backend can be type-broken while
everything looks green.** Run `pnpm service:check` (or just `pnpm gates`) after
touching `src/server/**` or `src/telegram/**`. See
[`.claude/commands/local/gates.md`](../.claude/commands/local/gates.md).

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

Build fixtures from **captured real payloads** (the debug panel exports the state tree,
and `${DATA_DIR}/state.json` is a real snapshot) rather than hand-writing an idealised
message — the CC2's actual payloads are the thing worth encoding. Strip anything
identifying before committing a fixture.

## Do not test against the printer

This is the repo's hard boundary and it is restated here because "just try it" is the
instinct a test failure produces: the printer is a physical machine. Reads are fine.
`set_temperature`, `fan`, `move`, `home`, `start_print`, `pause_print`, `stop_print`
and `emergency_stop` are **not test tools** — they heat a real nozzle, drive real
motors into whatever is on the bed, or abort a job that has been running for hours.
Verifying one of those is operator work: give the exact command, ask for the output,
interpret it. See [`AGENTS.md`](../AGENTS.md).

## `pnpm dev` on this host collides with production — twice

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

To run the service locally, override both ports in your checkout's `.env`
(e.g. `SERVICE_PORT=8188`, `MOONRAKER_PORT=7225`) and accept that you are still opening
a second MQTT connection — so keep it short, and prefer `pnpm dev:web` (vite on :5173,
frontend only) whenever the change is frontend-only. `vite.config.ts` proxies the API
to the running service, which means **the dev frontend can be pointed at production
state without a second connection at all.** That is the safest way to work here.

## What nothing checks — say so instead of implying otherwise

- **Layout and the actual UI.** No browser test, no screenshot, no playwright. A card
  that renders empty, overlaps, or throws in the console is invisible to every gate.
  Look at the page.
- **The WebSocket contract.** `ws-transport.ts` broadcasts and `ws-client.ts` consumes;
  nothing asserts they agree. Renaming a message `type` on one side is silent.
- **The MCP surface.** Neither the tool list nor `MCP.md`'s accuracy is verified — the
  doc can be wrong and no gate notices (see [mcp.md](mcp.md)).
- **The compatibility layers against a real client.** Mainsail/Fluidd/KlipperScreen
  compatibility is only ever proven by pointing one of them at `:7125`.
- **Anything about the deployed service.** The gates run in the checkout;
  `/opt/elegooweb` is a different tree.

When you close an issue, state what you actually ran and what it can and cannot prove.
"`pnpm gates` green" is true and weak here; "gates green, and I read the state-merge
path by hand because nothing tests it" is the honest version.
