/**
 * ELEG-143: OctoPrint-compat writes are gated behind SERVICE_API_KEY **inside the shared
 * router**, so one gate covers both places the router is mounted:
 *
 *   - `/octoprint/*` on the main port — driven here through `createOctoPrintRouter` on its
 *     own ephemeral-port server, the way `index.ts` mounts it;
 *   - `:7125/api/*` — driven through a real `MoonrakerServer` listening on an ephemeral
 *     port, whose `handleHttp` prepends `/octoprint` and hands the request to the router.
 *
 * Every case runs against BOTH mounts. No printer, no MQTT, nothing imported from
 * index.ts: the bridge is a fake whose `sendCommand` is a spy, and that spy is the
 * "reached the printer" observation. Each refusal fixture is a request that SUCCEEDS with
 * the right key — only the credential differs — so "the spy was not called" is not
 * vacuous, and the spy assertion comes before the status one (a gate that ran after the
 * command would still answer 403).
 *
 * OctoPrint answers a missing or wrong key with **403**, not the 401 the /api/* gate uses.
 */
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import { connect, type AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from '../config.js';
import { MoonrakerServer } from '../moonraker-server.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import { createOctoPrintRouter } from '../octoprint-compat.js';
import { StateStore } from '../state-store.js';
import type { PrinterStatus } from '../../types.js';

const KEY = 'k'.repeat(16) + '0123456789abcdef0123'; // 36 chars, generated, not a real key
const WRONG = 'x'.repeat(36);

// ── fakes ──────────────────────────────────────────────────────────────────

const bridge = { isConnected: true, sendCommand: vi.fn() };
const store = new StateStore(new EventEmitter() as unknown as MqttBridge, 25);
const dataDir = mkdtempSync(join(tmpdir(), 'eleg143-'));

const config = {
  printerIp: '192.0.2.10',
  cameraEnabled: false,
  corsPolicy: { kind: 'any' },
  serviceApiKey: KEY,
  moonrakerPort: 0,
  bindAddress: '127.0.0.1',
  dataDir,
} as unknown as ServiceConfig;

function setKey(k: string): void {
  (config as { serviceApiKey: string }).serviceApiKey = k;
}

// ── the two mounts ─────────────────────────────────────────────────────────

let octoServer: Server;
let moonraker: MoonrakerServer;
const ports = { octoprint: 0, moonraker: 0 };

beforeAll(async () => {
  const router = createOctoPrintRouter(store, bridge as unknown as MqttBridge, config);
  octoServer = createServer((req, res) => {
    if (router(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => octoServer.listen(0, '127.0.0.1', resolve));
  ports.octoprint = (octoServer.address() as AddressInfo).port;

  moonraker = new MoonrakerServer(store, bridge as unknown as MqttBridge, config);
  moonraker.start();
  const http = (moonraker as unknown as { httpServer: Server }).httpServer;
  if (!http.listening) await new Promise<void>((resolve) => http.once('listening', resolve));
  ports.moonraker = (http.address() as AddressInfo).port;
});

afterAll(async () => {
  moonraker.stop();
  await new Promise<void>((resolve) => octoServer.close(() => resolve()));
  store.destroy();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  setKey(KEY);
  store.status = null; // no job: the auth cases rely on the print guard failing open
});

// ── a raw HTTP client ──────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: string;
}

/** One request over a raw socket: header values go on the wire exactly as written. */
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<Reply> {
  const payload = Buffer.from(body);
  const lines = [`${method} ${path} HTTP/1.0`, 'Host: 127.0.0.1', 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push(`Content-Length: ${payload.length}`);
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('error', reject);
    sock.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);
      const split = raw.indexOf('\r\n\r\n');
      resolve({ status, body: split >= 0 ? raw.slice(split + 4) : '' });
    });
    sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    sock.end(payload);
  });
}

/** Both mounts: the main port's `/octoprint/api/*` and `:7125/api/*`. */
const MOUNTS = [
  { mount: '/octoprint on the main port', port: () => ports.octoprint, prefix: '/octoprint' },
  { mount: ':7125 (MoonrakerServer.handleHttp)', port: () => ports.moonraker, prefix: '' },
] as const;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The two writes the issue's proof names, each with the exact command it must send. */
const WRITES = [
  {
    name: 'POST /api/job {command:"cancel"}',
    path: '/api/job',
    body: JSON.stringify({ command: 'cancel' }),
    command: [1022, {}],
  },
  {
    name: 'POST /api/printer/bed {command:"target"}',
    path: '/api/printer/bed',
    body: JSON.stringify({ command: 'target', target: 60 }),
    command: [1028, { heater_bed: 60 }],
  },
] as const;

