/**
 * ELEG-142, WebSocket half: Moonraker JSON-RPC writes are gated behind SERVICE_API_KEY on
 * **both** `:7125` WebSockets — `/websocket` and the catch-all upgrade (`/`, `/klippy`, …).
 * This is where KlipperScreen, Fluidd and Mainsail actually send their writes. The HTTP
 * half is in `moonraker-http-auth.test.ts`, deliberately a separate file (see there).
 *
 * The real `MoonrakerServer` on an ephemeral port; no printer, no MQTT, nothing from
 * index.ts. `bridge.sendCommand` is the spy that says whether a call reached the printer.
 *
 * Every call here carries an id and the dispatcher answers every id — result or error —
 * so each case awaits *the reply to its own id*, never "an error". With the gate removed a
 * case therefore fails on its assertion, not on a timeout.
 */
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ServiceConfig } from '../config.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { StateStore } from '../state-store.js';
import { NO_API_KEY_MESSAGE } from '../compat-auth.js';
import { RPC_GATED, RPC_OPEN, classifyRpc } from '../moonraker-auth.js';
import { MoonrakerServer } from '../moonraker-server.js';

const KEY = 'k'.repeat(16) + '0123456789abcdef0123'; // 36 chars, generated, not a real key
const WRONG = 'q'.repeat(36);

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

const dataDir = mkdtempSync(join(tmpdir(), 'eleg142-ws-'));
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

// ── the server ─────────────────────────────────────────────────────────────

let moonraker: MoonrakerServer;
let port = 0;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  moonraker = new MoonrakerServer(
    store as unknown as StateStore,
    bridge as unknown as MqttBridge,
    config,
  );
  const http = (moonraker as unknown as { httpServer: Server }).httpServer;
  const listening = new Promise<void>((resolve) => http.once('listening', () => resolve()));
  moonraker.start();
  await listening;
  port = (http.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  moonraker.stop(); // starts a final async save of moonraker-db.json
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  setKey(KEY);
  store.status = null; // no job: the auth cases rely on the print guard failing open
});

// ── a JSON-RPC client ──────────────────────────────────────────────────────

type Reply = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

interface Client {
  call(method: string, params?: Record<string, unknown>): Promise<Reply>;
  /** Every frame received, for the no-leak check. */
  wire: string[];
}

let nextId = 1;

async function connect(path: string, headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  sockets.push(ws);
  const wire: string[] = [];
  const pending = new Map<number, (r: Reply) => void>();
  ws.on('message', (raw) => {
    const text = raw.toString();
    wire.push(text);
    const msg = JSON.parse(text) as Reply;
    if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    wire,
    call(method, params = {}) {
      const id = nextId++;
      return new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 3000);
        pending.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
      });
    },
  };
}

const UNAUTHORIZED = { code: 401, message: 'Unauthorized' };

// ── the issue's proof list, per WebSocket ──────────────────────────────────

