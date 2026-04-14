/**
 * REST API and camera proxy.
 *
 * Endpoints:
 *   GET /api/status    — Current printer state as JSON
 *   GET /api/metrics   — Structured metrics as JSON
 *   GET /api/metrics/prometheus — Metrics in Prometheus text exposition format
 *   GET /api/snapshot  — Camera JPEG snapshot (proxied + cached)
 *   GET /api/stream    — MJPEG stream proxy (single upstream, fan-out to all clients)
 *   GET /api/stream/overlay — MJPEG stream with status text overlay
 *   GET /api/health    — Service health check
 *   GET /api/files/download — Proxy file download from printer
 *   POST /api/files/upload  — Proxy file upload to printer (chunked PUT)
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { request as httpRequest } from 'http';
import { createHash } from 'crypto';
import { writeFile, readdir, readFile, mkdir, stat, unlink, readdir as readdirFs } from 'fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { join, resolve, extname } from 'path';
import { PassThrough } from 'stream';
import sharp from 'sharp';
import type { StateStore } from './state-store.js';
import type { ServiceConfig } from './config.js';
import type { AIMonitor, AILabelConfig } from './ai-monitor.js';
import type { PrintReportCollector } from './print-report-collector.js';
import type { MqttBridge } from './mqtt-bridge.js';
import { generateReportPDF } from './print-report-pdf.js';
import { getLogger } from './logger.js';
import { STATUS_NAMES, SUB_STATUS_NAMES, SPEED_MODE_NAMES, EXCEPTION_NAMES } from '../types.js';
import type { FanInfo } from '../types.js';

const log = getLogger('REST');
const debugLog = getLogger('Debug');

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const CACHE_TTL_MS = 5_000;

let cachedSnapshot: Buffer | null = null;
let cacheTime = 0;
let fetchInFlight: Promise<Buffer | null> | null = null;

// Debug capture state
let activeCapture: { file: string } | null = null;

// ── Gcode file cache ────────────────────────────────────────────
const GCODE_CACHE_DIR = join(process.cwd(), 'data', 'gcode-cache');
const GCODE_CACHE_MAX = 10; // keep at most N cached files

function gcodeCacheKey(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 16) + '.gcode';
}

async function ensureCacheDir(): Promise<void> {
  await mkdir(GCODE_CACHE_DIR, { recursive: true });
}

/** Cache a gcode file from a Buffer (e.g. after upload) */
export async function cacheGcodeBuffer(fileName: string, data: Buffer): Promise<void> {
  try {
    await ensureCacheDir();
    const cachePath = join(GCODE_CACHE_DIR, gcodeCacheKey(fileName));
    await writeFile(cachePath, data);
    await evictOldCache();
    log.info(`Cached uploaded gcode: ${fileName} (${data.length} bytes)`);
  } catch (err) {
    log.warn(`Failed to cache uploaded gcode ${fileName}: ${(err as Error).message}`);
  }
}

async function getCachedGcode(fileName: string): Promise<string | null> {
  try {
    const cached = join(GCODE_CACHE_DIR, gcodeCacheKey(fileName));
    const s = await stat(cached);
    if (s.size > 0) return cached;
  } catch { /* not cached */ }
  return null;
}

async function evictOldCache(): Promise<void> {
  try {
    const files = await readdir(GCODE_CACHE_DIR);
    if (files.length <= GCODE_CACHE_MAX) return;
    const entries = await Promise.all(files.map(async f => {
      const p = join(GCODE_CACHE_DIR, f);
      const s = await stat(p).catch(() => null);
      return { path: p, mtime: s?.mtimeMs ?? 0 };
    }));
    entries.sort((a, b) => a.mtime - b.mtime);
    const toRemove = entries.slice(0, entries.length - GCODE_CACHE_MAX);
    await Promise.all(toRemove.map(e => unlink(e.path).catch(() => {})));
  } catch { /* ignore */ }
}

