/**
 * OctoPrint API compatibility layer.
 *
 * Translates a subset of OctoPrint REST API calls into CC2 printer state
 * and MQTT commands. Enough for tools like OctoEverywhere, OctoPod,
 * and other OctoPrint-compatible clients to display status and basic controls.
 *
 * Mounted under /octoprint/api/* in the server.
 *
 * Reference: https://docs.octoprint.org/en/master/api/
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { ServiceConfig } from './config.js';
import type { FanInfo } from '../types.js';
import { getLogger } from './logger.js';

const log = getLogger('OctoPrint');

const OCTOPRINT_API_VERSION = '0.1';
const OCTOPRINT_SERVER_VERSION = '1.10.3';

const fanPct = (f?: FanInfo) => f ? Math.round((f.speed / 255) * 100) : 0;

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: 'Not found' }, 404);
}

function noContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** Map CC2 machine status to OctoPrint state flags */
function getOctoPrintState(store: StateStore) {
  const ms = store.status?.machine_status;
  const machineStatus = ms?.status ?? 0;
  const isPrinting = machineStatus === 2;
  const isPaused = machineStatus === 3 || (ms?.sub_status === 2502) || (ms?.sub_status === 2505);
  const isIdle = machineStatus === 1;
  const isError = (ms?.exception_status?.length ?? 0) > 0;

  let text = 'Offline';
  if (store.status) {
    if (isError) text = 'Error';
    else if (isPaused) text = 'Paused';
    else if (isPrinting) text = 'Printing';
    else if (isIdle) text = 'Operational';
    else text = 'Operational';
  }

  return {
    text,
    flags: {
      operational: !!store.status,
      paused: isPaused,
      printing: isPrinting && !isPaused,
      pausing: ms?.sub_status === 2501,
      cancelling: ms?.sub_status === 2503,
      sdReady: true,
      error: isError,
      ready: isIdle && !isError,
      closedOrError: !store.status,
    },
  };
}

/** Build OctoPrint temperature response */
function getTemperatureData(store: StateStore) {
  const s = store.status;
  return {
    tool0: {
      actual: s?.extruder?.temperature ?? 0,
      target: s?.extruder?.target ?? 0,
      offset: 0,
    },
    bed: {
      actual: s?.heater_bed?.temperature ?? 0,
      target: s?.heater_bed?.target ?? 0,
      offset: 0,
    },
    chamber: {
      actual: s?.ztemperature_sensor?.temperature ?? 0,
      target: 0,
      offset: 0,
    },
  };
}

