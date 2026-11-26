/**
 * ELEG-181: a paused print is status 2 with sub-status 2502/2505. Status 3 is Loading
 * Filament and is neither paused nor printing. Synthetic states only; the bridge is a spy.
 */
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from '../config.js';
import { queryObjects } from '../moonraker-compat.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import { createOctoPrintRouter, getOctoPrintState } from '../octoprint-compat.js';
import { StateStore } from '../state-store.js';
import { isPaused, type PrinterStatus } from '../../types.js';

const bridge = { isConnected: true, sendCommand: vi.fn() };
const store = new StateStore(new EventEmitter() as unknown as MqttBridge, 25);
const dataDir = mkdtempSync(join(tmpdir(), 'eleg181-'));
const config = {
  printerIp: '192.0.2.10',
  cameraEnabled: false,
  corsPolicy: { kind: 'any' },
  serviceApiKey: '',
  dataDir,
} as unknown as ServiceConfig;

let server: Server;
let port = 0;

beforeAll(async () => {
  const router = createOctoPrintRouter(store, bridge as unknown as MqttBridge, config);
  server = createServer((req, res) => {
    if (router(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.destroy();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

const state = (status: number, sub_status?: number, progress = 40) =>
  ({
    machine_status: { status, sub_status, progress },
    print_status: { filename: 'a.gcode', print_duration: 10, remaining_time_sec: 20 },
  }) as unknown as PrinterStatus;

async function toggle(): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/api/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'pause', action: 'toggle' }),
  });
  return r.status;
}

describe('isPaused', () => {
  it.each([
    [2, 2502, true],
    [2, 2505, true],
    [2, 2075, false],
    [2, undefined, false],
    [3, undefined, false],
    [3, 2502, false],
    [1, 2502, false],
  ])('status %s sub-status %s is paused: %s', (status, sub, expected) => {
    expect(isPaused(status, sub)).toBe(expected);
  });
});

describe('Moonraker print_stats and virtual_sdcard', () => {
  const query = (s: PrinterStatus) => {
    store.status = s;
    return queryObjects(store, { print_stats: null, virtual_sdcard: null });
  };

  it('status 2 + 2502 is paused', () => {
    expect(query(state(2, 2502)).print_stats.state).toBe('paused');
  });

  it('status 2 + 2505 is paused', () => {
    expect(query(state(2, 2505)).print_stats.state).toBe('paused');
  });

  it('status 2 with a printing sub-status is printing', () => {
    expect(query(state(2, 2075)).print_stats.state).toBe('printing');
  });

  it('status 3 is neither paused nor printing, and virtual_sdcard is inactive', () => {
    const r = query(state(3));
    expect(r.print_stats.state).toBe('standby');
    expect(r.virtual_sdcard.is_active).toBe(false);
    expect(r.virtual_sdcard.progress).toBe(0);
  });

  it('a pause keeps virtual_sdcard active', () => {
    expect(query(state(2, 2502)).virtual_sdcard.is_active).toBe(true);
  });
});

describe('OctoPrint state and job', () => {
  it('status 3 is not paused and not printing', () => {
    store.status = state(3);
    const f = getOctoPrintState(store).flags;
    expect(f.paused).toBe(false);
    expect(f.printing).toBe(false);
  });

  it('status 2 + 2502 is paused and not printing', () => {
    store.status = state(2, 2502);
    const o = getOctoPrintState(store);
    expect(o.text).toBe('Paused');
    expect(o.flags.paused).toBe(true);
    expect(o.flags.printing).toBe(false);
  });

  it('GET /api/job reports no progress under status 3', async () => {
    store.status = state(3);
    const r = await fetch(`http://127.0.0.1:${port}/api/job`);
    const j = (await r.json()) as { progress: { completion: number | null } };
    expect(j.progress.completion).toBeNull();
  });
});

describe('OctoPrint pause toggle', () => {
  it('on status 2 + 2502 sends resume (1023)', async () => {
    store.status = state(2, 2502);
    expect(await toggle()).toBe(204);
    expect(bridge.sendCommand.mock.calls).toEqual([[1023, {}]]);
  });

  it('on status 2 with a printing sub-status sends pause (1021)', async () => {
    store.status = state(2, 2075);
    expect(await toggle()).toBe(204);
    expect(bridge.sendCommand.mock.calls).toEqual([[1021, {}]]);
  });

  it('on status 3 sends pause (1021), not resume', async () => {
    store.status = state(3);
    expect(await toggle()).toBe(204);
    expect(bridge.sendCommand.mock.calls).toEqual([[1021, {}]]);
  });
});
