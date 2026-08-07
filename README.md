# elegoo-web

A web frontend + backend service for Elegoo Centauri Carbon 2 (CC2) FDM printers. The Node.js service maintains a single MQTT connection to the printer and exposes state to browsers via WebSocket, REST API, and Prometheus metrics.

## Features

- **Two-panel dashboard**: Resizable sidebar + main grid, collapsible/reorderable cards, responsive breakpoints
- **Print status**: Progress with thumbnail, temperatures, fan speeds, toolhead position, active filament
- **3D gcode preview**: Three.js toolpath visualization with layer follow mode and nozzle tracking
- **Live charts**: Temperature, fan speed, print speed, AI confidence, and layer time graphs with zoom/pan
- **Canvas/AMS display**: Spool-style filament slots with colors, types, filament editing, load/unload
- **Camera feed**: Live MJPEG stream with single-upstream fan-out proxy, snapshot button, fullscreen overlay
- **Printer control**: Temperature presets, fans, speed mode, LED toggle, XY/Z movement, emergency stop
- **Print management**: File browser with thumbnails/popovers, start dialog, pause/resume/stop, USB support
- **Zone detection**: Server-side toolhead zone tracking (print area, cutter, purge) for AI/event suppression
- **AI print monitoring**: Motion-based stall detection, SigLIP zero-shot classification, VLM analysis, zone-aware suppression, customizable labels
- **Telegram notifications**: Print events, progress updates, camera snapshots, AI alerts
- **MQTT Log**: Real-time structured log with diff view, method filtering, pinning
- **Debug panel**: Live state tree with change tracking, watched paths, export
- **Event log**: Print events, errors, milestones with timestamps and severity
- **Print history**: Method 1036 history with auto-load on connect
- **Print reports**: PDF generation with stats, charts, snapshots
- **Timelapse viewer**: Download/play timelapse videos
- **Spool calculator**: Remaining weight/meters from measured thickness
- **Moonraker/OctoPrint compatibility**: API layers for Mainsail/Fluidd/KlipperScreen and OctoPrint clients
- **MCP server**: Model Context Protocol for AI agent integration — [6 resources, 31 tools](MCP.md)
- **Prometheus metrics**: `/api/metrics/prometheus` endpoint for monitoring
- **PWA support**: Installable app with manifest + service worker
- **Dark theme**: Modern UI with CSS custom properties, responsive at 1200/800/480px breakpoints

## How It Works

The Node.js backend service (`src/server/`) connects to the printer's MQTT broker over TCP:1883 and acts as a bridge:
- **WebSocket** (`/ws`): Real-time state updates pushed to all connected browsers
- **REST API** (`/api/*`): Snapshots, file operations, camera proxy, commands
- **Static files**: Serves the built `dist/` frontend in production (SPA fallback to `index.html`)
- **Prometheus** (`/api/metrics`): Printer telemetry for monitoring

The CC2 printer runs its own MQTT broker on two ports:
- **Port 1883** — MQTT over TCP (used by the service)
- **Port 9001** — MQTT over WebSocket (legacy direct-connect mode)

### Protocol

Communication uses the CC2 MQTT protocol:
1. **Discovery**: UDP broadcast on port 52700 (not available from browser — IP entered manually)
2. **Connect**: MQTT 3.1.1 over WebSocket, auth `elegoo`/`123456` (or access code)
3. **Register**: Publish to `elegoo/<sn>/api_register`
4. **Subscribe**: `elegoo/<sn>/api_status` for delta status updates
5. **Commands**: Publish to `elegoo/<sn>/<client_id>/api_request`
6. **Heartbeat**: PING every 10 seconds to maintain connection

See [CC2 Protocol Documentation](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/docs/CC2_PROTOCOL.md) for the full protocol reference.

## Docker

### Quick Start (docker run)

```bash
docker run -d \
  --name elegoo-web \
  --restart unless-stopped \
  -p 8088:8088 \
  -p 7125:7125 \
  -e PRINTER_IP=172.20.100.236 \
  -v elegoo-data:/app/data \
  ghcr.io/runnane/elegoo-web:latest
```

Web UI: `http://localhost:8088` · Moonraker API: `http://localhost:7125`

To mount specific data directories as host paths instead of a named volume:

