/**
 * Moonraker API compatibility layer.
 *
 * Translates a subset of the Moonraker REST API into CC2 printer state
 * and MQTT commands. Enough for Mainsail, Fluidd, KlipperScreen,
 * and other Klipper-based frontends to display status and basic controls.
 *
 * Mounted under /moonraker/* in the server.
 *
 * Reference: https://moonraker.readthedocs.io/en/latest/external_api/
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { ServiceConfig } from './config.js';
import type { FanInfo } from '../types.js';
import { getLogger } from './logger.js';
import { loadavg, freemem } from 'os';

const log = getLogger('Moonraker');

export const MOONRAKER_VERSION = 'v0.9.3-0-elegoo-compat';

const fanPct = (f?: FanInfo) => f ? f.speed / 255 : 0; // 0..1 duty cycle

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ result: data }));
}

function jsonRaw(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(res: ServerResponse, message: string, status = 400): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: status, message } }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params: Record<string, string> = {};
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return params;
}

/** List of Klipper-style printer objects we emulate */
export const AVAILABLE_OBJECTS = [
  'heater_bed', 'extruder', 'heaters', 'fan', 'gcode_move',
  'print_stats', 'virtual_sdcard', 'display_status',
  'toolhead', 'idle_timeout', 'system_stats',
  'temperature_sensor chamber',
];

/** Build the Klipper-style printer objects from CC2 state */
export function queryObjects(
  store: StateStore,
  requested: Record<string, string[] | null>,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const s = store.status;

  for (const [objName, attrs] of Object.entries(requested)) {
    const pick = (full: Record<string, unknown>) => {
      if (!attrs) return full;
      const filtered: Record<string, unknown> = {};
      for (const a of attrs) {
        if (a in full) filtered[a] = full[a];
      }
      return filtered;
    };

    switch (objName) {
      case 'heater_bed':
        result.heater_bed = pick({
          temperature: s?.heater_bed?.temperature ?? 0,
          target: s?.heater_bed?.target ?? 0,
          power: s?.heater_bed?.target ? 1 : 0,
        });
        break;

      case 'extruder':
        result.extruder = pick({
          temperature: s?.extruder?.temperature ?? 0,
          target: s?.extruder?.target ?? 0,
          power: s?.extruder?.target ? 1 : 0,
          pressure_advance: 0,
          smooth_time: 0.04,
          can_extrude: (s?.extruder?.temperature ?? 0) > 170,
        });
        break;

      case 'heaters':
        result.heaters = pick({
          available_heaters: ['heater_bed', 'extruder'],
          available_sensors: ['heater_bed', 'extruder', 'temperature_sensor chamber'],
        });
        break;

      case 'fan':
        result.fan = pick({
          speed: fanPct(s?.fans?.fan),
          rpm: s?.fans?.fan?.rpm ?? null,
        });
        break;

      case 'gcode_move':
        result.gcode_move = pick({
          absolute_coordinates: true,
          absolute_extrude: true,
          extrude_factor: 1,
          gcode_position: [
            s?.gcode_move?.x ?? 0,
            s?.gcode_move?.y ?? 0,
            s?.gcode_move?.z ?? 0,
            s?.gcode_move?.extruder ?? s?.gcode_move?.e ?? 0,
          ],
          homing_origin: [0, 0, 0, 0],
          position: [
            s?.gcode_move?.x ?? 0,
            s?.gcode_move?.y ?? 0,
            s?.gcode_move?.z ?? 0,
            s?.gcode_move?.extruder ?? s?.gcode_move?.e ?? 0,
          ],
          speed: (s?.gcode_move?.speed ?? 0) * 60, // mm/s → mm/min
          speed_factor: 1,
        });
        break;

      case 'print_stats': {
        const ms = s?.machine_status;
        const ps = s?.print_status;
        let state = 'standby';
        if (ms?.status === 2) state = 'printing';
        else if (ms?.status === 3 || ms?.sub_status === 2502 || ms?.sub_status === 2505) state = 'paused';
        else if (ms?.sub_status === 2077) state = 'complete';
        else if ((ms?.exception_status?.length ?? 0) > 0) state = 'error';
        result.print_stats = pick({
          filename: ps?.filename ?? '',
          total_duration: ps?.total_duration ?? 0,
          print_duration: ps?.print_duration ?? 0,
          state,
          message: '',
          info: {
            total_layer: ps?.total_layer ?? store.fileTotalLayers ?? null,
            current_layer: ps?.current_layer ?? null,
          },
        });
        break;
      }

      case 'virtual_sdcard': {
        const ms = s?.machine_status;
        const isPrinting = ms?.status === 2 || ms?.status === 3;
        result.virtual_sdcard = pick({
          file_path: s?.print_status?.filename ?? '',
          progress: isPrinting ? (ms?.progress ?? 0) / 100 : 0,
          is_active: isPrinting,
          file_position: 0,
          file_size: 0,
        });
        break;
      }

      case 'display_status':
        result.display_status = pick({
          progress: (s?.machine_status?.progress ?? 0) / 100,
          message: '',
        });
        break;

      case 'toolhead':
        result.toolhead = pick({
          position: [
            s?.gcode_move?.x ?? 0,
            s?.gcode_move?.y ?? 0,
            s?.gcode_move?.z ?? 0,
            s?.gcode_move?.extruder ?? s?.gcode_move?.e ?? 0,
          ],
          homed_axes: s?.tool_head?.homed_axes ?? '',
          status: 'Ready',
          print_time: s?.print_status?.print_duration ?? 0,
          estimated_print_time: s?.print_status
            ? (s.print_status.print_duration + s.print_status.remaining_time_sec)
            : 0,
          max_velocity: 500,
          max_accel: 5000,
          max_accel_to_decel: 2500,
          square_corner_velocity: 5,
        });
        break;

      case 'idle_timeout': {
        const machineStatus = s?.machine_status?.status ?? 1;
        result.idle_timeout = pick({
          state: machineStatus === 2 ? 'Printing' : machineStatus === 1 ? 'Ready' : 'Idle',
          printing_time: s?.print_status?.print_duration ?? 0,
        });
        break;
      }

      case 'system_stats':
        result.system_stats = pick({
          sysload: loadavg()[0],
          cputime: process.cpuUsage().user / 1e6,
          memavail: Math.round(freemem() / 1024),
        });
        break;

      case 'temperature_sensor chamber':
        result['temperature_sensor chamber'] = pick({
          temperature: s?.ztemperature_sensor?.temperature ?? 0,
          measured_min_temp: s?.ztemperature_sensor?.measured_min_temperature ?? 0,
          measured_max_temp: s?.ztemperature_sensor?.measured_max_temperature ?? 0,
        });
        break;
    }
  }
  return result;
}


