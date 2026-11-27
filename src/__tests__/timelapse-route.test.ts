/**
 * ELEG-160: the timelapse proxy asks the printer's authenticated /download endpoint for a
 * relative value, passes Range through, and never lets the printer password out. Driven
 * against a local fake upstream on an ephemeral port — no printer, no MQTT.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, get, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { proxyTimelapseVideo } from '../server/rest-api.js';
import { resolveTimelapseUpstream } from '../server/timelapse-proxy.js';
import type { ServiceConfig } from '../server/config.js';

const PASSWORD = 'placeholder-pw&1';
const config = { printerIp: '127.0.0.1', printerPassword: PASSWORD } as ServiceConfig;

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

interface Seen {
  url?: string;
  range?: string;
}

interface Reply {
  status: number | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Fake printer that records the request and answers with `status`. */
function fakePrinter(seen: Seen, status: number): Server {
  return createServer((req, res) => {
    seen.url = req.url;
    seen.range = req.headers.range;
    if (status === 206) {
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': '4',
        'Content-Range': 'bytes 0-3/10',
      });
      res.end('abcd');
      return;
    }
    res.writeHead(status);
    res.end('nope');
  });
}

/** The service side: resolves the value like the route does, then proxies it. */
async function viaProxy(
  upstreamPort: number,
  value: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const target = resolveTimelapseUpstream(value, config.printerIp);
  if (!target.ok) throw new Error(target.error);
  const proxy = await listen(
    createServer((req, res) =>
      proxyTimelapseVideo(req, res, config, { ...target, port: upstreamPort }),
    ),
  );
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port: proxy, path: '/', headers }, (r) => {
      let body = '';
      r.on('data', (c: Buffer) => {
        body += c.toString();
      });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
    }).on('error', reject);
  });
}

describe('timelapse proxy request (ELEG-160)', () => {
  it('requests a relative value through /download with the token and passes Range through', async () => {
    const seen: Seen = {};
    const upstream = await listen(fakePrinter(seen, 206));

    const out = await viaProxy(upstream, '/Time-lapse/a%20b.mp4', {
      Range: 'bytes=0-3',
    });

    expect(seen.url).toBe('/download?X-Token=placeholder-pw%261&file_name=Time-lapse%2Fa%20b.mp4');
    expect(seen.range).toBe('bytes=0-3');
    expect(out.status).toBe(206);
    expect(out.headers['content-range']).toBe('bytes 0-3/10');
    expect(out.headers['content-type']).toBe('video/mp4');
    expect(out.body).toBe('abcd');
  });

  it('leaves the absolute-URL branch on its direct path', async () => {
    const seen: Seen = {};
    const upstream = await listen(fakePrinter(seen, 206));

    await viaProxy(upstream, 'http://127.0.0.1/video/a.mp4?x=1');

    expect(seen.url).toBe('/video/a.mp4?x=1');
  });

  it('does not leak the password in the error body or any response header', async () => {
    const seen: Seen = {};
    const upstream = await listen(fakePrinter(seen, 404));

    const out = await viaProxy(upstream, 'a.mp4');

    expect(seen.url).toContain('X-Token=');
    expect(out.status).toBe(404);
    const everything = JSON.stringify(out.headers) + out.body;
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(encodeURIComponent(PASSWORD));
    expect(everything).not.toContain('X-Token');
  });
});
