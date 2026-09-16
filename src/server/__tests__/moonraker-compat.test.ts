import { EventEmitter } from 'events';
import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { StateStore } from '../state-store.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { ServiceConfig } from '../config.js';
import {
  queryObjects,
  createMoonrakerRouter,
  AVAILABLE_OBJECTS,
  MOONRAKER_VERSION,
} from '../moonraker-compat.js';
import type { PrinterStatus } from '../../types.js';

/**
 * Pins the Moonraker translation (ELEG-97/ELEG-28): CC2 state in, fixed Klipper-style
 * JSON out. Every fixture below is generated, not captured printer state — this is a
 * public repo (AGENTS.md).
 *
 * The `/server/config` `host` field is deliberately not asserted: the open ELEG-93 PR
 * (#107) changes it from the hardcoded '0.0.0.0' to the configured bind address, and
 * asserting it here would conflict with that PR.
 */

let store: StateStore | null = null;

function makeStore(): StateStore {
  // The constructor only calls bridge.on(); nothing here touches MQTT or a port.
  const bridge = new EventEmitter() as unknown as MqttBridge;
  store = new StateStore(bridge, 25);
  return store;
}

afterEach(() => {
  store?.destroy();
  store = null;
});

function baseStatus(overrides: Partial<PrinterStatus> = {}): PrinterStatus {
  return {
    machine_status: { status: 1, sub_status: 0, exception_status: [], progress: 0 },
    print_status: {
      filename: 'fixture.gcode',
      uuid: 'fixture-uuid-0001',
      current_layer: 10,
      total_layer: 200,
      print_duration: 600,
      total_duration: 1200,
      remaining_time_sec: 600,
    },
    extruder: {
      temperature: 205.5,
      target: 210,
      filament_detect_enable: 1,
      filament_detected: 1,
    },
    heater_bed: { temperature: 59.8, target: 60 },
    ztemperature_sensor: {
      temperature: 28,
      measured_max_temperature: 30,
      measured_min_temperature: 20,
    },
    fans: {
      fan: { speed: 128, rpm: 4200 },
      aux_fan: { speed: 0 },
      box_fan: { speed: 0 },
      heater_fan: { speed: 255 },
      controller_fan: { speed: 255 },
    },
    gcode_move: { x: 100, y: 150, z: 12.4, e: 42, speed: 100, speed_mode: 0 },
    led: { status: 1 },
    tool_head: { homed_axes: 'xyz' },
    external_device: { camera: true, u_disk: false, type: 'none' },
    ...overrides,
  };
}

function stubBridge(connected = true): MqttBridge {
  return { isConnected: connected, sendCommand: () => {} } as unknown as MqttBridge;
}

function stubConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    printerIp: '203.0.113.5',
    servicePort: 8088,
    cameraEnabled: false,
    ...overrides,
  } as unknown as ServiceConfig;
}

function fakeReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let statusCode = 0;
  let body: unknown;
  const res = {
    writeHead(code: number) {
      statusCode = code;
      return res;
    },
    end(chunk?: string) {
      body = chunk ? JSON.parse(chunk) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => body };
}

