/**
 * ELEG-139: every `/api/*` write is gated behind SERVICE_API_KEY, through the real
 * router (`createRestRouter`) on an ephemeral port. No printer, no MQTT, nothing
 * imported from index.ts: the bridge, store and queue are fakes whose methods are spies,
 * and the printer upload's outbound `http.request` is mocked so its spy is both the
 * "never reached the printer" and the "did reach it" observation.
 *
 * Requests go over a raw socket rather than `fetch`, because `fetch` normalises header
 * values (it strips the trailing space one case below needs to send).
 *
 * Every refusal fixture is a request that SUCCEEDS with the right key — only the
 * credential differs — so "the spy was not called" is not vacuous. The spy assertion
 * comes before the status assertion: a guard that runs after the command would still
 * produce a 401, and the spy is what catches that.
 */
import { EventEmitter } from 'events';
import { createServer, type Server } from 'http';
import { connect, type AddressInfo } from 'net';
import { Readable } from 'stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceConfig } from '../server/config.js';
import type { MqttBridge } from '../server/mqtt-bridge.js';
import type { PrintQueue } from '../server/print-queue.js';
import type { StateStore } from '../server/state-store.js';

// The printer upload path calls `http.request` (imported as `httpRequest`) to PUT chunks
// to the printer. Mocked so no socket is opened, and so the call itself is observable.
const printerRequest = vi.hoisted(() => vi.fn());
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return { ...actual, default: { ...actual, request: printerRequest }, request: printerRequest };
});

const { createRestRouter } = await import('../server/rest-api.js');
const { handlePresetsRequest } = await import('../server/connection-presets.js');

const KEY = 'k'.repeat(16) + '0123456789abcdef0123'; // 36 chars, generated, not a real key
const WRONG = 'x'.repeat(36);

// ── fakes ──────────────────────────────────────────────────────────────────

const bridge = {
  isConnected: true,
  brokerConnected: true,
  phase: 'registered',
  registerAttempts: 1,
  serialNumber: 'TESTSN',
  ip: '192.0.2.10',
  sendCommand: vi.fn(),
  enableVideoStreamSDCP: vi.fn(async () => ({ success: true })),
  enableVideoStreamMQTT: vi.fn(),
};

const store = {
  attributes: {},
  status: {},
  canvas: {},
  files: [],
  layerTimes: [],
  fileTotalLayers: 0,
  getFilamentUsageArray: () => [],
  clearLayerData: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

const queue = {
  snapshot: vi.fn(() => ({ items: [] })),
  add: vi.fn(() => ({ ok: true, item: { id: 'a' } })),
  remove: vi.fn(() => true),
  move: vi.fn(() => true),
  clear: vi.fn(),
  resume: vi.fn(),
  startNext: vi.fn(() => ({ ok: true, item: { id: 'a' } })),
};

const presets = {
  list: vi.fn(() => []),
  add: vi.fn(() => ({ id: 'p1' })),
  remove: vi.fn(),
};
const presetsDeps = { writable: true };

const config = {
  printerIp: '192.0.2.10',
  printerPassword: 'x',
  cameraEnabled: false,
  cameraUrl: 'http://192.0.2.10:8080',
  corsPolicy: { kind: 'any' },
  serviceApiKey: KEY,
  telegramEnabled: false,
  telegramChatId: '',
  progressInterval: 25,
  aiEnabled: false,
  aiLocalEnabled: false,
  dataDir: './data',
} as unknown as ServiceConfig;

// ── the server ─────────────────────────────────────────────────────────────

let server: Server;
let port: number;

beforeAll(async () => {
  const router = createRestRouter(
    store as unknown as StateStore,
    config,
    null,
    null,
    bridge as unknown as MqttBridge,
    (req, res) =>
      handlePresetsRequest(req, res, {
        writable: presetsDeps.writable,
        presets: presets as never,
        bridge: { isConnected: true, retarget: vi.fn() },
        store: { status: null, resetForPrinterSwitch: vi.fn() },
      } as never),
    queue as unknown as PrintQueue,
  );
  server = createServer(router);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  (config as { serviceApiKey: string }).serviceApiKey = KEY;
  presetsDeps.writable = true;
  // A printer that accepts every chunk.
  printerRequest.mockImplementation((_opts: unknown, cb: (res: Readable) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      write: () => void;
      end: () => void;
      destroy: () => void;
    };
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => cb(Readable.from([Buffer.from('{"error_code":0}')])));
    return req;
  });
});

// ── a raw HTTP client ──────────────────────────────────────────────────────

interface Reply {
  status: number;
  head: string;
  body: string;
}

/** One request over a raw socket: header values go on the wire exactly as written. */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body: Buffer | string = '',
): Promise<Reply> {
  const payload = typeof body === 'string' ? Buffer.from(body) : body;
  // HTTP/1.0, so the response is never chunked and the body reads back as written.
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
      resolve({
        status,
        head: split >= 0 ? raw.slice(0, split) : raw,
        body: split >= 0 ? raw.slice(split + 4) : '',
      });
    });
    sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    sock.end(payload);
  });
}

const json = (o: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(o),
});

