import { EventEmitter } from 'events';
import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { StateStore } from '../state-store.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { ServiceConfig } from '../config.js';
import {
  createOctoPrintRouter,
  getOctoPrintState,
  getTemperatureData,
} from '../octoprint-compat.js';
import type { PrinterStatus } from '../../types.js';

/**
 * Pins the OctoPrint translation (ELEG-97/ELEG-28): CC2 state in, fixed OctoPrint JSON
 * out. `getOctoPrintState`/`getTemperatureData` were exported from octoprint-compat.ts
 * with no behaviour change so the pure translation halves can be asserted directly,
 * rather than only through the HTTP router. Fixtures below are generated, not captured
 * printer state (public repo — AGENTS.md).
 */

let store: StateStore | null = null;

function makeStore(): StateStore {
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

describe('getOctoPrintState — CC2 machine_status/sub_status → OctoPrint state text + flags', () => {
  it('idle (status 1) → Operational, ready, nothing else set', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 0, exception_status: [], progress: 0 },
    });
    const r = getOctoPrintState(s);
    expect(r.text).toBe('Operational');
    expect(r.flags).toEqual({
      operational: true,
      paused: false,
      printing: false,
      pausing: false,
      cancelling: false,
      sdReady: true,
      error: false,
      ready: true,
      closedOrError: false,
    });
  });

  it('printing (status 2) → Printing, printing flag set, not ready', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [], progress: 40 },
    });
    const r = getOctoPrintState(s);
    expect(r.text).toBe('Printing');
    expect(r.flags.printing).toBe(true);
    expect(r.flags.paused).toBe(false);
    expect(r.flags.ready).toBe(false);
  });

  it('paused via machine_status 3 → Paused', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 3, sub_status: 0, exception_status: [], progress: 40 },
    });
    const r = getOctoPrintState(s);
    expect(r.text).toBe('Paused');
    expect(r.flags.paused).toBe(true);
    expect(r.flags.printing).toBe(false);
  });

  it('paused via sub_status 2502 while machine_status is still 2 → Paused, and the printing flag clears', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 2502, exception_status: [], progress: 40 },
    });
    const r = getOctoPrintState(s);
    expect(r.text).toBe('Paused');
    expect(r.flags.paused).toBe(true);
    // The regression this guards: `printing` is `isPrinting && !isPaused`, not isPrinting alone.
    expect(r.flags.printing).toBe(false);
  });

  it('paused via sub_status 2505 → Paused', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 2505, exception_status: [], progress: 0 },
    });
    expect(getOctoPrintState(s).text).toBe('Paused');
  });

  it('pausing transition (sub_status 2501) sets the pausing flag without flipping the main state', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 2501, exception_status: [], progress: 40 },
    });
    const r = getOctoPrintState(s);
    expect(r.flags.pausing).toBe(true);
    expect(r.text).toBe('Printing');
  });

  it('cancelling transition (sub_status 2503) sets the cancelling flag', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 2503, exception_status: [], progress: 40 },
    });
    expect(getOctoPrintState(s).flags.cancelling).toBe(true);
  });

  it('an active exception → Error, overriding printing', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [1100], progress: 40 },
    });
    const r = getOctoPrintState(s);
    expect(r.text).toBe('Error');
    expect(r.flags.error).toBe(true);
    expect(r.flags.ready).toBe(false);
  });

  it('an unrecognised machine_status (e.g. still initializing) falls through to Operational, not an error state', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 0, sub_status: 0, exception_status: [], progress: 0 },
    });
    const r = getOctoPrintState(s);
    expect(r.text).toBe('Operational');
    // status 0 is not isIdle (===1), so `ready` stays false even though text says Operational.
    expect(r.flags.ready).toBe(false);
  });

  it('no status at all (never connected) → Offline, closedOrError', () => {
    const s = makeStore();
    const r = getOctoPrintState(s);
    expect(r.text).toBe('Offline');
    expect(r.flags.operational).toBe(false);
    expect(r.flags.closedOrError).toBe(true);
  });
});