describe('queryObjects — Klipper-style printer object shapes', () => {
  it('extruder: temperature/target pass through, power gated on target, can_extrude above 170°C', () => {
    const s = makeStore();
    s.status = baseStatus();
    expect(queryObjects(s, { extruder: null }).extruder).toEqual({
      temperature: 205.5,
      target: 210,
      power: 1,
      pressure_advance: 0,
      smooth_time: 0.04,
      can_extrude: true,
    });
  });

  it('extruder: power is 0 and can_extrude is false when cold and untargeted', () => {
    const s = makeStore();
    s.status = baseStatus({
      extruder: { temperature: 25, target: 0, filament_detect_enable: 0, filament_detected: 0 },
    });
    const r = queryObjects(s, { extruder: null }).extruder;
    expect(r.power).toBe(0);
    expect(r.can_extrude).toBe(false);
  });

  it('heater_bed: temperature/target pass through, power gated on target being set', () => {
    const s = makeStore();
    s.status = baseStatus();
    expect(queryObjects(s, { heater_bed: null }).heater_bed).toEqual({
      temperature: 59.8,
      target: 60,
      power: 1,
    });
  });

  it('fan: converts the 0..255 CC2 duty cycle to Klipper 0..1', () => {
    const s = makeStore();
    s.status = baseStatus();
    expect(queryObjects(s, { fan: null }).fan).toEqual({ speed: 128 / 255, rpm: 4200 });
  });

  it('fan: speed is 0 when the fans object is entirely absent (a partial delta before the first full status)', () => {
    const s = makeStore();
    const status = baseStatus();
    // Realistic partial-delta shape: fans key genuinely missing, not just zeroed.
    delete (status as { fans?: unknown }).fans;
    s.status = status;
    expect(queryObjects(s, { fan: null }).fan).toEqual({ speed: 0, rpm: null });
  });

  it('virtual_sdcard: progress is 0..1 and reflects the printing state while printing', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [], progress: 47 },
    });
    expect(queryObjects(s, { virtual_sdcard: null }).virtual_sdcard).toEqual({
      file_path: 'fixture.gcode',
      progress: 0.47,
      is_active: true,
      file_position: 0,
      file_size: 0,
    });
  });

  it('virtual_sdcard: progress is 0 and inactive when not printing, even if progress is stale', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 0, exception_status: [], progress: 47 },
    });
    const r = queryObjects(s, { virtual_sdcard: null }).virtual_sdcard;
    expect(r.progress).toBe(0);
    expect(r.is_active).toBe(false);
  });

  it('virtual_sdcard: is_active while paused (status 3), not only while actively printing (status 2)', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 3, sub_status: 0, exception_status: [], progress: 47 },
    });
    expect(queryObjects(s, { virtual_sdcard: null }).virtual_sdcard.is_active).toBe(true);
  });

  it('display_status: progress mirrors machine_status.progress / 100 regardless of print state', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [], progress: 83 },
    });
    expect(queryObjects(s, { display_status: null }).display_status).toEqual({
      progress: 0.83,
      message: '',
    });
  });

  // OTA firmware-update progress (ELEG-104), read-only. `display_status.message` is
  // Klipper's M117 channel, so Mainsail/Fluidd show it as a banner with no schema change.
  // Both Moonraker surfaces (`/moonraker/*` and `:7125`) go through this one
  // `queryObjects`, so asserting here covers both — see moonraker-server.ts's import.
  it('display_status.message: names the phase and says "do not power off" while sub_status is an in-progress OTA code', () => {
    const s = makeStore();
    for (const [code, phase] of [
      [2601, 'Info Updating'],
      [2701, 'Downloading'],
      [2702, 'Extracting'],
      [2703, 'Updating'],
    ] as const) {
      s.status = baseStatus({
        machine_status: { status: 1, sub_status: code, exception_status: [], progress: 0 },
      });
      const message = queryObjects(s, { display_status: null }).display_status.message as string;
      expect(message, `code ${code}`).toContain('Firmware update in progress');
      expect(message, `code ${code}`).toContain('do not power off the printer');
      expect(message, `code ${code}`).toContain(phase);
    }
  });

  it('display_status.message: the terminal OTA codes get their own text, and it is not "do not power off"', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2704, exception_status: [], progress: 0 },
    });
    const done = queryObjects(s, { display_status: null }).display_status.message as string;
    expect(done).toContain('Firmware update complete');
    expect(done).not.toContain('do not power off');

    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2705, exception_status: [], progress: 0 },
    });
    expect(queryObjects(s, { display_status: null }).display_status.message).toBe(
      'Firmware update failed',
    );
  });

  it('display_status.message: empty for a non-OTA sub_status, so the banner clears when the update is over', () => {
    const s = makeStore();
    for (const code of [0, 2502, 2603, 1061]) {
      s.status = baseStatus({
        machine_status: { status: 1, sub_status: code, exception_status: [], progress: 0 },
      });
      expect(queryObjects(s, { display_status: null }).display_status.message, `code ${code}`).toBe(
        '',
      );
    }
  });

  it('print_stats.state is untouched by an OTA sub_status — front-ends key their whole UI off it', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2703, exception_status: [], progress: 0 },
    });
    const ps = queryObjects(s, { print_stats: null }).print_stats;
    expect(ps.state).toBe('standby');
    expect(ps.message).toBe('');
  });

  it('toolhead: position mirrors gcode_move xyz + extruder/e fallback, plus the fixed kinematic limits', () => {
    const s = makeStore();
    s.status = baseStatus();
    expect(queryObjects(s, { toolhead: null }).toolhead).toEqual({
      position: [100, 150, 12.4, 42],
      homed_axes: 'xyz',
      status: 'Ready',
      print_time: 600,
      estimated_print_time: 1200,
      max_velocity: 500,
      max_accel: 5000,
      max_accel_to_decel: 2500,
      square_corner_velocity: 5,
    });
  });

  it('toolhead: falls back to gcode_move.e when .extruder is absent', () => {
    const s = makeStore();
    s.status = baseStatus({ gcode_move: { x: 1, y: 2, z: 3, e: 9, speed: 10, speed_mode: 0 } });
    expect(queryObjects(s, { toolhead: null }).toolhead.position).toEqual([1, 2, 3, 9]);
  });

  it.each([
    [2, 'Printing'],
    [1, 'Ready'],
    [5, 'Idle'],
    [0, 'Idle'],
  ])('idle_timeout.state for machine_status %i is %s', (status, expected) => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status, sub_status: 0, exception_status: [], progress: 0 },
    });
    expect(queryObjects(s, { idle_timeout: null }).idle_timeout.state).toBe(expected);
  });

  it('filters to the requested attrs when a list is given, rather than the full object', () => {
    const s = makeStore();
    s.status = baseStatus();
    expect(queryObjects(s, { extruder: ['temperature'] }).extruder).toEqual({
      temperature: 205.5,
    });
  });

  it('an object not in the request is absent from the result entirely', () => {
    const s = makeStore();
    s.status = baseStatus();
    const result = queryObjects(s, { extruder: null });
    expect('heater_bed' in result).toBe(false);
  });
});

