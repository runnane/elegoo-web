/**
 * ELEG-131: a printer that sends a 200 and then stalls mid-body used to leave the
 * browser's response open forever (the `!res.headersSent` guard skipped it) and could
 * leave a partial gcode file in the cache. Driven against a local fake upstream on an
 * ephemeral port — no printer, no MQTT, nothing imported from index.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, get, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleFileDownload, PRINTER_CLOSED_DOWNLOAD_MESSAGE } from '../server/rest-api.js';
import { gcodeCacheDir, initDataPaths, resetDataPathsForTest } from '../server/data-paths.js';
import type { ServiceConfig } from '../server/config.js';

const config = { printerIp: '127.0.0.1', printerPassword: 'x' } as ServiceConfig;
const BOUND_MS = 3000;

let dataDir: string;
const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** Fake printer: 200 + headers + a few bytes, then silence (or the full body). */
function fakePrinter(stall: boolean): Server {
  return createServer((_req, res) => {
    const body = 'G1 X0 Y0\nG1 X1 Y1\n';
    res.writeHead(200, { 'Content-Length': String(stall ? 1_000_000 : body.length) });
    if (stall) {
      res.write(body);
    } else {
      res.end(body);
    }
  });
}

/** The service side: a plain server routing straight into handleFileDownload. */
async function startProxy(upstreamPort: number, timeoutMs: number): Promise<number> {
  return listen(
    createServer((_req, res) => {
      void handleFileDownload(res, 'a.gcode', 'a.gcode', 'local', true, config, {
        port: upstreamPort,
        timeoutMs,
      });
    }),
  );
}

interface Outcome {
  status: number | undefined;
  complete: boolean;
  bytes: number;
  body: string;
  elapsedMs: number;
}

/**
 * Resolves when the browser-side response ends or breaks. Past the bound it resolves
 * with elapsedMs === BOUND_MS (still open), so the assertion — not a thrown error —
 * is what reports a response that never ended.
 */
function fetchVia(port: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let status: number | undefined;
    let bytes = 0;
    let body = '';
    const guard = setTimeout(
      () => resolve({ status, complete: false, bytes, body, elapsedMs: BOUND_MS }),
      BOUND_MS,
    );
    get({ host: '127.0.0.1', port, path: '/' }, (r: IncomingMessage) => {
      status = r.statusCode;
      r.on('data', (c: Buffer) => {
        bytes += c.length;
        body += c.toString();
      });
      const done = (): void => {
        clearTimeout(guard);
        resolve({
          status: r.statusCode,
          complete: r.complete,
          bytes,
          body,
          elapsedMs: Date.now() - start,
        });
      };
      r.on('close', done);
      r.on('error', () => {});
    }).on('error', (e) => {
      clearTimeout(guard);
      reject(e);
    });
  });
}

async function waitForCacheDirEmpty(): Promise<string[]> {
  let files: string[] = [];
  for (let i = 0; i < 40; i++) {
    files = await readdir(gcodeCacheDir());
    if (files.length === 0) return files;
    await new Promise((r) => setTimeout(r, 25));
  }
  return files;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'eleg131-'));
  initDataPaths(dataDir);
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  resetDataPathsForTest();
  await rm(dataDir, { recursive: true, force: true });
});

describe('printer download proxy (ELEG-131)', () => {
  it('ends the browser response and leaves no cache file when the printer stalls after headers', async () => {
    const upstream = await listen(fakePrinter(true));
    const proxy = await startProxy(upstream, 300);

    const out = await fetchVia(proxy);

    expect(out.status).toBe(200);
    expect(out.complete).toBe(false);
    expect(out.elapsedMs).toBeLessThan(BOUND_MS);
    expect(await waitForCacheDirEmpty()).toEqual([]);
  });

  it('still caches and serves a complete download', async () => {
    const upstream = await listen(fakePrinter(false));
    const proxy = await startProxy(upstream, 300);

    const out = await fetchVia(proxy);
    expect(out.complete).toBe(true);
    expect(out.bytes).toBe('G1 X0 Y0\nG1 X1 Y1\n'.length);

    // The `.part` file exists from the first byte; the rename into place happens just
    // after the response ends. Wait for the renamed file itself, not for "anything in
    // the dir", or a loaded run reads the dir between the two (ELEG-147).
    let files: string[] = [];
    for (let i = 0; i < 80; i++) {
      files = await readdir(gcodeCacheDir());
      if (files.length === 1 && files[0].endsWith('.gcode')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.gcode$/);
  });
});

/**
 * ELEG-200: mid-print the printer accepts the connection, sends nothing, and closes
 * it (~75 s on firmware 02.01.01.07). That is not a failure to connect, and saying
 * so hid the cause from everyone reading the preview's error.
 */
describe('printer download proxy, upstream errors before any response (ELEG-200)', () => {
  it('names a connection the printer closed without answering', async () => {
    const upstream = await listen(
      createServer((req) => {
        req.socket.destroy();
      }),
    );
    const proxy = await startProxy(upstream, 2000);

    const out = await fetchVia(proxy);

    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toEqual({ error: PRINTER_CLOSED_DOWNLOAD_MESSAGE });
  });

  it('still says "Failed to connect" when nothing is listening', async () => {
    // Bind an ephemeral port, then free it, so nothing is listening there.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const proxy = await startProxy(port, 2000);

    const out = await fetchVia(proxy);

    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toEqual({ error: 'Failed to connect to printer' });
  });
});
