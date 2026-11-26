/**
 * ELEG-140: `/ws` command frames are gated per method behind SERVICE_API_KEY, through the
 * real `WebSocketTransport` on an ephemeral port. No printer, no MQTT, nothing imported
 * from index.ts: the bridge and store are fakes, and `bridge.sendCommand` is the spy that
 * says whether a frame reached the printer.
 *
 * **Every observation is ordered by a fence.** A forwarded command has no reply of its
 * own, and a test that waited for `command_refused` would die on a timeout — not on an
 * assertion — the moment the gate was removed. So each case sends its frames, then
 * `fence()`: it re-sends the connection's last auth frame (same key, so the same outcome
 * and no change of state) and waits for that frame's `auth_result`. Frames on one socket
 * are handled in order, so by then every earlier frame has been decided, and the spy
 * assertion that follows is meaningful in both directions.
 */
import { EventEmitter } from 'events';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { StateStore } from '../state-store.js';
import { DENIED_BY_DEFAULT, READ_METHODS, isReadMethod } from '../method-policy.js';
import { WebSocketTransport } from '../ws-transport.js';

const KEY = 'w'.repeat(16) + '0123456789abcdef0123'; // 36 chars, generated, not a real key
const WRONG = 'x'.repeat(36);

// ── fakes ──────────────────────────────────────────────────────────────────

const bridge = Object.assign(new EventEmitter(), {
  isConnected: true,
  brokerConnected: true,
  phase: 'registered',
  registerAttempts: 1,
  serialNumber: 'TESTSN',
  ip: '192.0.2.10',
  sendCommand: vi.fn(),
});

const store = Object.assign(new EventEmitter(), {
  attributes: {},
  // `unknown`, not `{}`: the print-guard cases below set a job status per test.
  status: {} as unknown,
  canvas: {},
  files: [],
  thumbnail: null,
  thumbnailFailed: false,
  fileTotalLayers: 0,
  timelapseList: [],
  videoUrl: null,
  zones: null,
  layerTimes: [],
  getFilamentUsageArray: () => [],
  getChartHistory: () => [],
  getAIChartHistory: () => [],
  getEventLog: () => [],
});

const auth = { serviceApiKey: KEY, cameraEnabled: false };

// ── the server ─────────────────────────────────────────────────────────────

let server: Server;
let transport: WebSocketTransport;
let port: number;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  server = createServer();
  transport = new WebSocketTransport(
    server,
    store as unknown as StateStore,
    bridge as unknown as MqttBridge,
    auth,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  transport.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.serviceApiKey = KEY;
  store.status = {}; // no job: every case above relies on the guard staying out of the way
});

// ── a client ───────────────────────────────────────────────────────────────

type Msg = Record<string, unknown>;

interface Client {
  /** Every message received, in order. */
  messages: Msg[];
  send(frame: Msg): void;
  /** Resolves once every frame sent before it has been decided (see the header). */
  fence(): Promise<void>;
  refusals(): Msg[];
  /** `auth_result`s, excluding the fences' own. */
  authResults(): Msg[];
}