const REFUSED_CREDENTIALS: Array<[string, Record<string, string>]> = [
  ['no key', {}],
  ['a wrong X-Api-Key', { 'X-Api-Key': WRONG }],
  ['a wrong Bearer key', { Authorization: `Bearer ${WRONG}` }],
  ['Bearer with an empty value', { Authorization: 'Bearer ' }],
  ['an empty X-Api-Key', { 'X-Api-Key': '' }],
  ['the key in a Basic header', { Authorization: `Basic ${KEY}` }],
];

describe.each(MOUNTS)('OctoPrint compat through $mount', (m) => {
  describe.each(WRITES)('$name', (w) => {
    it.each(REFUSED_CREDENTIALS)(
      'is refused with %s and never reaches the printer',
      async (_l, creds) => {
        const r = await send(
          m.port(),
          'POST',
          m.prefix + w.path,
          { ...JSON_HEADERS, ...creds },
          w.body,
        );
        expect(bridge.sendCommand).not.toHaveBeenCalled();
        expect(r.status).toBe(403);
        expect(r.body).not.toContain(KEY);
        expect(r.body).not.toContain(WRONG);
      },
    );

    it('reaches the printer with the key as X-Api-Key', async () => {
      const r = await send(
        m.port(),
        'POST',
        m.prefix + w.path,
        { ...JSON_HEADERS, 'X-Api-Key': KEY },
        w.body,
      );
      expect(bridge.sendCommand).toHaveBeenCalledWith(...w.command);
      expect(r.status).toBe(204);
    });

    it('reaches the printer with the key as Authorization: Bearer', async () => {
      const r = await send(
        m.port(),
        'POST',
        m.prefix + w.path,
        { ...JSON_HEADERS, Authorization: `Bearer ${KEY}` },
        w.body,
      );
      expect(bridge.sendCommand).toHaveBeenCalledWith(...w.command);
      expect(r.status).toBe(204);
    });

    it('reaches the printer with no key when SERVICE_API_KEY is unset (intentional: fail-open on upgrade)', async () => {
      setKey('');
      const r = await send(m.port(), 'POST', m.prefix + w.path, JSON_HEADERS, w.body);
      expect(bridge.sendCommand).toHaveBeenCalledWith(...w.command);
      expect(r.status).toBe(204);
    });
  });

  describe('reads', () => {
    it('GET /api/version with a wrong key is 403, and the body carries neither key', async () => {
      const r = await send(m.port(), 'GET', `${m.prefix}/api/version`, { 'X-Api-Key': WRONG });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain(WRONG);
      expect(r.body).not.toContain(KEY);
    });

    it('GET /api/version with no key is 200', async () => {
      const r = await send(m.port(), 'GET', `${m.prefix}/api/version`);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).server).toBe('1.10.3');
    });

    it('GET /api/version with the right key is 200 (a slicer\'s "Test connection")', async () => {
      const r = await send(m.port(), 'GET', `${m.prefix}/api/version`, { 'X-Api-Key': KEY });
      expect(r.status).toBe(200);
    });

    it.each(['/api/printer/tool', '/api/printer/bed', '/api/job', '/api/files', '/api/connection'])(
      'GET %s is open with no key',
      async (path) => {
        const r = await send(m.port(), 'GET', m.prefix + path);
        expect(r.status).toBe(200);
      },
    );
  });

  describe('compat answers stay truthful (ELEG-26)', () => {
    it('/api/settings reports api.enabled: true with the key set, and never the key', async () => {
      const r = await send(m.port(), 'GET', `${m.prefix}/api/settings`, { 'X-Api-Key': KEY });
      expect(JSON.parse(r.body).api).toEqual({ enabled: true, key: null });
      expect(r.body).not.toContain(KEY);
    });

    it('/api/settings reports api.enabled: false with the key unset', async () => {
      setKey('');
      const r = await send(m.port(), 'GET', `${m.prefix}/api/settings`);
      expect(JSON.parse(r.body).api).toEqual({ enabled: false, key: null });
    });

    it('/api/currentuser is a guest with the key set and none presented', async () => {
      const r = await send(m.port(), 'GET', `${m.prefix}/api/currentuser`);
      const u = JSON.parse(r.body);
      expect(u.admin).toBe(false);
      expect(u.name).toBeNull();
      expect(u.groups).toEqual(['guests']);
    });

    it('/api/currentuser is admin with the right key', async () => {
      const r = await send(m.port(), 'GET', `${m.prefix}/api/currentuser`, { 'X-Api-Key': KEY });
      expect(JSON.parse(r.body).admin).toBe(true);
    });

    it('/api/currentuser is admin with the key unset, because every caller is', async () => {
      setKey('');
      const r = await send(m.port(), 'GET', `${m.prefix}/api/currentuser`);
      expect(JSON.parse(r.body).admin).toBe(true);
    });

    it('POST /api/login with no key is open, and answers an inactive guest (OctoPrint exempts Login)', async () => {
      const r = await send(
        m.port(),
        'POST',
        `${m.prefix}/api/login`,
        JSON_HEADERS,
        '{"passive":true}',
      );
      expect(bridge.sendCommand).not.toHaveBeenCalled();
      expect(r.status).toBe(200);
      const u = JSON.parse(r.body);
      expect(u.admin).toBe(false);
      expect(u.active).toBe(false);
      expect(u.groups).toEqual(['guests']);
      expect(u._login_mechanism).toBeNull();
    });

    it('POST /api/login with a wrong key is 403', async () => {
      const r = await send(
        m.port(),
        'POST',
        `${m.prefix}/api/login`,
        { ...JSON_HEADERS, 'X-Api-Key': WRONG },
        '{"passive":true}',
      );
      expect(r.status).toBe(403);
      expect(r.body).not.toContain(WRONG);
    });

    it('POST /api/login with the right key names apikey as the mechanism, and never returns the key', async () => {
      const r = await send(
        m.port(),
        'POST',
        `${m.prefix}/api/login`,
        { ...JSON_HEADERS, 'X-Api-Key': KEY },
        '{"passive":true}',
      );
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)._login_mechanism).toBe('apikey');
      expect(r.body).not.toContain(KEY);
    });

    it('POST /api/login with the key unset answers with no login mechanism', async () => {
      setKey('');
      const r = await send(m.port(), 'POST', `${m.prefix}/api/login`, JSON_HEADERS, '{}');
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)._login_mechanism).toBeNull();
    });
  });

  /**
   * Every write the router knows, pinned — plus routes it does NOT handle. The gate is
   * default-deny by method (anything but GET/HEAD needs the key, except the one open
   * `POST /api/login` stub), so `POST /api/files/local` (the slicer upload, which this
   * router does not implement yet) and an invented route are refused too: a write route
   * added later cannot slip through.
   */
  const GATED: Array<[string, string]> = [
    ['POST', '/api/printer/tool'],
    ['POST', '/api/printer/bed'],
    ['POST', '/api/printer/printhead'],
    ['POST', '/api/job'],
    ['POST', '/api/files/local'],
    ['POST', '/api/connection'],
    ['DELETE', '/api/job'],
    ['PUT', '/api/printer/bed'],
    ['PATCH', '/api/settings'],
    ['POST', '/api/some-future-route'],
  ];

  describe('every gated route', () => {
    it.each(GATED)('%s %s is 403 with no key and touches nothing', async (method, path) => {
      const body = JSON.stringify({ command: 'target', target: 60, targets: { tool0: 200 } });
      const r = await send(m.port(), method, m.prefix + path, JSON_HEADERS, body);
      expect(bridge.sendCommand).not.toHaveBeenCalled();
      expect(r.status).toBe(403);
    });

    it.each(GATED)('%s %s is 403 with a wrong key', async (method, path) => {
      const r = await send(m.port(), method, m.prefix + path, { 'X-Api-Key': WRONG }, '{}');
      expect(r.status).toBe(403);
    });

    it.each(GATED)('%s %s is not refused by the gate with the right key', async (method, path) => {
      const r = await send(
        m.port(),
        method,
        m.prefix + path,
        { ...JSON_HEADERS, 'X-Api-Key': KEY },
        '{}',
      );
      expect(r.status).not.toBe(403);
    });
  });
});