```bash
mkdir -p ./elegoo-data/{reports,gcode-cache,logs}
docker run -d \
  --name elegoo-web \
  --restart unless-stopped \
  -p 8088:8088 \
  -p 7125:7125 \
  -e PRINTER_IP=172.20.100.236 \
  -v ./elegoo-data/reports:/app/data/reports \
  -v ./elegoo-data/gcode-cache:/app/data/gcode-cache \
  -v ./elegoo-data/logs:/app/data/logs \
  -v ./elegoo-data/state.json:/app/data/state.json \
  -v ./elegoo-data/moonraker-db.json:/app/data/moonraker-db.json \
  ghcr.io/runnane/elegoo-web:latest
```

### Docker Compose

Copy the example file and edit your printer IP:

```bash
cp docker-compose.example.yml docker-compose.yml
# Edit PRINTER_IP in docker-compose.yml
docker compose up -d
```

See [`docker-compose.example.yml`](docker-compose.example.yml) for all available environment variables (Telegram, AI monitoring, camera, etc.).

### Build Locally

```bash
docker build -t ghcr.io/runnane/elegoo-web:local .
docker run -d -p 8088:8088 -p 7125:7125 -e PRINTER_IP=172.20.100.236 ghcr.io/runnane/elegoo-web:local
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRINTER_IP` | `172.20.100.236` | Printer IP address (required) |
| `PRINTER_PASSWORD` | `123456` | Printer access code |
| `SERVICE_PORT` | `8088` | Web UI / API / WebSocket port |
| `MOONRAKER_PORT` | `7125` | Moonraker compatibility API port |
| `CAMERA_ENABLED` | `true` | Enable camera MJPEG proxy |
| `CAMERA_URL` | `http://<PRINTER_IP>:8080` | Override camera URL |
| `CORS_ALLOWED_ORIGINS` | — (same-origin) | Comma-separated origins allowed to make cross-origin requests to `/api/*`, `/mcp`, `/moonraker/*`, `/octoprint/*` and `:7125`. Unset means **no cross-origin access**. `*` restores the old allow-everything behaviour |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (enables notifications) |
| `TELEGRAM_CHAT_ID` | — | Telegram chat ID — where notifications are **sent** |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `TELEGRAM_CHAT_ID` | Comma-separated numeric sender ids permitted to **issue** bot commands. Anyone else is ignored silently |
| `PROGRESS_INTERVAL` | `25` | Notify every N% progress |
| `DATA_DIR` | `./data` | Data directory for state, reports, logs |
| `AI_ENABLED` | `false` | Enable AI print monitoring |
| `AI_VLM_ENABLED` | `true` | Enable VLM analysis (when AI enabled) |
| `AI_VLM_PROVIDER` | `ollama` | VLM provider: `ollama` or `openai` |
| `AI_VLM_API_KEY` | — | API key for OpenAI VLM provider |
| `AI_VLM_BASE_URL` | `http://172.20.100.9:3000` | VLM API endpoint |
| `AI_VLM_MODEL` | `llava` | VLM model name |
| `AI_LOCAL_ENABLED` | `true` | Enable local SigLIP zero-shot classification |
| `AI_LOCAL_MODEL` | `Xenova/siglip-base-patch16-224` | Local classification model |
| `AI_INTERVAL` | `60` | Seconds between AI analysis |
| `AI_ALERT_THRESHOLD` | `3` | Consecutive alerts before notification |
| `AI_ALERT_COOLDOWN` | `300` | Seconds between alert notifications |

### Volumes

All persistent data lives under `/app/data` inside the container:

| Path | Contents |
|------|----------|
| `/app/data/state.json` | Persisted printer state (survives restarts) |
| `/app/data/moonraker-db.json` | Moonraker compatibility database |
| `/app/data/reports/` | Print reports with snapshots and PDFs |
| `/app/data/gcode-cache/` | Downloaded gcode files for 3D preview |
| `/app/data/logs/` | MQTT capture logs (from debug panel) |

### Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 8088 | HTTP/WS | Web UI, REST API, WebSocket, camera proxy, MCP |
| 7125 | HTTP/WS | Moonraker compatibility API (for Mainsail/Fluidd/KlipperScreen) |

## Prerequisites

- Node.js 20+
- pnpm
- An Elegoo CC2 printer on the same network, set to **LAN-only mode**

## Quick Start

```bash
pnpm install
pnpm dev
```

This starts both the backend service and Vite dev server. Open `http://localhost:5173`.

## Build

```bash
pnpm build
```

Production output goes to `dist/`. The service serves it automatically on port 8088.

## Production Deployment

Install as a systemd service:

