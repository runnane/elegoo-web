# The `/mcp` surface

This repo is an MCP **server**: it exposes the printer to AI agents over
StreamableHTTP at `POST /mcp` on `SERVICE_PORT`, implemented in
`src/server/mcp-server.ts` and documented in [`MCP.md`](../MCP.md).

It is also, separately, an MCP **client** of the RCP tracker — that is
[`.mcp.json`](../.mcp.json), which is how the `/fix`, `/plan` and `/sweep` commands read
and write ELEG issues. Two unrelated things with the same acronym; don't conflate them
when reading a stack trace or an error message.

## The server

- **Transport**: StreamableHTTP with session management. `initialize` on `POST /mcp`
  returns an `Mcp-Session-Id` header; every later request carries it. `GET /mcp` is the
  SSE stream, `DELETE /mcp` closes the session.
- **Per-session server instance**, all sharing the one `StateStore` and `MqttBridge`
  from `src/server/index.ts` — so a tool never opens its own printer connection (see
  [architecture.md](architecture.md)).
- **6 resources** (`printer://status|files|metrics|events|system|zones`) and **31
  tools**, grouped in `MCP.md` as read-only / control / print management / maintenance.

Connecting a client locally:

```bash
claude mcp add --transport http elegoo http://localhost:8088/mcp
```

## Two rules

**1. `MCP.md` and `mcp-server.ts` change in the same commit.** The doc is the contract —
it is what an agent reads to decide what to call.

**A test now enforces the name half of this** (ELEG-7):
`src/server/__tests__/mcp-doc-parity.test.ts` stands the server up over an in-memory
transport, asks it for its tools and resources exactly as a client would, and compares
that against the tables in `MCP.md` **in both directions** — a tool missing from the doc
fails, and a doc row with no tool behind it fails too. It also checks the counts quoted in
`README.md` and in this file. So adding a tool without touching the doc is now a red gate
rather than silent drift, and the counts cannot rot.

It lives under `src/server/` deliberately: `tsconfig.json` excludes that directory, so a
test importing server code from `src/__tests__/` would drag Node-only modules into the
browser typecheck. Being there means it is typechecked by `pnpm service:check` rather than
by `pnpm build`, which never sees `src/server`. Both run in `pnpm gates`, and since ELEG-5
`pnpm gates` is what CI runs — so the test executes on every PR.

**What the test still does not check: parameters, types and bounds.** It compares *names*.
A changed clamp (`0-300°C`), a new optional parameter, a renamed argument or a wrong
default is drift it will not catch, and that is the drift most likely to mislead an agent —
a documented bound that is no longer enforced is worse than an undocumented one. Keep
updating those by hand.

**2. A tool that commands the printer is a physical action.** `set_temperature`, `fan`,
`led`, `home`, `move`, `start_print`, `pause_print`, `resume_print`, `stop_print` and
`emergency_stop` all reach a real machine. Consequences:

- **Do not call them to test your change.** Read-only tools and the `printer://*`
  resources are fair game against a live printer; the rest is operator work — give the
  exact call and ask.
- **Validate and clamp at the tool boundary.** The existing tools bound their inputs
  (`nozzle` 0–300 °C, `bed` 0–120 °C, fan 0–100 %) and a new one must too, in the tool
  schema rather than downstream, because the schema is also the documentation an agent
  reads before calling.
- **The endpoint is unauthenticated**, like the rest of the service — so every tool you
  add is available to anyone who can reach the port. Read
  [security.md](security.md) before adding one, and say on the issue that you are
  widening that surface.

## When a client's tool list looks wrong

An MCP client's tool schemas are captured when the session connects and **do not
refresh on their own**. So "the server doesn't have that tool" or "that parameter isn't
accepted" may simply be a stale session — reconnect, or check the live surface directly
before believing it:

```bash
curl -s -X POST http://localhost:8088/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

`tools/list` with the returned session id then gives you the real list. This costs a
minute and settles the question; the same trap in the sibling RCP repo produced a
careful, wrong issue about a tool that had been there all along.