describe.each([
  ['/websocket', '/websocket'],
  ['the catch-all upgrade', '/'],
  ['the catch-all upgrade', '/klippy'],
])('JSON-RPC on %s (%s)', (_label, path) => {
  it('printer.emergency_stop with no key is 401 and never reaches the bridge', async () => {
    const c = await connect(path);
    const r = await c.call('printer.emergency_stop');
    expect(r.error).toEqual(UNAUTHORIZED);
    expect(r.result).toBeUndefined();
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('after identify with the right api_key, printer.emergency_stop is forwarded', async () => {
    const c = await connect(path);
    const id = await c.call('server.connection.identify', {
      client_name: 'KlipperScreen',
      version: 'test',
      type: 'display',
      url: 'test',
      api_key: KEY,
    });
    expect(id.result).toHaveProperty('connection_id');
    const r = await c.call('printer.emergency_stop');
    expect(r.result).toBe('ok');
    expect(bridge.sendCommand.mock.calls).toEqual([[1022, {}]]);
  });

  it('identify with a wrong api_key is 401, and writes stay refused', async () => {
    const c = await connect(path);
    const id = await c.call('server.connection.identify', { client_name: 'x', api_key: WRONG });
    expect(id.error).toEqual(UNAUTHORIZED);
    const r = await c.call('printer.emergency_stop');
    expect(r.error).toEqual(UNAUTHORIZED);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty string', ''],
    ['a number', 12345],
    ['null', null],
  ])('identify with api_key = %s is 401', async (_l, apiKey) => {
    const c = await connect(path);
    const id = await c.call('server.connection.identify', { client_name: 'x', api_key: apiKey });
    expect(id.error).toEqual(UNAUTHORIZED);
    expect((await c.call('printer.emergency_stop')).error).toEqual(UNAUTHORIZED);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('a later wrong identify revokes an earlier right one', async () => {
    const c = await connect(path);
    await c.call('server.connection.identify', { client_name: 'x', api_key: KEY });
    await c.call('server.connection.identify', { client_name: 'x', api_key: WRONG });
    expect((await c.call('printer.emergency_stop')).error).toEqual(UNAUTHORIZED);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('identify with no api_key (Mainsail, Fluidd) succeeds anonymously and can read', async () => {
    const c = await connect(path);
    const id = await c.call('server.connection.identify', { client_name: 'mainsail' });
    expect(id.result).toHaveProperty('connection_id');
    expect(
      (await c.call('printer.objects.query', { objects: { extruder: null } })).result,
    ).toHaveProperty('status.extruder');
    expect((await c.call('printer.emergency_stop')).error).toEqual(UNAUTHORIZED);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('printer.objects.query and printer.objects.subscribe work with no key', async () => {
    const c = await connect(path);
    const q = await c.call('printer.objects.query', { objects: { heater_bed: null } });
    expect(q.error).toBeUndefined();
    expect(q.result).toHaveProperty('status.heater_bed');
    const s = await c.call('printer.objects.subscribe', { objects: { extruder: null } });
    expect(s.error).toBeUndefined();
    expect(s.result).toHaveProperty('status.extruder');
  });

  it('identify with non-object params is answered, and the server keeps answering', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(ws);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    const reply = new Promise<Reply>((resolve) =>
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Reply;
        if (m.id === 424242) resolve(m);
      }),
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'server.connection.identify',
        params: 'x',
        id: 424242,
      }),
    );
    expect((await reply).result).toHaveProperty('connection_id');
    const c = await connect(path);
    expect((await c.call('server.info')).result).toHaveProperty('moonraker_version');
  });

  it('a wrong key is not a ban: the connection can still read', async () => {
    const c = await connect(path);
    await c.call('server.connection.identify', { client_name: 'x', api_key: WRONG });
    expect((await c.call('server.info')).result).toHaveProperty('moonraker_version');
  });

  it.each([
    ['X-Api-Key', { 'X-Api-Key': KEY }],
    ['Authorization: Bearer', { Authorization: `Bearer ${KEY}` }],
  ])('the key on the upgrade request (%s) authorises the connection', async (_l, headers) => {
    const c = await connect(path, headers);
    expect((await c.call('printer.emergency_stop')).result).toBe('ok');
    expect(bridge.sendCommand.mock.calls).toEqual([[1022, {}]]);
  });

  it('a wrong key on the upgrade request leaves the connection unauthorised', async () => {
    const c = await connect(path, { 'X-Api-Key': WRONG });
    expect((await c.call('printer.emergency_stop')).error).toEqual(UNAUTHORIZED);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('authorising one connection does not authorise another', async () => {
    const a = await connect(path);
    const b = await connect(path);
    await a.call('server.connection.identify', { client_name: 'x', api_key: KEY });
    expect((await b.call('printer.emergency_stop')).error).toEqual(UNAUTHORIZED);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('server.database.* is open, except writes to the webcams namespace', async () => {
    const c = await connect(path);
    const ok = await c.call('server.database.post_item', {
      namespace: 'mainsail',
      key: 'general.locale',
      value: 'en',
    });
    expect(ok.error).toBeUndefined();
    expect(
      (await c.call('server.database.get_item', { namespace: 'mainsail' })).error,
    ).toBeUndefined();
    for (const method of ['server.database.post_item', 'server.database.delete_item']) {
      const r = await c.call(method, { namespace: 'webcams', key: 'default', value: {} });
      expect(r.error, method).toEqual(UNAUTHORIZED);
    }
  });

  it('an unclassified method runs nothing: Method not found, key or no key', async () => {
    const c = await connect(path);
    await c.call('server.connection.identify', { client_name: 'x', api_key: KEY });
    const r = await c.call('server.spoolman.post_spool_id', { spool_id: 1 });
    expect(r.error?.code).toBe(-32601);
    // Prototype names must not slip through an object lookup.
    expect((await c.call('constructor')).error?.code).toBe(-32601);
  });

  it('with SERVICE_API_KEY unset, writes are open (intentional, as on /api/*)', async () => {
    setKey('');
    const c = await connect(path);
    expect((await c.call('printer.emergency_stop')).result).toBe('ok');
    expect(bridge.sendCommand.mock.calls).toEqual([[1022, {}]]);
  });

  it('access.info keeps login_required: false; access.get_api_key never returns the key', async () => {
    const c = await connect(path);
    await c.call('server.connection.identify', { client_name: 'x', api_key: KEY });
    const info = await c.call('access.info');
    expect((info.result as { login_required: boolean }).login_required).toBe(false);
    const k = await c.call('access.get_api_key');
    expect(k.result).toBeUndefined();
    expect(k.error?.message).toBe(NO_API_KEY_MESSAGE);
  });

  it('no frame ever carries the key, right or wrong', async () => {
    const c = await connect(path);
    await c.call('server.connection.identify', { client_name: 'x', api_key: WRONG });
    await c.call('printer.emergency_stop');
    await c.call('server.connection.identify', { client_name: 'x', api_key: KEY });
    await c.call('printer.emergency_stop');
    await c.call('access.get_api_key');
    await c.call('access.post_api_key');
    const all = c.wire.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(WRONG);
  });
});

// ── the gated table, pinned ────────────────────────────────────────────────

/** Adding to or removing from either table must be a visible diff here. */
const EXPECTED_GATED = [
  'machine.reboot',
  'machine.services.restart',
  'machine.services.start',
  'machine.services.stop',
  'machine.shutdown',
  'printer.emergency_stop',
  'printer.firmware_restart',
  'printer.gcode.script',
  'printer.print.cancel',
  'printer.print.pause',
  'printer.print.resume',
  'printer.print.start',
  'printer.restart',
  'server.announcements.delete_feed',
  'server.announcements.dismiss',
  'server.announcements.post_feed',
  'server.announcements.update',
  'server.files.copy',
  'server.files.delete_directory',
  'server.files.delete_file',
  'server.files.move',
  'server.files.post_directory',
  'server.history.delete_job',
  'server.history.reset_totals',
  'server.job_queue.delete_job',
  'server.job_queue.jump',
  'server.job_queue.pause',
  'server.job_queue.post_job',
  'server.job_queue.start',
  'server.logs.rollover',
  'server.restart',
  'server.webcams.delete_item',
  'server.webcams.post_item',
];

describe('the RPC tables', () => {
  it('the gated table is exactly this list', () => {
    expect([...RPC_GATED].sort()).toEqual(EXPECTED_GATED);
  });

  it('no method is in both tables', () => {
    for (const m of RPC_GATED) expect(RPC_OPEN.has(m), m).toBe(false);
  });

  it('every open method is a read, identify, access.* or server.database.*', () => {
    for (const m of RPC_OPEN) {
      const groupOpen =
        m === 'server.connection.identify' ||
        m.startsWith('access.') ||
        m.startsWith('server.database.');
      const looksLikeRead =
        /\.(info|config|list|list_feeds|query|subscribe|help|status|roots|metadata|metascan|thumbnails|get_directory|get_item|get_job|totals|temperature_store|gcode_store|system_info|proc_stats|id)$/.test(
          m,
        );
      expect(groupOpen || looksLikeRead, m).toBe(true);
    }
  });

  it('every case the dispatcher implements is classified, and nothing else is', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../moonraker-server.ts', import.meta.url)),
      'utf8',
    );
    const start = src.indexOf('private handleWsMessage(');
    const end = src.indexOf('private handleHttp(');
    const labels = [...src.slice(start, end).matchAll(/case '([^']+)':/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(70); // the slice found the dispatcher
    expect(new Set(labels)).toEqual(new Set([...RPC_OPEN, ...RPC_GATED]));
  });

  it('classifyRpc: gated, open, protected namespace, unknown', () => {
    expect(classifyRpc('printer.emergency_stop', {})).toBe('write');
    expect(classifyRpc('printer.objects.query', {})).toBe('read');
    expect(classifyRpc('server.database.post_item', { namespace: 'fluidd' })).toBe('read');
    expect(classifyRpc('server.database.post_item', { namespace: 'webcams' })).toBe('write');
    expect(classifyRpc('server.database.get_item', { namespace: 'webcams' })).toBe('read');
    expect(classifyRpc('toString', {})).toBe('unknown');
  });

  it.each(EXPECTED_GATED)('%s with no key is 401 on both WebSockets', async (method) => {
    for (const path of ['/websocket', '/']) {
      const c = await connect(path);
      const r = await c.call(method, { filename: 'a.gcode', script: 'G28', name: 'x' });
      expect(r.error, `${method} on ${path}`).toEqual(UNAUTHORIZED);
    }
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });
});

// ── the print guard (ELEG-176) ─────────────────────────────────────────────

describe('the print guard on printer.gcode.script', () => {
  const job = (code: number) => ({ machine_status: { status: code } });

  async function identified(): Promise<Client> {
    const c = await connect('/websocket');
    await c.call('server.connection.identify', { client_name: 'x', api_key: KEY });
    return c;
  }

  /** The console lines a Mainsail/Fluidd would print, in order. */
  const consoleLines = (c: Client) =>
    c.wire
      .map((t) => JSON.parse(t) as { method?: string; params?: string[] })
      .filter((m) => m.method === 'notify_gcode_response')
      .map((m) => m.params?.[0]);

  it.each([
    ['G28', 'homing'],
    ['SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=0', 'turning a heater off'],
    ['TURN_OFF_HEATERS', 'turning a heater off'],
  ])(
    'while printing, %s is an rpc 409 with a "!!" console line, and sends nothing',
    async (gcode, what) => {
      store.status = job(2);
      const c = await identified();
      const r = await c.call('printer.gcode.script', { script: gcode });
      expect(r.result).toBeUndefined();
      expect(r.error?.code).toBe(409);
      expect(r.error?.message).toContain('busy printing');
      expect(r.error?.message).toContain(what);
      const lines = consoleLines(c);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(`!! ${r.error?.message}`);
      expect(bridge.sendCommand).not.toHaveBeenCalled();
    },
  );

  it('idle control: G28 and TURN_OFF_HEATERS are forwarded and answered ok', async () => {
    store.status = job(1);
    const c = await identified();
    expect((await c.call('printer.gcode.script', { script: 'G28' })).result).toBe('ok');
    expect((await c.call('printer.gcode.script', { script: 'TURN_OFF_HEATERS' })).result).toBe(
      'ok',
    );
    expect(bridge.sendCommand.mock.calls).toEqual([
      [1026, { axes: ['x', 'y', 'z'] }],
      [1028, { extruder: 0 }],
      [1028, { heater_bed: 0 }],
    ]);
  });

  it('mid-print allow: M140 S60 and SET_HEATER_TEMPERATURE to 215 are forwarded', async () => {
    store.status = job(2);
    const c = await identified();
    expect((await c.call('printer.gcode.script', { script: 'M140 S60' })).result).toBe('ok');
    const set = await c.call('printer.gcode.script', {
      script: 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=215',
    });
    expect(set.result).toBe('ok');
    expect(bridge.sendCommand.mock.calls).toEqual([
      [1028, { heater_bed: 60 }],
      [1028, { extruder: 215 }],
    ]);
  });
});
