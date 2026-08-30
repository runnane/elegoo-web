# Architecture

One MQTT connection to the printer, fanned out to six consumers. Everything else
follows from that.

```
              ┌──────────────── printer (CC2) ────────────────┐
              │  MQTT/TCP :1883   ·   MQTT/WS :9001            │
              │  camera MJPEG :8080  ·  UDP discovery :52700   │
              └───────────────────────┬───────────────────────┘
                                      │
                        src/server/mqtt-bridge.ts   ← the ONLY client
                                      │
                        src/server/state-store.ts   ← merged state + events
                                      │
   ┌──────────┬──────────┬────────────┼─────────────┬──────────────┬──────────┐
   │          │          │            │             │              │          │
 /ws       /api/*      /mcp      /octoprint/*   /moonraker/*   :7125      Telegram
ws-       rest-api   mcp-       octoprint-     moonraker-    moonraker-  telegram.ts
transport   .ts      server.ts   compat.ts      compat.ts     server.ts  + telegram/
```

`src/server/index.ts` wires exactly one of each and is the only place that does. Read
it first: it is ~220 lines and is the whole composition.

## The two HTTP servers

| Port | Source | Serves |
| --- | --- | --- |
| `SERVICE_PORT` (8088) | `createServer` in `index.ts` | `/mcp`, `/octoprint/*`, `/moonraker/*`, then everything else falls through to `rest-api.ts` (`/api/*`, `/webcam/*`, and the built `dist/` with SPA fallback) — plus the `/ws` WebSocket upgrade |
| `MOONRAKER_PORT` (7125) | `moonraker-server.ts` | a **dedicated** Moonraker endpoint on its own port, for clients (Mainsail, Fluidd, KlipperScreen) that expect Moonraker at the root |

So the Moonraker compatibility layer exists **twice**, deliberately: path-prefixed on
8088 and root-level on 7125. A change to Moonraker behaviour usually belongs in
`moonraker-compat.ts` (shared logic) rather than in one of the two entry points.

Dispatch on 8088 is **ordered prefix matching in a single handler**, not a router
library. A new route is an `if (url === …)` branch in `rest-api.ts`, and order matters:
the first match wins, and the static/SPA fallback is last.

## Where a change belongs

- **Printer protocol** (a new MQTT method, a new field in the status delta) →
  `mqtt-bridge.ts` for transport, `printer-state.ts` / `types.ts` for the shape,
  `state-store.ts` for derived state and events. Nothing above this layer should parse
  raw MQTT payloads.
- **Derived state that more than one consumer needs** (zone detection, layer times,
  filament usage) → `state-store.ts`, *not* in the REST handler or the MCP tool that
  happens to need it first. The point of the store is that the WebSocket, the MCP
  server and the Telegram bot all see the same numbers.
- **A new browser-facing read or action** → `rest-api.ts` + the matching card in
  `src/ui/*.ts`. Push state changes over `/ws` (`wsTransport.broadcast`) rather than
  making the browser poll.
- **A new agent-facing capability** → `mcp-server.ts` **and** `MCP.md` in the same
  commit (see [mcp.md](mcp.md)).
- **A new notification** → `src/server/telegram.ts`, driven off a `state-store` event,
  never off a poll of the printer.

## State flow, and the two things that surprise people

1. **The printer sends deltas, and the store merges them.** A field absent from a
   status message means *unchanged*, not *cleared* — `printer-state.ts` merges rather
   than replaces. Code that treats a snapshot as complete will read stale-looking
   nulls right after a reconnect.
2. **State outlives the process.** `state-persistence.ts` writes to
   `${DATA_DIR}/state.json` and `persistence.load()` runs **before** the MQTT
   connection opens, so the first thing a browser sees may be restored history rather
   than live data. Layer charts, print history and filament usage all depend on this;
   don't "fix" an empty-looking store by clearing the file.

## Frontend

`index.html` + `src/main.ts` compose hand-written DOM modules from `src/ui/*.ts` — no
framework, no JSX, no component library. Each card is a module that owns its own DOM
subtree and subscribes to `ws-client.ts` updates. Layout state (which cards are
collapsed / reordered) is persisted client-side by `ui-settings.ts`.

There used to be a `persistence.ts` here too, saving chart and layer data to
localStorage. It was superseded when chart history moved server-side and then sat
unreachable for the life of the repo; knip found it and ELEG-65 deleted it, along with
`mqtt-client.ts` — a browser-side MQTT client from before the service existed, replaced
by `ws-client.ts`. Both are worth knowing about only because their names still read as
plausible in older notes.

`gcode-preview.ts` and `canvas.ts` are the heavy ones (Three.js). Gcode is fetched
through the service, which pre-caches a file when a print starts
(`precacheGcode`) — the printer's own HTTP server is slow while printing, and that
cache is why the preview loads at all mid-print.

## Optional subsystems

`config.ts` gates each of these; they are off unless configured, and every code path
above must tolerate them being `null`:

- **Telegram** (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`)
- **AI print monitoring** (`ai-monitor.ts`) — motion detection, a local SigLIP
  zero-shot classifier via `@huggingface/transformers`, and optionally a remote VLM
  (OpenAI-compatible or Ollama). Emits `analysis`, `alert` and `ai_chart_data`, which
  `index.ts` forwards to the WebSocket, the store and Telegram.
- **Camera** (`CAMERA_ENABLED`) — a single upstream MJPEG connection fanned out to all
  viewers by `rest-api.ts`. Same principle as the MQTT bridge: one connection to the
  device, N consumers. Don't add a second reader.