async function handleFileDownload(
  res: ServerResponse,
  fileName: string,
  baseName: string,
  source: string,
  isGcode: boolean,
  config: ServiceConfig,
): Promise<void> {
  // Try serving from cache first (gcode files only)
  if (isGcode) {
    try {
      await ensureCacheDir();
      const cached = await getCachedGcode(fileName);
      if (cached) {
        log.info(`Download proxy: serving ${fileName} from cache`);
        const s = await stat(cached);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${baseName}"`,
          'Content-Length': String(s.size),
        });
        createReadStream(cached).pipe(res);
        return;
      }
    } catch { /* cache miss, fall through to printer */ }
  }

  const pathMap: Record<string, string> = { 'local': '/download', 'u-disk': '/download/udisk', 'sd-card': '/download/sdcard' };
  const dlPath = pathMap[source] ?? '/download';
  log.info(`Download proxy: ${fileName} from ${dlPath}`);

  const proxyReq = httpRequest({
    hostname: config.printerIp,
    port: 80,
    path: `${dlPath}?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
    method: 'GET',
    timeout: 120_000,
    // Printer's libhv sends both Content-Length and Transfer-Encoding: chunked,
    // which is invalid HTTP. Node's strict parser rejects this.
    insecureHTTPParser: true,
  }, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      res.writeHead(proxyRes.statusCode ?? 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Printer returned ${proxyRes.statusCode}` }));
      proxyRes.resume();
      return;
    }
    // Keep the socket alive during slow transfers
    proxyRes.socket?.setTimeout(120_000);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${baseName}"`,
      ...(proxyRes.headers['content-length'] ? { 'Content-Length': proxyRes.headers['content-length'] } : {}),
    });

    // For gcode files, tee the stream to a cache file
    if (isGcode) {
      const cachePath = join(GCODE_CACHE_DIR, gcodeCacheKey(fileName));
      const cacheStream = createWriteStream(cachePath);
      const tee = new PassThrough();
      tee.pipe(res);
      tee.pipe(cacheStream);
      proxyRes.pipe(tee);
      cacheStream.on('finish', () => {
        evictOldCache().catch(() => {});
        log.info(`Cached gcode: ${fileName}`);
      });
      cacheStream.on('error', () => {
        unlink(cachePath).catch(() => {});
      });
    } else {
      proxyRes.pipe(res);
    }
  });
  proxyReq.on('error', (err) => {
    log.error(`Download proxy error: ${(err as NodeJS.ErrnoException).code} ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to connect to printer' }));
    }
  });
  proxyReq.on('timeout', () => {
    log.error('Download proxy timeout');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Download timed out' }));
    }
  });
  proxyReq.end();
}

/**
 * Pre-download a gcode file to cache in the background.
 * Called on print start so the preview can be served from cache
 * instead of hitting the printer while it's busy printing.
 */
export function precacheGcode(fileName: string, config: ServiceConfig, source = 'local'): void {
  // Fire and forget — errors are logged but don't affect the caller
  void precacheGcodeAsync(fileName, config, source);
}

/**
 * Pre-download a gcode file to cache. Returns a promise that resolves
 * with { ok, cached, size } when done.
 */
export async function precacheGcodeAsync(
  fileName: string, config: ServiceConfig, source = 'local',
): Promise<{ ok: boolean; cached: boolean; size: number; error?: string }> {
  try {
    await ensureCacheDir();
    const existing = await getCachedGcode(fileName);
    if (existing) {
      const s = await stat(existing);
      log.info(`Precache: ${fileName} already cached (${s.size} bytes)`);
      return { ok: true, cached: true, size: s.size };
    }

    const pathMap: Record<string, string> = { 'local': '/download', 'u-disk': '/download/udisk', 'sd-card': '/download/sdcard' };
    const dlPath = pathMap[source] ?? '/download';
    log.info(`Precache: downloading ${fileName} from ${dlPath}`);

    const cachePath = join(GCODE_CACHE_DIR, gcodeCacheKey(fileName));

    const size = await new Promise<number>((resolve, reject) => {
      const proxyReq = httpRequest({
        hostname: config.printerIp,
        port: 80,
        path: `${dlPath}?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
        method: 'GET',
        timeout: 120_000,
        insecureHTTPParser: true,
      }, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          proxyRes.resume();
          reject(new Error(`Printer returned ${proxyRes.statusCode}`));
          return;
        }
        proxyRes.socket?.setTimeout(120_000);
        const cacheStream = createWriteStream(cachePath);
        let bytes = 0;
        proxyRes.on('data', (chunk: Buffer) => { bytes += chunk.length; });
        proxyRes.pipe(cacheStream);
        cacheStream.on('finish', () => {
          evictOldCache().catch(() => {});
          log.info(`Precache: cached ${fileName} (${bytes} bytes)`);
          resolve(bytes);
        });
        cacheStream.on('error', (err) => {
          unlink(cachePath).catch(() => {});
          reject(err);
        });
      });
      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('Precache download timed out'));
      });
      proxyReq.end();
    });

    return { ok: true, cached: false, size };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn(`Precache failed for ${fileName}: ${msg}`);
    return { ok: false, cached: false, size: 0, error: msg };
  }
}

async function fetchCameraFrame(cameraUrl: string): Promise<Buffer | null> {
  // Return cached snapshot if fresh
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  // Serialize concurrent requests
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = doFetch(cameraUrl);
  try {
    const result = await fetchInFlight;
    if (result) {
      cachedSnapshot = result;
      cacheTime = Date.now();
    }
    return result;
  } finally {
    fetchInFlight = null;
  }
}

async function doFetch(cameraUrl: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(cameraUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
      return Buffer.from(await res.arrayBuffer());
    }

    // MJPEG stream — extract first frame
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let totalLen = 0;

    try {
      while (totalLen < 5 * 1024 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        totalLen += buf.length;

        const combined = Buffer.concat(chunks);
        const startIdx = combined.indexOf(JPEG_START);
        if (startIdx === -1) continue;
        const endIdx = combined.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) continue;

        reader.cancel();
        return combined.subarray(startIdx, endIdx + 2);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    return null;
  } catch (err) {
    log.warn(`Snapshot failed: ${(err as Error).message}`);
    return null;
  }
}

/** Shared snapshot fetcher — used by both REST API, Telegram, and AI monitor.
 *  Prefers the cached frame from the active MJPEG fan-out stream (zero-cost).
 *  Only falls back to a dedicated HTTP fetch if no recent frame is available. */
/** Check actual camera stream health (fresh cached frame or active upstream). */
export function getCameraHealth(): 'available' | 'unavailable' {
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) return 'available';
  if (upstreamActive) return 'available';
  return 'unavailable';
}

export async function getSnapshot(config: ServiceConfig): Promise<Buffer | null> {
  if (!config.cameraEnabled) return null;
  // Use cached frame from MJPEG stream if fresh (within TTL)
  if (cachedSnapshot && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSnapshot;
  }
  return fetchCameraFrame(config.cameraUrl);
}

// ---- MJPEG fan-out proxy ----
// Single upstream connection to the camera, re-streamed to all connected clients.
const MJPEG_BOUNDARY = '--mjpegboundary';
const streamClients = new Set<ServerResponse>();
const overlayClients = new Set<ServerResponse>();
let upstreamActive = false;
let overlayStore: StateStore | null = null;
let overlayProcessing = false;
const OVERLAY_MIN_INTERVAL_MS = 200; // max ~5 FPS for overlay
let lastOverlayTime = 0;

