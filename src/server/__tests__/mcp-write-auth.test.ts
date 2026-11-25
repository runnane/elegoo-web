/**
 * ELEG-141: the `/mcp` control tools are gated behind SERVICE_API_KEY; the read tools, the
 * resources, initialize and tools/list stay open.
 *
 * Driven through the real `handleMcpRequest` on an ephemeral port, over HTTP, exactly as a
 * StreamableHTTP client talks to it. No printer, no MQTT, nothing from index.ts: the bridge
 * is a fake whose three command methods are spies, so "the spy was not called" is the
 * observation that a refused call never reached the printer.
 *
 * Every refused call is one that SUCCEEDS with the right key (valid arguments, connected
 * bridge) — only the credential differs — and the "with the key" half asserts the spy WAS
 * called, so the "not called" half is not vacuous. The spy assertion comes before the
 * shape assertion: a gate that ran after the command would still return the refusal.
 *
 * Lives under `src/server/` for the same reason as mcp-doc-parity.test.ts: it imports
 * server code, which the browser tsconfig must not see.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpRequest } from '../mcp-server.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { StateStore } from '../state-store.js';
import { UNAUTHORIZED_MESSAGE } from '../write-auth.js';

const KEY = 'k'.repeat(16) + '0123456789abcdef0123'; // 36 chars, generated, not a real key
const WRONG = 'x'.repeat(36);

// ── fakes ──────────────────────────────────────────────────────────────────

const bridge = {
  isConnected: true,
  sendCommand: vi.fn(),
  enableVideoStreamSDCP: vi.fn(async () => ({ success: true })),
  enableVideoStreamMQTT: vi.fn(),
};
const bridgeSpies = [
  bridge.sendCommand,
  bridge.enableVideoStreamSDCP,
  bridge.enableVideoStreamMQTT,
];
const callsToPrinter = () => bridgeSpies.reduce((n, s) => n + s.mock.calls.length, 0);

const store = {
  status: null,
  attributes: {},
  canvas: null,
  files: [],
  layerTimes: [],
  fileTotalLayers: 0,
  zones: { current: 'unknown', history: [] },
  getEventLog: () => [],
  getFilamentUsageArray: () => [],
};

const config = { serviceApiKey: KEY };

// ── the server ─────────────────────────────────────────────────────────────

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleMcpRequest(
      req,
      res,
      store as unknown as StateStore,
      bridge as unknown as MqttBridge,
      config.serviceApiKey,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  config.serviceApiKey = KEY;
});

// ── a minimal StreamableHTTP client ────────────────────────────────────────

interface Reply {
  status: number;
  body: string;
  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC message, shape asserted per test
  msg: any;
  sessionId: string | null;
}

const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

let nextId = 1;

async function post(
  message: object,
  headers: Record<string, string> = {},
  sessionId?: string,
): Promise<Reply> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers,
    },
    body: JSON.stringify(message),
  });
  const body = await res.text();
  let msg: unknown;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = body.split('\n').find((l) => l.startsWith('data: '));
    msg = data ? JSON.parse(data.slice(6)) : undefined;
  } else if (body) {
    msg = JSON.parse(body);
  }
  return { status: res.status, body, msg, sessionId: res.headers.get('mcp-session-id') };
}

/** initialize + notifications/initialized; returns the session id. */
async function openSession(headers: Record<string, string> = {}): Promise<string> {
  const init = await post(
    {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'write-auth-test', version: '0' },
      },
    },
    headers,
  );
  expect(init.status).toBe(200);
  expect(init.sessionId).toBeTruthy();
  const sid = init.sessionId as string;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers, sid);
  return sid;
}

const call = (sid: string, name: string, args: object, headers: Record<string, string> = {}) =>
  post(
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
    headers,
    sid,
  );

/** The exact tool result a gated tool returns without the key. */
const refusal = (tool: string) => ({
  content: [{ type: 'text', text: `"${tool}" needs SERVICE_API_KEY. ${UNAUTHORIZED_MESSAGE}` }],
  isError: true,
});

// ── the classification ─────────────────────────────────────────────────────

/**
 * Every control tool, with arguments that pass its schema — input validation runs BEFORE
 * the gate, so `{}` on a tool with required parameters would be refused by Zod and leave
 * the spy uncalled even with the gate deleted.
 */
const GATED: Record<string, object> = {
  set_temperature: { nozzle: 0 },
  fan: { name: 'part', speed: 0 },
  speed_mode: { mode: 'balanced' },
  led: { on: false },
  home: {},
  move: { axis: 'x', distance: 0 },
  start_print: { filename: 'test.gcode' },
  pause_print: {},
  resume_print: {},
  stop_print: {},
  emergency_stop: {},
  auto_level: {},
  pid_calibrate: {},
  vibration_calibrate: {},
  self_check: {},
  delete_file: { path: '/test.gcode' },
  load_filament: {},
  unload_filament: {},
  set_auto_refill: { enabled: false },
  enable_video_stream: {},
  send_command: { method: 1007 },
};