const BOUNDARY = 'elegooTestBoundary';
const uploadBody = Buffer.from(
  `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="test.bin"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n' +
    'hello printer\r\n' +
    `--${BOUNDARY}--\r\n`,
);

/**
 * The three writes the issue names, each with the spy that proves whether it reached
 * the printer (or the queue), and the status it answers when it does.
 */
const WRITES = [
  {
    name: 'POST /api/queue/start-next',
    method: 'POST',
    path: '/api/queue/start-next',
    ...json({ id: 'a', bedCleared: true }),
    effect: () => queue.startNext,
    okStatus: 202,
  },
  {
    name: 'POST /api/debug/videostream/sdcp',
    method: 'POST',
    path: '/api/debug/videostream/sdcp',
    headers: {},
    body: '',
    effect: () => bridge.enableVideoStreamSDCP,
    okStatus: 200,
  },
  {
    name: 'POST /api/files/upload',
    method: 'POST',
    path: '/api/files/upload?source=local',
    headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: uploadBody,
    effect: () => printerRequest,
    okStatus: 200,
  },
] as const;

const REFUSED_CREDENTIALS: Array<[string, Record<string, string>]> = [
  ['no header', {}],
  ['a wrong key (Bearer)', { Authorization: `Bearer ${WRONG}` }],
  ['a wrong key (X-Api-Key)', { 'X-Api-Key': WRONG }],
  ['Bearer with an empty value', { Authorization: 'Bearer ' }],
  ['an empty X-Api-Key', { 'X-Api-Key': '' }],
  ['the key with trailing content', { Authorization: `Bearer ${KEY} x` }],
  ['the key with a leading space', { Authorization: `Bearer  ${KEY}` }],
  ['the key in a Basic header', { Authorization: `Basic ${KEY}` }],
];

describe.each(WRITES)('$name', (w) => {
  it.each(REFUSED_CREDENTIALS)(
    'is refused with %s, and never reaches its target',
    async (_label, creds) => {
      const r = await send(w.method, w.path, { ...w.headers, ...creds }, w.body);
      expect(w.effect()).not.toHaveBeenCalled();
      expect(r.status).toBe(401);
    },
  );

  it('succeeds with the right key as Authorization: Bearer', async () => {
    const r = await send(
      w.method,
      w.path,
      { ...w.headers, Authorization: `Bearer ${KEY}` },
      w.body,
    );
    expect(w.effect()).toHaveBeenCalled();
    expect(r.status).toBe(w.okStatus);
  });

  it('succeeds with the right key as X-Api-Key', async () => {
    const r = await send(w.method, w.path, { ...w.headers, 'X-Api-Key': KEY }, w.body);
    expect(w.effect()).toHaveBeenCalled();
    expect(r.status).toBe(w.okStatus);
  });

  it('succeeds with no header when SERVICE_API_KEY is unset (intentional: fail-open on upgrade)', async () => {
    (config as { serviceApiKey: string }).serviceApiKey = '';
    const r = await send(w.method, w.path, w.headers, w.body);
    expect(w.effect()).toHaveBeenCalled();
    expect(r.status).toBe(w.okStatus);
  });
});

describe('the key with a trailing space', () => {
  // Measured: Node's HTTP parser strips trailing whitespace from header values (RFC 9110
  // OWS), so `Bearer <key> ` on the wire reaches the router as `Bearer <key>` — the same
  // bytes as the right key. That is the protocol, not a bypass: no server can see the
  // space. This pins the measurement, and `write-auth.test.ts` pins that `extractKey`
  // itself never trims (a header that DID carry the space is refused there).
  it('is stripped by the HTTP parser before the guard sees it', async () => {
    const r = await send(
      'POST',
      '/api/queue/start-next',
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY} `,
      },
      JSON.stringify({ id: 'a', bedCleared: true }),
    );
    expect(queue.startNext).toHaveBeenCalled();
    expect(r.status).toBe(202);
  });
});