function startMjpegUpstream(cameraUrl: string): void {
  if (upstreamActive) return;
  upstreamActive = true;

  const url = new URL(cameraUrl);
  const reqOpts = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + (url.search || ''),
    method: 'GET',
    timeout: 10_000,
  };

  log.info(`Opening upstream MJPEG stream to ${cameraUrl}`);

  const req = httpRequest(reqOpts, (upstream) => {
    let buf = Buffer.alloc(0);

    upstream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      // Extract complete JPEG frames and broadcast
      while (true) {
        const startIdx = buf.indexOf(JPEG_START);
        if (startIdx === -1) { buf = Buffer.alloc(0); break; }
        const endIdx = buf.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) break; // Wait for more data

        const frame = buf.subarray(startIdx, endIdx + 2);
        buf = buf.subarray(endIdx + 2);

        // Update snapshot cache too
        cachedSnapshot = frame;
        cacheTime = Date.now();

        // Broadcast to all connected clients
        for (const client of streamClients) {
          try {
            client.write(`${MJPEG_BOUNDARY}\r\n`);
            client.write('Content-Type: image/jpeg\r\n');
            client.write(`Content-Length: ${frame.length}\r\n\r\n`);
            client.write(frame);
          } catch {
            streamClients.delete(client);
          }
        }

        // Broadcast overlay frames (throttled)
        if (overlayClients.size > 0 && !overlayProcessing) {
          const now = Date.now();
          if (now - lastOverlayTime >= OVERLAY_MIN_INTERVAL_MS) {
            lastOverlayTime = now;
            overlayProcessing = true;
            processOverlayFrame(frame).then((overlayFrame) => {
              if (!overlayFrame) return;
              for (const client of overlayClients) {
                try {
                  client.write(`${MJPEG_BOUNDARY}\r\n`);
                  client.write('Content-Type: image/jpeg\r\n');
                  client.write(`Content-Length: ${overlayFrame.length}\r\n\r\n`);
                  client.write(overlayFrame);
                } catch {
                  overlayClients.delete(client);
                }
              }
            }).catch(() => {}).finally(() => { overlayProcessing = false; });
          }
        }
      }
    });

    upstream.on('end', () => {
      log.info('Upstream stream ended');
      upstreamActive = false;
      if (streamClients.size > 0 || overlayClients.size > 0) {
        setTimeout(() => startMjpegUpstream(cameraUrl), 2000);
      }
    });

    upstream.on('error', (err) => {
      log.warn(`Upstream error: ${err.message}`);
      upstreamActive = false;
      if (streamClients.size > 0 || overlayClients.size > 0) {
        setTimeout(() => startMjpegUpstream(cameraUrl), 5000);
      }
    });
  });

  req.on('error', (err) => {
    log.warn(`Upstream connection failed: ${err.message}`);
    upstreamActive = false;
    if (streamClients.size > 0 || overlayClients.size > 0) {
      setTimeout(() => startMjpegUpstream(cameraUrl), 5000);
    }
  });

  req.on('timeout', () => {
    log.warn('Upstream connection timed out');
    req.destroy();
    upstreamActive = false;
    if (streamClients.size > 0 || overlayClients.size > 0) {
      setTimeout(() => startMjpegUpstream(cameraUrl), 2000);
    }
  });

  req.end();
}

function addStreamClient(res: ServerResponse, config: ServiceConfig): void {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'close',
  });

  streamClients.add(res);
  log.info(`Stream client connected (total: ${streamClients.size})`);

  res.on('close', () => {
    streamClients.delete(res);
    log.info(`Stream client disconnected (total: ${streamClients.size})`);
  });

  // Start upstream if not already running
  startMjpegUpstream(config.cameraUrl);
}

// ---- MJPEG overlay processing ----

