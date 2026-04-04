# TODO — Elegoo Web Frontend

## High Priority

- [ ] **Print start confirmation dialog** — Preview thumbnail + settings (bed mesh detect, filament detect, storage source) before starting
- [ ] **File thumbnail preview** — Show thumbnail on hover/click in file list (method 1045)
- [ ] **Print history panel** — Method 1048 returns print history (task name, status, begin/end time). Not implemented at all
- [ ] **Mono filament status** — `mono_filament_info` is received but never displayed (type, color, temp range)
- [ ] **Disable controls during commands** — Prevent double-sends while a command is in flight (isExecutingCommand pattern)

## Medium Priority

- [ ] **Power loss recovery UI** — Status 15 has no UI handling; show dialog to resume or cancel
- [ ] **AI detection settings** — Show/configure spaghetti detection and foreign object detection (methods 2010/2011)
- [ ] **Export MQTT log** — Download log as JSON for offline debugging
- [ ] **Camera snapshot** — Capture still frame from MJPEG stream

## Lower Priority / Nice-to-Have

- [ ] **OTA firmware update** — Firmware update UI with progress (method 1064, sub_status OTA* codes)
- [ ] **Dark/light theme toggle** — CSS custom properties make this straightforward
- [ ] **Keyboard shortcuts** — Pause (P), Resume (R), Stop (S), Home (H) etc.
- [ ] **Device rename** — Set printer hostname from UI (method 1060)
- [ ] **Storage capacity** — Show free/total disk space (method 1061)
- [ ] **Emergency stop button** — Prominent e-stop with confirmation (method 1036)
- [ ] **Self-check wizard** — Auto-level + vibration optimize + PID detect (method 1035/OneKeyCheck)
- [ ] **File delete** — Delete files from printer storage (method 1047)
- [ ] **History delete** — Remove print history entries (method 1049)
- [ ] **Folder navigation** — File browser currently flat; support directory traversal
- [ ] **Print queue** — Queue multiple files for sequential printing
- [ ] **Mobile layout polish** — Responsive layout exists but needs work on touch targets and ordering
- [ ] **Notification sound** — Audio alert when print completes or error occurs
- [ ] **Connection presets** — Save/recall multiple printer IPs
- [ ] **Multi-printer support** — Connect to multiple printers simultaneously in tabs
- [ ] **WebSocket keep-alive indicator** — Visual heartbeat indicator showing connection health
- [ ] **Rate limiting UI** — Show when printer returns "busy" (error code) and queue retries
- [ ] **Localization** — i18n support (English/Norwegian/Chinese at minimum, matching official app)
- [ ] **Relative time display** — Show "2m ago" / "just now" for log timestamps option

## Completed

- [x] Temperature display with live values and target bars
- [x] Print status with progress, layer count, thumbnail
- [x] Fan control with speed bars and toggles
- [x] LED control
- [x] XYZ move controls with homing
- [x] Speed mode selector (Silent/Balanced/Sport/Ludicrous)
- [x] Canvas/AMS spool visualization
- [x] Camera MJPEG stream
- [x] File browser with print start
- [x] MQTT raw log with filter, auto-scroll, click-to-expand
- [x] Exception/error banner with critical/warning classification
- [x] Temperature chart (live canvas graph)
- [x] Structured MQTT log with tabs, search, type filter, pause, highlighting
- [x] Auto-disable auto-scroll on log entry click
- [x] Show a chart of time per layer
- [x] canvas spools show in wrong order. They are in order CCW: 1, 2, 3 ,4. 1 being top left. 
- [x] Edit spool viser ikke korrekt farge i dialog. 
- [x] **Toast/notification system** — Surface command errors (fan set, temp set, move) to user instead of silent failures
- [x] **Reconnect logic** — Auto-reconnect on connection loss with exponential backoff
- [x] **File detail enrichment** — Show estimated time, filament type, layer count (method 1046) in file browser
- [x] **Fan speed chart** — Live graph for fan speeds (infrastructure already exists in chart-store)
- [x] **USB file browser** — Toggle between local/USB file source (`storage_media: 'u_disk'`), show USB insert status
- [x] **Print progress chart** — Plot progress % and layer count over time during a print
- [x] **Filament info editing** — Set filament type/color/temp for Canvas trays (method 2003) and mono setup (method 2007)
- [x] **Auto-refill toggle** — Enable/disable Canvas auto-refill from UI (method 2004)
- [x] **Canvas filament load/unload** — Buttons to load/unload filament via Canvas/AMS panel (methods 2001/2002)
- [x] **Timelapse viewer** — Download/play timelapse videos from history (method 1051)
- [x] **System info panel** — Display firmware versions, hardware info, network details (method 1062)
- [x] **Bed mesh visualization** — 3D/heatmap view of auto-leveling bed mesh data
- [x] **Gcode preview** — Simple 2D layer preview from file metadata
- [x] **PWA support** — Add manifest + service worker for installable app experience
- [x] **Temperature presets** — Quick-set buttons for common materials (PLA 210/60, PETG 240/80, ABS 250/100)
- [x] **Chart time window selector** — Toggle between 1min / 5min / 15min / 1hr chart windows
- [x] **Chart zoom/pan** — Click and drag to zoom into chart regions
- [x] **Structured log: method name filter** — Dropdown with all known method names for quick filtering
- [x] **Structured log: diff view** — Show delta between consecutive status events
- [x] **Structured log: pin entries** — Pin important log entries to top for reference
