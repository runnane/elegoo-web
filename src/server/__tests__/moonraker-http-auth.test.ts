/**
 * ELEG-142, HTTP half: Moonraker writes are gated behind SERVICE_API_KEY on **both** HTTP
 * mounts — `/moonraker/*` on the main port (`createMoonrakerRouter`) and the dedicated
 * `:7125` server (`MoonrakerServer.handleHttp`). The WebSocket half is in
 * `moonraker-ws-auth.test.ts`, deliberately a separate file: one test covering both
 * transports is the hole ELEG-25 exists to prevent, and each file is the red half of one
 * mutation.
 *
 * Real servers on ephemeral ports; no printer, no MQTT, nothing from index.ts. The bridge
 * is a fake and `bridge.sendCommand` is the spy that says whether a request reached the
 * printer.
 */
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from '../config.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { StateStore } from '../state-store.js';
import { NO_API_KEY_MESSAGE } from '../compat-auth.js';
import { isMoonrakerHttpWrite } from '../moonraker-auth.js';
import { createMoonrakerRouter } from '../moonraker-compat.js';
import { MoonrakerServer } from '../moonraker-server.js';

const KEY = 'm'.repeat(16) + '0123456789abcdef0123'; // 36 chars, generated, not a real key
const WRONG = 'z'.repeat(36);

// ── fakes ──────────────────────────────────────────────────────────────────

const bridge = Object.assign(new EventEmitter(), {
  isConnected: true,
  sendCommand: vi.fn(),
});

const store = Object.assign(new EventEmitter(), {
  // `unknown`, not `null`: the print-guard cases below set a job status per test.
  status: null as unknown,
  attributes: null,
  files: [],
  fileTotalLayers: null,
  getChartHistory: () => [],
});

const dataDir = mkdtempSync(join(tmpdir(), 'eleg142-http-'));
const config = {
  serviceApiKey: KEY,
  corsPolicy: { kind: 'none' },
  dataDir,
  moonrakerPort: 0,
  bindAddress: '127.0.0.1',
  servicePort: 8088,
  cameraEnabled: false,
  printerIp: '192.0.2.10',
} as unknown as ServiceConfig;
const setKey = (k: string) => {
  (config as { serviceApiKey: string }).serviceApiKey = k;
};

// ── the two mounts ─────────────────────────────────────────────────────────

let compatServer: Server;
let moonraker: MoonrakerServer;
let compatBase = '';
let serverBase = '';