function formatOverlayTime(sec: number | undefined): string {
  if (sec == null || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildOverlaySvg(width: number, height: number): string {
  const store = overlayStore;
  if (!store?.status) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`;
  }

  const s = store.status;
  const ps = s.print_status;
  const ms = s.machine_status;
  const isPrinting = ms?.status === 2;
  const statusName = STATUS_NAMES[ms?.status] ?? 'Unknown';

  const lines: string[] = [];

  const fontSize = Math.max(14, Math.round(height / 30));
  const charWidth = fontSize * 0.6; // monospace approximate
  const padding = 8;
  const maxChars = Math.max(10, Math.floor((width - padding * 2 - 8) / charWidth));

  if (isPrinting && ps?.filename) {
    const name = ps.filename.length > maxChars ? ps.filename.slice(0, maxChars - 3) + '...' : ps.filename;
    lines.push(escapeXml(name));
    lines.push(`Progress: ${ms?.progress ?? 0}%  Layer: ${ps.current_layer ?? '--'}/${ps.total_layer ?? store.fileTotalLayers ?? '??'}`);
    lines.push(`Remaining: ${formatOverlayTime(ps.remaining_time_sec)}  Elapsed: ${formatOverlayTime(ps.print_duration)}`);
  } else {
    lines.push(`Status: ${statusName}`);
  }

  // Temperatures
  const nozzle = s.extruder?.temperature?.toFixed(1) ?? '--';
  const nozzleTgt = s.extruder?.target ? `/${Math.round(s.extruder.target)}` : '';
  const bed = s.heater_bed?.temperature?.toFixed(1) ?? '--';
  const bedTgt = s.heater_bed?.target ? `/${Math.round(s.heater_bed.target)}` : '';
  lines.push(`Nozzle: ${nozzle}${nozzleTgt}°C  Bed: ${bed}${bedTgt}°C`);

  const lineHeight = fontSize * 1.3;
  const boxHeight = lines.length * lineHeight + padding * 2;
  const boxY = height - boxHeight - 4;

  let svgText = '';
  lines.forEach((line, i) => {
    const y = boxY + padding + (i + 1) * lineHeight - 2;
    svgText += `<text x="${padding + 4}" y="${y}" fill="white" font-family="monospace" font-size="${fontSize}" font-weight="bold">`
      + `<tspan stroke="black" stroke-width="3" paint-order="stroke">${line}</tspan></text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect x="2" y="${boxY}" width="${width - 4}" height="${boxHeight}" rx="4" fill="rgba(0,0,0,0.55)"/>`
    + svgText
    + `</svg>`;
}

async function processOverlayFrame(frame: Buffer): Promise<Buffer | null> {
  try {
    const meta = await sharp(frame).metadata();
    const w = meta.width || 640;
    const h = meta.height || 480;

    const svg = buildOverlaySvg(w, h);
    const svgBuf = Buffer.from(svg);

    return await sharp(frame)
      .composite([{ input: svgBuf, top: 0, left: 0 }])
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    log.warn(`Overlay processing failed: ${(err as Error).message}`);
    return null;
  }
}

function addOverlayClient(res: ServerResponse, config: ServiceConfig): void {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'close',
  });

  overlayClients.add(res);
  log.info(`Overlay client connected (total: ${overlayClients.size})`);

  res.on('close', () => {
    overlayClients.delete(res);
    log.info(`Overlay client disconnected (total: ${overlayClients.size})`);
  });

  startMjpegUpstream(config.cameraUrl);
}

let _bridge: MqttBridge | null = null;

/* ── Static file serving (production) ──────────────────────────── */

const DIST_DIR = resolve(import.meta.dirname ?? '.', '..', '..', 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(url: string, res: ServerResponse): void {
  // Strip query string
  const pathname = url.split('?')[0];
  // Prevent directory traversal
  const safePath = resolve(DIST_DIR, '.' + pathname);
  if (!safePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Try exact file, then index.html (SPA fallback)
  const candidates = [safePath, resolve(DIST_DIR, 'index.html')];
  if (safePath === DIST_DIR || safePath === DIST_DIR + '/') {
    candidates.unshift(resolve(DIST_DIR, 'index.html'));
  }

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      try {
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        // Cache hashed assets (Vite fingerprinted) aggressively
        const cacheControl = filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
        createReadStream(filePath).pipe(res);
        return;
      } catch {
        break;
      }
    }
  }

  res.writeHead(404);
  res.end('Not found');
}

export function createRestRouter(store: StateStore, config: ServiceConfig, aiMonitor?: AIMonitor | null, reportCollector?: PrintReportCollector | null, bridge?: MqttBridge | null) {
  overlayStore = store;
  if (bridge) _bridge = bridge;
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';

    // CORS headers for API routes
    if (url.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        mqtt: _bridge?.isConnected ? 'connected' : (_bridge?.brokerConnected ? 'broker_only' : 'disconnected'),
        clients: 0, // filled in by ws-transport if needed
      }));
      return;
    }

    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        attributes: store.attributes,
        status: store.status,
        canvas: store.canvas,
        files: store.files,
      }));
      return;
    }

    // /webcam/?action=stream|snapshot (mjpegstreamer-compatible)
    if (url.startsWith('/webcam/') || url === '/webcam') {
      const qIdx = url.indexOf('?');
      const qs = qIdx >= 0 ? url.slice(qIdx + 1) : '';
      const action = new URLSearchParams(qs).get('action');
      if (action === 'stream') {
        if (!config.cameraEnabled) { res.writeHead(503); res.end('Camera disabled'); return; }
        addStreamClient(res, config);
        return;
      }
      // Default to snapshot
      getSnapshot(config).then((jpeg) => {
        if (jpeg) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', 'Content-Length': jpeg.length });
          res.end(jpeg);
        } else {
          res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Camera unavailable');
        }
      }).catch(() => { res.writeHead(500); res.end('Internal error'); });
      return;
    }

    if (url === '/api/snapshot') {
      getSnapshot(config).then((jpeg) => {
        if (jpeg) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-cache',
            'Content-Length': jpeg.length,
          });
          res.end(jpeg);
        } else {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Camera unavailable');
        }
      }).catch(() => {
        res.writeHead(500);
        res.end('Internal error');
      });
      return;
    }

    if (url === '/api/stream') {
      if (!config.cameraEnabled) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Camera disabled');
        return;
      }
      addStreamClient(res, config);
      return;
    }

    if (url === '/api/stream/overlay') {
      if (!config.cameraEnabled) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Camera disabled');
        return;
      }
      addOverlayClient(res, config);
      return;
    }

    // Telegram config — GET (read) and POST (update progress interval)
    if (url === '/api/config/telegram') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: config.telegramEnabled,
          chatId: config.telegramChatId ? config.telegramChatId.slice(0, 4) + '...' : '',
          progressInterval: config.progressInterval,
        }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { progressInterval?: number };
            if (typeof data.progressInterval === 'number' &&
                data.progressInterval >= 5 && data.progressInterval <= 50) {
              (config as { progressInterval: number }).progressInterval = data.progressInterval;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, progressInterval: config.progressInterval }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid progressInterval (5-50)' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    // AI label config — GET (read) POST (update) DELETE (reset to defaults)
    if (url === '/api/config/ai-labels') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          labels: aiMonitor?.getLabelConfigs() ?? [],
          enabled: config.aiEnabled && config.aiLocalEnabled,
        }));
        return;
      }
      if (req.method === 'POST') {
        if (!aiMonitor) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AI monitor not enabled' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { labels?: AILabelConfig[] };
            if (!Array.isArray(data.labels) || data.labels.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'labels must be a non-empty array' }));
              return;
            }
            // Validate each label config
            for (const lc of data.labels) {
              if (!lc.label || typeof lc.label !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Each label must have a non-empty label string' }));
                return;
              }
              if (!['ok', 'warning', 'critical'].includes(lc.severity)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid severity: ${lc.severity}` }));
                return;
              }
              if (typeof lc.warnThreshold !== 'number' || lc.warnThreshold < 0 || lc.warnThreshold > 1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'warnThreshold must be 0-1' }));
                return;
              }
              if (typeof lc.critThreshold !== 'number' || lc.critThreshold < 0 || lc.critThreshold > 1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'critThreshold must be 0-1' }));
                return;
              }
              // Validate group if provided; default to 'Other' if missing
              const validGroups = ['Print in Progress', 'Spaghetti/Failure', 'Empty Bed', 'Paused/Stopped', 'Other'];
              if (lc.group && !validGroups.includes(lc.group)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid group: ${lc.group}` }));
                return;
              }
              if (!lc.group) {
                lc.group = 'Other';
              }
            }
            aiMonitor.setLabelConfigs(data.labels).then(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            }).catch(() => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to save' }));
            });
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
      if (req.method === 'DELETE') {
        if (!aiMonitor) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AI monitor not enabled' }));
          return;
        }
        aiMonitor.resetLabelConfigs().then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, labels: aiMonitor.getLabelConfigs() }));
        }).catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to reset' }));
        });
        return;
      }
    }

    // Debug capture: start a timed raw MQTT capture
    if (url === '/api/debug/capture' && req.method === 'POST') {
      if (activeCapture) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Capture already in progress', file: activeCapture.file }));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        let duration = 10;
        try {
          const parsed = JSON.parse(body) as { duration?: number };
          if (parsed.duration && parsed.duration > 0 && parsed.duration <= 60) {
            duration = parsed.duration;
          }
        } catch { /* use default */ }
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `mqtt-capture-${ts}.json`;
        const messages: Array<{ direction: string; topic: string; data: unknown; ts: number }> = [];
        const listener = (entry: { direction: string; topic: string; data: unknown; ts: number }) => {
          messages.push(entry);
        };
        store.on('raw', listener);
        activeCapture = { file: filename };
        setTimeout(async () => {
          store.off('raw', listener);
          activeCapture = null;
          const filePath = join('data', 'logs', filename);
          await writeFile(filePath, JSON.stringify(messages, null, 2));
          debugLog.info(`Capture saved: ${filename} (${messages.length} messages, ${duration}s)`);
        }, duration * 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: filename, duration, message: `Capturing for ${duration}s` }));
      });
      return;
    }

    // List available captures
    if (url === '/api/debug/captures' && req.method === 'GET') {
      readdir(join('data', 'logs')).then(files => {
        const captures = files.filter(f => f.startsWith('mqtt-capture-')).sort().reverse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ captures, active: activeCapture?.file ?? null }));
      }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ captures: [], active: null }));
      });
      return;
    }

    // Download a specific capture file
    if (url.startsWith('/api/debug/captures/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.slice('/api/debug/captures/'.length));
      // Prevent path traversal
      if (filename.includes('..') || filename.includes('/') || !filename.startsWith('mqtt-capture-')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid filename' }));
        return;
      }
      readFile(join('data', 'logs', filename), 'utf-8').then(content => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(content);
      }).catch(() => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
      });
      return;
    }

    // Enable video stream via SDCP WebSocket (port 3030) — what the official app does
    if (url === '/api/debug/videostream/sdcp' && req.method === 'POST') {
      if (!bridge) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bridge not available' }));
        return;
      }
      bridge.enableVideoStreamSDCP().then(result => {
        res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
      return;
    }

    // Enable video stream via MQTT method 1054 (CTRL_LIVE_STREAM)
    if (url === '/api/debug/videostream/mqtt' && req.method === 'POST') {
      if (!bridge) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bridge not available' }));
        return;
      }
      bridge.enableVideoStreamMQTT();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, note: 'Sent method 1054 Enable=1 — check MQTT log for response' }));
      return;
    }

    // Reset layer duration data
    if (url === '/api/layer-data' && req.method === 'DELETE') {
      store.clearLayerData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── File download proxy ─────────────────────────────────────────
    // GET /api/files/download?file=<path>&source=local|u-disk|sd-card
    // Gcode files are cached on disk so they can be served even when the printer is busy
    if (url.startsWith('/api/files/download') && req.method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const fileName = params.get('file');
      const source = params.get('source') || 'local';
      if (!fileName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing file parameter' }));
        return;
      }

      const isGcode = fileName.toLowerCase().endsWith('.gcode');
      const baseName = fileName.split('/').pop() || 'file';

      // Try cache first, then fall through to printer proxy
      void handleFileDownload(res, fileName, baseName, source, isGcode, config);
      return;
    }

    // ── List cached gcode files ─────────────────────────────────────
    // GET /api/files/cached — returns array of filenames that have cached gcode
    if (url.startsWith('/api/files/cached') && req.method === 'GET') {
      void (async () => {
        try {
          await ensureCacheDir();
          const cacheFiles = await readdir(GCODE_CACHE_DIR);
          const cacheHashes = new Set(cacheFiles.map(f => f.replace(/\.gcode$/, '')));
          const params = new URL(req.url || '', 'http://localhost').searchParams;
          const checkFiles = params.getAll('file');
          const cached: string[] = [];
          for (const f of checkFiles) {
            const hash = createHash('sha256').update(f).digest('hex').slice(0, 16);
            if (cacheHashes.has(hash)) cached.push(f);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ cached }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ cached: [], error: (err as Error).message }));
        }
      })();
      return;
    }

    // ── Gcode precache endpoint ──────────────────────────────────────
    // POST /api/files/precache  { file: string, source?: string }
    // Downloads gcode from printer to service cache before print start
    if (url === '/api/files/precache' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { file, source } = JSON.parse(body) as { file: string; source?: string };
          if (!file) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing file parameter' }));
            return;
          }
          const result = await precacheGcodeAsync(file, config, source || 'local');
          res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      });
      return;
    }

    // ── File upload proxy ───────────────────────────────────────────
    // POST /api/files/upload  (multipart/form-data with 'file' field)
    // Query: ?source=local|u-disk|sd-card
    if (url.startsWith('/api/files/upload') && req.method === 'POST') {
      const params = new URL(url, 'http://localhost').searchParams;
      const source = params.get('source') || 'local';
      const pathMap: Record<string, string> = { 'local': '/upload', 'u-disk': '/upload/udisk', 'sd-card': '/upload/sdcard' };
      const uploadPath = pathMap[source] ?? '/upload';

      // Parse multipart boundary from Content-Type
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing multipart boundary' }));
        return;
      }

      // Collect full body (gcode files are typically < 100MB)
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const MAX_UPLOAD = 500 * 1024 * 1024; // 500MB limit
      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File too large (max 500MB)' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks);

          // Extract the file from multipart data
          const boundary = boundaryMatch[1];
          const { fileName, fileData } = parseMultipart(body, boundary);
          if (!fileName || !fileData) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No file found in upload' }));
            return;
          }

          // Compute MD5 of entire file
          const md5 = createHash('md5').update(fileData).digest('hex');

          // Upload in 1MB chunks via PUT
          const CHUNK_SIZE = 1024 * 1024;
          const totalBytes = fileData.length;
          let offset = 0;

          while (offset < totalBytes) {
            const end = Math.min(offset + CHUNK_SIZE, totalBytes);
            const chunkData = fileData.subarray(offset, end);

            const chunkResult = await uploadChunk(
              config.printerIp, uploadPath, config.printerPassword,
              fileName, md5, chunkData, offset, end - 1, totalBytes,
            );

            if (chunkResult.error_code !== 0) {
              // Retry once on offset mismatch
              if (chunkResult.error_code === 9000) {
                const retry = await uploadChunk(
                  config.printerIp, uploadPath, config.printerPassword,
                  fileName, md5, chunkData, offset, end - 1, totalBytes,
                );
                if (retry.error_code !== 0) {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: `Upload failed at offset ${offset}`, error_code: retry.error_code }));
                  return;
                }
              } else {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Upload failed at offset ${offset}`, error_code: chunkResult.error_code }));
                return;
              }
            }

            offset = end;
          }

          log.info(`Upload complete: ${fileName} (${formatUploadSize(totalBytes)}, MD5: ${md5})`);

          // Cache the uploaded gcode on the service for preview
          if (fileName.toLowerCase().endsWith('.gcode')) {
            void cacheGcodeBuffer(fileName, fileData);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, fileName, size: totalBytes, md5 }));
        } catch (err) {
          log.error(`Upload error: ${(err as Error).message}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Upload failed' }));
          }
        }
      });
      return;
    }

    // JSON metrics endpoint
    if (url === '/api/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildMetrics(store)));
      return;
    }

    // Prometheus metrics endpoint
    if (url === '/api/metrics/prometheus' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(buildPrometheusMetrics(store));
      return;
    }

    // ── Print Reports ───────────────────────────────────────────────
    if (url === '/api/reports' && req.method === 'GET') {
      if (!reportCollector) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reports: [] }));
        return;
      }
      reportCollector.listReports().then(reports => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reports, active: reportCollector.isActive() }));
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to list reports' }));
      });
      return;
    }

    if (url.startsWith('/api/reports/') && req.method === 'GET') {
      if (!reportCollector) { res.writeHead(404); res.end('Not found'); return; }
      const parts = url.slice('/api/reports/'.length).split('/');
      const reportId = decodeURIComponent(parts[0]);
      const action = parts[1];

      // Validate report ID
      if (!reportId || reportId.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid report ID' }));
        return;
      }

      // GET /api/reports/:id/pdf — Download PDF
      if (action === 'pdf') {
        Promise.all([
          reportCollector.getReport(reportId),
          reportCollector.getChartData(reportId),
        ]).then(async ([report, chartData]) => {
          if (!report) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Report not found' }));
            return;
          }
          const pdf = await generateReportPDF(report, chartData ?? [], join(config.dataDir, 'reports'));
          const safeName = report.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="report-${safeName}.pdf"`,
            'Content-Length': pdf.length,
          });
          res.end(pdf);
        }).catch((err) => {
          log.error(`PDF generation failed: ${err}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'PDF generation failed' }));
          }
        });
        return;
      }

      // GET /api/reports/:id/snapshot/:filename — Download snapshot JPEG
      if (action === 'snapshot' && parts[2]) {
        const snapName = decodeURIComponent(parts[2]);
        if (snapName.includes('..') || !snapName.endsWith('.jpg')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid snapshot filename' }));
          return;
        }
        reportCollector.getSnapshot(reportId, snapName).then(jpeg => {
          if (jpeg) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
            res.end(jpeg);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Snapshot not found' }));
          }
        }).catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read snapshot' }));
        });
        return;
      }

      // GET /api/reports/:id — Report JSON
      reportCollector.getReport(reportId).then(report => {
        if (report) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(report));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Report not found' }));
        }
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read report' }));
      });
      return;
    }

    if (url.startsWith('/api/reports/') && req.method === 'DELETE') {
      if (!reportCollector) { res.writeHead(404); res.end('Not found'); return; }
      const reportId = decodeURIComponent(url.slice('/api/reports/'.length));
      if (!reportId || reportId.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid report ID' }));
        return;
      }
      reportCollector.deleteReport(reportId).then(ok => {
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to delete report' }));
      });
      return;
    }

    // ── Client error reporting ───────────────────────────────────────
    if (url === '/api/client-error' && req.method === 'POST') {
      handleClientError(req, res);
      return;
    }

    // Not an API route — serve static files from dist/
    serveStatic(url, res);

    function handleClientError(req: IncomingMessage, res: ServerResponse): void {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        if (body.length > 8192) return; // cap at 8KB
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body) as { message?: string; stack?: string; url?: string; line?: number; col?: number };
          const msg = typeof data.message === 'string' ? data.message.slice(0, 500) : 'unknown';
          const stack = typeof data.stack === 'string' ? data.stack.slice(0, 2000) : '';
          const url = typeof data.url === 'string' ? data.url.slice(0, 200) : '';
          const line = typeof data.line === 'number' ? data.line : 0;
          const col = typeof data.col === 'number' ? data.col : 0;
          log.warn(`[ClientError] ${msg} at ${url}:${line}:${col}${stack ? '\\n' + stack : ''}`);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    }
  };
}

/* ── File upload helpers ──────────────────────────────────────────── */

function parseMultipart(body: Buffer, boundary: string): { fileName: string | null; fileData: Buffer | null } {
  const sep = Buffer.from(`--${boundary}`);
  let start = body.indexOf(sep);
  if (start === -1) return { fileName: null, fileData: null };

  // Find the part with Content-Disposition containing filename
  while (start !== -1) {
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;

    const headers = body.subarray(start, headerEnd).toString('utf-8');
    const nameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      const dataStart = headerEnd + 4;
      const nextBoundary = body.indexOf(sep, dataStart);
      const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : body.length; // -2 for \r\n before boundary
      return { fileName: nameMatch[1], fileData: body.subarray(dataStart, dataEnd) };
    }

    start = body.indexOf(sep, start + sep.length);
  }
  return { fileName: null, fileData: null };
}

function uploadChunk(
  printerIp: string, uploadPath: string, password: string,
  fileName: string, md5: string, chunk: Buffer,
  rangeStart: number, rangeEnd: number, totalSize: number,
): Promise<{ error_code: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: printerIp,
      port: 80,
      path: uploadPath,
      method: 'PUT',
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': chunk.length,
        'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${totalSize}`,
        'X-Token': password,
        'X-File-Name': encodeURIComponent(fileName),
        'X-File-MD5': md5,
      },
    }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as { error_code: number });
        } catch {
          resolve({ error_code: -1 });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upload chunk timeout')); });
    req.write(chunk);
    req.end();
  });
}

function formatUploadSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ── Metrics helpers ─────────────────────────────────────────────── */

function fanPct(speed: number): number {
  return Math.round((speed / 255) * 100);
}

function buildMetrics(store: StateStore) {
  const s = store.status;
  const a = store.attributes;
  const ms = s?.machine_status;
  const ps = s?.print_status;
  const ext = s?.extruder;
  const bed = s?.heater_bed;
  const ch = s?.ztemperature_sensor;
  const fans = s?.fans;
  const gm = s?.gcode_move;
  const layers = store.layerTimes;

  const avgLayerDur = layers.length > 0
    ? layers.reduce((sum, l) => sum + l.duration, 0) / layers.length
    : null;
  const lastLayerDur = layers.length > 0 ? layers[layers.length - 1].duration : null;

  return {
    printer: a ? {
      model: a.machine_model,
      sn: a.sn,
      ip: a.ip,
      firmware: a.software_version?.ota_version ?? null,
    } : null,
    connected: !!_bridge?.isConnected,
    state: {
      status: ms?.status ?? null,
      status_name: STATUS_NAMES[ms?.status ?? -1] ?? 'Unknown',
      sub_status: ms?.sub_status ?? null,
      sub_status_name: SUB_STATUS_NAMES[ms?.sub_status ?? 0] || null,
      progress: ms?.progress ?? null,
      exceptions: (ms?.exception_status ?? []).map(c => ({
        code: c,
        name: EXCEPTION_NAMES[c] ?? `Unknown (${c})`,
      })),
    },
    temperature: {
      nozzle: ext?.temperature ?? null,
      nozzle_target: ext?.target ?? null,
      bed: bed?.temperature ?? null,
      bed_target: bed?.target ?? null,
      chamber: ch?.temperature ?? null,
    },
    fans: fans ? {
      part_fan: fanPct(fans.fan?.speed ?? 0),
      aux_fan: fanPct(fans.aux_fan?.speed ?? 0),
      box_fan: fanPct(fans.box_fan?.speed ?? 0),
      heater_fan: fanPct(fans.heater_fan?.speed ?? 0),
      controller_fan: fanPct(fans.controller_fan?.speed ?? 0),
    } : null,
    position: gm ? {
      x: gm.x,
      y: gm.y,
      z: gm.z,
      speed: gm.speed,
      speed_mode: gm.speed_mode,
      speed_mode_name: SPEED_MODE_NAMES[gm.speed_mode] ?? 'Unknown',
    } : null,
    print: ps ? {
      filename: ps.filename || null,
      current_layer: ps.current_layer,
      total_layer: ps.total_layer ?? store.fileTotalLayers ?? null,
      print_duration: ps.print_duration,
      remaining_time_sec: ps.remaining_time_sec,
    } : null,
    filament_detected: ext?.filament_detected ?? null,
    filament_usage: store.getFilamentUsageArray(),
    layers: {
      count: layers.length,
      avg_duration_sec: avgLayerDur != null ? Math.round(avgLayerDur * 10) / 10 : null,
      last_duration_sec: lastLayerDur ?? null,
    },
  };
}