describe('getTemperatureData — actual/target/offset shape, degrees Celsius', () => {
  it('reports tool0, bed and chamber with a fixed zero offset', () => {
    const s = makeStore();
    s.status = baseStatus();
    expect(getTemperatureData(s)).toEqual({
      tool0: { actual: 205.5, target: 210, offset: 0 },
      bed: { actual: 59.8, target: 60, offset: 0 },
      // The CC2 has no chamber heater — target is a fixed 0, not read from state.
      chamber: { actual: 28, target: 0, offset: 0 },
    });
  });

  it('defaults every field to zero when there is no status at all', () => {
    const s = makeStore();
    expect(getTemperatureData(s)).toEqual({
      tool0: { actual: 0, target: 0, offset: 0 },
      bed: { actual: 0, target: 0, offset: 0 },
      chamber: { actual: 0, target: 0, offset: 0 },
    });
  });
});

describe('createOctoPrintRouter — REST endpoints', () => {
  it('/api/version: reports the fixed API/server version strings', () => {
    const s = makeStore();
    const router = createOctoPrintRouter(s, stubBridge(), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/octoprint/api/version'), res);
    expect(body()).toEqual({
      api: '0.1',
      server: '1.10.3',
      text: 'OctoPrint 1.10.3 (Elegoo CC2 Compat)',
    });
  });

  it('/api/printer: temperature + sd + state in the real OctoPrint shape', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [], progress: 10 },
    });
    const router = createOctoPrintRouter(s, stubBridge(), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/octoprint/api/printer'), res);
    const result = body() as {
      temperature: { tool0: unknown };
      sd: unknown;
      state: { text: string };
    };
    expect(result.temperature.tool0).toEqual({ actual: 205.5, target: 210, offset: 0 });
    expect(result.sd).toEqual({ ready: true });
    expect(result.state.text).toBe('Printing');
  });

  it('/api/printer: 409 when the printer has never reported status', () => {
    const s = makeStore();
    const router = createOctoPrintRouter(s, stubBridge(), stubConfig());
    const { res, status, body } = fakeRes();
    router(fakeReq('/octoprint/api/printer'), res);
    expect(status()).toBe(409);
    expect(body()).toEqual({ error: 'Printer is not operational' });
  });

  it("/api/job: completion is 0..100 (not Moonraker's 0..1) and times are whole seconds, while printing", () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 2, sub_status: 0, exception_status: [], progress: 63 },
    });
    const router = createOctoPrintRouter(s, stubBridge(), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/octoprint/api/job'), res);
    const result = body() as {
      progress: { completion: number; printTime: number; printTimeLeft: number };
      state: string;
      job: { estimatedPrintTime: number };
    };
    expect(result.progress.completion).toBe(63);
    expect(result.progress.printTime).toBe(600);
    expect(result.progress.printTimeLeft).toBe(600);
    expect(result.state).toBe('Printing');
    expect(result.job.estimatedPrintTime).toBe(1200);
  });

  it('/api/job: progress fields are null when idle, even though print_status still carries stale numbers', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 1, sub_status: 0, exception_status: [], progress: 63 },
    });
    const router = createOctoPrintRouter(s, stubBridge(), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/octoprint/api/job'), res);
    const result = body() as {
      progress: {
        completion: null | number;
        printTime: null | number;
        printTimeLeft: null | number;
      };
    };
    expect(result.progress.completion).toBeNull();
    expect(result.progress.printTime).toBeNull();
    expect(result.progress.printTimeLeft).toBeNull();
  });

  it('/api/job: progress stays populated while paused (status 3) — its own isPrinting includes paused', () => {
    const s = makeStore();
    s.status = baseStatus({
      machine_status: { status: 3, sub_status: 0, exception_status: [], progress: 63 },
    });
    const router = createOctoPrintRouter(s, stubBridge(), stubConfig());
    const { res, body } = fakeRes();
    router(fakeReq('/octoprint/api/job'), res);
    const result = body() as { progress: { completion: number }; state: string };
    expect(result.progress.completion).toBe(63);
    expect(result.state).toBe('Paused');
  });
});