beforeAll(async () => {
  const handle = createMoonrakerRouter(
    store as unknown as StateStore,
    bridge as unknown as MqttBridge,
    config,
  );
  compatServer = createServer((req, res) => {
    // index.ts falls through to the REST handler; here, an unhandled route is a 404.
    if (!handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => compatServer.listen(0, '127.0.0.1', resolve));
  compatBase = `http://127.0.0.1:${(compatServer.address() as AddressInfo).port}/moonraker`;

  moonraker = new MoonrakerServer(
    store as unknown as StateStore,
    bridge as unknown as MqttBridge,
    config,
  );
  const http = (moonraker as unknown as { httpServer: Server }).httpServer;
  const listening = new Promise<void>((resolve) => http.once('listening', () => resolve()));
  moonraker.start();
  await listening;
  serverBase = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  moonraker.stop(); // starts a final async save of moonraker-db.json
  await new Promise<void>((resolve) => compatServer.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  setKey(KEY);
  store.status = null; // no job: the auth cases rely on the print guard failing open
});

type Mount = { name: string; base: () => string };
const MOUNTS: Mount[] = [
  { name: '/moonraker/* on the main port', base: () => compatBase },
  { name: 'the :7125 server', base: () => serverBase },
];

async function call(
  base: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, text: await res.text() };
}

const UNAUTHORIZED_BODY = { error: { code: 401, message: 'Unauthorized' } };

// ── the issue's proof list, per mount ──────────────────────────────────────

describe.each(MOUNTS)('HTTP on $name', ({ base }) => {
  it('POST /printer/emergency_stop with no key is 401 and never reaches the bridge', async () => {
    const r = await call(base(), 'POST', '/printer/emergency_stop');
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text)).toEqual(UNAUTHORIZED_BODY);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('POST /printer/emergency_stop with a wrong key is 401 and never reaches the bridge', async () => {
    const r = await call(base(), 'POST', '/printer/emergency_stop', {
      headers: { 'X-Api-Key': WRONG },
    });
    expect(r.status).toBe(401);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['X-Api-Key', { 'X-Api-Key': KEY }],
    ['Authorization: Bearer', { Authorization: `Bearer ${KEY}` }],
  ])('POST /printer/emergency_stop with the key (%s) is forwarded', async (_l, headers) => {
    const r = await call(base(), 'POST', '/printer/emergency_stop', { headers });
    expect(r.status).toBe(200);
    expect(bridge.sendCommand.mock.calls).toEqual([[1022, {}]]);
  });

  // (A trailing space would be stripped by the HTTP layer itself, so it cannot be tested
  // over the wire; `write-auth.test.ts` covers the untrimmed comparison.)
  it.each([
    ['the key plus one character', `${KEY}x`],
    ['an empty Bearer', ''],
  ])('%s is a wrong key', async (label, k) => {
    const headers: Record<string, string> =
      label === 'an empty Bearer' ? { Authorization: 'Bearer' } : { 'X-Api-Key': k };
    const r = await call(base(), 'POST', '/printer/emergency_stop', { headers });
    expect(r.status).toBe(401);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  // The pair ELEG-144's operator verification runs (scope addition on the issue).
  it('GET /server/info: a wrong key is 401, no key is 200, the key is 200', async () => {
    const wrong = await call(base(), 'GET', '/server/info', { headers: { 'X-Api-Key': WRONG } });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.text)).toEqual(UNAUTHORIZED_BODY);
    expect((await call(base(), 'GET', '/server/info')).status).toBe(200);
    expect(
      (await call(base(), 'GET', '/server/info', { headers: { 'X-Api-Key': KEY } })).status,
    ).toBe(200);
  });

  it('POST /printer/objects/query is a read: answered with no key', async () => {
    const r = await call(base(), 'POST', '/printer/objects/query', {
      body: { objects: { extruder: null } },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).result.status).toHaveProperty('extruder');
  });

  it('with SERVICE_API_KEY unset, writes are open (intentional, as on /api/*)', async () => {
    setKey('');
    const r = await call(base(), 'POST', '/printer/emergency_stop');
    expect(r.status).toBe(200);
    expect(bridge.sendCommand.mock.calls).toEqual([[1022, {}]]);
  });

  it('no response carries the key, right or wrong', async () => {
    const texts = [
      (await call(base(), 'POST', '/printer/emergency_stop', { headers: { 'X-Api-Key': WRONG } }))
        .text,
      (await call(base(), 'POST', '/printer/emergency_stop', { headers: { 'X-Api-Key': KEY } }))
        .text,
      (await call(base(), 'GET', '/server/info', { headers: { 'X-Api-Key': KEY } })).text,
    ].join('\n');
    expect(texts).not.toContain(KEY);
    expect(texts).not.toContain(WRONG);
  });
});

// ── the gated tables, pinned ───────────────────────────────────────────────

/**
 * Every write route each mount implements. A new write route is gated anyway (default-deny
 * on non-GET), but it should appear here as a visible diff.
 */
const COMPAT_GATED: Array<[string, string, unknown?]> = [
  ['POST', '/printer/print/start?filename=a.gcode'],
  ['POST', '/printer/print/start', { filename: 'a.gcode' }],
  ['POST', '/printer/print/pause'],
  ['POST', '/printer/print/resume'],
  ['POST', '/printer/print/cancel'],
  ['POST', '/printer/emergency_stop'],
  ['POST', '/printer/gcode/script', { script: 'G28' }],
  ['POST', '/server/restart'],
];

const SERVER_GATED: Array<[string, string, unknown?]> = [
  ...COMPAT_GATED,
  ['POST', '/printer/restart'],
  ['POST', '/printer/firmware_restart'],
  ['POST', '/server/files/upload'],
  ['POST', '/server/files/move', { source: 'gcodes/a', dest: 'gcodes/b' }],
  ['POST', '/server/files/copy', { source: 'gcodes/a', dest: 'gcodes/b' }],
  ['POST', '/server/files/directory', { path: 'gcodes/d' }],
  ['DELETE', '/server/files/directory?path=gcodes/d'],
  ['DELETE', '/server/files/gcodes/a.gcode'],
  ['DELETE', '/server/history/job?uid=1'],
  ['POST', '/server/history/reset_totals'],
  ['POST', '/server/job_queue/job', { filenames: ['a.gcode'] }],
  ['DELETE', '/server/job_queue/job?job_ids=1'],
  ['POST', '/server/job_queue/pause'],
  ['POST', '/server/job_queue/start'],
  ['POST', '/machine/services/restart?service=klipper'],
  ['POST', '/machine/services/start?service=klipper'],
  ['POST', '/machine/services/stop?service=klipper'],
  ['POST', '/machine/shutdown'],
  ['POST', '/machine/reboot'],
  ['POST', '/server/webcams/item', { name: 'x' }],
  ['DELETE', '/server/webcams/item?name=default'],
  // `server.webcams.post_item` writes this namespace, so it is not a way round it.
  ['POST', '/server/database/item', { namespace: 'webcams', key: 'x', value: {} }],
  ['DELETE', '/server/database/item?namespace=webcams&key=default'],
  ['POST', '/server/logs/rollover'],
  ['POST', '/server/announcements/update'],
  ['POST', '/server/announcements/dismiss', { entry_id: 'x' }],
  ['POST', '/server/announcements/feed', { name: 'x' }],
  ['DELETE', '/server/announcements/feed?name=x'],
];

const route = (p: string) => p.split('?')[0];
const qs = (p: string) => Object.fromEntries(new URLSearchParams(p.split('?')[1] ?? ''));

describe.each([
  { name: '/moonraker/* on the main port', base: () => compatBase, table: COMPAT_GATED },
  { name: 'the :7125 server', base: () => serverBase, table: SERVER_GATED },
])('gated routes on $name', ({ base, table }) => {
  it.each(table)('%s %s with no key is 401 and touches nothing', async (method, path, body) => {
    const r = await call(base(), method, path, { body });
    expect(r.status).toBe(401);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it.each(table.filter(([, p]) => !p.startsWith('/server/database')))(
    '%s %s is a write to the classifier',
    (method, path) => {
      expect(isMoonrakerHttpWrite(method, route(path), qs(path))).toBe(true);
    },
  );
});

/** Open on both mounts with no key at all: reads, and the deliberately open writes. */
const OPEN_BOTH: Array<[string, string, unknown?]> = [
  ['GET', '/server/info'],
  ['GET', '/server/config'],
  ['GET', '/printer/info'],
  ['GET', '/printer/objects/list'],
  ['GET', '/printer/objects/query?extruder'],
  ['POST', '/printer/objects/query', { objects: { heater_bed: null } }],
  ['GET', '/server/files/list'],
  ['GET', '/server/files/directory'],
  ['GET', '/server/files/roots'],
  ['GET', '/server/temperature_store'],
  ['GET', '/server/webcams/list'],
];

const OPEN_SERVER_ONLY: Array<[string, string, unknown?]> = [
  ['GET', '/server/database/list'],
  ['GET', '/server/database/item?namespace=mainsail'],
  ['POST', '/server/database/item', { namespace: 'mainsail', key: 'k', value: 1 }],
  ['DELETE', '/server/database/item?namespace=mainsail&key=k'],
  ['GET', '/access/info'],
  ['GET', '/access/oneshot_token'],
  ['POST', '/access/login', { username: 'a', password: 'b' }],
  ['GET', '/access/api_key'],
  ['GET', '/server/history/list'],
  ['GET', '/server/job_queue/status'],
  ['GET', '/machine/system_info'],
];

describe.each([
  { name: '/moonraker/* on the main port', base: () => compatBase, table: OPEN_BOTH },
  { name: 'the :7125 server', base: () => serverBase, table: [...OPEN_BOTH, ...OPEN_SERVER_ONLY] },
])('open routes on $name', ({ base, table }) => {
  it.each(table)('%s %s is answered with no key', async (method, path, body) => {
    const r = await call(base(), method, path, { body });
    expect(r.status).not.toBe(401);
    expect(r.status).toBeLessThan(500);
  });
});

describe('the compat answers stay truthful on :7125', () => {
  it('access.info keeps login_required: false, so read-only clients still connect', async () => {
    const r = await call(serverBase, 'GET', '/access/info');
    expect(JSON.parse(r.text).result.login_required).toBe(false);
  });

  it('GET /access/api_key refuses and never returns the key, even when the key is sent', async () => {
    const r = await call(serverBase, 'GET', '/access/api_key', { headers: { 'X-Api-Key': KEY } });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text).error.message).toBe(NO_API_KEY_MESSAGE);
    expect(r.text).not.toContain(KEY);
  });
});

// ── the print guard (ELEG-176) ─────────────────────────────────────────────

const job = (code: number) => ({ machine_status: { status: code } });
const WITH_KEY = { headers: { 'X-Api-Key': KEY } };
const script = (s: string) => ({ ...WITH_KEY, body: { script: s } });

/**
 * The two mounts translate 1028 into different param shapes (ELEG-180), so each row pins
 * what that mount sends. Both shapes are recognised by the guard.
 */
describe.each([
  {
    name: '/moonraker/* on the main port',
    base: () => compatBase,
    bedOff: [
      [1028, { target: 'extruder', temperature: 0 }],
      [1028, { target: 'heater_bed', temperature: 0 }],
    ],
    m140: [1028, { target: 'heater_bed', temperature: 60 }],
    m104: [1028, { target: 'extruder', temperature: 215 }],
  },
  {
    name: 'the :7125 server',
    base: () => serverBase,
    bedOff: [
      [1028, { extruder: 0 }],
      [1028, { heater_bed: 0 }],
    ],
    m140: [1028, { heater_bed: 60 }],
    m104: [1028, { extruder: 215 }],
  },
])('the print guard on POST /printer/gcode/script, $name', ({ base, bedOff, m140, m104 }) => {
  it.each([
    ['G28', 'homing'],
    ['M140 S0', 'turning a heater off'],
    ['M104 S150', 'below 170'],
    ['TURN_OFF_HEATERS', 'turning a heater off'],
  ])('while printing, %s is 409 and sends nothing', async (gcode, what) => {
    store.status = job(2);
    const r = await call(base(), 'POST', '/printer/gcode/script', script(gcode));
    expect(r.status).toBe(409);
    const body = JSON.parse(r.text);
    expect(body.error.code).toBe(409);
    expect(body.error.message).toContain('busy printing');
    expect(body.error.message).toContain(what);
    // TURN_OFF_HEATERS is two sends; decided up front, so neither half goes.
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('idle control: G28 and TURN_OFF_HEATERS are forwarded', async () => {
    store.status = job(1);
    const home = await call(base(), 'POST', '/printer/gcode/script', script('G28'));
    const off = await call(base(), 'POST', '/printer/gcode/script', script('TURN_OFF_HEATERS'));
    expect(home.status).toBe(200);
    expect(off.status).toBe(200);
    expect(bridge.sendCommand.mock.calls).toEqual([[1026, { axes: ['x', 'y', 'z'] }], ...bedOff]);
  });

  it('mid-print allow: M140 S60 and M104 S215 are forwarded', async () => {
    store.status = job(2);
    const bed = await call(base(), 'POST', '/printer/gcode/script', script('M140 S60'));
    const nozzle = await call(base(), 'POST', '/printer/gcode/script', script('M104 S215'));
    expect(bed.status).toBe(200);
    expect(nozzle.status).toBe(200);
    expect(bridge.sendCommand.mock.calls).toEqual([m140, m104]);
  });

  it('mid-print: unrecognised gcode (a babystep) is still answered ok and sends nothing', async () => {
    store.status = job(2);
    const r = await call(
      base(),
      'POST',
      '/printer/gcode/script',
      script('SET_GCODE_OFFSET Z_ADJUST=0.01'),
    );
    expect(r.status).toBe(200);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('idle control: M140 S0 and M104 S150 are forwarded', async () => {
    store.status = job(1);
    const bed = await call(base(), 'POST', '/printer/gcode/script', script('M140 S0'));
    const nozzle = await call(base(), 'POST', '/printer/gcode/script', script('M104 S150'));
    expect(bed.status).toBe(200);
    expect(nozzle.status).toBe(200);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(2);
    expect(bridge.sendCommand.mock.calls.map(([m]) => m)).toEqual([1028, 1028]);
  });
});