```bash
pnpm build
sudo bash contrib/install.sh
```

This creates:
- Service user `elegooweb`
- Installation at `/opt/elegooweb/`
- systemd unit `elegooweb.service` (auto-start on boot)
- Default `.env` config at `/opt/elegooweb/.env`

Edit `/opt/elegooweb/.env` to configure printer IP, Telegram, AI monitoring, etc.

```bash
sudo systemctl status elegooweb       # Check status
sudo journalctl -u elegooweb -f       # Tail logs
sudo systemctl restart elegooweb      # Restart after config changes
sudo bash contrib/uninstall.sh        # Uninstall
```

Web UI: `http://<host>:8088`

## Project Structure

```
src/
├── main.ts              # Entry point, WsClient, render loop, sidebar resize
├── ws-client.ts         # WebSocket client (connects to service, not printer)
├── types.ts             # CC2 protocol types, status codes, zone detection
├── printer-state.ts     # Browser-side state with delta merge + zones
├── log-store.ts         # Ring buffer (500 entries) for MQTT log
├── chart-store.ts       # Ring-buffer time-series store for charts
├── persistence.ts       # Save/restore chart + layer data to localStorage
├── server/
│   ├── index.ts             # Service entry point
│   ├── mqtt-bridge.ts       # Singleton MQTT connection to printer
│   ├── state-store.ts       # Centralized state, event detection, zone tracking
│   ├── ws-transport.ts      # WebSocket server for browsers
│   ├── rest-api.ts          # REST API, MJPEG fan-out proxy, Prometheus
│   ├── config.ts            # Environment-based configuration (.env)
│   ├── logger.ts            # Winston structured logging with rotation
│   ├── telegram.ts          # Telegram bot notifications
│   ├── ai-monitor.ts        # AI print monitoring (SigLIP + VLM + motion)
│   ├── moonraker-compat.ts  # Moonraker API compatibility
│   ├── moonraker-server.ts  # Moonraker standalone server (:7125)
│   ├── octoprint-compat.ts  # OctoPrint API compatibility
│   ├── mcp-server.ts        # Model Context Protocol server
│   ├── state-persistence.ts # Persist/restore state across restarts
│   ├── print-report-collector.ts  # Collect print data for reports
│   └── print-report-pdf.ts       # PDF report generation
├── telegram/
│   ├── bot.ts               # Telegram bot initialization
│   ├── camera.ts            # Camera snapshot handling
│   ├── commands.ts          # Bot command handlers
│   ├── config.ts            # Telegram configuration
│   ├── mqtt-bridge.ts       # Bridge for MQTT event handling
│   └── notifications.ts     # Notification formatting + sending
├── ui/
│   ├── dashboard.ts       # Re-export barrel for all UI modules
│   ├── helpers.ts         # Shared DOM/formatting utilities
│   ├── print-status.ts    # Print status sidebar card
│   ├── service-status.ts  # Header badge + dropdown (service health + system info)
│   ├── canvas.ts          # Canvas/AMS spool visualization
│   ├── files.ts           # File browser with popovers
│   ├── controls.ts        # Control event handlers
│   ├── charts.ts          # Canvas 2D live charts with zoom/pan
│   ├── gcode-preview.ts   # 3D gcode toolpath (Three.js)
│   ├── log.ts             # MQTT log panel
│   ├── log-methods.ts     # MQTT method ID labels and filtering
│   ├── structured-log.ts  # Structured log with diff/pin/filter
│   ├── system-info.ts     # System information display component
│   ├── debug-panel.ts     # Live state tree, change tracking, export
│   ├── settings.ts        # Card layout + tab management
│   ├── event-log.ts       # Print event log
│   ├── ai-panel.ts        # AI monitor panel
│   ├── print-history.ts   # Print history
│   ├── print-reports.ts   # PDF print reports
│   ├── print-dialog.ts    # Print start confirmation dialog
│   ├── maintenance.ts     # Self-check, auto-level, vibration, PID
│   ├── timelapse.ts       # Timelapse viewer
│   ├── layer-chart.ts     # Layer time chart
│   ├── filament-editor.ts # Canvas filament editor
│   ├── spool-calc.ts      # Spool calculator
│   ├── toast.ts           # Toast notifications
│   ├── help.ts            # Help tab / API docs
│   └── ui-settings.ts    # UI preference persistence
└── styles/
    └── main.css           # Dark theme, two-panel layout, responsive
```

