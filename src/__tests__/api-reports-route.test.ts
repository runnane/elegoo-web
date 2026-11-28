/**
 * ELEG-196 (from PR #182): `GET /api/reports` carries each report's filament usage,
 * progressAtEnd and failureReason, and the live print as `activePrint`.
 *
 * The collector test proves `listReports()` builds the items; this pins what the route
 * actually SENDS, through the real router (`createRestRouter`) on an ephemeral port with a
 * real collector over a temp data dir. A stub store, no printer, no MQTT.
 */
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from '../server/config.js';
import type { MqttBridge } from '../server/mqtt-bridge.js';
import { PrintReportCollector } from '../server/print-report-collector.js';
import { createRestRouter } from '../server/rest-api.js';
import type { FilamentUsage, StateStore } from '../server/state-store.js';

const LIVE: FilamentUsage = {
  trayKey: 'canvas_0_tray_1',
  filamentType: 'PLA',
  color: '#ffffff',
  extruded_mm: 1500,
  grams: 4.47,
  meters: 1.5,
};

/** Enough of StateStore for both the router and the collector. */
class StubStore extends EventEmitter {
  attributes = {};
  status = {
    print_status: { filename: 'live_part.gcode', current_layer: 5, total_layer: 100 },
    machine_status: { progress: 12 },
  };
  canvas = {};
  files = [];
  thumbnail = null;
  layerTimes = [];
  fileTotalLayers = 100;
  getChartHistory() {
    return [];
  }
  getFilamentUsageArray() {
    return [LIVE];
  }
}

const bridge = {
  isConnected: true,
  brokerConnected: true,
  phase: 'registered',
  registerAttempts: 1,
  serialNumber: 'TESTSN',
  ip: '192.0.2.10',
  on: vi.fn(),
};

let dir: string;
let store: StubStore;
let collector: PrintReportCollector;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eleg196-route-'));
  const repDir = join(dir, 'reports', 'rep-failed');
  mkdirSync(repDir, { recursive: true });
  writeFileSync(
    join(repDir, 'report.json'),
    JSON.stringify({
      version: 1,
      id: 'rep-failed',
      filename: 'bracket.gcode',
      startedAt: 1000,
      endedAt: 4000,
      outcome: 'failed',
      failureReason: 'Stopping',
      duration: 3,
      stats: { totalLayers: 80, progressAtEnd: 31, fileTotalLayers: 80 },
      filament: [{ ...LIVE, extruded_mm: 11425, grams: 34.06, meters: 11.425 }],
    }),
  );
  const config = {
    printerIp: '192.0.2.10',
    printerPassword: 'x',
    cameraEnabled: false,
    cameraUrl: 'http://192.0.2.10:8080',
    corsPolicy: { kind: 'any' },
    serviceApiKey: '',
    dataDir: dir,
  } as unknown as ServiceConfig;
  store = new StubStore();
  collector = new PrintReportCollector(store as unknown as StateStore, config);
  server = createServer(
    createRestRouter(
      store as unknown as StateStore,
      config,
      null,
      collector,
      bridge as unknown as MqttBridge,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  store.emit('printer_switched'); // drops the collector's active print and its timer
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function getReports() {
  const res = await fetch(`${base}/api/reports`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    reports: Array<Record<string, unknown>>;
    active: boolean;
    activePrint: Record<string, unknown> | null;
  };
}

describe('GET /api/reports (ELEG-196)', () => {
  it("returns each report's filament usage, progressAtEnd and failureReason", async () => {
    const body = await getReports();
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toEqual({
      id: 'rep-failed',
      filename: 'bracket.gcode',
      outcome: 'failed',
      startedAt: 1000,
      endedAt: 4000,
      duration: 3,
      progressAtEnd: 31,
      failureReason: 'Stopping',
      filament: [{ ...LIVE, extruded_mm: 11425, grams: 34.06, meters: 11.425 }],
    });
    expect(body.active).toBe(false);
    expect(body.activePrint).toBeNull();
  });

  it('reports the running print as activePrint, with its live filament usage', async () => {
    store.emit('print_event', {
      type: 'print_started',
      filename: 'live_part.gcode',
      resumed: false,
    });
    const body = await getReports();
    expect(body.active).toBe(true);
    expect(body.activePrint).toMatchObject({
      filename: 'live_part.gcode',
      progress: 12,
      filament: [LIVE],
    });
  });
});