export function createMoonrakerRouter(
  store: StateStore,
  bridge: MqttBridge,
  config: ServiceConfig,
): (req: IncomingMessage, res: ServerResponse) => boolean {

  /**
   * Returns true if the request was handled, false otherwise.
   * Caller should only invoke this for URLs starting with /moonraker/.
   */
  return function handleMoonraker(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method || 'GET';
    const fullUrl = req.url || '';
    const [urlPath] = fullUrl.split('?');
    const query = parseQuery(fullUrl);
    // Strip the /moonraker prefix
    const path = urlPath.replace(/^\/moonraker/, '');

    // --- GET /server/info ---
    if (path === '/server/info' && method === 'GET') {
      json(res, {
        klippy_connected: bridge.isConnected,
        klippy_state: bridge.isConnected ? 'ready' : 'error',
        components: [
          'klippy_apis', 'file_manager', 'machine',
          'data_store', 'history', 'octoprint_compat',
        ],
        failed_components: [],
        registered_directories: ['gcodes'],
        warnings: [],
        websocket_count: 0,
        moonraker_version: MOONRAKER_VERSION,
        api_version: [1, 5, 0],
        api_version_string: '1.5.0',
      });
      return true;
    }

    // --- GET /server/config ---
    if (path === '/server/config' && method === 'GET') {
      json(res, {
        config: {
          server: { host: '0.0.0.0', port: config.servicePort },
        },
        orig: {},
        files: [],
      });
      return true;
    }

    // --- GET /printer/info ---
    if (path === '/printer/info' && method === 'GET') {
      json(res, {
        state: bridge.isConnected ? 'ready' : 'error',
        state_message: bridge.isConnected ? 'Printer is ready' : 'Printer not connected',
        hostname: store.attributes?.hostname ?? 'elegoo-cc2',
        software_version: store.attributes?.software_version?.ota_version ?? 'unknown',
        cpu_info: 'Elegoo CC2',
        klipper_path: '/opt/elegoo',
        python_path: '/usr/bin/python3',
        log_file: '/var/log/elegoo.log',
        config_file: '/etc/elegoo/printer.cfg',
        process_id: process.pid,
        user_id: 1000,
        group_id: 1000,
      });
      return true;
    }

    // --- GET /printer/objects/list ---
    if (path === '/printer/objects/list' && method === 'GET') {
      json(res, { objects: AVAILABLE_OBJECTS });
      return true;
    }

    // --- GET/POST /printer/objects/query ---
    if (path === '/printer/objects/query' && (method === 'GET' || method === 'POST')) {
      const handleQuery = (objects: Record<string, string[] | null>) => {
        const status = queryObjects(store, objects);
        json(res, {
          eventtime: Date.now() / 1000,
          status,
        });
      };

      if (method === 'POST') {
        readBody(req).then((body) => {
          const parsed = JSON.parse(body);
          handleQuery(parsed.objects || {});
        }).catch(() => errorResponse(res, 'Invalid JSON'));
      } else {
        // Parse query string objects: ?gcode_move&toolhead=position,status
        const objects: Record<string, string[] | null> = {};
        for (const [key, val] of Object.entries(query)) {
          if (AVAILABLE_OBJECTS.includes(key)) {
            objects[key] = val ? val.split(',') : null;
          }
        }
        handleQuery(objects);
      }
      return true;
    }

    // --- POST /printer/print/start ---
    if (path === '/printer/print/start' && method === 'POST') {
      const filename = query.filename;
      if (!filename) {
        readBody(req).then((body) => {
          const parsed = JSON.parse(body);
          if (parsed.filename) {
            bridge.sendCommand(1020, {
              filename: parsed.filename,
              storage_media: 'udisk',
            });
            json(res, 'ok');
          } else {
            errorResponse(res, 'filename required');
          }
        }).catch(() => errorResponse(res, 'Invalid JSON'));
      } else {
        bridge.sendCommand(1020, { filename, storage_media: 'udisk' });
        json(res, 'ok');
      }
      return true;
    }

    // --- POST /printer/print/pause ---
    if (path === '/printer/print/pause' && method === 'POST') {
      bridge.sendCommand(1021, {});
      json(res, 'ok');
      return true;
    }

    // --- POST /printer/print/resume ---
    if (path === '/printer/print/resume' && method === 'POST') {
      bridge.sendCommand(1023, {});
      json(res, 'ok');
      return true;
    }

    // --- POST /printer/print/cancel ---
    if (path === '/printer/print/cancel' && method === 'POST') {
      bridge.sendCommand(1022, {});
      json(res, 'ok');
      return true;
    }

    // --- POST /printer/emergency_stop ---
    if (path === '/printer/emergency_stop' && method === 'POST') {
      bridge.sendCommand(1022, {}); // CC2 doesn't have true e-stop, use cancel
      json(res, 'ok');
      return true;
    }

    // --- POST /printer/gcode/script ---
    if (path === '/printer/gcode/script' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        const script = (parsed.script || '').trim().toUpperCase();
        // Handle common gcodes
        if (script === 'G28' || script.startsWith('G28 ')) {
          bridge.sendCommand(1026, { axes: ['x', 'y', 'z'] });
        } else if (script.startsWith('M104 ')) {
          const match = script.match(/S(\d+)/);
          if (match) {
            bridge.sendCommand(1028, { target: 'extruder', temperature: parseInt(match[1]) });
          }
        } else if (script.startsWith('M140 ')) {
          const match = script.match(/S(\d+)/);
          if (match) {
            bridge.sendCommand(1028, { target: 'heater_bed', temperature: parseInt(match[1]) });
          }
        } else if (script === 'M112') {
          bridge.sendCommand(1022, {});
        } else if (script === 'TURN_OFF_HEATERS') {
          bridge.sendCommand(1028, { target: 'extruder', temperature: 0 });
          bridge.sendCommand(1028, { target: 'heater_bed', temperature: 0 });
        }
        json(res, 'ok');
      }).catch(() => errorResponse(res, 'Invalid JSON'));
      return true;
    }

    // --- GET /server/files/list ---
    if (path === '/server/files/list' && method === 'GET') {
      const files = store.files
        .filter((f) => f.type !== 'folder')
        .map((f) => ({
          path: f.filename,
          modified: f.create_time ?? Date.now() / 1000,
          size: f.size,
          permissions: 'rw',
        }));
      json(res, files);
      return true;
    }

    // --- GET /server/files/directory ---
    if (path === '/server/files/directory' && method === 'GET') {
      const dirs = store.files
        .filter((f) => f.type === 'folder')
        .map((f) => ({
          dirname: f.filename,
          modified: f.create_time ?? Date.now() / 1000,
          size: 4096,
          permissions: 'rw',
        }));
      const files = store.files
        .filter((f) => f.type !== 'folder')
        .map((f) => ({
          filename: f.filename,
          modified: f.create_time ?? Date.now() / 1000,
          size: f.size,
          permissions: 'rw',
        }));
      json(res, {
        dirs,
        files,
        disk_usage: { total: 0, used: 0, free: 0 },
        root_info: { name: 'gcodes', permissions: 'rw' },
      });
      return true;
    }

    // --- GET /server/files/metadata ---
    if (path === '/server/files/metadata' && method === 'GET') {
      const filename = query.filename;
      if (!filename) {
        errorResponse(res, 'filename required');
        return true;
      }
      const file = store.files.find((f) => f.filename === filename);
      if (!file) {
        errorResponse(res, 'File not found', 404);
        return true;
      }
      json(res, {
        size: file.size,
        modified: file.create_time ?? Date.now() / 1000,
        filename: file.filename,
        estimated_time: file.print_time ?? null,
        layer_height: null,
        first_layer_height: null,
        object_height: null,
        slicer: null,
        slicer_version: null,
        thumbnails: [],
      });
      return true;
    }

    // --- GET /server/temperature_store ---
    if (path === '/server/temperature_store' && method === 'GET') {
      // Build temperature history from chart data
      const chartData = store.getChartHistory();
      const temps = chartData.map((p) => p.values.nozzle ?? 0);
      const bedTemps = chartData.map((p) => p.values.bed ?? 0);
      const chamberTemps = chartData.map((p) => p.values.chamber ?? 0);
      const nozzleTargets = chartData.map((p) => p.values.nozzleTarget ?? 0);
      const bedTargets = chartData.map((p) => p.values.bedTarget ?? 0);

      json(res, {
        extruder: {
          temperatures: temps,
          targets: nozzleTargets,
          powers: nozzleTargets.map((t) => t > 0 ? 1 : 0),
        },
        heater_bed: {
          temperatures: bedTemps,
          targets: bedTargets,
          powers: bedTargets.map((t) => t > 0 ? 1 : 0),
        },
        'temperature_sensor chamber': {
          temperatures: chamberTemps,
        },
      });
      return true;
    }

    // --- GET /server/files/roots ---
    if (path === '/server/files/roots' && method === 'GET') {
      json(res, [
        { name: 'gcodes', path: '/gcodes', permissions: 'rw' },
        { name: 'config', path: '/config', permissions: 'r' },
      ]);
      return true;
    }

    // --- GET /api/version (Moonraker version info) ---
    if (path === '/api/version' && method === 'GET') {
      jsonRaw(res, MOONRAKER_VERSION);
      return true;
    }

    // --- GET /server/webcams/list ---
    if (path === '/server/webcams/list' && method === 'GET') {
      const webcams = config.cameraEnabled ? [{
        name: 'default',
        location: 'printer',
        service: 'mjpegstreamer',
        enabled: true,
        icon: 'mdiWebcam',
        target_fps: 15,
        target_fps_idle: 5,
        stream_url: '/api/stream',
        snapshot_url: '/api/snapshot',
        flip_horizontal: false,
        flip_vertical: false,
        rotation: 0,
        aspect_ratio: '4:3',
        extra_data: {},
        source: 'config',
        uid: 'default-webcam',
      }] : [];
      json(res, { webcams });
      return true;
    }

    // --- POST /server/restart ---
    if (path === '/server/restart' && method === 'POST') {
      // No-op, we don't want to restart
      json(res, 'ok');
      return true;
    }

    // --- GET / (root — endpoint index) ---
    if ((path === '' || path === '/') && method === 'GET') {
      jsonRaw(res, {
        elegoo_cc2_compat: true,
        moonraker_version: MOONRAKER_VERSION,
        endpoints: [
          'GET /moonraker/server/info',
          'GET /moonraker/server/config',
          'GET /moonraker/server/temperature_store',
          'GET /moonraker/server/files/list',
          'GET /moonraker/server/files/directory',
          'GET /moonraker/server/files/metadata?filename=...',
          'GET /moonraker/server/files/roots',
          'GET /moonraker/server/webcams/list',
          'GET /moonraker/printer/info',
          'GET /moonraker/printer/objects/list',
          'GET|POST /moonraker/printer/objects/query',
          'POST /moonraker/printer/print/start?filename=...',
          'POST /moonraker/printer/print/pause',
          'POST /moonraker/printer/print/resume',
          'POST /moonraker/printer/print/cancel',
          'POST /moonraker/printer/emergency_stop',
          'POST /moonraker/printer/gcode/script',
        ],
      });
      return true;
    }

    // Not handled
    return false;
  };
}
