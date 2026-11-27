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

## Authentication

When the service runs with `SERVICE_API_KEY` set, **every tool that changes the machine
needs the key**: all 21 tools under Control, Print Management, Maintenance, File & Filament
and Camera & Advanced below, `send_command` included. The 10 Read-Only tools, all
`printer://*` resources, `initialize` and `tools/list` stay open.

Send the key as a Bearer token on **every** request (`X-Api-Key: <key>` is accepted too):

```
Authorization: Bearer <SERVICE_API_KEY>
```

- **Checked per HTTP request, not per session.** A session opened with the key grants
  nothing to a later request on the same `Mcp-Session-Id` that does not carry it, so set the
  header in the client config rather than only on `initialize`.
- **No key presented** → reads work; a gated tool returns an MCP tool error (HTTP 200, the
  JSON-RPC call succeeds) and nothing is sent to the printer:

  ```json
  { "content": [{ "type": "text", "text": "\"emergency_stop\" needs SERVICE_API_KEY. This action needs the service API key. Send it as \"Authorization: Bearer <key>\" or \"X-Api-Key: <key>\"." }], "isError": true }
  ```

- **A wrong key presented** → **HTTP 401** on any request, reads and `initialize` included.
- **`SERVICE_API_KEY` unset** → every tool is open, as before the key existed.

Client config, e.g. for Claude Code (the key comes from your environment, never a file in a
repo):

```bash
claude mcp add --transport http elegoo http://localhost:8088/mcp \
  --header "Authorization: Bearer ${SERVICE_API_KEY}"
```

or in a JSON MCP config:

```json
{
  "mcpServers": {
    "elegoo": {
      "type": "http",
      "url": "http://localhost:8088/mcp",
      "headers": { "Authorization": "Bearer ${SERVICE_API_KEY}" }
    }
  }
}
```

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

Open — no key needed.

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

**Needs the key** when `SERVICE_API_KEY` is set (see [Authentication](#authentication)) — as does every tool below this point.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `set_temperature` | `nozzle?` (0-300°C), `bed?` (0-120°C) | Set nozzle and/or bed temperature |
| `fan` | `name` (part\|aux\|case), `speed` (0-100%) | Set fan speed |
| `speed_mode` | `mode` (silent\|balanced\|sport\|ludicrous) | Set print speed mode |
| `led` | `on` (boolean) | Toggle LED light on/off |
| `home` | `axes?` (xy\|z\|xyz, default xyz) | Home printer axes |
| `move` | `axis` (x\|y\|z), `distance` (mm) | Jog a single axis (negative = reverse) |

**Refused while a job is active** (status Printing or Power Loss Recovery; see the print guard under [Error Handling](#error-handling)): `home` and `move` always. `set_temperature` is refused when it would turn a heater off (`bed: 0`, `nozzle: 0`) or set the nozzle below 170 °C. Any other target change still goes through mid-print. A call with both targets is all or nothing: if either target is refused, nothing is sent. `fan`, `speed_mode` and `led` stay available.

### Print Management

**Needs the key.**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `start_print` | `filename`, `source?` (local\|u-disk, default local) | Start printing a file |
| `pause_print` | — | Pause current print |
| `resume_print` | — | Resume paused print |
| `stop_print` | — | Stop/cancel current print |
| `emergency_stop` | — | Emergency stop — immediately halts printer |

### Maintenance

**Needs the key.**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `auto_level` | — | Start auto bed leveling |
| `pid_calibrate` | — | Start PID auto-tune |
| `vibration_calibrate` | — | Start resonance/vibration optimization |
| `self_check` | `ringing?` (bool, default true), `pid?` (bool, default true), `leveling?` (bool, default true) | Run combined self-test |

**All four are refused while a job is active.** They home and probe the bed.

### File & Filament

**Needs the key.**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `delete_file` | `path`, `source?` (local\|u-disk, default local) | Delete a file from printer storage |
| `load_filament` | — | Feed/load filament into extruder |
| `unload_filament` | — | Retract/unload filament from extruder |
| `set_auto_refill` | `enabled` (boolean) | Enable/disable Canvas auto-refill |

**`load_filament` and `unload_filament` are refused while a job is active**, because they would start a filament change under a print.

### Camera & Advanced

**Needs the key** — `send_command` always, because it sends any raw method number.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `enable_video_stream` | `method?` (sdcp\|mqtt, default sdcp) | Enable camera MJPEG stream |
| `send_command` | `method` (number), `params?` (JSON string, default "{}") | Send raw MQTT command (advanced) |

**`send_command` follows the same print guard**, by method number, so it is no way around it.

## Error Handling

- A gated tool called without the key returns `isError: true` naming `SERVICE_API_KEY` (see [Authentication](#authentication)); a wrong key is an HTTP 401.
- **The print guard.** While a job is active, a refused tool returns `isError: true` with `"<tool>" refused: Printer is busy printing — …`, and nothing is sent. Pause, resume, stop and emergency stop stay available. Retry once the printer is idle. The guard covers:
  - `home`, `move`;
  - heater-off and a nozzle below 170 °C via `set_temperature`;
  - the four calibrations;
  - `load_filament`, `unload_filament`;
  - the matching raw methods through `send_command`: 1024–1028, 1032–1035, 2001 and 2002.

  The policy is `src/server/print-guard.ts` (ELEG-176). `/ws`, Moonraker and OctoPrint apply the same rule.

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