// ── the print guard (ELEG-176) ─────────────────────────────────────────────

const job = (code: number) => ({ machine_status: { status: code } }) as unknown as PrinterStatus;
const KEYED = { ...JSON_HEADERS, 'X-Api-Key': KEY };

/**
 * [path, body, what the refusal names, the exact command sent when idle] — each refused
 * while printing. The idle command pins the SPA's param shape (ELEG-180).
 */
const REFUSED_MID_PRINT: Array<[string, object, string, [number, object]]> = [
  [
    '/api/printer/printhead',
    { command: 'jog', z: 0.1 },
    'moving the toolhead',
    [1027, { axes: 'z', distance: 0.1 }],
  ],
  [
    '/api/printer/printhead',
    { command: 'home', axes: ['x', 'y'] },
    'homing',
    [1026, { homed_axes: 'xy' }],
  ],
  [
    '/api/printer/bed',
    { command: 'target', target: 0 },
    'turning a heater off',
    [1028, { heater_bed: 0 }],
  ],
  [
    '/api/printer/tool',
    { command: 'target', targets: { tool0: 0 } },
    'turning a heater off',
    [1028, { extruder: 0 }],
  ],
  [
    '/api/printer/tool',
    { command: 'target', targets: { tool0: 150 } },
    'below 170',
    [1028, { extruder: 150 }],
  ],
];

