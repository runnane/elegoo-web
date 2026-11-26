/**
 * ELEG-171: an `/api/*` URL no route matches answers a JSON 404, not the SPA shell with a
 * 200. Through the real router (`createRestRouter`) on an ephemeral port, with fakes for
 * the store and bridge — no printer, no MQTT.
 *
 * `dist/` is not guaranteed to exist when the tests run, so `fs` is mocked just enough
 * that the SPA fallback has an `index.html` to serve: the non-API cases then prove the
 * fallback still fires, rather than passing on whatever happens to be on disk.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from '../server/config.js';
import type { MqttBridge } from '../server/mqtt-bridge.js';
import type { StateStore } from '../server/state-store.js';

const SPA_SHELL = '<!doctype html><title>spa-shell</title>';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = (p: unknown) =>
    typeof p === 'string' && p.endsWith('index.html') ? true : actual.existsSync(p as string);
  const createReadStream = (p: unknown, ...rest: unknown[]) =>
    typeof p === 'string' && p.endsWith('index.html')
      ? Readable.from([Buffer.from(SPA_SHELL)])
      : (actual.createReadStream as (...a: unknown[]) => unknown)(p, ...rest);
  return {
    ...actual,
    default: { ...actual, existsSync, createReadStream },
    existsSync,
    createReadStream,
  };
});

const { createRestRouter } = await import('../server/rest-api.js');

const bridge = {
  isConnected: true,
  brokerConnected: true,
  phase: 'registered',
  registerAttempts: 1,
  serialNumber: 'TESTSN',
  ip: '192.0.2.10',
  on: vi.fn(),
};

const store = {
  attributes: {},
  status: {},
  canvas: {},
  files: [],
  layerTimes: [],
  fileTotalLayers: 0,
  getFilamentUsageArray: () => [],
  on: vi.fn(),
  off: vi.fn(),
};

const config = {
  printerIp: '192.0.2.10',
  printerPassword: 'x',
  cameraEnabled: false,
  cameraUrl: 'http://192.0.2.10:8080',
  corsPolicy: { kind: 'any' },
  serviceApiKey: '',
  telegramEnabled: false,
  telegramChatId: '',
  progressInterval: 25,
  aiEnabled: false,
  aiLocalEnabled: false,
  dataDir: './data',
} as unknown as ServiceConfig;

let server: Server;
let base: string;

beforeAll(async () => {
  const router = createRestRouter(
    store as unknown as StateStore,
    config,
    null,
    null,
    bridge as unknown as MqttBridge,
  );
  server = createServer(router);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('unknown /api/* paths (ELEG-171)', () => {
  it('answers a JSON 404 naming the path', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found', path: '/api/does-not-exist' });
  });

  it('keeps the query string out of the reported path', async () => {
    const res = await fetch(`${base}/api/nope/deeper?x=1`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found', path: '/api/nope/deeper' });
  });

  it('still answers a known route', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('non-API paths keep the SPA fallback (ELEG-171)', () => {
  it.each(['/', '/settings', '/some/deep/client-route'])('%s serves index.html', async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(SPA_SHELL);
  });
});
