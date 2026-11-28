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
 *   GET /api/health    — Service health check (incl. the deployed build stamp)
 *   GET /api/files/download — Proxy file download from printer
 *   POST /api/files/upload  — Proxy file upload to printer (chunked PUT)
 *   GET /api/timelapse/video?url=<timelapse_url> — Stream a timelapse video from the printer
 *                              (host is always the configured printer; Range passthrough)
 */

import type { ClientRequest, IncomingMessage, ServerResponse } from 'http';
import { request as httpRequest } from 'http';
import { createHash } from 'crypto';
import { writeFile, readdir, readFile, mkdir, stat, unlink, rename } from 'fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { join, resolve, extname } from 'path';
import { PassThrough } from 'stream';
import sharp from 'sharp';
import type { StateStore } from './state-store.js';
import type { ServiceConfig } from './config.js';
import type { AIMonitor, AILabelConfig } from './ai-monitor.js';
import type { PrintReportCollector } from './print-report-collector.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { PrintQueue } from './print-queue.js';
import { handlePrintQueueRequest } from './print-queue-routes.js';
import { generateReportPDF } from './print-report-pdf.js';
import { getBuildInfo } from './build-info.js';
import { applyCors, corsHeaders } from './cors.js';
import { guardHttp } from './write-auth.js';
import { captureLogDir, gcodeCacheDir } from './data-paths.js';
import { getLogger } from './logger.js';
import {
  buildPrinterDownloadPath,
  resolveTimelapseUpstream,
  type TimelapseDownload,
  type TimelapseUpstream,
} from './timelapse-proxy.js';
import {
  STATUS_NAMES,
  SUB_STATUS_NAMES,
  SPEED_MODE_NAMES,
  EXCEPTION_NAMES,
  mqttPhaseMessage,
} from '../types.js';
import type { CameraHealth, FanInfo } from '../types.js';
import {
  CameraEvidence,
  type CameraHealthInput,
  deriveCameraHealth,
  printerCameraReport,
} from './camera-health.js';

const log = getLogger('REST');
const debugLog = getLogger('Debug');

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const CACHE_TTL_MS = 5_000;

let cachedSnapshot: Buffer | null = null;
let cacheTime = 0;
let fetchInFlight: Promise<Buffer | null> | null = null;
/**
 * Bumped when the service switches printer (ELEG-95). Camera work started for the
 * previous printer checks it before touching shared state, so a late frame, retry or
 * error from printer A cannot land in printer B's snapshot cache or stream.
 */
let cameraGeneration = 0;
/** What really happened on the camera path — the input to `getCameraHealth` (ELEG-178). */
const cameraEvidence = new CameraEvidence();
/** Bound on the snapshot fetch, headers **and** body. */
const SNAPSHOT_TIMEOUT_MS = 10_000;

// Debug capture state
let activeCapture: { file: string } | null = null;

// ── Gcode file cache ────────────────────────────────────────────
// Path helpers live in data-paths.ts so DATA_DIR is honoured — this used to be
// join(process.cwd(), 'data', 'gcode-cache'), which ignored it (ELEG-70).
const GCODE_CACHE_MAX = 10; // keep at most N cached files

// Keyed by printer identity as well as file name (ELEG-105) — two presets
// routinely hold a same-named file (a slicer's default export name) with
// different contents, and the cache dir is shared process-wide. `printerKey`
// is `config.printerIp`, which already follows the active preset (ELEG-95).
export function gcodeCacheKey(printerKey: string, fileName: string): string {
  return (
    createHash('sha256').update(`${printerKey}\0${fileName}`).digest('hex').slice(0, 16) + '.gcode'
  );
}

async function ensureCacheDir(): Promise<void> {
  await mkdir(gcodeCacheDir(), { recursive: true });
}

/** Cache a gcode file from a Buffer (e.g. after upload) */
export async function cacheGcodeBuffer(
  fileName: string,
  data: Buffer,
  config: ServiceConfig,
): Promise<void> {
  try {
    await ensureCacheDir();
    const cachePath = join(gcodeCacheDir(), gcodeCacheKey(config.printerIp, fileName));
    await writeFile(cachePath, data);
    await evictOldCache();
    log.info(`Cached uploaded gcode: ${fileName} (${data.length} bytes)`);
  } catch (err) {
    log.warn(`Failed to cache uploaded gcode ${fileName}: ${(err as Error).message}`);
  }
}

async function getCachedGcode(fileName: string, config: ServiceConfig): Promise<string | null> {
  try {
    const cached = join(gcodeCacheDir(), gcodeCacheKey(config.printerIp, fileName));
    const s = await stat(cached);
    if (s.size > 0) return cached;
  } catch {
    /* not cached */
  }
  return null;
}

async function evictOldCache(): Promise<void> {
  try {
    const files = await readdir(gcodeCacheDir());
    if (files.length <= GCODE_CACHE_MAX) return;
    const entries = await Promise.all(
      files.map(async (f) => {
        const p = join(gcodeCacheDir(), f);
        const s = await stat(p).catch(() => null);
        return { path: p, mtime: s?.mtimeMs ?? 0 };
      }),
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    const toRemove = entries.slice(0, entries.length - GCODE_CACHE_MAX);
    await Promise.all(toRemove.map((e) => unlink(e.path).catch(() => {})));
  } catch {
    /* ignore */
  }
}

/** Upstream port and idle timeout of the printer download; injectable for tests. */
export interface DownloadUpstreamOptions {
  port?: number;
  timeoutMs?: number;
}

const PRINTER_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * What the printer's `/download` does while a print is running (ELEG-136, measured
 * 2026-11-28 on firmware 02.01.01.07): it accepts the TCP connection, never sends
 * response headers, and closes the socket after ~75 s — for the file being printed
 * and for any other file alike. Node reports that as `ECONNRESET` ("socket hang up"),
 * which is not a failure to connect, so it gets its own message (ELEG-200).
 */
export const PRINTER_CLOSED_DOWNLOAD_MESSAGE =
  'The printer closed the download without sending the file. It does not serve files ' +
  'while a print is running — the preview loads if the file was cached before the ' +
  'print started, or once the print has finished.';

