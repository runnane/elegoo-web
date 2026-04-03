# elegoo-web

A Fluidd-inspired web frontend for Elegoo Centauri Carbon 2 (CC2) FDM printers. Connects directly to the printer's MQTT broker over WebSocket — no server or proxy required.

## Features

- **Real-time dashboard**: Print progress with thumbnail, temperatures (2 decimal places), fan speeds, toolhead position
- **Canvas/AMS display**: Spool-style filament slots with colors, types, and active tray indicator
- **Camera feed**: Live MJPEG stream from the printer camera
- **Printer control**: Temperature, fans (Model/Assistance/Case toggles + fine adjust), speed mode, LED toggle, XY/Z movement with 0.1/1/10/30mm distances
- **Print management**: File browser, start/pause/resume/stop prints
- **MQTT Log**: Real-time log panel showing all sent/received MQTT messages with filtering and click-to-expand
- **Dark theme**: Fluidd/Elegoo-inspired UI with responsive layout

## How It Works

The CC2 printer runs its own MQTT broker on two ports:
- **Port 1883** — MQTT over TCP (used by ElegooSlicer)
- **Port 9001** — MQTT over WebSocket (used by this web frontend)

This app connects directly from the browser to `ws://<printer_ip>:9001` using [mqtt.js](https://github.com/mqttjs/MQTT.js), with no backend needed.

### Protocol

Communication uses the CC2 MQTT protocol:
1. **Discovery**: UDP broadcast on port 52700 (not available from browser — IP entered manually)
2. **Connect**: MQTT 3.1.1 over WebSocket, auth `elegoo`/`123456` (or access code)
3. **Register**: Publish to `elegoo/<sn>/api_register`
4. **Subscribe**: `elegoo/<sn>/api_status` for delta status updates
5. **Commands**: Publish to `elegoo/<sn>/<client_id>/api_request`
6. **Heartbeat**: PING every 10 seconds to maintain connection

See [CC2 Protocol Documentation](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/docs/CC2_PROTOCOL.md) for the full protocol reference.

## Prerequisites

- Node.js 20+
- pnpm
- An Elegoo CC2 printer on the same network, set to **LAN-only mode**

## Quick Start

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`, enter your printer's IP address, and click Connect.

## Build

```bash
pnpm build
```

Output is in `dist/` — serve it with any static file server.

## Project Structure

```
src/
├── main.ts           # Entry point, connect flow, render loop
├── types.ts          # CC2 protocol types and status codes
├── mqtt-client.ts    # MQTT WebSocket client with registration/heartbeat
├── printer-state.ts  # State management with delta merge
├── log-store.ts      # Ring buffer for MQTT message logging
├── ui/
│   ├── dashboard.ts  # Re-exports all UI modules
│   ├── helpers.ts    # Shared DOM/formatting utilities
│   ├── print-status.ts # Main dashboard + header rendering
│   ├── canvas.ts     # Canvas/AMS spool visualization
│   ├── files.ts      # File browser with print action
│   ├── controls.ts   # All control event handlers
│   └── log.ts        # MQTT log panel rendering
└── styles/
    └── main.css      # Fluidd-inspired dark theme
```

## Supported Printers

- Elegoo Centauri Carbon 2
- Other CC2-protocol printers (Elegoo Cura, etc.)

Resin printers (Mars, Saturn) use a different protocol (SDCP over WebSocket) and are not currently supported.

## Limitations

- **Max 4 connections**: The printer limits concurrent MQTT clients. This app uses one slot.
- **No UDP discovery**: Browsers can't send UDP — printer IP must be entered manually.
- **Camera CORS**: The MJPEG stream on port 8080 may be blocked by browser CORS policy depending on your setup. Works when served from the same network.
- **No file upload**: File upload uses HTTP PUT on port 80, not yet implemented.
- **LAN-only**: Cloud mode is not supported.

## Protocol Quirks

- Method 1045 (thumbnail) requires `file_name` (with underscore), but 1046 (file detail) requires `filename` (no underscore). Using the wrong form returns error 1003.
- `total_layer` is often missing from delta status updates — fetched separately via method 1046.
- Fan speed is PWM 0-255, not percentage. Convert: `pct = Math.round(speed / 255 * 100)`.

## Credits

- [elegoo-link](https://github.com/ELEGOO-3D/elegoo-link) — Elegoo's official C++ SDK
- [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) — CC2 protocol documentation
- [Fluidd](https://github.com/fluidd-core/fluidd) — UI design inspiration
- [mqtt.js](https://github.com/mqttjs/MQTT.js) — MQTT client for the browser

## License

MIT