describe('queryObjects — print_stats.state: CC2 machine_status/sub_status → the fixed Moonraker vocabulary', () => {
  it('idle (status 1, no sub_status, no exceptions) → standby', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 0, exception_status: [], progress: 0 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('standby');
  });

  it('status 2 → printing', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [], progress: 10 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('printing');
  });

  it('status 3 → paused', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 3, sub_status: 0, exception_status: [], progress: 10 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('paused');
  });

  it('sub_status 2502 → paused, independent of machine_status', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2502, exception_status: [], progress: 10 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('paused');
  });

  it('sub_status 2505 → paused', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2505, exception_status: [], progress: 10 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('paused');
  });

  it('sub_status 2077 → complete', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2077, exception_status: [], progress: 100 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('complete');
  });

  it('a non-empty exception_status → error', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 0, exception_status: [1100], progress: 0 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('error');
  });

  it('a genuinely unrecognised machine_status code falls through to standby, not undefined', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 999, sub_status: 0, exception_status: [], progress: 0 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('standby');
  });

  it('branch order: printing (status 2) wins even when sub_status also looks complete', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 2077, exception_status: [], progress: 99 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('printing');
  });

  it('branch order: complete (sub_status 2077) wins over error when both conditions hold', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2077, exception_status: [1100], progress: 0 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats.state).toBe('complete');
  });

  it('print_stats: filename, durations and layer info come straight from print_status', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [], progress: 10 },
    });
    expect(queryObjects(s, { print_stats: null }).print_stats).toEqual({
      filename: 'fixture.gcode',
      total_duration: 1200,
      print_duration: 600,
      state: 'printing',
      message: '',
      info: { total_layer: 200, current_layer: 10 },
    });
  });

  it('print_stats.info.total_layer falls back to store.fileTotalLayers when the delta omits it', () => {
    const s = makeStore();
    s.status = baseStatus({
      print_status: {
        filename: 'fixture.gcode',
        uuid: 'fixture-uuid-0001',
        current_layer: 10,
        total_layer: undefined,
        print_duration: 600,
        total_duration: 1200,
        remaining_time_sec: 600,
      },
    });
    s.fileTotalLayers = 321;
    const info = queryObjects(s, { print_stats: null }).print_stats.info as { total_layer: number };
    expect(info.total_layer).toBe(321);
  });
});