/** Status and message for an upstream request error that arrived before any response. */
export function printerDownloadError(code: string | undefined): {
  status: number;
  message: string;
} {
  if (code === 'ECONNRESET') return { status: 502, message: PRINTER_CLOSED_DOWNLOAD_MESSAGE };
  return { status: 502, message: 'Failed to connect to printer' };
}

export async function handleFileDownload(
  res: ServerResponse,
  fileName: string,
  baseName: string,
  source: string,
  isGcode: boolean,
  config: ServiceConfig,
  upstream: DownloadUpstreamOptions = {},
): Promise<void> {
  const port = upstream.port ?? 80;
  const timeoutMs = upstream.timeoutMs ?? PRINTER_DOWNLOAD_TIMEOUT_MS;
  // Try serving from cache first (gcode files only)
  if (isGcode) {
    try {
      await ensureCacheDir();
      const cached = await getCachedGcode(fileName, config);
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
    } catch {
      /* cache miss, fall through to printer */
    }
  }

  const pathMap: Record<string, string> = {
    local: '/download',
    'u-disk': '/download/udisk',
    'sd-card': '/download/sdcard',
  };
  const dlPath = pathMap[source] ?? '/download';
  log.info(`Download proxy: ${fileName} from ${dlPath}`);

  let failed = false;
  let discardPartial: (() => void) | null = null;
  // End the download. Before headers: the JSON error. After headers a status can no
  // longer be sent, so the only way to tell the browser is to destroy the response
  // (it used to be left open forever) and drop the partial cache file.
  const failDownload = (
    reason: string,
    status = 502,
    message = 'Printer download failed',
  ): void => {
    if (failed) return;
    failed = true;
    discardPartial?.();
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    } else {
      log.warn(`Download proxy: ${fileName} ended early (${reason}), destroying response`);
      res.destroy();
    }
    proxyReq.destroy();
  };

  const proxyReq = httpRequest(
    {
      hostname: config.printerIp,
      port,
      path: `${dlPath}?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
      method: 'GET',
      timeout: timeoutMs,
      // Printer's libhv sends both Content-Length and Transfer-Encoding: chunked,
      // which is invalid HTTP. Node's strict parser rejects this.
      insecureHTTPParser: true,
    },
    (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        res.writeHead(proxyRes.statusCode ?? 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Printer returned ${proxyRes.statusCode}` }));
        proxyRes.resume();
        return;
      }
      // Keep the socket alive during slow transfers
      proxyRes.socket?.setTimeout(timeoutMs);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${baseName}"`,
        ...(proxyRes.headers['content-length']
          ? { 'Content-Length': proxyRes.headers['content-length'] }
          : {}),
      });

      // The printer went away or stalled mid-body: the response must not be left open.
      proxyRes.on('aborted', () => failDownload('upstream aborted mid-body'));
      proxyRes.on('close', () => {
        if (!proxyRes.complete) failDownload('upstream closed before the body completed');
      });
      // The browser left: stop pulling from the printer and drop the partial file.
      res.on('close', () => {
        if (!res.writableFinished) failDownload('client closed the download');
      });

      // For gcode files, tee the stream to a cache file. It is written under a
      // `.part` name and only renamed into place once the whole body arrived, so a
      // partial file can never be served from the cache.
      if (isGcode) {
        const cachePath = join(gcodeCacheDir(), gcodeCacheKey(config.printerIp, fileName));
        const partPath = `${cachePath}.part`;
        const cacheStream = createWriteStream(partPath);
        const tee = new PassThrough();
        tee.pipe(res);
        tee.pipe(cacheStream);
        proxyRes.pipe(tee);
        discardPartial = () => {
          tee.destroy();
          cacheStream.once('close', () => {
            unlink(partPath).catch(() => {});
          });
          cacheStream.destroy();
        };
        cacheStream.on('finish', () => {
          if (failed || !proxyRes.complete) return;
          rename(partPath, cachePath)
            .then(() => {
              evictOldCache().catch(() => {});
              log.info(`Cached gcode: ${fileName}`);
            })
            .catch(() => {
              unlink(partPath).catch(() => {});
            });
        });
        cacheStream.on('error', () => {
          unlink(partPath).catch(() => {});
        });
      } else {
        proxyRes.pipe(res);
      }
    },
  );
  proxyReq.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    log.error(`Download proxy error: ${code} ${err.message}`);
    const { status, message } = printerDownloadError(code);
    failDownload('upstream error', status, message);
  });
  proxyReq.on('timeout', () => {
    log.error('Download proxy timeout');
    failDownload('upstream timeout', 504, 'Download timed out');
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
  fileName: string,
  config: ServiceConfig,
  source = 'local',
): Promise<{ ok: boolean; cached: boolean; size: number; error?: string }> {
  try {
    await ensureCacheDir();
    const existing = await getCachedGcode(fileName, config);
    if (existing) {
      const s = await stat(existing);
      log.info(`Precache: ${fileName} already cached (${s.size} bytes)`);
      return { ok: true, cached: true, size: s.size };
    }

    const pathMap: Record<string, string> = {
      local: '/download',
      'u-disk': '/download/udisk',
      'sd-card': '/download/sdcard',
    };
    const dlPath = pathMap[source] ?? '/download';
    log.info(`Precache: downloading ${fileName} from ${dlPath}`);

    const cachePath = join(gcodeCacheDir(), gcodeCacheKey(config.printerIp, fileName));

    const size = await new Promise<number>((resolve, reject) => {
      const proxyReq = httpRequest(
        {
          hostname: config.printerIp,
          port: 80,
          path: `${dlPath}?X-Token=${encodeURIComponent(config.printerPassword)}&file_name=${encodeURIComponent(fileName)}`,
          method: 'GET',
          timeout: 120_000,
          insecureHTTPParser: true,
        },
        (proxyRes) => {
          if (proxyRes.statusCode !== 200) {
            proxyRes.resume();
            reject(new Error(`Printer returned ${proxyRes.statusCode}`));
            return;
          }
          proxyRes.socket?.setTimeout(120_000);
          // Written as `.part` and renamed only when the body completed, so a stalled
          // or aborted download never leaves a partial file the cache would serve.
          const partPath = `${cachePath}.part`;
          const cacheStream = createWriteStream(partPath);
          discardPartial = () => {
            cacheStream.once('close', () => {
              unlink(partPath).catch(() => {});
            });
            cacheStream.destroy();
          };
          let bytes = 0;
          proxyRes.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
          });
          proxyRes.on('close', () => {
            if (!proxyRes.complete)
              fail(new Error('Precache download ended before the body completed'));
          });
          proxyRes.pipe(cacheStream);
          cacheStream.on('finish', () => {
            if (failed || !proxyRes.complete) return;
            rename(partPath, cachePath)
              .then(() => {
                evictOldCache().catch(() => {});
                log.info(`Precache: cached ${fileName} (${bytes} bytes)`);
                resolve(bytes);
              })
              .catch((err: unknown) => fail(err as Error));
          });
          cacheStream.on('error', (err) => fail(err));
        },
      );
      let failed = false;
      let discardPartial: (() => void) | null = null;
      const fail = (err: Error): void => {
        if (failed) return;
        failed = true;
        discardPartial?.();
        proxyReq.destroy();
        reject(err);
      };
      proxyReq.on('error', (err) => fail(err));
      proxyReq.on('timeout', () => fail(new Error('Precache download timed out')));
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

  const generation = cameraGeneration;
  const attempt = doFetch(cameraUrl);
  fetchInFlight = attempt.then((r) => r.frame);
  try {
    const result = await attempt;
    // The printer was switched while this was in flight: it is the old camera's frame,
    // and its failure is the old camera's failure.
    if (generation !== cameraGeneration) return null;
    if (result.frame) {
      cachedSnapshot = result.frame;
      cacheTime = Date.now();
      cameraEvidence.frame(cacheTime);
    } else {
      cameraEvidence.failed(result.error);
    }
    return result.frame;
  } finally {
    fetchInFlight = null;
  }
}

type FetchResult = { frame: Buffer; error?: undefined } | { frame: null; error: string };

/** The underlying cause of a `fetch failed` (`connect ECONNREFUSED …`), or the message. */
function describeFetchError(err: unknown): string {
  const e = err as Error & { cause?: { message?: string } };
  if (e?.name === 'AbortError') {
    return `Snapshot timed out after ${SNAPSHOT_TIMEOUT_MS / 1000} s`;
  }
  return `Snapshot failed: ${e?.cause?.message || e?.message || String(err)}`;
}

async function doFetch(cameraUrl: string): Promise<FetchResult> {
  const controller = new AbortController();
  // Bounds the body read too. It used to be cleared once the headers arrived, so a
  // camera that answered and then stalled pinned `fetchInFlight` — and every later
  // snapshot — for ever (ELEG-178).
  const timeout = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  try {
    const res = await fetch(cameraUrl, { signal: controller.signal });

    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { frame: null, error: `Camera answered HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
      return { frame: Buffer.from(await res.arrayBuffer()) };
    }

    // MJPEG stream — extract first frame
    if (!res.body) return { frame: null, error: 'Camera answered with an empty body' };
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

        return { frame: combined.subarray(startIdx, endIdx + 2) };
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    return { frame: null, error: 'Camera response held no JPEG frame' };
  } catch (err) {
    const error = describeFetchError(err);
    log.warn(error);
    return { frame: null, error };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The camera's health, from evidence (ELEG-178): see `deriveCameraHealth`. Exported for
 * `/ws` `service_status` (`camera` + `cameraHealth`) and `/api/health` (`camera`), and
 * for the camera card and AI monitor work that builds on it (ELEG-166, ELEG-168).
 */
export function getCameraHealth(input: CameraHealthInput): CameraHealth {
  return deriveCameraHealth(cameraEvidence, input);
}

/** `getCameraHealth` for the service's own bridge and store — what `/api/health` reports. */
function currentCameraHealth(config: ServiceConfig, store: StateStore): CameraHealth {
  return getCameraHealth({
    enabled: config.cameraEnabled,
    printerReportsCamera: printerCameraReport(_bridge?.isConnected ?? false, store.status),
  });
}

/** Shared snapshot fetcher — used by both REST API, Telegram, and AI monitor.
 *  Prefers the cached frame from the active MJPEG fan-out stream (zero-cost).
 *  Only falls back to a dedicated HTTP fetch if no recent frame is available. */
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

let upstreamReq: ClientRequest | null = null;

/**
 * Timeouts on the stream path (ELEG-178). `upstreamMs` is the socket idle timeout on the
 * one upstream connection: no bytes for that long is a failure. `stallMs` bounds how long
 * a viewer waits without a frame before its response is ended with the reason, so a dead
 * camera is an answer, not a hang. Mutable only so tests need not wait 10 s.
 */
const cameraTimeouts = { upstreamMs: 10_000, stallMs: 20_000, idleCloseMs: 5_000 };

/** Stops the live upstream attempt quietly (no failure, no retry); null with none open. */
let stopUpstream: (() => void) | null = null;
let idleCloseTimer: NodeJS.Timeout | null = null;

function cancelIdleClose(): void {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = null;
}

/**
 * ELEG-184: when the last viewer leaves, close the upstream after a short grace period, so
 * the printer's few MJPEG client slots are not held for frames nobody sees. The grace lets a
 * page reload or a stream/overlay toggle reuse the connection; a viewer arriving in it
 * cancels the close (see `addViewer`).
 */
function scheduleIdleClose(): void {
  if (streamClients.size > 0 || overlayClients.size > 0) return;
  if (!upstreamActive || idleCloseTimer) return;
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    if (streamClients.size > 0 || overlayClients.size > 0) return;
    log.info('No camera viewers left; closing the upstream MJPEG stream');
    stopUpstream?.();
  }, cameraTimeouts.idleCloseMs);
  idleCloseTimer.unref();
}

/** Test seam: shorten the stream timeouts. Production never calls this. */
export function setCameraTimeouts(t: Partial<typeof cameraTimeouts>): void {
  Object.assign(cameraTimeouts, t);
}

/** Per viewer: has it ever had a frame, and the watchdog that ends it if frames stop. */
const viewerState = new Map<ServerResponse, { gotFrame: boolean; watchdog: NodeJS.Timeout }>();

function writeFramePart(client: ServerResponse, frame: Buffer): void {
  client.write(`${MJPEG_BOUNDARY}\r\n`);
  client.write('Content-Type: image/jpeg\r\n');
  client.write(`Content-Length: ${frame.length}\r\n\r\n`);
  client.write(frame);
  const v = viewerState.get(client);
  if (v) {
    v.gotFrame = true;
    v.watchdog.refresh();
  }
}

/**
 * End one viewer's response with the reason. The 200 and the multipart headers are already
 * on the wire (they are flushed on connect), so the error is in-band: a final `text/plain`
 * part, then the end of the response.
 */
function endViewer(client: ServerResponse, reason: string): void {
  const v = viewerState.get(client);
  if (v) clearTimeout(v.watchdog);
  viewerState.delete(client);
  streamClients.delete(client);
  overlayClients.delete(client);
  scheduleIdleClose();
  if (client.writableEnded) return;
  try {
    const body = `Camera unavailable: ${reason}\r\n`;
    client.write(`${MJPEG_BOUNDARY}\r\n`);
    client.write('Content-Type: text/plain; charset=utf-8\r\n');
    client.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
    client.end(body);
  } catch {
    client.destroy();
  }
}

/**
 * The upstream failed. A viewer that has never had a frame has nothing to resume, so it
 * gets the reason now rather than waiting on a retry loop; a viewer that was watching keeps
 * its response open for the retry, bounded by its own watchdog.
 */
function failWaitingViewers(reason: string): void {
  for (const [client, v] of [...viewerState]) {
    if (!v.gotFrame) endViewer(client, reason);
  }
}

function startMjpegUpstream(cameraUrl: string): void {
  if (upstreamActive) return;
  upstreamActive = true;
  const generation = cameraGeneration;
  /** False once the service has switched printer: this upstream must then go quiet. */
  const current = () => generation === cameraGeneration;
  cameraEvidence.attemptStarted();
  /** One failure per attempt: a timeout's destroy() also raises `error`, which is noise. */
  let settled = false;
  const fail = (reason: string, retryMs: number) => {
    if (settled || !current()) return;
    settled = true;
    log.warn(`Upstream: ${reason}`);
    cameraEvidence.failed(reason);
    upstreamActive = false;
    upstreamReq = null;
    stopUpstream = null;
    failWaitingViewers(reason);
    // Retry only for a viewer still holding a response — no blind loop with nobody watching.
    if (streamClients.size > 0 || overlayClients.size > 0) {
      setTimeout(() => {
        if (current() && (streamClients.size > 0 || overlayClients.size > 0)) {
          startMjpegUpstream(cameraUrl);
        }
      }, retryMs);
    }
  };
  stopUpstream = () => {
    if (settled || !current()) return;
    settled = true; // silences fail() for the error the destroy raises
    if (cameraEvidence.connectingSince !== null) cameraEvidence.attemptEnded();
    upstreamActive = false;
    upstreamReq = null;
    stopUpstream = null;
    req.destroy();
  };

  const url = new URL(cameraUrl);
  const reqOpts = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + (url.search || ''),
    method: 'GET',
    timeout: cameraTimeouts.upstreamMs,
  };

  log.info(`Opening upstream MJPEG stream to ${cameraUrl}`);

  const req = httpRequest(reqOpts, (upstream) => {
    let buf = Buffer.alloc(0);

    // A non-200 used to be parsed as if it were the stream, then looped through a retry
    // with no trace of why (ELEG-178).
    if (upstream.statusCode !== 200) {
      upstream.resume();
      req.destroy();
      fail(`Camera answered HTTP ${upstream.statusCode}`, 5000);
      return;
    }

    upstream.on('data', (chunk: Buffer) => {
      if (!current()) return;
      buf = Buffer.concat([buf, chunk]);

      // Extract complete JPEG frames and broadcast
      while (true) {
        const startIdx = buf.indexOf(JPEG_START);
        if (startIdx === -1) {
          buf = Buffer.alloc(0);
          break;
        }
        const endIdx = buf.indexOf(JPEG_END, startIdx + 2);
        if (endIdx === -1) break; // Wait for more data

        const frame = buf.subarray(startIdx, endIdx + 2);
        buf = buf.subarray(endIdx + 2);

        // Update snapshot cache too
        cachedSnapshot = frame;
        cacheTime = Date.now();
        cameraEvidence.frame(cacheTime);

        // Broadcast to all connected clients
        for (const client of streamClients) {
          try {
            writeFramePart(client, frame);
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
            processOverlayFrame(frame)
              .then((overlayFrame) => {
                if (!overlayFrame) return;
                for (const client of overlayClients) {
                  try {
                    writeFramePart(client, overlayFrame);
                  } catch {
                    overlayClients.delete(client);
                  }
                }
              })
              .catch(() => {})
              .finally(() => {
                overlayProcessing = false;
              });
          }
        }
      }
    });

    upstream.on('end', () => fail('Camera closed the stream', 2000));
    upstream.on('error', (err) => fail(`Camera stream error: ${err.message}`, 5000));
  });
  upstreamReq = req;

  req.on('error', (err) => fail(`Camera connection failed: ${err.message}`, 5000));

  req.on('timeout', () => {
    fail(`No data from the camera for ${cameraTimeouts.upstreamMs / 1000} s`, 2000);
    req.destroy();
  });

  req.end();
}

/**
 * Point the camera proxy at the newly active printer (ELEG-95): drop the cached frame,
 * close the upstream to the old camera, and reopen it for any viewer still watching.
 * Still one upstream connection — the old one is destroyed before the new one opens.
 */
export function resetCameraForPrinterSwitch(config: ServiceConfig): void {
  cameraGeneration++;
  cachedSnapshot = null;
  cacheTime = 0;
  fetchInFlight = null;
  // Printer A's frames and failures say nothing about printer B's camera.
  cameraEvidence.reset();
  cancelIdleClose();
  const old = upstreamReq;
  upstreamReq = null;
  stopUpstream = null;
  upstreamActive = false;
  old?.destroy();
  if (config.cameraEnabled && (streamClients.size > 0 || overlayClients.size > 0)) {
    startMjpegUpstream(config.cameraUrl);
  }
}

/**
 * Register one MJPEG viewer (`/api/stream`, `/api/stream/overlay`, `/webcam/?action=stream`).
 * The headers are flushed **now**: `writeHead` alone sends nothing until the first body
 * write, so a dead upstream used to look to the client like a request that never answered
 * (ELEG-167). The watchdog then bounds the wait for a frame.
 */
function addViewer(
  res: ServerResponse,
  config: ServiceConfig,
  set: Set<ServerResponse>,
  kind: string,
): void {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store',
    Connection: 'close',
  });
  res.flushHeaders();

  set.add(res);
  const watchdog = setTimeout(() => {
    const last = cameraEvidence.lastFailure;
    endViewer(
      res,
      `No frame from the camera for ${cameraTimeouts.stallMs / 1000} s${last ? ` (last error: ${last})` : ''}`,
    );
  }, cameraTimeouts.stallMs);
  viewerState.set(res, { gotFrame: false, watchdog });
  log.info(`${kind} client connected (total: ${set.size})`);

  res.on('close', () => {
    clearTimeout(watchdog);
    viewerState.delete(res);
    set.delete(res);
    log.info(`${kind} client disconnected (total: ${set.size})`);
    scheduleIdleClose();
  });

  // A viewer inside the grace period keeps the upstream that is already open.
  cancelIdleClose();
  // Start upstream if not already running
  startMjpegUpstream(config.cameraUrl);
}

function addStreamClient(res: ServerResponse, config: ServiceConfig): void {
  addViewer(res, config, streamClients, 'Stream');
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
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    const name =
      ps.filename.length > maxChars ? ps.filename.slice(0, maxChars - 3) + '...' : ps.filename;
    lines.push(escapeXml(name));
    lines.push(
      `Progress: ${ms?.progress ?? 0}%  Layer: ${ps.current_layer ?? '--'}/${ps.total_layer ?? store.fileTotalLayers ?? '??'}`,
    );
    lines.push(
      `Remaining: ${formatOverlayTime(ps.remaining_time_sec)}  Elapsed: ${formatOverlayTime(ps.print_duration)}`,
    );
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
    svgText +=
      `<text x="${padding + 4}" y="${y}" fill="white" font-family="monospace" font-size="${fontSize}" font-weight="bold">` +
      `<tspan stroke="black" stroke-width="3" paint-order="stroke">${line}</tspan></text>`;
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="2" y="${boxY}" width="${width - 4}" height="${boxHeight}" rx="4" fill="rgba(0,0,0,0.55)"/>` +
    svgText +
    `</svg>`
  );
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
  addViewer(res, config, overlayClients, 'Overlay');
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
        const cacheControl = filePath.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
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

/**
 * `/api/*` writes that stay open with a key set (ELEG-139). Exact method + path.
 * `POST /api/client-error` is a size-capped log line the SPA must be able to send
 * before anyone has entered a key; it reaches neither the printer nor any config.
 */
const OPEN_API_WRITES = new Set(['POST /api/client-error']);

/**
 * Whether an `/api/*` request is a write that needs the key. **Default-deny:** every
 * method other than GET and HEAD is a write unless it is listed in OPEN_API_WRITES, so a
 * write route added later is gated without anyone remembering to gate it. Reads (GET)
 * stay open — that includes the camera, `/api/metrics/prometheus` and downloads.
 */
function isGatedApiWrite(method: string | undefined, url: string): boolean {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return false;
  const path = url.split('?')[0];
  return !OPEN_API_WRITES.has(`${m} ${path}`);
}

export function createRestRouter(
  store: StateStore,
  config: ServiceConfig,
  aiMonitor?: AIMonitor | null,
  reportCollector?: PrintReportCollector | null,
  bridge?: MqttBridge | null,
  /** `/api/printers` — connection presets (ELEG-95); see connection-presets.ts. */
  presetsHandler?: ((req: IncomingMessage, res: ServerResponse) => boolean) | null,
  printQueue?: PrintQueue | null,
) {
  overlayStore = store;
  if (bridge) {
    _bridge = bridge;
    // A camera failure from before the printer came back is stale (ELEG-178).
    bridge.on('connected', () => cameraEvidence.printerReconnected());
  }
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';

    // CORS headers for API routes — same-origin unless CORS_ALLOWED_ORIGINS says
    // otherwise (ELEG-24). This is the surface that serves /api/snapshot, /api/stream
    // and the control routes, so the wildcard mattered most here.
    if (url.startsWith('/api/')) {
      applyCors(
        res,
        corsHeaders(
          config.corsPolicy,
          req.headers.origin,
          // DELETE too: /api/reports/:id, /api/queue/items/:id, /api/layer-data,
          // /api/config/ai-labels and /api/printers/:id are DELETE writes (ELEG-149).
          'GET, POST, DELETE, OPTIONS',
          'Content-Type, Authorization, X-Api-Key',
        ),
      );
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      // Write authentication (ELEG-139): the one gate for every /api/* route, including
      // the presets and queue handlers below. After the CORS block, so a preflight (which
      // never carries credentials) still answers and a 401 still carries CORS headers.
      if (!guardHttp(req, res, config.serviceApiKey, isGatedApiWrite(req.method, url))) return;
    }

    if (presetsHandler && url.startsWith('/api/printers') && presetsHandler(req, res)) return;

    // Print queue (ELEG-35) — after the CORS block so it gets the same policy.
    if (printQueue && handlePrintQueueRequest(req, res, printQueue)) return;

    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          mqtt: _bridge?.isConnected
            ? 'connected'
            : _bridge?.brokerConnected
              ? 'broker_only'
              : 'disconnected',
          // `mqtt` above stays as it was for existing consumers. These three are what
          // make a `broker_only` diagnosable without a journal read (ELEG-59):
          // `mqttPhase` separates "printer never spoke" from "registration refused",
          // `mqttRegisterAttempts` separates 0 (never started) from 12 (trying and
          // failing), and `mqttMessage` is the sentence to show a human.
          mqttPhase: _bridge?.phase ?? 'disconnected',
          mqttRegisterAttempts: _bridge?.registerAttempts ?? 0,
          mqttMessage: mqttPhaseMessage(_bridge?.phase ?? 'disconnected'),
          printerSn: _bridge?.serialNumber || null,
          // Which address the one connection targets — changes when a connection preset is
          // switched (ELEG-95). Already sent to every `/ws` client in `service_status`.
          printerIp: _bridge?.ip ?? null,
          // Whether SERVICE_API_KEY gates writes (ELEG-139). Never the key itself.
          writeAuth: config.serviceApiKey ? 'enabled' : 'disabled',
          // The camera's state from evidence, with the reason (ELEG-178). Reading it
          // never touches the camera: no probe, the firmware has few client slots.
          camera: currentCameraHealth(config, store),
          clients: 0, // filled in by ws-transport if needed
          // Which commit is serving this. All-null on an unstamped deploy or a dev
          // run; cached, because this endpoint is polled.
          build: getBuildInfo(),
        }),
      );
      return;
    }

    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          attributes: store.attributes,
          status: store.status,
          canvas: store.canvas,
          files: store.files,
        }),
      );
      return;
    }

    // /webcam/?action=stream|snapshot (mjpegstreamer-compatible)
    if (url.startsWith('/webcam/') || url === '/webcam') {
      const qIdx = url.indexOf('?');
      const qs = qIdx >= 0 ? url.slice(qIdx + 1) : '';
      const action = new URLSearchParams(qs).get('action');
      if (action === 'stream') {
        if (!config.cameraEnabled) {
          res.writeHead(503);
          res.end('Camera disabled');
          return;
        }
        addStreamClient(res, config);
        return;
      }
      // Default to snapshot
      getSnapshot(config)
        .then((jpeg) => {
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
        })
        .catch(() => {
          res.writeHead(500);
          res.end('Internal error');
        });
      return;
    }

    if (url === '/api/snapshot') {
      getSnapshot(config)
        .then((jpeg) => {
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
        })
        .catch(() => {
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
        res.end(
          JSON.stringify({
            enabled: config.telegramEnabled,
            chatId: config.telegramChatId ? config.telegramChatId.slice(0, 4) + '...' : '',
            progressInterval: config.progressInterval,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { progressInterval?: number };
            if (
              typeof data.progressInterval === 'number' &&
              data.progressInterval >= 5 &&
              data.progressInterval <= 50
            ) {
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
        res.end(
          JSON.stringify({
            labels: aiMonitor?.getLabelConfigs() ?? [],
            enabled: config.aiEnabled && config.aiLocalEnabled,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        if (!aiMonitor) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AI monitor not enabled' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
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
              if (
                typeof lc.warnThreshold !== 'number' ||
                lc.warnThreshold < 0 ||
                lc.warnThreshold > 1
              ) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'warnThreshold must be 0-1' }));
                return;
              }
              if (
                typeof lc.critThreshold !== 'number' ||
                lc.critThreshold < 0 ||
                lc.critThreshold > 1
              ) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'critThreshold must be 0-1' }));
                return;
              }
              // Validate group if provided; default to 'Other' if missing
              const validGroups = [
                'Print in Progress',
                'Spaghetti/Failure',
                'Empty Bed',
                'Paused/Stopped',
                'Other',
              ];
              if (lc.group && !validGroups.includes(lc.group)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid group: ${lc.group}` }));
                return;
              }
              if (!lc.group) {
                lc.group = 'Other';
              }
            }
            aiMonitor
              .setLabelConfigs(data.labels)
              .then(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
              })
              .catch(() => {
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
        aiMonitor
          .resetLabelConfigs()
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, labels: aiMonitor.getLabelConfigs() }));
          })
          .catch(() => {
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
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        let duration = 10;
        try {
          const parsed = JSON.parse(body) as { duration?: number };
          if (parsed.duration && parsed.duration > 0 && parsed.duration <= 60) {
            duration = parsed.duration;
          }
        } catch {
          /* use default */
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `mqtt-capture-${ts}.json`;
        const messages: Array<{ direction: string; topic: string; data: unknown; ts: number }> = [];
        const listener = (entry: {
          direction: string;
          topic: string;
          data: unknown;
          ts: number;
        }) => {
          messages.push(entry);
        };
        store.on('raw', listener);
        activeCapture = { file: filename };
        setTimeout(async () => {
          store.off('raw', listener);
          activeCapture = null;
          const filePath = join(captureLogDir(), filename);
          await writeFile(filePath, JSON.stringify(messages, null, 2));
          debugLog.info(`Capture saved: ${filename} (${messages.length} messages, ${duration}s)`);
        }, duration * 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            file: filename,
            duration,
            message: `Capturing for ${duration}s`,
          }),
        );
      });
      return;
    }

    // List available captures
    if (url === '/api/debug/captures' && req.method === 'GET') {
      readdir(captureLogDir())
        .then((files) => {
          const captures = files
            .filter((f) => f.startsWith('mqtt-capture-'))
            .sort()
            .reverse();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ captures, active: activeCapture?.file ?? null }));
        })
        .catch(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ captures: [], active: null }));
        });
      return;
    }

    // Download a specific capture file
    if (url.startsWith('/api/debug/captures/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.slice('/api/debug/captures/'.length));
      // Prevent path traversal
      if (
        filename.includes('..') ||
        filename.includes('/') ||
        !filename.startsWith('mqtt-capture-')
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid filename' }));
        return;
      }
      readFile(join(captureLogDir(), filename), 'utf-8')
        .then((content) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(content);
        })
        .catch(() => {
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
      bridge
        .enableVideoStreamSDCP()
        .then((result) => {
          res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
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
      res.end(
        JSON.stringify({
          success: true,
          note: 'Sent method 1054 Enable=1 — check MQTT log for response',
        }),
      );
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

    // ── Timelapse video proxy (ELEG-114) ────────────────────────────
    // GET /api/timelapse/video?url=<the printer's timelapse_url>
    // The upstream host is always the configured printer; see timelapse-proxy.ts.
    if (url.startsWith('/api/timelapse/video') && req.method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const target = resolveTimelapseUpstream(params.get('url'), config.printerIp);
      if (!target.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: target.error }));
        return;
      }
      proxyTimelapseVideo(req, res, config, target);
      return;
    }

    // ── List cached gcode files ─────────────────────────────────────
    // GET /api/files/cached — returns array of filenames that have cached gcode
    if (url.startsWith('/api/files/cached') && req.method === 'GET') {
      void (async () => {
        try {
          await ensureCacheDir();
          const cacheFiles = await readdir(gcodeCacheDir());
          const cacheHashes = new Set(cacheFiles.map((f) => f.replace(/\.gcode$/, '')));
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
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
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
      const pathMap: Record<string, string> = {
        local: '/upload',
        'u-disk': '/upload/udisk',
        'sd-card': '/upload/sdcard',
      };
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
              config.printerIp,
              uploadPath,
              config.printerPassword,
              fileName,
              md5,
              chunkData,
              offset,
              end - 1,
              totalBytes,
            );

            if (chunkResult.error_code !== 0) {
              // Retry once on offset mismatch
              if (chunkResult.error_code === 9000) {
                const retry = await uploadChunk(
                  config.printerIp,
                  uploadPath,
                  config.printerPassword,
                  fileName,
                  md5,
                  chunkData,
                  offset,
                  end - 1,
                  totalBytes,
                );
                if (retry.error_code !== 0) {
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error: `Upload failed at offset ${offset}`,
                      error_code: retry.error_code,
                    }),
                  );
                  return;
                }
              } else {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: `Upload failed at offset ${offset}`,
                    error_code: chunkResult.error_code,
                  }),
                );
                return;
              }
            }

            offset = end;
          }

          log.info(`Upload complete: ${fileName} (${formatUploadSize(totalBytes)}, MD5: ${md5})`);

          // Cache the uploaded gcode on the service for preview
          if (fileName.toLowerCase().endsWith('.gcode')) {
            void cacheGcodeBuffer(fileName, fileData, config);
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
        res.end(JSON.stringify({ reports: [], active: false, activePrint: null }));
        return;
      }
      reportCollector
        .listReports()
        .then((reports) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              reports,
              active: reportCollector.isActive(),
              activePrint: reportCollector.getActiveSummary(),
            }),
          );
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to list reports' }));
        });
      return;
    }

    if (url.startsWith('/api/reports/') && req.method === 'GET') {
      if (!reportCollector) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
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
        Promise.all([reportCollector.getReport(reportId), reportCollector.getChartData(reportId)])
          .then(async ([report, chartData]) => {
            if (!report) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Report not found' }));
              return;
            }
            const pdf = await generateReportPDF(
              report,
              chartData ?? [],
              join(config.dataDir, 'reports'),
            );
            const safeName = report.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
            res.writeHead(200, {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="report-${safeName}.pdf"`,
              'Content-Length': pdf.length,
            });
            res.end(pdf);
          })
          .catch((err) => {
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
        reportCollector
          .getSnapshot(reportId, snapName)
          .then((jpeg) => {
            if (jpeg) {
              res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
              res.end(jpeg);
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Snapshot not found' }));
            }
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read snapshot' }));
          });
        return;
      }

      // GET /api/reports/:id — Report JSON
      reportCollector
        .getReport(reportId)
        .then((report) => {
          if (report) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(report));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Report not found' }));
          }
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read report' }));
        });
      return;
    }

    if (url.startsWith('/api/reports/') && req.method === 'DELETE') {
      if (!reportCollector) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const reportId = decodeURIComponent(url.slice('/api/reports/'.length));
      if (!reportId || reportId.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid report ID' }));
        return;
      }
      reportCollector
        .deleteReport(reportId)
        .then((ok) => {
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        })
        .catch(() => {
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

    // No /api/ route matched: a JSON 404, never the SPA shell with a 200 (ELEG-171) — a
    // typo'd or version-skewed call must fail here, not later at JSON.parse, and a
    // monitor probing an /api/ URL must not read the HTML shell as healthy.
    if (url.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url.split('?')[0] }));
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
          const data = JSON.parse(body) as {
            message?: string;
            stack?: string;
            url?: string;
            line?: number;
            col?: number;
          };
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

function parseMultipart(
  body: Buffer,
  boundary: string,
): { fileName: string | null; fileData: Buffer | null } {
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
  printerIp: string,
  uploadPath: string,
  password: string,
  fileName: string,
  md5: string,
  chunk: Buffer,
  rangeStart: number,
  rangeEnd: number,
  totalSize: number,
): Promise<{ error_code: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
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
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          body += d.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as { error_code: number });
          } catch {
            resolve({ error_code: -1 });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Upload chunk timeout'));
    });
    req.write(chunk);
    req.end();
  });
}

