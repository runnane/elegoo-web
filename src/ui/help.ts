import { $ } from './helpers';

let helpRendered = false;

export function renderHelp(): void {
  const container = $('help-content');
  if (!container || helpRendered) return;
  helpRendered = true;

  container.innerHTML = `
<div class="help-section">
  <h3>Overview</h3>
  <p>This is a browser-based web frontend for Elegoo Centauri Carbon 2 (CC2) FDM printers.
  It connects to the printer via MQTT over WebSocket. A companion Node.js server provides
  REST APIs, compatibility layers for Fluidd/Mainsail (Moonraker), OctoPrint, MCP, and Prometheus metrics.</p>

  <table class="help-ports">
    <thead><tr><th>Service</th><th>Port</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>Web UI + REST API</td><td>8088</td><td>Main web interface, REST API, MCP, OctoPrint compat, Moonraker compat</td></tr>
      <tr><td>Moonraker standalone</td><td>7125</td><td>Standalone Moonraker-compatible server (Fluidd/Mainsail)</td></tr>
      <tr><td>Printer MQTT</td><td>9001</td><td>Printer MQTT broker (WebSocket)</td></tr>
      <tr><td>Printer Camera</td><td>8080</td><td>MJPEG stream from printer</td></tr>
    </tbody>
  </table>
</div>

<div class="help-section">
  <h3>Native REST API <code>/api/*</code></h3>
  <p>Primary API on port 8088.</p>
  <table class="help-api">
    <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>GET</td><td>/api/health</td><td>Service health check (MQTT status)</td></tr>
      <tr><td>GET</td><td>/api/status</td><td>Full printer state (attributes, status, canvas, files)</td></tr>
      <tr><td>GET</td><td>/api/snapshot</td><td>JPEG camera snapshot</td></tr>
      <tr><td>GET</td><td>/api/stream</td><td>MJPEG camera stream proxy</td></tr>
      <tr><td>GET</td><td>/api/stream/overlay</td><td>MJPEG stream with status overlay</td></tr>
      <tr><td>GET</td><td>/webcam</td><td>Snapshot (mjpegstreamer-compatible)</td></tr>
      <tr><td>GET</td><td>/webcam/?action=stream</td><td>Stream (mjpegstreamer-compatible)</td></tr>
      <tr><td>GET</td><td>/api/metrics</td><td>Structured metrics as JSON</td></tr>
      <tr><td>GET</td><td>/api/metrics/prometheus</td><td>Prometheus text exposition format</td></tr>
      <tr><td>GET</td><td>/api/files/download</td><td>Download file from printer (?file=&amp;source=local|u-disk)</td></tr>
      <tr><td>POST</td><td>/api/files/upload</td><td>Upload file to printer (multipart, ?source=local|u-disk)</td></tr>
      <tr><td>GET</td><td>/api/config/telegram</td><td>Telegram bot config</td></tr>
      <tr><td>POST</td><td>/api/config/telegram</td><td>Update Telegram progress interval</td></tr>
      <tr><td>GET</td><td>/api/config/ai-labels</td><td>AI label configurations</td></tr>
      <tr><td>POST</td><td>/api/config/ai-labels</td><td>Update AI label configs</td></tr>
      <tr><td>DELETE</td><td>/api/config/ai-labels</td><td>Reset AI labels to defaults</td></tr>
      <tr><td>POST</td><td>/api/debug/capture</td><td>Start MQTT capture ({duration: 10-60})</td></tr>
      <tr><td>GET</td><td>/api/debug/captures</td><td>List MQTT capture files</td></tr>
      <tr><td>GET</td><td>/api/debug/captures/:file</td><td>Download capture file</td></tr>
      <tr><td>DELETE</td><td>/api/layer-data</td><td>Clear layer duration history</td></tr>
    </tbody>
  </table>
</div>

<div class="help-section">
  <h3>Prometheus Metrics <code>/api/metrics/prometheus</code></h3>
  <p>Scrape-compatible endpoint for Prometheus/Grafana monitoring.</p>
  <table class="help-api">
    <thead><tr><th>Metric</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>elegoo_nozzle_temp_celsius</td><td>gauge</td><td>Current nozzle temperature</td></tr>
      <tr><td>elegoo_nozzle_target_celsius</td><td>gauge</td><td>Nozzle target temperature</td></tr>
      <tr><td>elegoo_bed_temp_celsius</td><td>gauge</td><td>Current bed temperature</td></tr>
      <tr><td>elegoo_bed_target_celsius</td><td>gauge</td><td>Bed target temperature</td></tr>
      <tr><td>elegoo_chamber_temp_celsius</td><td>gauge</td><td>Chamber temperature</td></tr>
      <tr><td>elegoo_part_fan_percent</td><td>gauge</td><td>Part cooling fan speed %</td></tr>
      <tr><td>elegoo_aux_fan_percent</td><td>gauge</td><td>Auxiliary fan speed %</td></tr>
      <tr><td>elegoo_case_fan_percent</td><td>gauge</td><td>Case fan speed %</td></tr>
      <tr><td>elegoo_print_progress_percent</td><td>gauge</td><td>Print progress 0-100</td></tr>
      <tr><td>elegoo_print_layer_current</td><td>gauge</td><td>Current layer number</td></tr>
      <tr><td>elegoo_print_layer_total</td><td>gauge</td><td>Total layer count</td></tr>
      <tr><td>elegoo_print_duration_seconds</td><td>gauge</td><td>Elapsed print time</td></tr>
      <tr><td>elegoo_position_x_mm</td><td>gauge</td><td>X axis position</td></tr>
      <tr><td>elegoo_position_y_mm</td><td>gauge</td><td>Y axis position</td></tr>
      <tr><td>elegoo_position_z_mm</td><td>gauge</td><td>Z axis position</td></tr>
      <tr><td>elegoo_filament_used_mm</td><td>gauge</td><td>Filament used in mm</td></tr>
      <tr><td>elegoo_printer_status</td><td>gauge</td><td>Printer status code</td></tr>
      <tr><td>elegoo_printer_info</td><td>gauge</td><td>Printer info labels (model, firmware, SN)</td></tr>
    </tbody>
  </table>
</div>

<div class="help-section">
  <h3>MCP Server <code>/mcp</code></h3>
  <p>Model Context Protocol endpoint (HTTP + SSE transport) for AI assistant integration.</p>

  <h4>Resources</h4>
  <table class="help-api">
    <thead><tr><th>URI</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>printer://status</td><td>Human-readable printer status summary</td></tr>
      <tr><td>printer://files</td><td>File list as JSON</td></tr>
      <tr><td>printer://metrics</td><td>Structured metrics snapshot</td></tr>
    </tbody>
  </table>

  <h4>Tools</h4>
  <table class="help-api">
    <thead><tr><th>Tool</th><th>Parameters</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>get_printer_status</td><td>—</td><td>Status summary text</td></tr>
      <tr><td>get_temperatures</td><td>—</td><td>Nozzle, bed, chamber temps</td></tr>
      <tr><td>get_print_progress</td><td>—</td><td>Active print progress</td></tr>
      <tr><td>get_file_list</td><td>storage</td><td>List gcode files</td></tr>
      <tr><td>set_temperature</td><td>nozzle?, bed?</td><td>Set temps (nozzle 0-300, bed 0-120)</td></tr>
      <tr><td>pause_print</td><td>—</td><td>Pause current job</td></tr>
      <tr><td>resume_print</td><td>—</td><td>Resume paused job</td></tr>
      <tr><td>stop_print</td><td>—</td><td>Cancel print job</td></tr>
      <tr><td>set_fan_speed</td><td>fan, speed</td><td>Fan: part/aux/case, speed: 0-100%</td></tr>
      <tr><td>set_speed_mode</td><td>mode</td><td>silent/balanced/sport/ludicrous</td></tr>
      <tr><td>home_axes</td><td>axes</td><td>Home xy/z/xyz</td></tr>
      <tr><td>toggle_led</td><td>on</td><td>Toggle LED on/off</td></tr>
      <tr><td>send_command</td><td>method, params</td><td>Raw MQTT command</td></tr>
    </tbody>
  </table>
</div>

<div class="help-section">
  <h3>OctoPrint Compatibility <code>/octoprint/api/*</code></h3>
  <p>Drop-in OctoPrint API for clients expecting OctoPrint (e.g. Home Assistant, OctoApp).</p>
  <table class="help-api">
    <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>GET</td><td>/octoprint/api/version</td><td>API & server version info</td></tr>
      <tr><td>GET</td><td>/octoprint/api/server</td><td>Server identification</td></tr>
      <tr><td>GET</td><td>/octoprint/api/connection</td><td>Connection status</td></tr>
      <tr><td>GET</td><td>/octoprint/api/printer</td><td>Printer state & temperatures</td></tr>
      <tr><td>GET</td><td>/octoprint/api/printer/tool</td><td>Extruder temperature</td></tr>
      <tr><td>POST</td><td>/octoprint/api/printer/tool</td><td>Set extruder temp</td></tr>
      <tr><td>GET</td><td>/octoprint/api/printer/bed</td><td>Bed temperature</td></tr>
      <tr><td>POST</td><td>/octoprint/api/printer/bed</td><td>Set bed temp</td></tr>
      <tr><td>GET</td><td>/octoprint/api/printer/chamber</td><td>Chamber temperature</td></tr>
      <tr><td>POST</td><td>/octoprint/api/printer/printhead</td><td>Jog axes or home</td></tr>
      <tr><td>GET</td><td>/octoprint/api/job</td><td>Current job info</td></tr>
      <tr><td>POST</td><td>/octoprint/api/job</td><td>Job control (start/cancel/pause/resume)</td></tr>
      <tr><td>GET</td><td>/octoprint/api/files</td><td>List all files</td></tr>
      <tr><td>GET</td><td>/octoprint/api/settings</td><td>Settings (webcam, profiles)</td></tr>
      <tr><td>GET</td><td>/octoprint/api/printerprofiles</td><td>Printer profiles</td></tr>
      <tr><td>POST</td><td>/octoprint/api/login</td><td>Login (stub, always succeeds)</td></tr>
    </tbody>
  </table>
</div>

<div class="help-section">
  <h3>Moonraker Compatibility</h3>
  <p>Full Moonraker-compatible API for Fluidd and Mainsail frontends.</p>

  <h4>Prefixed REST API <code>/moonraker/*</code> (port 8088)</h4>
  <table class="help-api">
    <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>GET</td><td>/moonraker/server/info</td><td>Server & component status</td></tr>
      <tr><td>GET</td><td>/moonraker/server/config</td><td>Server config</td></tr>
      <tr><td>GET</td><td>/moonraker/server/temperature_store</td><td>Temperature history</td></tr>
      <tr><td>GET</td><td>/moonraker/server/files/list</td><td>List gcode files</td></tr>
      <tr><td>GET</td><td>/moonraker/server/files/directory</td><td>Directory listing</td></tr>
      <tr><td>GET</td><td>/moonraker/server/files/metadata</td><td>File metadata (?filename=)</td></tr>
      <tr><td>GET</td><td>/moonraker/server/files/roots</td><td>Storage roots</td></tr>
      <tr><td>GET</td><td>/moonraker/server/webcams/list</td><td>Webcam list</td></tr>
      <tr><td>GET</td><td>/moonraker/printer/info</td><td>Printer model, SN, firmware</td></tr>
      <tr><td>GET</td><td>/moonraker/printer/objects/list</td><td>Available Klipper objects</td></tr>
      <tr><td>GET|POST</td><td>/moonraker/printer/objects/query</td><td>Query printer state objects</td></tr>
      <tr><td>POST</td><td>/moonraker/printer/print/start</td><td>Start print (?filename=)</td></tr>
      <tr><td>POST</td><td>/moonraker/printer/print/pause</td><td>Pause</td></tr>
      <tr><td>POST</td><td>/moonraker/printer/print/resume</td><td>Resume</td></tr>
      <tr><td>POST</td><td>/moonraker/printer/print/cancel</td><td>Cancel</td></tr>
      <tr><td>POST</td><td>/moonraker/printer/gcode/script</td><td>Execute G-code</td></tr>
      <tr><td>GET</td><td>/moonraker/api/version</td><td>Moonraker version</td></tr>
    </tbody>
  </table>

  <h4>Standalone Moonraker Server (port 7125)</h4>
  <p>Full Moonraker implementation for direct Fluidd/Mainsail connection.</p>

  <h4>WebSocket <code>ws://host:7125/websocket</code></h4>
  <p>JSON-RPC 2.0 protocol with the following key methods:</p>
  <table class="help-api">
    <thead><tr><th>Method</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>server.connection.identify</td><td>Identify client</td></tr>
      <tr><td>server.info</td><td>Server status & components</td></tr>
      <tr><td>printer.info</td><td>Printer state & firmware</td></tr>
      <tr><td>printer.objects.list</td><td>Available objects</td></tr>
      <tr><td>printer.objects.query</td><td>Query state objects</td></tr>
      <tr><td>printer.objects.subscribe</td><td>Subscribe to delta updates</td></tr>
      <tr><td>printer.print.start</td><td>Start print</td></tr>
      <tr><td>printer.print.pause / resume / cancel</td><td>Print control</td></tr>
      <tr><td>printer.gcode.script</td><td>Execute G-code</td></tr>
      <tr><td>server.files.list</td><td>List files</td></tr>
      <tr><td>server.files.metadata</td><td>File metadata</td></tr>
      <tr><td>server.temperature_store</td><td>Temperature history</td></tr>
      <tr><td>server.webcams.list</td><td>Webcam config</td></tr>
      <tr><td>server.history.list / totals</td><td>Job history</td></tr>
      <tr><td>machine.system_info</td><td>System information</td></tr>
      <tr><td>machine.proc_stats</td><td>CPU/memory stats</td></tr>
      <tr><td>server.database.get_item / post_item</td><td>Key-value database</td></tr>
      <tr><td>server.job_queue.status</td><td>Job queue</td></tr>
    </tbody>
  </table>

  <h4>Push Notifications (WebSocket)</h4>
  <table class="help-api">
    <thead><tr><th>Notification</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>notify_status_update</td><td>Delta updates for subscribed objects</td></tr>
      <tr><td>notify_proc_stat_update</td><td>System utilization stats</td></tr>
      <tr><td>notify_gcode_response</td><td>GCode response text</td></tr>
      <tr><td>notify_webcams_changed</td><td>Webcam list update</td></tr>
      <tr><td>notify_filelist_changed</td><td>File list changes</td></tr>
    </tbody>
  </table>

  <h4>REST Endpoints (port 7125)</h4>
  <p>Same endpoints as the prefixed version, but at the root path (e.g. <code>/server/info</code>, <code>/printer/info</code>,
  <code>/machine/system_info</code>). Full Moonraker REST API compatibility for Fluidd/Mainsail.</p>
</div>

<div class="help-section">
  <h3>CC2 MQTT Command Reference</h3>
  <p>Commands sent to the printer via MQTT (<code>elegoo/&lt;sn&gt;/&lt;client_id&gt;/api_request</code>).</p>
  <table class="help-api">
    <thead><tr><th>Method</th><th>Name</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>1001</td><td>Get Attributes</td><td>Printer hostname, model, SN, firmware versions</td></tr>
      <tr><td>1002</td><td>Get Status</td><td>Full status snapshot (temps, fans, position, print state)</td></tr>
      <tr><td>1020</td><td>Print Control</td><td>Start print (filename, storage_media)</td></tr>
      <tr><td>1021</td><td>Pause Print</td><td>Pause current job</td></tr>
      <tr><td>1022</td><td>Resume Print</td><td>Resume paused job</td></tr>
      <tr><td>1023</td><td>Stop Print</td><td>Cancel/stop current job</td></tr>
      <tr><td>1026</td><td>Set Temperature</td><td>Set nozzle/bed/chamber target temps</td></tr>
      <tr><td>1027</td><td>Move Axis</td><td>Jog axes (X/Y/Z, distance, speed)</td></tr>
      <tr><td>1028</td><td>Home Axes</td><td>Home specified axes</td></tr>
      <tr><td>1029</td><td>Set Fan Speed</td><td>Set part/aux/case fan speed</td></tr>
      <tr><td>1030</td><td>Set LED</td><td>Toggle LED on/off</td></tr>
      <tr><td>1031</td><td>Set Speed Mode</td><td>Speed profile (silent/balanced/sport/ludicrous)</td></tr>
      <tr><td>1044</td><td>List Files</td><td>Get file list from storage</td></tr>
      <tr><td>1045</td><td>Get Thumbnail</td><td>Base64 PNG thumbnail (uses <code>file_name</code>)</td></tr>
      <tr><td>1046</td><td>Get File Detail</td><td>File metadata (uses <code>filename</code>)</td></tr>
      <tr><td>2005</td><td>Canvas Status</td><td>AMS/spool slot status</td></tr>
      <tr><td>6000</td><td>Status Event</td><td>Async status update push from printer</td></tr>
    </tbody>
  </table>

  <h4>MQTT Topics</h4>
  <table class="help-api">
    <thead><tr><th>Topic</th><th>Direction</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>elegoo/+/api_status</td><td>← Printer</td><td>Status discovery (wildcard for SN)</td></tr>
      <tr><td>elegoo/&lt;sn&gt;/api_status</td><td>← Printer</td><td>Delta status updates</td></tr>
      <tr><td>elegoo/&lt;sn&gt;/api_register</td><td>→ Printer</td><td>Client registration</td></tr>
      <tr><td>elegoo/&lt;sn&gt;/&lt;cid&gt;/api_request</td><td>→ Printer</td><td>Commands to printer</td></tr>
      <tr><td>elegoo/&lt;sn&gt;/&lt;cid&gt;/api_response</td><td>← Printer</td><td>Command responses</td></tr>
    </tbody>
  </table>
</div>

<div class="help-section">
  <h3>Supported G-code Commands</h3>
  <p>G-code commands accepted via <code>printer.gcode.script</code> (Moonraker) or <code>/printer/gcode/script</code>.</p>
  <table class="help-api">
    <thead><tr><th>Command</th><th>Action</th></tr></thead>
    <tbody>
      <tr><td>M104 S&lt;temp&gt;</td><td>Set nozzle temperature</td></tr>
      <tr><td>M140 S&lt;temp&gt;</td><td>Set bed temperature</td></tr>
      <tr><td>G28 [X] [Y] [Z]</td><td>Home axes</td></tr>
      <tr><td>M112</td><td>Emergency stop</td></tr>
      <tr><td>SET_HEATER_TEMPERATURE HEATER=&lt;name&gt; TARGET=&lt;temp&gt;</td><td>Set heater by name</td></tr>
      <tr><td>TURN_OFF_HEATERS</td><td>Set all heaters to 0</td></tr>
    </tbody>
  </table>
</div>

<div class="help-section">
  <h3>Integration Examples</h3>

  <h4>Prometheus / Grafana</h4>
  <pre><code># prometheus.yml
scrape_configs:
  - job_name: 'elegoo-cc2'
    scrape_interval: 15s
    static_configs:
      - targets: ['&lt;host&gt;:8088']
    metrics_path: '/api/metrics/prometheus'</code></pre>

  <h4>Fluidd / Mainsail</h4>
  <p>Point Fluidd or Mainsail at <code>http://&lt;host&gt;:7125</code> — the standalone Moonraker server provides full compatibility.</p>

  <h4>Home Assistant (OctoPrint integration)</h4>
  <p>Add an OctoPrint integration pointing to <code>http://&lt;host&gt;:8088/octoprint/</code> with any API key.</p>

  <h4>MCP (AI Assistant)</h4>
  <pre><code>// Claude Desktop / VS Code config
{
  "mcpServers": {
    "elegoo-cc2": {
      "url": "http://&lt;host&gt;:8088/mcp"
    }
  }
}</code></pre>

  <h4>curl Examples</h4>
  <pre><code># Get printer status
curl http://&lt;host&gt;:8088/api/status

# Get camera snapshot
curl -o snapshot.jpg http://&lt;host&gt;:8088/api/snapshot

# Set nozzle temperature
curl -X POST http://&lt;host&gt;:8088/moonraker/printer/gcode/script \\
  -H 'Content-Type: application/json' \\
  -d '{"script": "M104 S200"}'

# Start a print
curl -X POST 'http://&lt;host&gt;:8088/moonraker/printer/print/start?filename=test.gcode'

# Prometheus metrics
curl http://&lt;host&gt;:8088/api/metrics/prometheus</code></pre>
</div>
`;
}