describe.each(MOUNTS)('the print guard through $mount', (m) => {
  it.each(REFUSED_MID_PRINT)(
    'while printing, POST %s %j is 409 and sends nothing',
    async (path, body, what) => {
      store.status = job(2);
      const r = await send(m.port(), 'POST', m.prefix + path, KEYED, JSON.stringify(body));
      expect(r.status).toBe(409);
      const error: string = JSON.parse(r.body).error;
      expect(error).toContain('busy printing');
      expect(error).toContain(what);
      expect(bridge.sendCommand).not.toHaveBeenCalled();
    },
  );

  it.each(REFUSED_MID_PRINT)(
    'idle control: POST %s %j is 204 and sent once, in the SPA shape',
    async (path, body, _what, command) => {
      store.status = job(1);
      const r = await send(m.port(), 'POST', m.prefix + path, KEYED, JSON.stringify(body));
      expect(r.status).toBe(204);
      expect(bridge.sendCommand.mock.calls).toEqual([command]);
    },
  );

  it('idle: a multi-axis jog is one 1027 per non-zero axis, in x/y/z order, speed dropped', async () => {
    store.status = job(1);
    const body = { command: 'jog', z: -2, x: 10, y: 0, speed: 1200 };
    const r = await send(
      m.port(),
      'POST',
      `${m.prefix}/api/printer/printhead`,
      KEYED,
      JSON.stringify(body),
    );
    expect(r.status).toBe(204);
    expect(bridge.sendCommand.mock.calls).toEqual([
      [1027, { axes: 'x', distance: 10 }],
      [1027, { axes: 'z', distance: -2 }],
    ]);
  });

  it('while printing, a multi-axis jog is 409 and sends no axis at all', async () => {
    store.status = job(2);
    const body = { command: 'jog', x: 10, y: 5 };
    const r = await send(
      m.port(),
      'POST',
      `${m.prefix}/api/printer/printhead`,
      KEYED,
      JSON.stringify(body),
    );
    expect(r.status).toBe(409);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('an absolute jog is 400 and sends nothing (coordinates are not distances)', async () => {
    store.status = job(1);
    const body = { command: 'jog', x: 100, absolute: true };
    const r = await send(
      m.port(),
      'POST',
      `${m.prefix}/api/printer/printhead`,
      KEYED,
      JSON.stringify(body),
    );
    expect(r.status).toBe(400);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('idle: home with no axes homes xyz', async () => {
    store.status = job(1);
    const body = { command: 'home' };
    const r = await send(
      m.port(),
      'POST',
      `${m.prefix}/api/printer/printhead`,
      KEYED,
      JSON.stringify(body),
    );
    expect(r.status).toBe(204);
    expect(bridge.sendCommand.mock.calls).toEqual([[1026, { homed_axes: 'xyz' }]]);
  });

  it('idle: home axes are lower-cased, de-duplicated and put in x/y/z order', async () => {
    store.status = job(1);
    const body = { command: 'home', axes: ['Z', 'x', 'z'] };
    const r = await send(
      m.port(),
      'POST',
      `${m.prefix}/api/printer/printhead`,
      KEYED,
      JSON.stringify(body),
    );
    expect(r.status).toBe(204);
    expect(bridge.sendCommand.mock.calls).toEqual([[1026, { homed_axes: 'xz' }]]);
  });

  it('home naming no real axis is 400 and homes nothing', async () => {
    store.status = job(1);
    const body = { command: 'home', axes: ['e'] };
    const r = await send(
      m.port(),
      'POST',
      `${m.prefix}/api/printer/printhead`,
      KEYED,
      JSON.stringify(body),
    );
    expect(r.status).toBe(400);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/printer/bed', { command: 'target', target: '60' }],
    ['/api/printer/tool', { command: 'target', targets: { tool0: 'hot' } }],
  ])('idle: POST %s %j with a non-number target is 400 and sends nothing', async (path, body) => {
    store.status = job(1);
    const r = await send(m.port(), 'POST', m.prefix + path, KEYED, JSON.stringify(body));
    expect(r.status).toBe(400);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/printer/bed', { command: 'target', target: 60 }, [1028, { heater_bed: 60 }]],
    [
      '/api/printer/tool',
      { command: 'target', targets: { tool0: 215 } },
      [1028, { extruder: 215 }],
    ],
  ])('mid-print allow: POST %s %j is 204 and sent', async (path, body, command) => {
    store.status = job(2);
    const r = await send(m.port(), 'POST', m.prefix + path, KEYED, JSON.stringify(body));
    expect(r.status).toBe(204);
    expect(bridge.sendCommand.mock.calls).toEqual([command]);
  });
});