/** Stream a timelapse video from the printer, passing Range through so <video> can seek. */
export function proxyTimelapseVideo(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServiceConfig,
  target: TimelapseUpstream | TimelapseDownload,
): void {
  // A `download` target goes through the printer's authenticated /download endpoint (see
  // buildPrinterDownloadPath for the finding and its provenance). That path carries the
  // printer password, so it must not reach a log line, an error body or a response header:
  // nothing below echoes `path`, and upstream errors are logged by message only.
  const path =
    'kind' in target
      ? buildPrinterDownloadPath(config.printerPassword, target.fileName)
      : target.path;
  const headers: Record<string, string> = {};
  const range = req.headers.range;
  if (typeof range === 'string') headers.Range = range;

  let finished = false;
  const fail = (status: number, message: string) => {
    if (finished) return;
    finished = true;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  };

  const upstream = httpRequest(
    {
      hostname: config.printerIp,
      port: target.port,
      path,
      method: 'GET',
      headers,
      timeout: 15_000,
      // The printer's libhv sends both Content-Length and Transfer-Encoding: chunked, which
      // Node's strict parser rejects. The same server answers the direct path too.
      insecureHTTPParser: true,
    },
    (up) => {
      const status = up.statusCode ?? 502;
      if (status !== 200 && status !== 206) {
        up.resume();
        fail(status === 404 ? 404 : 502, `Printer returned ${status}`);
        return;
      }
      const out: Record<string, string | number> = {
        'Accept-Ranges': String(up.headers['accept-ranges'] || 'bytes'),
        'Cache-Control': 'no-store',
      };
      const ct = String(up.headers['content-type'] || '').toLowerCase();
      out['Content-Type'] = ct.startsWith('video/') ? ct : 'video/mp4';
      if (up.headers['content-length'])
        out['Content-Length'] = String(up.headers['content-length']);
      if (up.headers['content-range']) out['Content-Range'] = String(up.headers['content-range']);
      res.writeHead(status, out);
      up.pipe(res);
      up.on('error', () => res.destroy());
    },
  );
  upstream.on('error', (err) => {
    log.warn(`Timelapse proxy error: ${err.message}`);
    fail(502, 'Could not fetch video from printer');
  });
  upstream.on('timeout', () => {
    upstream.destroy(new Error('timeout'));
  });
  res.on('close', () => upstream.destroy());
  upstream.end();
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

  const avgLayerDur =
    layers.length > 0 ? layers.reduce((sum, l) => sum + l.duration, 0) / layers.length : null;
  const lastLayerDur = layers.length > 0 ? layers[layers.length - 1].duration : null;

  return {
    printer: a
      ? {
          model: a.machine_model,
          sn: a.sn,
          ip: a.ip,
          firmware: a.software_version?.ota_version ?? null,
        }
      : null,
    connected: !!_bridge?.isConnected,
    state: {
      status: ms?.status ?? null,
      status_name: STATUS_NAMES[ms?.status ?? -1] ?? 'Unknown',
      sub_status: ms?.sub_status ?? null,
      sub_status_name: SUB_STATUS_NAMES[ms?.sub_status ?? 0] || null,
      progress: ms?.progress ?? null,
      exceptions: (ms?.exception_status ?? []).map((c) => ({
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
    fans: fans
      ? {
          part_fan: fanPct(fans.fan?.speed ?? 0),
          aux_fan: fanPct(fans.aux_fan?.speed ?? 0),
          box_fan: fanPct(fans.box_fan?.speed ?? 0),
          heater_fan: fanPct(fans.heater_fan?.speed ?? 0),
          controller_fan: fanPct(fans.controller_fan?.speed ?? 0),
        }
      : null,
    position: gm
      ? {
          x: gm.x,
          y: gm.y,
          z: gm.z,
          speed: gm.speed,
          speed_mode: gm.speed_mode,
          speed_mode_name: SPEED_MODE_NAMES[gm.speed_mode] ?? 'Unknown',
        }
      : null,
    print: ps
      ? {
          filename: ps.filename || null,
          current_layer: ps.current_layer,
          total_layer: ps.total_layer ?? store.fileTotalLayers ?? null,
          print_duration: ps.print_duration,
          remaining_time_sec: ps.remaining_time_sec,
        }
      : null,
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

  const labels = a ? `model="${a.machine_model}",sn="${a.sn}"` : '';

  function g(name: string, help: string, value: number | null | undefined, extra = '') {
    if (value == null) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    const lab = [labels, extra].filter(Boolean).join(',');
    lines.push(`${name}{${lab}} ${value}`);
  }

  // Connection
  g(
    'elegoo_connected',
    'Printer MQTT connection state (1=connected, 0=disconnected)',
    _bridge?.isConnected ? 1 : 0,
  );

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
      ['part', fans.fan],
      ['aux', fans.aux_fan],
      ['box', fans.box_fan],
      ['heater', fans.heater_fan],
      ['controller', fans.controller_fan],
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
    g(
      'elegoo_print_total_layers',
      'Total print layers',
      ps.total_layer ?? store.fileTotalLayers ?? undefined,
    );
    g('elegoo_print_duration_seconds', 'Elapsed print time in seconds', ps.print_duration);
    g(
      'elegoo_print_remaining_seconds',
      'Estimated remaining time in seconds',
      ps.remaining_time_sec,
    );
  }

  // Filament detected
  g('elegoo_filament_detected', 'Filament detected (1=yes, 0=no)', ext?.filament_detected);

  // Filament usage per spool
  const usage = store.getFilamentUsageArray();
  if (usage.length > 0) {
    lines.push('# HELP elegoo_filament_used_grams Filament used in grams');
    lines.push('# TYPE elegoo_filament_used_grams gauge');
    for (const u of usage) {
      const lab = [labels, `tray="${u.trayKey}",type="${u.filamentType}"`]
        .filter(Boolean)
        .join(',');
      lines.push(`elegoo_filament_used_grams{${lab}} ${Math.round(u.grams * 100) / 100}`);
    }
    lines.push('# HELP elegoo_filament_used_meters Filament used in meters');
    lines.push('# TYPE elegoo_filament_used_meters gauge');
    for (const u of usage) {
      const lab = [labels, `tray="${u.trayKey}",type="${u.filamentType}"`]
        .filter(Boolean)
        .join(',');
      lines.push(`elegoo_filament_used_meters{${lab}} ${Math.round(u.meters * 1000) / 1000}`);
    }
  }

  // Layer stats
  if (layers.length > 0) {
    g('elegoo_layer_count', 'Number of recorded layer times', layers.length);
    const avgDur = layers.reduce((sum, l) => sum + l.duration, 0) / layers.length;
    g('elegoo_layer_avg_duration_seconds', 'Average layer duration', Math.round(avgDur * 10) / 10);
    g(
      'elegoo_layer_last_duration_seconds',
      'Last layer duration',
      layers[layers.length - 1].duration,
    );
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
