/**
 * ELEG-186: the token-bearing methods (1049 UpdateToken, 1050 GetToken, 1053
 * SetTokenSwitch) are redacted before a raw MQTT payload leaves the service — over `/ws`
 * and into `/api/debug/capture` files — while every other method passes through as-is.
 *
 * Through the real `StateStore`, `WebSocketTransport` and REST router on an ephemeral port,
 * with a fake bridge that emits what `MqttBridge` would. No printer, no MQTT. The token is
 * generated and obviously fake; every check is that its text appears nowhere.
 */
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ServiceConfig } from '../config.js';
import { captureLogDir, initDataPaths, resetDataPathsForTest } from '../data-paths.js';
import type { MqttBridge } from '../mqtt-bridge.js';
import { createRestRouter } from '../rest-api.js';
import { REDACTED, SECRET_METHODS, redactSecretPayload } from '../secret-payload.js';
import { StateStore } from '../state-store.js';
import { WebSocketTransport } from '../ws-transport.js';

const FAKE_TOKEN = 'tok-REDACTME-0000';
const TOPIC_RESPONSE = 'elegoo/FAKESN0000/fake-client/api_response';
const TOPIC_REQUEST = 'elegoo/FAKESN0000/fake-client/api_request';

/** What the printer would answer to 1050, if it carried a token. The shape is a guess. */
const getTokenReply = () => ({
  id: 7,
  method: 1050,
  result: { error_code: 0, token: FAKE_TOKEN, url: `http://fake.invalid/${FAKE_TOKEN}` },
});
const updateTokenRequest = () => ({ id: 8, method: 1049, params: { token: FAKE_TOKEN } });
const tokenSwitchReply = () => ({
  id: 9,
  method: 1053,
  result: { error_code: 0, nested: [{ secret: FAKE_TOKEN }] },
});
/** An ordinary reply, which must arrive unchanged. */
const fileListReply = () => ({
  id: 10,
  method: 1044,
  result: { error_code: 0, file_list: [{ filename: 'cube.gcode', size: 1234 }] },
});

describe('redactSecretPayload', () => {
  it('covers exactly the three token methods', () => {
    expect([...SECRET_METHODS].sort()).toEqual([1049, 1050, 1053]);
  });

  it('keeps id, method and error_code of a 1050 reply and replaces everything else', () => {
    expect(redactSecretPayload(1050, getTokenReply())).toEqual({
      id: 7,
      method: 1050,
      result: { error_code: 0, token: REDACTED, url: REDACTED },
    });
  });

  it('redacts 1049 request params and nested 1053 values', () => {
    expect(redactSecretPayload(1049, updateTokenRequest())).toEqual({
      id: 8,
      method: 1049,
      params: { token: REDACTED },
    });
    expect(JSON.stringify(redactSecretPayload(1053, tokenSwitchReply()))).not.toContain(FAKE_TOKEN);
  });

  it('returns any other method untouched, as the same object', () => {
    const reply = fileListReply();
    expect(redactSecretPayload(1044, reply)).toBe(reply);
    expect(redactSecretPayload(undefined, reply)).toBe(reply);
  });

  it('redacts a method given as a string, as the bridge does not check its type', () => {
    expect(JSON.stringify(redactSecretPayload('1050', getTokenReply()))).not.toContain(FAKE_TOKEN);
  });

  it('does not mutate the payload it redacts', () => {
    const reply = getTokenReply();
    redactSecretPayload(1050, reply);
    expect(reply.result.token).toBe(FAKE_TOKEN);
  });
});

// ── end to end: StateStore → /ws and → /api/debug/capture ─────────────────────

const bridge = Object.assign(new EventEmitter(), {
  isConnected: true,
  brokerConnected: true,
  phase: 'registered',
  registerAttempts: 1,
  serialNumber: 'FAKESN0000',
  ip: '192.0.2.10',
  sendCommand: vi.fn(),
});

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
  dataDir: '',
} as unknown as ServiceConfig;

let store: StateStore;
let server: Server;
let transport: WebSocketTransport;
let base: string;
let dataDir: string;
const sockets: WebSocket[] = [];

/** Emit what MqttBridge emits for one message: `raw`, then `response` for a reply. */
function deliver(direction: 'sent' | 'received', msg: Record<string, unknown>): void {
  bridge.emit('raw', direction, direction === 'sent' ? TOPIC_REQUEST : TOPIC_RESPONSE, msg);
  if (direction === 'received') bridge.emit('response', msg.method, msg);
}

function deliverAll(): void {
  deliver('received', getTokenReply());
  deliver('sent', updateTokenRequest());
  deliver('received', tokenSwitchReply());
  deliver('received', fileListReply());
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'eleg-186-'));
  initDataPaths(dataDir);
  mkdirSync(captureLogDir(), { recursive: true });
  store = new StateStore(bridge as unknown as MqttBridge, 25);
  server = createServer(
    createRestRouter(store, config, null, null, bridge as unknown as MqttBridge),
  );
  transport = new WebSocketTransport(server, store, bridge as unknown as MqttBridge, {
    serviceApiKey: '',
    cameraEnabled: false,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  transport.close();
  store.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDataPathsForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the /ws broadcast (ELEG-186)', () => {
  it('carries no token from 1049/1050/1053, and an ordinary reply unchanged', async () => {
    const ws = new WebSocket(`ws://${base}/ws`);
    sockets.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    let seenLast: () => void = () => {};
    const last = new Promise<void>((resolve) => {
      seenLast = resolve;
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(msg);
      // The 1044 `response` is the last frame deliverAll() causes; frames arrive in order.
      if (msg.type === 'response' && msg.method === 1044) seenLast();
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    deliverAll();
    await last;

    const raws = messages.filter((m) => m.type === 'raw');
    const responses = messages.filter((m) => m.type === 'response');
    // Every message got through, so "no token" is not "nothing arrived".
    expect(raws.map((m) => (m.data as { method: number }).method)).toEqual([
      1050, 1049, 1053, 1044,
    ]);
    expect(responses.map((m) => m.method)).toEqual([1050, 1053, 1044]);

    expect(JSON.stringify(messages)).not.toContain(FAKE_TOKEN);
    expect(responses[0].data).toEqual({
      id: 7,
      method: 1050,
      result: { error_code: 0, token: REDACTED, url: REDACTED },
    });
    expect(raws[3].data).toEqual(fileListReply());
    expect(responses[2].data).toEqual(fileListReply());

    // A 1050 reply no longer lands in any state field either (it used to set videoUrl).
    expect(store.timelapseUrl).toBeNull();
    expect(JSON.stringify(store.getRecentLogs())).not.toContain(FAKE_TOKEN);
  });
});

describe('/api/debug/capture (ELEG-186)', () => {
  it('writes no token from 1049/1050/1053, and an ordinary reply unchanged', async () => {
    const res = await fetch(`http://${base}/api/debug/capture`, {
      method: 'POST',
      body: JSON.stringify({ duration: 0.2 }),
    });
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as { file: string };

    deliverAll();

    const path = join(captureLogDir(), file);
    let text = '';
    for (let i = 0; i < 100 && !text; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        text = readFileSync(path, 'utf8');
        JSON.parse(text);
      } catch {
        text = ''; // not written yet, or not completely
      }
    }
    const captured = JSON.parse(text) as Array<{ data: { method: number } }>;
    expect(captured.map((e) => e.data.method)).toEqual([1050, 1049, 1053, 1044]);
    expect(text).not.toContain(FAKE_TOKEN);
    expect(captured[3].data).toEqual(fileListReply());
  });
});