async function connectClient(headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  sockets.push(ws);
  const messages: Msg[] = [];
  const waiters: Array<() => void> = [];
  // Attached before `open`, so `init` (sent on connect) is not missed.
  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()) as Msg);
    for (const w of waiters.splice(0)) w();
  });
  const until = (pred: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer from the server')), 3000);
      const check = () => {
        if (pred()) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  const results = () => messages.filter((m) => m.type === 'auth_result');

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await until(() => messages.some((m) => m.type === 'init'));

  // The key this connection last presented, as sent: re-presenting it is state-neutral.
  const headerKey = headers.Authorization?.replace(/^Bearer /, '') ?? headers['X-Api-Key'];
  let lastKey: unknown = headerKey ?? '';
  // An upgrade-header key is answered right after init; wait so cases start clean.
  if (headerKey !== undefined) await until(() => results().length > 0);

  let fences = 0;
  return {
    messages,
    send(frame) {
      if (frame.type === 'auth') lastKey = frame.key;
      ws.send(JSON.stringify(frame));
    },
    async fence() {
      const before = results().length;
      fences += 1;
      ws.send(JSON.stringify({ type: 'auth', key: lastKey }));
      await until(() => results().length > before);
    },
    refusals: () => messages.filter((m) => m.type === 'command_refused'),
    authResults: () => results().slice(0, results().length - fences),
  };
}

const command = (method: unknown, params: Msg = {}): Msg => ({ type: 'command', method, params });

const forwarded = () => bridge.sendCommand.mock.calls;

// ── the issue's proof list ─────────────────────────────────────────────────

describe('an unauthorised connection', () => {
  it.each([
    [1007, 'EmergencyStop'],
    [1049, 'UpdateToken: writes the printer auth token'],
  ])('method %i (%s) is refused, and never reaches the bridge', async (method) => {
    const c = await connectClient();
    c.send(command(method));
    await c.fence();
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(c.refusals()).toEqual([
      { type: 'command_refused', method, code: 'auth', reason: 'API key required' },
    ]);
  });

  it('an allowlisted read (1002) is forwarded without auth', async () => {
    const c = await connectClient();
    c.send(command(1002));
    await c.fence();
    expect(forwarded()).toEqual([[1002, {}]]);
    expect(c.refusals()).toEqual([]);
  });

  it('a wrong-key auth frame answers ok:false and leaves the connection unauthorised', async () => {
    const c = await connectClient();
    c.send({ type: 'auth', key: WRONG });
    c.send(command(1007));
    await c.fence();
    expect(c.authResults()).toEqual([{ type: 'auth_result', ok: false }]);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(c.refusals()).toEqual([
      { type: 'command_refused', method: 1007, code: 'auth', reason: 'API key required' },
    ]);
  });

  it('a wrong-key connection can still read (a wrong key is not a ban)', async () => {
    const c = await connectClient();
    c.send({ type: 'auth', key: WRONG });
    c.send(command(1044, { storage_media: 'local' }));
    await c.fence();
    expect(forwarded()).toEqual([[1044, { storage_media: 'local' }]]);
  });

  it.each([
    ['an empty key', ''],
    ['the key with a trailing space', `${KEY} `],
    ['a number', 12345],
    ['no key field at all', undefined],
  ])('an auth frame with %s is ok:false', async (_label, key) => {
    const c = await connectClient();
    c.send({ type: 'auth', key });
    c.send(command(1007));
    await c.fence();
    expect(c.authResults()).toEqual([{ type: 'auth_result', ok: false }]);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });
});

describe('an authorised connection', () => {
  it('after a correct auth frame, 1007 and 1049 are both forwarded', async () => {
    const c = await connectClient();
    c.send({ type: 'auth', key: KEY });
    c.send(command(1007));
    c.send(command(1049, { token: 'generated' }));
    await c.fence();
    expect(c.authResults()).toEqual([{ type: 'auth_result', ok: true }]);
    expect(forwarded()).toEqual([
      [1007, {}],
      [1049, { token: 'generated' }],
    ]);
    expect(c.refusals()).toEqual([]);
  });

  it.each([
    ['Authorization: Bearer', { Authorization: `Bearer ${KEY}` }],
    ['X-Api-Key', { 'X-Api-Key': KEY }],
  ])('the key on the upgrade request (%s) authorises the connection', async (_l, headers) => {
    const c = await connectClient(headers);
    expect(c.authResults()).toEqual([{ type: 'auth_result', ok: true }]);
    c.send(command(1007));
    await c.fence();
    expect(forwarded()).toEqual([[1007, {}]]);
  });

  it('a wrong key on the upgrade request answers ok:false and stays unauthorised', async () => {
    const c = await connectClient({ 'X-Api-Key': WRONG });
    expect(c.authResults()).toEqual([{ type: 'auth_result', ok: false }]);
    c.send(command(1007));
    await c.fence();
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('a later empty auth frame revokes it (what Settings → Clear sends)', async () => {
    const c = await connectClient();
    c.send({ type: 'auth', key: KEY });
    c.send({ type: 'auth', key: '' });
    c.send(command(1007));
    await c.fence();
    expect(c.authResults()).toEqual([
      { type: 'auth_result', ok: true },
      { type: 'auth_result', ok: false },
    ]);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('a later wrong auth frame revokes it too', async () => {
    const c = await connectClient();
    c.send({ type: 'auth', key: KEY });
    c.send({ type: 'auth', key: WRONG });
    c.send(command(1007));
    await c.fence();
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('authorising one connection does not authorise another', async () => {
    const a = await connectClient();
    const b = await connectClient();
    a.send({ type: 'auth', key: KEY });
    await a.fence();
    b.send(command(1007));
    await b.fence();
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(b.refusals()).toHaveLength(1);
  });
});

describe('nothing leaks', () => {
  it('no reply ever carries the key, right or wrong, or the refused params', async () => {
    const c = await connectClient();
    c.send({ type: 'auth', key: WRONG });
    c.send({ type: 'auth', key: KEY });
    c.send(command(1007, { secret: 'param-value' }));
    c.send({ type: 'auth', key: '' });
    c.send(command(1007, { secret: 'param-value' }));
    await c.fence();
    expect(c.refusals()).toHaveLength(1);
    const wire = JSON.stringify(c.messages);
    expect(wire).not.toContain(KEY);
    expect(wire).not.toContain(WRONG);
    expect(wire).not.toContain('param-value');
  });
});

describe('SERVICE_API_KEY unset (intentional: fail-open on upgrade, as on /api/*)', () => {
  it('every frame is forwarded, with no auth at all', async () => {
    auth.serviceApiKey = '';
    const c = await connectClient();
    c.send(command(1007));
    c.send(command(1049));
    c.send(command(2006));
    await c.fence();
    expect(forwarded()).toEqual([
      [1007, {}],
      [1049, {}],
      [2006, {}],
    ]);
    expect(c.refusals()).toEqual([]);
  });
});

describe('frames that are not commands', () => {
  it('a command with a non-numeric method is dropped, even when authorised', async () => {
    const c = await connectClient();
    c.send({ type: 'auth', key: KEY });
    c.send(command('1007'));
    await c.fence();
    expect(forwarded()).toEqual([]);
  });
});

// ── the print guard (ELEG-176) ─────────────────────────────────────────────

const job = (code: number) => ({ machine_status: { status: code } });

/** [method, params, what the refusal names] — each refused while printing. */
const WS_REFUSED_MID_PRINT: Array<[number, Record<string, unknown>, string]> = [
  [1026, { homed_axes: 'xyz' }, 'homing'],
  [1027, { axes: 'z', distance: 1 }, 'moving the toolhead'],
  [1028, { heater_bed: 0 }, 'turning a heater off'],
  [2001, {}, 'loading a tray'],
];

describe('the print guard on an authorised connection', () => {
  it.each(WS_REFUSED_MID_PRINT)(
    'while printing, %i is refused with code "busy" and never reaches the bridge',
    async (method, params, what) => {
      store.status = job(2);
      const c = await connectClient();
      c.send({ type: 'auth', key: KEY });
      c.send(command(method, params));
      await c.fence();
      expect(bridge.sendCommand).not.toHaveBeenCalled();
      const refusals = c.refusals();
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ type: 'command_refused', method, code: 'busy' });
      expect(refusals[0].reason).toContain(what);
      expect(refusals[0].reason).toContain('busy printing');
    },
  );

  it.each(WS_REFUSED_MID_PRINT)(
    'idle control: %i is forwarded when no job is active',
    async (method, params) => {
      store.status = job(1);
      const c = await connectClient();
      c.send({ type: 'auth', key: KEY });
      c.send(command(method, params));
      await c.fence();
      expect(forwarded()).toEqual([[method, params]]);
      expect(c.refusals()).toEqual([]);
    },
  );

  it('mid-print allow: pause, a fan, and a safe temperature change still go through', async () => {
    store.status = job(2);
    const c = await connectClient();
    c.send({ type: 'auth', key: KEY });
    c.send(command(1021));
    c.send(command(1030, { fan: 128 }));
    c.send(command(1028, { extruder: 215, heater_bed: 60 }));
    await c.fence();
    expect(forwarded()).toEqual([
      [1021, {}],
      [1030, { fan: 128 }],
      [1028, { extruder: 215, heater_bed: 60 }],
    ]);
    expect(c.refusals()).toEqual([]);
  });

  it('power-loss recovery (15) counts as a job', async () => {
    store.status = job(15);
    const c = await connectClient();
    c.send({ type: 'auth', key: KEY });
    c.send(command(1026));
    await c.fence();
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(c.refusals()).toMatchObject([{ code: 'busy', method: 1026 }]);
  });

  it('auth is decided first: an unauthorised connection mid-print gets code "auth"', async () => {
    store.status = job(2);
    const c = await connectClient();
    c.send(command(1026));
    await c.fence();
    expect(c.refusals()).toEqual([
      { type: 'command_refused', method: 1026, code: 'auth', reason: 'API key required' },
    ]);
  });
});

// ── the allowlist, pinned ──────────────────────────────────────────────────

/**
 * Adding a method to the read allowlist must be a visible diff here, with its evidence in
 * `method-policy.ts`. Every method NOT in this table is gated.
 */
const EXPECTED_READS = [1002, 1036, 1044, 1045, 1046, 1048, 2005];

describe('the read allowlist', () => {
  it('is exactly the proven reads', () => {
    expect([...READ_METHODS.keys()].sort((a, b) => a - b)).toEqual(EXPECTED_READS);
  });

  it('every entry records its evidence and its tier', () => {
    for (const [, evidence] of READ_METHODS) expect(evidence).toMatch(/^[ABC]: .{40,}/);
  });

  it('2006 and 1051 are deliberately denied, with the reason recorded', () => {
    expect([...DENIED_BY_DEFAULT.keys()].sort((a, b) => a - b)).toEqual([1051, 2006]);
    for (const m of DENIED_BY_DEFAULT.keys()) expect(isReadMethod(m)).toBe(false);
  });

  // Every write the SPA, /mcp and the compat layers send: none may ever be on the list.
  it.each([
    1007, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1032, 1033, 1034,
    1035, 1038, 1039, 1043, 1047, 1049, 1051, 1054, 1063, 2001, 2002, 2003, 2004, 2007,
  ])('write %i is not a read', (m) => {
    expect(isReadMethod(m)).toBe(false);
  });

  it.each(EXPECTED_READS)('read %i is forwarded on an unauthorised connection', async (m) => {
    const c = await connectClient();
    c.send(command(m));
    await c.fence();
    expect(forwarded()).toEqual([[m, {}]]);
  });

  it('2006 (unproven) is refused on an unauthorised connection', async () => {
    const c = await connectClient();
    c.send(command(2006));
    await c.fence();
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(c.refusals()).toEqual([
      { type: 'command_refused', method: 2006, code: 'auth', reason: 'API key required' },
    ]);
  });
});