function buildPrometheusMetrics(store: StateStore): string {
  const lines: string[] = [];
  const s = store.status;
  const a = store.attributes;
  const ms = s?.machine_status;
  const ps = s?.print_status;
  const ext = s?.extruder;
  const bed = s?.heater_bed;
  const ch = s?.ztemperature_sensor;
  const fans = s?.fans;
  const gm = s?.gcode_move;
  const layers = store.layerTimes;

  const labels = a
    ? `model="${a.machine_model}",sn="${a.sn}"`
    : '';

  function g(name: string, help: string, value: number | null | undefined, extra = '') {
    if (value == null) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    const lab = [labels, extra].filter(Boolean).join(',');
    lines.push(`${name}{${lab}} ${value}`);
  }

  // Connection
  g('elegoo_connected', 'Printer MQTT connection state (1=connected, 0=disconnected)', _bridge?.isConnected ? 1 : 0);

  // Machine state
  g('elegoo_machine_status', 'Machine status code', ms?.status);
  g('elegoo_machine_sub_status', 'Machine sub-status code', ms?.sub_status);
  g('elegoo_print_progress', 'Print progress percentage (0-100)', ms?.progress);

  // Temperatures
  g('elegoo_nozzle_temperature_celsius', 'Nozzle temperature', ext?.temperature);
  g('elegoo_nozzle_target_celsius', 'Nozzle target temperature', ext?.target);
  g('elegoo_bed_temperature_celsius', 'Bed temperature', bed?.temperature);
  g('elegoo_bed_target_celsius', 'Bed target temperature', bed?.target);
  g('elegoo_chamber_temperature_celsius', 'Chamber temperature', ch?.temperature);

  // Fans (as percentage 0-100)
  if (fans) {
    const fanEntries: [string, FanInfo | undefined][] = [
      ['part', fans.fan], ['aux', fans.aux_fan], ['box', fans.box_fan],
      ['heater', fans.heater_fan], ['controller', fans.controller_fan],
    ];
    lines.push('# HELP elegoo_fan_speed_percent Fan speed percentage');
    lines.push('# TYPE elegoo_fan_speed_percent gauge');
    for (const [name, fi] of fanEntries) {
      if (fi == null) continue;
      const lab = [labels, `fan="${name}"`].filter(Boolean).join(',');
      lines.push(`elegoo_fan_speed_percent{${lab}} ${fanPct(fi.speed)}`);
    }
  }

  // Position
  if (gm) {
    g('elegoo_position_x_mm', 'Toolhead X position', gm.x);
    g('elegoo_position_y_mm', 'Toolhead Y position', gm.y);
    g('elegoo_position_z_mm', 'Toolhead Z position', gm.z);
    g('elegoo_speed_mm_per_min', 'Toolhead speed', gm.speed);
    g('elegoo_speed_mode', 'Speed mode (0=Silent,1=Balanced,2=Sport,3=Ludicrous)', gm.speed_mode);
  }

  // Print info
  if (ps) {
    g('elegoo_print_current_layer', 'Current print layer', ps.current_layer);
    g('elegoo_print_total_layers', 'Total print layers', ps.total_layer ?? store.fileTotalLayers ?? undefined);
    g('elegoo_print_duration_seconds', 'Elapsed print time in seconds', ps.print_duration);
    g('elegoo_print_remaining_seconds', 'Estimated remaining time in seconds', ps.remaining_time_sec);
  }

  // Filament detected
  g('elegoo_filament_detected', 'Filament detected (1=yes, 0=no)', ext?.filament_detected);

  // Filament usage per spool
  const usage = store.getFilamentUsageArray();
  if (usage.length > 0) {
    lines.push('# HELP elegoo_filament_used_grams Filament used in grams');
    lines.push('# TYPE elegoo_filament_used_grams gauge');
    for (const u of usage) {
      const lab = [labels, `tray="${u.trayKey}",type="${u.filamentType}"`].filter(Boolean).join(',');
      lines.push(`elegoo_filament_used_grams{${lab}} ${Math.round(u.grams * 100) / 100}`);
    }
    lines.push('# HELP elegoo_filament_used_meters Filament used in meters');
    lines.push('# TYPE elegoo_filament_used_meters gauge');
    for (const u of usage) {
      const lab = [labels, `tray="${u.trayKey}",type="${u.filamentType}"`].filter(Boolean).join(',');
      lines.push(`elegoo_filament_used_meters{${lab}} ${Math.round(u.meters * 1000) / 1000}`);
    }
  }

  // Layer stats
  if (layers.length > 0) {
    g('elegoo_layer_count', 'Number of recorded layer times', layers.length);
    const avgDur = layers.reduce((sum, l) => sum + l.duration, 0) / layers.length;
    g('elegoo_layer_avg_duration_seconds', 'Average layer duration', Math.round(avgDur * 10) / 10);
    g('elegoo_layer_last_duration_seconds', 'Last layer duration', layers[layers.length - 1].duration);
  }

  // Exceptions
  const exceptions = ms?.exception_status ?? [];
  if (exceptions.length > 0) {
    lines.push('# HELP elegoo_exception Active exception (1=active)');
    lines.push('# TYPE elegoo_exception gauge');
    for (const code of exceptions) {
      const name = EXCEPTION_NAMES[code] ?? `unknown_${code}`;
      const lab = [labels, `code="${code}",name="${name}"`].filter(Boolean).join(',');
      lines.push(`elegoo_exception{${lab}} 1`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