const OPEN: Record<string, object> = {
  status: {},
  temperatures: {},
  print_progress: {},
  files: {},
  events: {},
  system_info: {},
  zones: {},
  layers: {},
  filament_usage: {},
  canvas_info: {},
};

describe('the classification table', () => {
  it('covers every registered tool exactly once — a new tool must be classified here', async () => {
    const sid = await openSession(); // no key: tools/list must work without one
    const list = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, {}, sid);
    const registered: string[] = list.msg.result.tools.map((t: { name: string }) => t.name).sort();
    const classified = [...Object.keys(GATED), ...Object.keys(OPEN)].sort();
    expect(registered).toEqual(classified);
    expect(Object.keys(GATED)).toHaveLength(21);
    expect(Object.keys(OPEN)).toHaveLength(10);
  });
});

describe.each(Object.entries(GATED))('gated: %s', (tool, args) => {
  it('without a key: a tool error naming the key, and nothing reaches the printer', async () => {
    const sid = await openSession();
    const r = await call(sid, tool, args);
    expect(callsToPrinter()).toBe(0);
    expect(r.status).toBe(200);
    expect(r.msg.error).toBeUndefined();
    expect(r.msg.result).toEqual(refusal(tool));
  });

  it('with the key: reaches the printer exactly once', async () => {
    const sid = await openSession(bearer(KEY));
    const r = await call(sid, tool, args, bearer(KEY));
    expect(callsToPrinter()).toBe(1);
    expect(r.msg.result.isError).toBeFalsy();
  });

  it('with a wrong key: HTTP 401, and nothing reaches the printer', async () => {
    const sid = await openSession();
    const r = await call(sid, tool, args, bearer(WRONG));
    expect(callsToPrinter()).toBe(0);
    expect(r.status).toBe(401);
  });

  it('with SERVICE_API_KEY unset: open, as before (fail-open on upgrade)', async () => {
    config.serviceApiKey = '';
    const sid = await openSession();
    const r = await call(sid, tool, args);
    expect(callsToPrinter()).toBe(1);
    expect(r.msg.result.isError).toBeFalsy();
  });
});

describe.each(Object.entries(OPEN))('open: %s', (tool, args) => {
  it('works without a key and is never the auth refusal', async () => {
    const sid = await openSession();
    const r = await call(sid, tool, args);
    expect(r.status).toBe(200);
    expect(r.msg.result).not.toEqual(refusal(tool));
    expect(JSON.stringify(r.msg.result)).not.toContain('SERVICE_API_KEY');
    expect(callsToPrinter()).toBe(0);
  });

  it('is refused with HTTP 401 when a wrong key is presented', async () => {
    const sid = await openSession();
    const r = await call(sid, tool, args, bearer(WRONG));
    expect(r.status).toBe(401);
  });
});

describe('the issue proof list', () => {
  it.each([
    ['emergency_stop', {}, 1007],
    ['send_command', { method: 1007 }, 1007],
  ])('%s: no key → tool error; key → sendCommand(%s) once', async (tool, args, method) => {
    const sid = await openSession();
    const refused = await call(sid, tool, args);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(refused.msg.result).toEqual(refusal(tool));

    const allowed = await call(sid, tool, args, bearer(KEY));
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    expect(bridge.sendCommand).toHaveBeenCalledWith(method, {});
    expect(allowed.msg.result.isError).toBeFalsy();
  });

  it('an authorised initialize does not authorise later requests on the same session', async () => {
    const sid = await openSession(bearer(KEY));
    const withKey = await call(sid, 'emergency_stop', {}, bearer(KEY));
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    expect(withKey.msg.result.isError).toBeFalsy();

    const withoutKey = await call(sid, 'emergency_stop', {});
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    expect(withoutKey.msg.result).toEqual(refusal('emergency_stop'));
  });

  it('status works with no key at all', async () => {
    const sid = await openSession();
    const r = await call(sid, 'status', {});
    expect(r.status).toBe(200);
    expect(r.msg.result.isError).toBeFalsy();
    expect(r.msg.result.content[0].text).toBe('Printer not connected');
  });
});

describe('transport level', () => {
  it('initialize with a wrong key is 401, and the body carries neither key', async () => {
    const r = await post(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'write-auth-test', version: '0' },
        },
      },
      bearer(WRONG),
    );
    expect(r.status).toBe(401);
    expect(r.sessionId).toBeNull();
    expect(r.body).not.toContain(WRONG);
    expect(r.body).not.toContain(KEY);
  });

  it('initialize, tools/list and resources/read work without a key', async () => {
    const sid = await openSession();
    const tools = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, {}, sid);
    expect(tools.msg.result.tools.length).toBe(31);
    const res = await post(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'resources/read',
        params: { uri: 'printer://status' },
      },
      {},
      sid,
    );
    expect(res.msg.result.contents[0].uri).toBe('printer://status');
  });

  it('a wrong key on an existing session GET or DELETE is 401', async () => {
    const sid = await openSession();
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(url, {
        method,
        headers: { 'mcp-session-id': sid, Accept: 'text/event-stream', ...bearer(WRONG) },
      });
      expect(r.status).toBe(401);
      await r.body?.cancel();
    }
  });
});