describe('reads', () => {
  it('GET /api/status with a wrong key is 401', async () => {
    const r = await send('GET', '/api/status', { Authorization: `Bearer ${WRONG}` });
    expect(r.status).toBe(401);
    expect(r.body).not.toContain(WRONG);
    expect(r.body).not.toContain(KEY);
  });

  it('GET /api/status with no key is 200', async () => {
    const r = await send('GET', '/api/status');
    expect(r.status).toBe(200);
  });

  it('GET /api/metrics/prometheus is open with no credentials (stock Prometheus scrape)', async () => {
    const r = await send('GET', '/api/metrics/prometheus');
    expect(r.status).toBe(200);
    expect(r.body).toContain('# HELP');
  });

  it('GET /api/metrics/prometheus also accepts the key as Bearer (authorization: {credentials})', async () => {
    const r = await send('GET', '/api/metrics/prometheus', { Authorization: `Bearer ${KEY}` });
    expect(r.status).toBe(200);
  });

  it('GET /api/metrics/prometheus behind a proxy forwarding Basic auth is still open', async () => {
    const r = await send('GET', '/api/metrics/prometheus', { Authorization: 'Basic dXNlcjpwYXNz' });
    expect(r.status).toBe(200);
  });

  it.each([
    '/api/health',
    '/api/status',
    '/api/metrics',
    '/api/metrics/prometheus',
    '/api/queue',
    '/api/printers',
    '/api/config/telegram',
    '/api/config/ai-labels',
    '/api/reports',
    '/api/stream',
    '/api/stream/overlay',
  ])('GET %s is open with no key', async (path) => {
    const r = await send('GET', path);
    expect(r.status).not.toBe(401);
  });

  it('POST /api/client-error stays open with no key (size-capped, log-only)', async () => {
    const r = await send('POST', '/api/client-error', {}, JSON.stringify({ message: 'boom' }));
    expect(r.status).toBe(204);
  });

  it('/api/health reports writeAuth without ever carrying the key', async () => {
    const on = await send('GET', '/api/health');
    expect(JSON.parse(on.body).writeAuth).toBe('enabled');
    expect(on.body).not.toContain(KEY);
    (config as { serviceApiKey: string }).serviceApiKey = '';
    const off = await send('GET', '/api/health');
    expect(JSON.parse(off.body).writeAuth).toBe('disabled');
  });

  it('a CORS preflight is answered without a key, and admits Authorization and X-Api-Key', async () => {
    const r = await send('OPTIONS', '/api/queue/start-next', {
      Origin: 'http://127.0.0.1',
      'Access-Control-Request-Method': 'POST',
    });
    expect(r.status).toBe(204);
    expect(r.head).toMatch(/Access-Control-Allow-Headers: Content-Type, Authorization, X-Api-Key/i);
  });

  it('a 401 still carries the CORS headers, so a cross-origin client can read it', async () => {
    const r = await send('POST', '/api/queue/clear', { Origin: 'http://127.0.0.1' }, '{}');
    expect(r.status).toBe(401);
    expect(r.head).toMatch(/Access-Control-Allow-Origin: \*/i);
  });
});

/**
 * Every gated `/api/*` write, pinned. A write route added without the gate would be
 * missing here AND answer non-401 — the default-deny classifier means it cannot be
 * added ungated by accident, and this table is what notices if that ever changes.
 */
const GATED_ROUTES: Array<[string, string]> = [
  ['POST', '/api/config/telegram'],
  ['POST', '/api/config/ai-labels'],
  ['DELETE', '/api/config/ai-labels'],
  ['POST', '/api/debug/capture'],
  ['POST', '/api/debug/videostream/sdcp'],
  ['POST', '/api/debug/videostream/mqtt'],
  ['DELETE', '/api/layer-data'],
  ['POST', '/api/files/precache'],
  ['POST', '/api/files/upload'],
  ['DELETE', '/api/reports/some-report'],
  ['POST', '/api/queue/items'],
  ['DELETE', '/api/queue/items/abc'],
  ['POST', '/api/queue/items/abc/move'],
  ['POST', '/api/queue/clear'],
  ['POST', '/api/queue/resume'],
  ['POST', '/api/queue/start-next'],
  ['POST', '/api/printers'],
  ['DELETE', '/api/printers/p1'],
  ['POST', '/api/printers/p1/activate'],
];

describe('every gated /api/* write', () => {
  it.each(GATED_ROUTES)('%s %s is 401 with no key and touches nothing', async (method, path) => {
    const r = await send(method, path, { 'Content-Type': 'application/json' }, '{}');
    for (const spy of [
      bridge.sendCommand,
      bridge.enableVideoStreamSDCP,
      bridge.enableVideoStreamMQTT,
      store.clearLayerData,
      store.on,
      queue.add,
      queue.remove,
      queue.move,
      queue.clear,
      queue.resume,
      queue.startNext,
      presets.add,
      presets.remove,
      printerRequest,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(r.status).toBe(401);
  });

  it.each(GATED_ROUTES)('%s %s is 401 with a wrong key', async (method, path) => {
    const r = await send(method, path, { 'X-Api-Key': WRONG }, '{}');
    expect(r.status).toBe(401);
  });

  // `/api/debug/capture` is left out of this one: with the key it really starts a capture,
  // whose 10 s timer then writes a file — its gating is pinned by the two cases above.
  const admitted = GATED_ROUTES.filter(([, path]) => path !== '/api/debug/capture');
  it.each(admitted)('%s %s is not refused by the gate with the right key', async (method, path) => {
    const r = await send(
      method,
      path,
      { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
      '{}',
    );
    expect(r.status).not.toBe(401);
  });
});

describe('connection presets', () => {
  it('the right key does not lift CONNECTION_PRESETS_API — still 403 with the flag off', async () => {
    presetsDeps.writable = false;
    const r = await send(
      'POST',
      '/api/printers',
      { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
      '{}',
    );
    expect(presets.add).not.toHaveBeenCalled();
    expect(r.status).toBe(403);
  });

  it('with the flag on, the right key adds a preset', async () => {
    const r = await send(
      'POST',
      '/api/printers',
      { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
      JSON.stringify({ name: 'a', ip: '192.0.2.20' }),
    );
    expect(presets.add).toHaveBeenCalled();
    expect(r.status).toBe(201);
  });
});
