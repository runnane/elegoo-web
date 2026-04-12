# Copilot Instructions for elegoo-web

## Project Overview

A web frontend + backend service for Elegoo Centauri Carbon 2 (CC2) FDM printers. The Node.js service maintains a single MQTT connection to the printer and exposes state to browsers via WebSocket, REST API, and Prometheus metrics. Integrations: Telegram notifications, AI print monitoring (CLIP + VLM), Moonraker/OctoPrint compatibility APIs, MCP server.

## Architecture

- **Build**: Vite + TypeScript (vanilla, no framework)
- **Service**: Node.js backend (`src/server/`) — single MQTT connection shared by all consumers
- **Protocol**: MQTT 3.1.1 via mqtt.js (service connects TCP:1883, browsers connect via WS proxy)
- **State**: Service-side `StateStore` with delta merge; browser-side `PrinterState` hydrated from service
- **Transport**: WebSocket (`/ws`) for real-time state, REST (`/api/*`) for snapshots/actions
- **Rendering**: Direct DOM manipulation with `requestAnimationFrame` batching
- **3D Preview**: gcode-preview (Three.js WebGL) for toolpath visualization — on-demand rendering only
- **Charts**: Canvas 2D live charts via `setInterval` (10 FPS) — no `requestAnimationFrame`
- **Styling**: Plain CSS with CSS custom properties (dark theme)

## Key Files

### Service (Backend)
- `src/server/index.ts` — Service entry point, wires all components together
- `src/server/mqtt-bridge.ts` — Singleton MQTT connection to printer (connect, register, heartbeat, commands)
- `src/server/state-store.ts` — Centralized state with event detection (print events, filament, layers, errors)
- `src/server/ws-transport.ts` — WebSocket server for browser clients (init, status, raw message relay)
- `src/server/rest-api.ts` — REST API, camera proxy, Prometheus metrics, file upload/download proxy
- `src/server/config.ts` — Environment-based configuration (`.env`)
- `src/server/telegram.ts` — Telegram bot notifications (print events, progress, snapshots)
- `src/server/ai-monitor.ts` — AI print monitoring (motion detection, CLIP classification, VLM)
- `src/server/moonraker-compat.ts` — Moonraker API compatibility layer
- `src/server/mcp-server.ts` — Model Context Protocol server

### Client (Frontend)
- `src/main.ts` — Entry point, WsClient connect flow, renders on state change
- `src/ws-client.ts` — WebSocket client connecting to service (replaces old direct MQTT client)
- `src/types.ts` — TypeScript types for the CC2 protocol (status codes, data structures, helpers)
- `src/printer-state.ts` — Browser-side state with deep-merge delta updates and subscriber pattern
- `src/log-store.ts` — Ring buffer (500 entries) for MQTT message logging
- `src/ui/dashboard.ts` — Thin re-export barrel for all UI modules
- `src/ui/helpers.ts` — Shared DOM helpers (`$`, `formatTime`, `fanPct`, `escapeHtml`)
- `src/ui/print-status.ts` — Main dashboard rendering (temps, progress, thumbnail, fans, camera)
- `src/ui/canvas.ts` — Canvas/AMS spool visualization
- `src/ui/files.ts` — File browser with print start action
- `src/ui/controls.ts` — All control event handlers (move, temp, fans, LED, speed)
- `src/ui/log.ts` — MQTT log panel with filter, auto-scroll, click-to-expand
- `src/ui/charts.ts` — Canvas 2D live line charts (temps, fans, speed, AI, layers) with zoom/pan
- `src/ui/gcode-preview.ts` — 3D gcode toolpath visualization (Three.js via gcode-preview library)
- `src/chart-store.ts` — Ring-buffer time-series store for chart data
- `src/persistence.ts` — Save/restore chart and layer data to localStorage
- `src/styles/main.css` — Fluidd-inspired dark theme
- `index.html` — Full page layout (single-page, no routing)

## CC2 Protocol

The printer runs its own MQTT broker. Communication flow:
1. Connect to `ws://<ip>:9001` with credentials `elegoo`/`123456`
2. Discover SN from status topic wildcard `elegoo/+/api_status`
3. Register: publish `{client_id, request_id}` to `elegoo/<sn>/api_register`
4. Subscribe to `elegoo/<sn>/api_status` (delta updates) and `elegoo/<sn>/<client_id>/api_response`
5. Send commands to `elegoo/<sn>/<client_id>/api_request` as `{id, method, params}`
6. Heartbeat PING every 10 seconds

Key methods: 1001 (attributes), 1002 (full status), 1020-1023 (print control), 1026-1031 (motion/temp/fans), 1044 (file list), 1045 (thumbnail), 1046 (file detail), 2005 (canvas status), 6000 (status event).