## Supported Printers

- Elegoo Centauri Carbon 2
- Other CC2-protocol printers (Elegoo Cura, etc.)

Resin printers (Mars, Saturn) use a different protocol (SDCP over WebSocket) and are not currently supported.

## Limitations

- **Max 2 MQTT connections**: The printer limits concurrent MQTT clients. The service uses one slot.
- **No UDP discovery**: Browsers can't send UDP — printer IP must be configured in `.env`.
- **Camera CORS**: The MJPEG stream on port 8080 is proxied through the service to avoid CORS issues.
- **LAN-only**: Cloud mode is not supported.

## Protocol Quirks

- Method 1045 (thumbnail) requires `file_name` (with underscore), but 1046 (file detail) requires `filename` (no underscore). Using the wrong form returns error 1003.
- `total_layer` is often missing from delta status updates — fetched separately via method 1046.
- Fan speed is PWM 0-255, not percentage. Convert: `pct = Math.round(speed / 255 * 100)`.
- `gcode_move` (not `gcode_move_inf`) — code normalizes the old name at ingest for firmware compat.
- Sub-status 1066 is undocumented but observed during Canvas filament swaps (firmware 01.03.01.89).
- Canvas filament swaps: sub_status mostly stays at 2075 (Printing) with brief flickers to 1045/1066; `zones.current` is the reliable indicator (toolhead moves to cutter/purge areas).
- Sensor-based filament runout (`filament_detected` 1→0) during `machineStatus === 2` always means filament change, never actual runout. Real runouts trigger exception codes 109/1211.

## Zone Detection

Server-side toolhead zone tracking based on `gcode_move.x/y` coordinates:

| Zone | Center | Boundary | Purpose |
|------|--------|----------|---------|
| `cutter_area` | X=254, Y≈3.5 | X:245-265, Y:-5-15 | Filament cutter |
| `purge_area` | X=52.5, Y=264 | X:40-65, Y:257-275 | Purge/poop area |
| `print_area` | — | X:0-256, Y:0-256 | Normal printing |
| `outside` | — | everything else | Fallback |

Used to suppress false AI stall alerts and filament runout events during Canvas filament changes.

## AI Print Monitoring

Enable with `AI_ENABLED=true`. Three detection backends run in parallel:

**SigLIP zero-shot classification** (`AI_LOCAL_ENABLED`): Runs the `Xenova/siglip-base-patch16-224` model locally via `@huggingface/transformers`. Classifies camera frames against configurable text labels (spaghetti, bed adhesion, stringing, layer shift, warping, blob, empty bed, etc.). SigLIP uses per-label sigmoid scores (each 0–1 independently), normalized to a relative distribution for threshold comparison. Labels are customizable via Settings UI or `GET/POST/DELETE /api/config/ai-labels`.

**Motion-based stall detection**: Computes frame-to-frame pixel diff (160×120 grayscale via sharp). If motion drops below 0.5% for 3 consecutive frames while printing, injects a `print_stalled` issue.

**VLM analysis** (`AI_VLM_ENABLED`): Sends camera snapshots to an external vision-language model (Ollama or OpenAI-compatible API). Can detect issues SigLIP cannot: `under_extrusion`, `nozzle_clog`, `print_stalled`.

**Zone-aware filtering**: Analysis only runs when `sub_status === 2075` (Printing) AND `zones.current === 'print_area'`. Skipped during heating, filament changes, and when the toolhead is in the cutter/purge area.

**Alert logic**: Each cycle, critical issues add +2 and warnings add +1 to a consecutive counter (OK decays by -1). When the counter reaches `AI_ALERT_THRESHOLD` (default 3), an alert fires and is sent to Telegram (if configured) with a camera snapshot. Alerts are rate-limited by `AI_ALERT_COOLDOWN` (default 300s).

**Charts**: AI data is shown as 5 score groups: Print in Progress, Spaghetti/Failure, Empty Bed, Paused/Stopped, Other — plus a motion percentage line.

## Credits

- [gcode-preview](https://github.com/remcoder/gcode-preview) — Three.js gcode toolpath visualization
- [elegoo-link](https://github.com/ELEGOO-3D/elegoo-link) — Elegoo's official C++ SDK
- [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) — CC2 protocol documentation
- [Fluidd](https://github.com/fluidd-core/fluidd) — UI design inspiration
- [mqtt.js](https://github.com/mqttjs/MQTT.js) — MQTT client library

## License

MIT
