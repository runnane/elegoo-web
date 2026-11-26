/**
 * ELEG-178: the camera proxy records evidence from real attempts, and `/api/stream`
 * answers instead of hanging.
 *
 * A local HTTP server on 127.0.0.1 stands in for the printer's camera, in four moods:
 * answers 503, accepts and never answers, streams one frame and goes quiet, streams one
 * frame and keeps the connection. No printer is involved and no request leaves the host.
 */
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { EventEmitter } from 'events';
import type { AddressInfo, Socket } from 'net';
import type { MqttBridge } from '../mqtt-bridge.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceConfig } from '../config.js';
import type { StateStore } from '../state-store.js';
import {
  createRestRouter,
  getCameraHealth,
  getSnapshot,
  resetCameraForPrinterSwitch,
  setCameraTimeouts,
} from '../rest-api.js';

type Mood = '503' | 'hang' | 'one-frame' | 'frame-then-silence';

// A minimal valid-looking JPEG: SOI … EOI is all the proxy looks for.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

let mood: Mood = '503';
let camera: Server;
const cameraSockets = new Set<Socket>();
let service: Server;
let servicePort: number;
const config = {
  cameraEnabled: true,
  cameraUrl: '',
  corsPolicy: { kind: 'any' },
  serviceApiKey: '',
} as unknown as ServiceConfig;
const store = { status: null } as unknown as StateStore;
const ON = { enabled: true, printerReportsCamera: true };

function cameraHandler(_req: IncomingMessage, res: ServerResponse): void {
  if (mood === '503') {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('busy');
    return;
  }
  if (mood === 'hang') return; // accept, never answer
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
  res.write(JPEG);
  // 'one-frame' and 'frame-then-silence' both hold the connection open afterwards.
}

beforeAll(async () => {
  camera = createServer(cameraHandler);
  camera.on('connection', (s) => {
    cameraSockets.add(s);
    s.on('close', () => cameraSockets.delete(s));
  });
  await new Promise<void>((r) => camera.listen(0, '127.0.0.1', r));
  (config as { cameraUrl: string }).cameraUrl =
    `http://127.0.0.1:${(camera.address() as AddressInfo).port}/`;

  service = createServer(createRestRouter(store, config));
  await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
  servicePort = (service.address() as AddressInfo).port;
});

afterEach(() => {
  // Forget this test's evidence and drop the upstream, the way a printer switch does.
  resetCameraForPrinterSwitch(config);
  for (const s of cameraSockets) s.destroy();
  setCameraTimeouts({ upstreamMs: 10_000, stallMs: 20_000 });
});

afterAll(async () => {
  await new Promise<void>((r) => service.close(() => r()));
  await new Promise<void>((r) => camera.close(() => r()));
});

interface StreamResult {
  status: number;
  contentType: string;
  /** Camera state at the moment the response headers reached the client. */
  stateAtHeaders: string;
  body: string;
  ms: number;
}

/** GET a stream route and read it to the end, or until `stopAfterBytes`. */
function readStream(
  path: string,
  stopAfterBytes = Number.POSITIVE_INFINITY,
): Promise<StreamResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port: servicePort, path }, (res) => {
      const stateAtHeaders = getCameraHealth(ON).state;
      const chunks: Buffer[] = [];
      let total = 0;
      const done = () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type']),
          stateAtHeaders,
          body: Buffer.concat(chunks).toString('latin1'),
          ms: Date.now() - started,
        });
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        total += c.length;
        if (total >= stopAfterBytes) {
          req.destroy();
          done();
        }
      });
      res.on('end', done);
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => reject(new Error('stream did not finish within 5 s')));
  });
}

describe('/api/stream against a dead camera', () => {
  it('flushes headers while connecting, then ends with the reason instead of hanging', async () => {
    mood = 'hang';
    setCameraTimeouts({ upstreamMs: 300 });

    const r = await readStream('/api/stream');

    expect(r.status).toBe(200);
    expect(r.contentType).toContain('multipart/x-mixed-replace');
    // The headers arrived before any frame and before the upstream gave up.
    expect(r.stateAtHeaders).toBe('connecting');
    expect(r.body).toContain('Camera unavailable: No data from the camera for 0.3 s');
    expect(r.ms).toBeLessThan(3_000);
    const h = getCameraHealth(ON);
    expect(h.state).toBe('unreachable');
    expect(h.lastFailure).toBe('No data from the camera for 0.3 s');
  });

  it('checks the upstream HTTP status and reports it', async () => {
    mood = '503';
    const r = await readStream('/api/stream');
    expect(r.body).toContain('Camera unavailable: Camera answered HTTP 503');
    expect(getCameraHealth(ON).state).toBe('unreachable');
    expect(getCameraHealth(ON).lastFailure).toBe('Camera answered HTTP 503');
  });
});

describe('/api/stream against a live camera', () => {
  it('relays a frame and reads streaming', async () => {
    mood = 'one-frame';
    const r = await readStream('/api/stream', JPEG.length + 60);
    expect(r.body).toContain('Content-Type: image/jpeg');
    expect(getCameraHealth(ON).state).toBe('streaming');
  });

  it('ends a viewer whose frames stop, after the bounded wait', async () => {
    mood = 'frame-then-silence';
    setCameraTimeouts({ stallMs: 300 });
    const r = await readStream('/api/stream');
    expect(r.body).toContain('Content-Type: image/jpeg');
    expect(r.body).toContain('Camera unavailable: No frame from the camera for 0.3 s');
  });
});

describe('snapshot evidence', () => {
  it('a 503 snapshot records unreachable with the status', async () => {
    mood = '503';
    expect(await getSnapshot(config)).toBeNull();
    const h = getCameraHealth(ON);
    expect(h.state).toBe('unreachable');
    expect(h.reason).toMatch(/^Camera answered HTTP 503 \(\d+s ago\)$/);
  });

  it('a good snapshot records a frame', async () => {
    mood = 'one-frame';
    expect(await getSnapshot(config)).toEqual(JPEG);
    expect(getCameraHealth(ON).state).toBe('streaming');
  });

  it('with no attempt at all, a connected printer reporting a camera reads idle', () => {
    expect(getCameraHealth(ON).state).toBe('idle');
  });

  it("the bridge's reconnect clears a failure recorded while the printer was away", async () => {
    const bridge = new EventEmitter() as EventEmitter & { isConnected: boolean };
    bridge.isConnected = true;
    createRestRouter(store, config, null, null, bridge as unknown as MqttBridge);
    mood = '503';
    await getSnapshot(config);
    expect(getCameraHealth(ON).state).toBe('unreachable');

    bridge.emit('connected', 'SN');

    expect(getCameraHealth(ON).state).toBe('idle');
  });
});