**WARNING**: Parameter naming is inconsistent in the CC2 API:
- Method 1045 (thumbnail) requires `file_name` (with underscore)
- Method 1046 (file detail) requires `filename` (no underscore)
- Using the wrong form returns error 1003 (INVALID_PARAMETER)
- This was discovered by comparing against the official Elegoo web interface source (`raw/index-unminified.html`)

**WARNING**: Field names in status updates may differ from documentation:
- `gcode_move` (not `gcode_move_inf` as some docs suggest) — verified via MQTT capture
- Extruder position is `gcode_move.extruder` (not `gcode_move.e`) — verified via MQTT capture
- Code normalizes `gcode_move_inf` → `gcode_move` at ingest for compatibility with older firmware
- Always use the debug capture feature (`POST /api/debug/capture`) to verify actual field names

**WARNING**: Sub-status 1066 is undocumented in the official app but observed on firmware 01.03.01.89 during Canvas filament swaps. It appears between nozzle preheat (1045) and return to printing (2075). We label it 'Filament Change' in `types.ts`.

**WARNING**: Canvas/AMS filament swaps cause false positives:
- The filament sensor reads "empty" during swaps (old filament retracts, new one loads)
- Exception code 1211 (Canvas Filament Runout) fires during normal swaps
- Sub-status stays as machine_status=2 (Printing) throughout the swap — only sub_status changes
- Use `isFilamentChangeSubStatus()` from `types.ts` to suppress false runout/stall events during swap sub-statuses (1045, 1061-1066, 1133-1145, 1150-1166, 2505)

Reference: [CC2_PROTOCOL.md](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/docs/CC2_PROTOCOL.md)

## MQTT Bridge Pitfalls

- **Registration code 3**: Printer allows max 2 MQTT clients. If both slots are taken (e.g. Elegoo Slicer + another client), registration is rejected. The bridge retries on a slow 30s interval until a slot opens.
- **mqtt.js `client.end(true)`**: Permanently destroys the client — no auto-reconnect. For forced reconnects, tear down the old client entirely and call `connect()` again to create a fresh one.
- **Health check accuracy**: Use `bridge.isConnected` / `bridge.brokerConnected` for real MQTT state. Never use `store.attributes` presence as a proxy — persisted state survives disconnects.

## Client Performance Pitfalls

**WARNING**: The `gcode-preview` library (WebGLPreview) runs an internal 60fps `animate()` loop via `requestAnimationFrame` that calls `renderer.render(scene, camera)` every frame. With a loaded gcode model, this leaks ~23 MB/s of heap memory that GC can't reclaim fast enough, causing OOM crashes within minutes.
- After calling `processGCode()`, immediately cancel the animate loop: access `(preview as any).animationFrameId`, call `cancelAnimationFrame()`, and override `animate` to a no-op
- Render on-demand only: orbit controls `change` event for user interaction, throttled `render()` (≤2 FPS) for layer/nozzle updates
- The library's `render()` rebuilds geometry (expensive) — for position-only changes (nozzle), use `renderer.render(scene, camera)` directly

**WARNING**: Event listeners in render functions cause memory leaks:
- Never add `addEventListener` inside functions called on every state update (e.g. `renderFiles()`, `renderStructuredLog()`, `renderCanvas()`)
- Use event delegation: one listener on the container, dispatch via `e.target.closest('.selector')`
- Guard with a `let bound = false` flag or bind in a one-time `init` function

**WARNING**: `requestAnimationFrame` loops and Vite HMR don't mix:
- HMR hot-reloads reset module-level `let animating = false` guards, creating duplicate rAF loops
- Use `setInterval` with a stored timer handle instead — `clearInterval(handle)` works reliably across HMR
- For the chart draw loop: `setInterval(drawAllCharts, 100)` (10 FPS) is plenty for 1 Hz sensor data

## Conventions

- Vanilla TypeScript only — no React/Vue/Svelte
- No unnecessary abstractions — keep it simple and direct
- Use pnpm as package manager
- CSS custom properties for theming (all in `--var` format)
- DOM IDs for element references (no virtual DOM)
- State changes trigger `requestAnimationFrame` render batching
- Use conventional commits (`feat:`, `fix:`, `chore:`, etc.)

## Development

```bash
pnpm install
pnpm dev        # Start Vite dev server on :5173
pnpm build      # TypeScript check + Vite production build
```

## Printer Details for Testing

- Printer IP: `172.20.100.236`
- Model: Centauri Carbon 2
- SN: `F01U3UD3798YT8K`
- Firmware: `01.03.01.89`
- MQTT port: 1883 (TCP), 9001 (WebSocket)
- Camera: port 8080 (MJPEG)
- Auth: `elegoo`/`123456` (no access code set)
- Mode: LAN-only (`lan_status: 1`)