describe('createMoonrakerRouter — REST endpoints', () => {
  it('/server/info: reports klippy connectivity, the pinned moonraker_version and api_version_string', () => {
    const s = makeStore();
    const router = createMoonrakerRouter(s, stubBridge(true), stubConfig());
    const { res, body } = fakeRes();
    expect(router(fakeReq('/moonraker/server/info'), res)).toBe(true);
    const result = (body() as { result: Record<string, unknown> }).result;
    expect(result.klippy_connected).toBe(true);
    expect(result.klippy_state).toBe('ready');
    expect(result.moonraker_version).toBe(MOONRAKER_VERSION);
    expect(result.api_version_string).toBe('1.5.0');
  });

  it('/server/info: klippy_state is error when the bridge is disconnected', () => {
    const s = makeStore();
    const router = createMoonrakerRouter(s, stubBridge(false), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/moonraker/server/info'), res);
    const result = (body() as { result: Record<string, unknown> }).result;
    expect(result.klippy_connected).toBe(false);
    expect(result.klippy_state).toBe('error');
  });

  it('/server/config: reports the configured service port (host field excluded — ELEG-93/#107 owns it)', () => {
    const s = makeStore();
    const router = createMoonrakerRouter(s, stubBridge(true), stubConfig({ servicePort: 9999 }));
    const { res, body } = fakeRes();
    router(fakeReq('/moonraker/server/config'), res);
    const result = (body() as { result: { config: { server: { port: number } } } }).result;
    expect(result.config.server.port).toBe(9999);
  });

  it('/printer/info: reports ready state and hostname/software_version from attributes', () => {
    const s = makeStore();
    s.attributes = {
      hostname: 'fixture-host',
      machine_model: 'Elegoo CC2 (fixture)',
      sn: 'FIXTURESN0001',
      ip: '203.0.113.5',
      protocol_version: '1.0',
      hardware_version: '1.0',
      software_version: { ota_version: '9.9.9-fixture', mcu_version: '1.0', soc_version: '1.0' },
    };
    const router = createMoonrakerRouter(s, stubBridge(true), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/moonraker/printer/info'), res);
    const result = (body() as { result: Record<string, unknown> }).result;
    expect(result.state).toBe('ready');
    expect(result.state_message).toBe('Printer is ready');
    expect(result.hostname).toBe('fixture-host');
    expect(result.software_version).toBe('9.9.9-fixture');
  });

  it('/printer/info: falls back to defaults when attributes have never been received', () => {
    const s = makeStore();
    const router = createMoonrakerRouter(s, stubBridge(false), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/moonraker/printer/info'), res);
    const result = (body() as { result: Record<string, unknown> }).result;
    expect(result.state).toBe('error');
    expect(result.hostname).toBe('elegoo-cc2');
    expect(result.software_version).toBe('unknown');
  });

  it('/printer/objects/list: enumerates exactly the emulated Klipper objects', () => {
    const s = makeStore();
    const router = createMoonrakerRouter(s, stubBridge(true), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/moonraker/printer/objects/list'), res);
    expect((body() as { result: { objects: string[] } }).result.objects).toEqual(AVAILABLE_OBJECTS);
  });

  it('/printer/objects/query (GET): parses bare ?obj and ?obj=attr,attr from the query string', () => {
    const s = makeStore();
    s.status = baseStatus();
    const router = createMoonrakerRouter(s, stubBridge(true), stubConfig());
    const { res, body } = fakeRes();
    const handled = router(
      fakeReq('/moonraker/printer/objects/query?extruder&toolhead=position'),
      res,
    );
    expect(handled).toBe(true);
    const status = (body() as { result: { status: Record<string, Record<string, unknown>> } })
      .result.status;
    expect(Object.keys(status.extruder).sort()).toEqual(
      ['can_extrude', 'power', 'pressure_advance', 'smooth_time', 'target', 'temperature'].sort(),
    );
    expect(status.toolhead).toEqual({ position: [100, 150, 12.4, 42] });
  });

  it('/api/version: returns the raw version string, not wrapped in a result envelope', () => {
    const s = makeStore();
    const router = createMoonrakerRouter(s, stubBridge(true), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/moonraker/api/version'), res);
    expect(body()).toBe(MOONRAKER_VERSION);
  });
});