export function createOctoPrintRouter(
  store: StateStore,
  bridge: MqttBridge,
  config: ServiceConfig,
): (req: IncomingMessage, res: ServerResponse) => boolean {

  /**
   * Returns true if the request was handled, false otherwise.
   * Caller should only invoke this for URLs starting with /octoprint/api.
   */
  return function handleOctoPrint(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method || 'GET';
    const fullUrl = req.url || '';
    const [urlPath, _query] = fullUrl.split('?');
    // Strip the /octoprint prefix to get the OctoPrint-style path
    const path = urlPath.replace(/^\/octoprint/, '');

    // --- GET /api/version ---
    if (path === '/api/version' && method === 'GET') {
      json(res, {
        api: OCTOPRINT_API_VERSION,
        server: OCTOPRINT_SERVER_VERSION,
        text: `OctoPrint ${OCTOPRINT_SERVER_VERSION} (Elegoo CC2 Compat)`,
      });
      return true;
    }

    // --- GET /api/server ---
    if (path === '/api/server' && method === 'GET') {
      json(res, {
        server: OCTOPRINT_SERVER_VERSION,
        safemode: false,
      });
      return true;
    }

    // --- GET /api/connection ---
    if (path === '/api/connection' && method === 'GET') {
      const connected = bridge.isConnected;
      json(res, {
        current: {
          state: connected ? getOctoPrintState(store).text : 'Closed',
          port: `mqtt://${config.printerIp}:1883`,
          baudrate: null,
          printerProfile: '_default',
        },
        options: {
          ports: [`mqtt://${config.printerIp}:1883`],
          baudrates: [],
          printerProfiles: [{ id: '_default', name: 'Elegoo CC2' }],
          portPreference: `mqtt://${config.printerIp}:1883`,
          baudratePreference: null,
          printerProfilePreference: '_default',
          autoconnect: true,
        },
      });
      return true;
    }

    // --- GET /api/printer ---
    if (path === '/api/printer' && method === 'GET') {
      if (!store.status) {
        json(res, { error: 'Printer is not operational' }, 409);
        return true;
      }
      json(res, {
        temperature: getTemperatureData(store),
        sd: { ready: true },
        state: getOctoPrintState(store),
      });
      return true;
    }

    // --- GET /api/printer/tool ---
    if (path === '/api/printer/tool' && method === 'GET') {
      json(res, getTemperatureData(store));
      return true;
    }

    // --- POST /api/printer/tool ---
    if (path === '/api/printer/tool' && method === 'POST') {
      readBody(req).then((body) => {
        const cmd = JSON.parse(body);
        if (cmd.command === 'target' && cmd.targets?.tool0 != null) {
          bridge.sendCommand(1028, {
            target: 'extruder',
            temperature: cmd.targets.tool0,
          });
        }
        noContent(res);
      }).catch(() => json(res, { error: 'Bad request' }, 400));
      return true;
    }

    // --- GET /api/printer/bed ---
    if (path === '/api/printer/bed' && method === 'GET') {
      const s = store.status;
      json(res, {
        bed: {
          actual: s?.heater_bed?.temperature ?? 0,
          target: s?.heater_bed?.target ?? 0,
          offset: 0,
        },
      });
      return true;
    }

    // --- POST /api/printer/bed ---
    if (path === '/api/printer/bed' && method === 'POST') {
      readBody(req).then((body) => {
        const cmd = JSON.parse(body);
        if (cmd.command === 'target' && cmd.target != null) {
          bridge.sendCommand(1028, {
            target: 'heater_bed',
            temperature: cmd.target,
          });
        }
        noContent(res);
      }).catch(() => json(res, { error: 'Bad request' }, 400));
      return true;
    }

    // --- GET /api/printer/chamber ---
    if (path === '/api/printer/chamber' && method === 'GET') {
      const s = store.status;
      json(res, {
        chamber: {
          actual: s?.ztemperature_sensor?.temperature ?? 0,
          target: 0,
          offset: 0,
        },
      });
      return true;
    }

    // --- POST /api/printer/printhead ---
    if (path === '/api/printer/printhead' && method === 'POST') {
      readBody(req).then((body) => {
        const cmd = JSON.parse(body);
        if (cmd.command === 'jog') {
          const axes: Record<string, number> = {};
          if (cmd.x != null) axes.x = cmd.x;
          if (cmd.y != null) axes.y = cmd.y;
          if (cmd.z != null) axes.z = cmd.z;
          bridge.sendCommand(1027, {
            direction: 'relative',
            ...axes,
            speed: cmd.speed ?? 3000,
          });
        } else if (cmd.command === 'home') {
          const homeAxes = cmd.axes?.length ? cmd.axes : ['x', 'y', 'z'];
          bridge.sendCommand(1026, { axes: homeAxes });
        }
        noContent(res);
      }).catch(() => json(res, { error: 'Bad request' }, 400));
      return true;
    }

    // --- GET /api/job ---
    if (path === '/api/job' && method === 'GET') {
      const s = store.status;
      const ps = s?.print_status;
      const ms = s?.machine_status;
      const isPrinting = ms?.status === 2 || ms?.status === 3;
      json(res, {
        job: {
          file: {
            name: ps?.filename ?? null,
            display: ps?.filename ?? null,
            path: ps?.filename ?? null,
            origin: 'local',
            size: null,
            date: null,
          },
          estimatedPrintTime: ps ? (ps.print_duration + ps.remaining_time_sec) : null,
          lastPrintTime: null,
          filament: null,
          user: null,
        },
        progress: {
          completion: isPrinting ? (ms?.progress ?? 0) : null,
          filepos: null,
          printTime: isPrinting ? (ps?.print_duration ?? 0) : null,
          printTimeLeft: isPrinting ? (ps?.remaining_time_sec ?? 0) : null,
          printTimeLeftOrigin: 'estimate',
        },
        state: getOctoPrintState(store).text,
        error: null,
      });
      return true;
    }

    // --- POST /api/job (start/cancel/pause/resume) ---
    if (path === '/api/job' && method === 'POST') {
      readBody(req).then((body) => {
        const cmd = JSON.parse(body);
        switch (cmd.command) {
          case 'start':
            // OctoPrint start requires a file already selected — we support filename
            if (cmd.filename) {
              bridge.sendCommand(1020, {
                filename: cmd.filename,
                storage_media: 'udisk',
              });
            }
            break;
          case 'cancel':
            bridge.sendCommand(1022, {});
            break;
          case 'pause':
            if (cmd.action === 'toggle') {
              const isPaused = store.status?.machine_status?.status === 3;
              bridge.sendCommand(isPaused ? 1023 : 1021, {});
            } else if (cmd.action === 'resume') {
              bridge.sendCommand(1023, {});
            } else {
              // Default: pause
              bridge.sendCommand(1021, {});
            }
            break;
          case 'restart':
            bridge.sendCommand(1023, {});
            break;
        }
        noContent(res);
      }).catch(() => json(res, { error: 'Bad request' }, 400));
      return true;
    }

    // --- GET /api/files ---
    if ((path === '/api/files' || path === '/api/files/local') && method === 'GET') {
      const files = store.files.map((f) => ({
        name: f.filename,
        display: f.filename,
        path: f.filename,
        origin: 'local',
        type: f.type === 'folder' ? 'folder' : 'machinecode',
        typePath: f.type === 'folder' ? ['folder'] : ['machinecode', 'gcode'],
        size: f.size,
        date: f.create_time ? Math.floor(f.create_time) : null,
        gcodeAnalysis: f.print_time ? {
          estimatedPrintTime: f.print_time,
        } : undefined,
      }));
      json(res, { files, free: null, total: null });
      return true;
    }

    // --- GET /api/settings (minimal stub) ---
    if (path === '/api/settings' && method === 'GET') {
      json(res, {
        api: { enabled: true, key: 'elegoo-cc2-compat' },
        feature: {
          sdSupport: true,
          temperatureGraph: true,
          autoUppercaseBlacklist: [],
        },
        printer: {
          defaultExtrusionLength: 5,
        },
        webcam: {
          webcamEnabled: config.cameraEnabled,
          streamUrl: config.cameraEnabled ? '/octoprint/webcam/?action=stream' : null,
          snapshotUrl: config.cameraEnabled ? '/api/snapshot' : null,
          flipH: false,
          flipV: false,
          rotate90: false,
        },
        temperature: {
          profiles: [
            { name: 'PLA', bed: 60, extruder: 210, chamber: null },
            { name: 'PETG', bed: 80, extruder: 240, chamber: null },
            { name: 'ABS', bed: 100, extruder: 250, chamber: null },
          ],
        },
      });
      return true;
    }

    // --- GET /api/printerprofiles ---
    if (path === '/api/printerprofiles' && method === 'GET') {
      const model = store.attributes?.machine_model ?? 'Elegoo CC2';
      json(res, {
        profiles: {
          _default: {
            id: '_default',
            name: model,
            model,
            default: true,
            current: true,
            volume: {
              width: 300,
              depth: 300,
              height: 400,
              formFactor: 'rectangular',
              origin: 'lowerleft',
            },
            heatedBed: true,
            heatedChamber: false,
            axes: {
              x: { speed: 6000, inverted: false },
              y: { speed: 6000, inverted: false },
              z: { speed: 200, inverted: false },
              e: { speed: 300, inverted: false },
            },
            extruder: { count: 1, nozzleDiameter: 0.4, sharedNozzle: false },
          },
        },
      });
      return true;
    }

    // --- GET /api/login (stub, always "logged in") ---
    if (path === '/api/login' && method === 'POST') {
      json(res, {
        _is_external_client: false,
        _login_mechanism: 'apikey',
        active: true,
        admin: true,
        apikey: 'elegoo-cc2-compat',
        groups: ['admins', 'users'],
        name: 'elegoo',
        needs: { group: ['admins'], role: [] },
        permissions: [],
        roles: ['admin', 'user'],
        user: true,
      });
      return true;
    }

    // --- GET /api/currentuser ---
    if (path === '/api/currentuser' && method === 'GET') {
      json(res, {
        name: 'elegoo',
        admin: true,
        groups: ['admins', 'users'],
        permissions: [],
        roles: ['admin', 'user'],
      });
      return true;
    }

    // --- GET / (root — endpoint index) ---
    if ((path === '' || path === '/' || path === '/api') && method === 'GET') {
      json(res, {
        elegoo_cc2_compat: true,
        api: OCTOPRINT_API_VERSION,
        server: OCTOPRINT_SERVER_VERSION,
        endpoints: [
          'GET /octoprint/api/version',
          'GET /octoprint/api/server',
          'GET /octoprint/api/connection',
          'GET /octoprint/api/printer',
          'GET /octoprint/api/job',
          'POST /octoprint/api/job',
          'GET /octoprint/api/printer/tool',
          'POST /octoprint/api/printer/tool',
          'GET /octoprint/api/printer/bed',
          'POST /octoprint/api/printer/bed',
          'GET /octoprint/api/printer/chamber',
          'POST /octoprint/api/printer/printhead',
          'GET /octoprint/api/files',
          'GET /octoprint/api/settings',
          'GET /octoprint/api/printerprofiles',
          'GET /octoprint/api/currentuser',
        ],
      });
      return true;
    }

    // Not handled
    return false;
  };
}
