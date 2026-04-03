# Copilot Instructions for elegoo-web

## Project Overview

A browser-based web frontend for Elegoo Centauri Carbon 2 (CC2) FDM printers. Connects directly to the printer's MQTT broker over WebSocket (port 9001) using mqtt.js. No backend server required.

## Architecture

- **Build**: Vite + TypeScript (vanilla, no framework)
- **Protocol**: MQTT 3.1.1 over WebSocket via mqtt.js
- **State**: Custom reactive state with delta merge (`printer-state.ts`)
- **Rendering**: Direct DOM manipulation with `requestAnimationFrame` batching
- **Styling**: Plain CSS with CSS custom properties (dark theme)

## Key Files

- `src/main.ts` — Entry point, connect flow, renders on state change
- `src/types.ts` — TypeScript types for the CC2 protocol (status codes, data structures)
- `src/mqtt-client.ts` — MQTT WebSocket client with registration, heartbeat, and command sending
- `src/printer-state.ts` — Centralized state with deep-merge delta updates and subscriber pattern
- `src/ui/dashboard.ts` — All UI rendering functions and control event handlers
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

Key methods: 1001 (attributes), 1002 (full status), 1020-1023 (print control), 1026-1031 (motion/temp/fans), 1044 (file list), 2005 (canvas status), 6000 (status event).

Reference: [CC2_PROTOCOL.md](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/docs/CC2_PROTOCOL.md)

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
