# MCP Server — Elegoo CC2

Model Context Protocol server for AI agent integration with Elegoo Centauri Carbon 2 printers.

**Endpoint**: `POST /mcp` (StreamableHTTP transport with session management)

## Connection

The MCP server uses [StreamableHTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport:

1. Send a JSON-RPC `initialize` request to `POST /mcp`
2. The response includes `Mcp-Session-Id` header — include it in all subsequent requests
3. Use `GET /mcp` with the session header for SSE streaming
4. Use `DELETE /mcp` with the session header to close the session

Each session gets its own MCP server instance with access to the shared printer state and MQTT bridge.

## Resources

Read-only data exposed as MCP resources for context retrieval.

| URI | Description |
|-----|-------------|
| `printer://status` | Human-readable status summary (temps, fans, progress, errors, zones) |
| `printer://files` | JSON array of files on printer storage (name, size, type) |
| `printer://metrics` | Structured JSON metrics snapshot (temps, print progress, filament, layers, zone) |
| `printer://events` | Last 50 event log entries (print starts, errors, layer changes) |
| `printer://system` | System info — firmware version, model, serial number, IP (from method 1001) |
| `printer://zones` | Toolhead zone detection state and history (current, previous, enteredAt, history) |

## Tools

### Read-Only

| Tool | Parameters | Description |
|------|-----------|-------------|
| `status` | — | Printer status summary (text) |
| `temperatures` | — | Nozzle, bed, and chamber temperatures |
| `print_progress` | — | Active print details (filename, progress, layer, elapsed, remaining, speed) |
| `files` | — | List gcode files with sizes |
| `events` | `count?` (number, default 20) | Recent event log entries |
| `system_info` | — | Firmware, hardware, and network info, from method 1001 (`GET_ATTRIBUTES`) |
| `zones` | — | Toolhead zone state (current zone, history) |
| `layers` | `last?` (number, default all) | Layer time history |
| `filament_usage` | — | Per-spool filament usage tracking |
| `canvas_info` | — | Canvas/AMS spool status (colors, types, loaded state) |

### Control

| Tool | Parameters | Description |
|------|-----------|-------------|
| `set_temperature` | `nozzle?` (0-300°C), `bed?` (0-120°C) | Set nozzle and/or bed temperature |
| `fan` | `name` (part\|aux\|case), `speed` (0-100%) | Set fan speed |
| `speed_mode` | `mode` (silent\|balanced\|sport\|ludicrous) | Set print speed mode |
| `led` | `on` (boolean) | Toggle LED light on/off |
| `home` | `axes?` (xy\|z\|xyz, default xyz) | Home printer axes |
| `move` | `axis` (x\|y\|z), `distance` (mm) | Jog a single axis (negative = reverse) |

### Print Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `start_print` | `filename`, `source?` (local\|u-disk, default local) | Start printing a file |
| `pause_print` | — | Pause current print |
| `resume_print` | — | Resume paused print |
| `stop_print` | — | Stop/cancel current print |
| `emergency_stop` | — | Emergency stop — immediately halts printer |

### Maintenance

| Tool | Parameters | Description |
|------|-----------|-------------|
| `auto_level` | — | Start auto bed leveling |
| `pid_calibrate` | — | Start PID auto-tune |
| `vibration_calibrate` | — | Start resonance/vibration optimization |
| `self_check` | `ringing?` (bool, default true), `pid?` (bool, default true), `leveling?` (bool, default true) | Run combined self-test |

### File & Filament

| Tool | Parameters | Description |
|------|-----------|-------------|
| `delete_file` | `path`, `source?` (local\|u-disk, default local) | Delete a file from printer storage |
| `load_filament` | — | Feed/load filament into extruder |
| `unload_filament` | — | Retract/unload filament from extruder |
| `set_auto_refill` | `enabled` (boolean) | Enable/disable Canvas auto-refill |

### Camera & Advanced

| Tool | Parameters | Description |
|------|-----------|-------------|
| `enable_video_stream` | `method?` (sdcp\|mqtt, default sdcp) | Enable camera MJPEG stream |
| `send_command` | `method` (number), `params?` (JSON string, default "{}") | Send raw MQTT command (advanced) |

## Error Handling

- Tools that require a printer connection return `isError: true` with "Printer not connected" if the MQTT bridge is disconnected.
- Parameter validation is enforced via Zod schemas — invalid values return descriptive errors.
- `send_command` parses the `params` string as JSON and returns an error if invalid.

## Examples

### Get printer status
```json
{ "method": "tools/call", "params": { "name": "status" } }
```

### Set nozzle to 210°C
```json
{ "method": "tools/call", "params": { "name": "set_temperature", "arguments": { "nozzle": 210 } } }
```

### Start a print
```json
{ "method": "tools/call", "params": { "name": "start_print", "arguments": { "filename": "model.gcode" } } }
```

### Get last 10 events
```json
{ "method": "tools/call", "params": { "name": "events", "arguments": { "count": 10 } } }
```

### Send raw MQTT command
```json
{ "method": "tools/call", "params": { "name": "send_command", "arguments": { "method": 1001 } } }
```
