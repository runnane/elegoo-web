/**
 * WebSocket transport — serves browser clients.
 *
 * Protocol (JSON messages):
 *
 * Server → Client:
 *   { type: "init", sn, attributes, status, canvas, files, ... , serviceStatus }
 *   { type: "response", method, data }     // forwarded from printer api_response
 *   { type: "status", data }               // forwarded from printer api_status (delta)
 *   { type: "raw", direction, topic, data } // MQTT raw log entry
 *   { type: "connection", connected }       // printer connection state
 *   { type: "service_status", ... }         // periodic service health
 *   { type: "auth_result", ok }             // answer to an auth frame (or upgrade header)
 *   { type: "command_refused", method, code, reason } // never forwarded; code is
 *                                           // 'auth' (needs the key) or 'busy' (ELEG-176)
 *
 * Client → Server:
 *   { type: "auth", key }                   // authorise this connection (ELEG-140)
 *   { type: "command", method, params }     // forwarded to printer api_request
 *
 * Write auth (ELEG-140). Connecting, `init` and every broadcast are open: the stream is a
 * read and carries what `/api/status` already serves. A `command` frame is classified by
 * `method-policy.ts` (default-deny); with `SERVICE_API_KEY` set, a non-read is forwarded
 * only on a connection that presented the key — by an `auth` frame (browsers cannot set
 * WebSocket headers, and a `?key=` would land in proxy logs) or by `Authorization:
 * Bearer` / `X-Api-Key` on the upgrade request. With the key unset, every frame is
 * forwarded as before. The key is never logged or echoed.
 *
 * Print guard (ELEG-176). A command that passes auth is then checked against
 * `print-guard.ts`: while a job is active, motion, homing, heater-off and filament changes
 * are refused with `code: 'busy'` and the guard's message as `reason`.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { StateStore, EventLogEntry } from './state-store.js';
import { getCameraHealth } from './rest-api.js';
import { printerCameraReport } from './camera-health.js';
import type { CameraHealth, CameraState } from '../types.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { TelegramIntegration } from './telegram.js';
import type { AIMonitor } from './ai-monitor.js';
import type { ServiceConfig } from './config.js';
import { getLogger } from './logger.js';
import { getBuildInfo } from './build-info.js';
import { authorize, checkKey, extractKey } from './write-auth.js';
import { isReadMethod } from './method-policy.js';
import { printBusyRefusal } from './print-guard.js';

const log = getLogger('WS');

/** Per-connection auth: the key this connection proved, or null. Never sent anywhere. */
const verifiedKeys = new WeakMap<WebSocket, string>();

export interface ServiceStatusProvider {
  telegram: TelegramIntegration | null;
  aiMonitor: AIMonitor | null;
}

export class WebSocketTransport {
  private wss: WebSocketServer;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private services: ServiceStatusProvider = { telegram: null, aiMonitor: null };
  private startTime = Date.now();

  constructor(
    server: Server,
    private store: StateStore,
    private bridge: MqttBridge,
    /**
     * Read per frame, never cached: `serviceApiKey` is `''` when unset. `cameraEnabled`
     * feeds the camera's `disabled` state in `service_status`.
     */
    private config: Pick<ServiceConfig, 'serviceApiKey' | 'cameraEnabled'>,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req: IncomingMessage) => {
      log.info(`Client connected (total: ${this.wss.clients.size})`);

      // Send current state snapshot on connect
      this.sendInit(ws);

      // A non-browser client may present the key on the upgrade request instead.
      const presented = extractKey(req);
      if (presented !== null) this.authenticate(ws, presented);

      ws.on('message', (raw) => {
        this.handleClientMessage(ws, raw.toString());
      });

      ws.on('close', () => {
        log.info(`Client disconnected (total: ${this.wss.clients.size})`);
      });
    });

    // Forward events from state store to all WS clients
    store.on('response', (method: number, data: Record<string, unknown>) => {
      this.broadcast({ type: 'response', method, data });
    });

    store.on('status', (data: Record<string, unknown>) => {
      this.broadcast({ type: 'status', data });
    });

    store.on('raw', (entry: { direction: string; topic: string; data: unknown; ts: number }) => {
      this.broadcast({ type: 'raw', ...entry });
    });

    store.on('chart_data', (point: { t: number; values: Record<string, number> }) => {
      this.broadcast({ type: 'chart_data', ...point });
    });

    store.on('event_log', (entry: EventLogEntry) => {
      this.broadcast({ type: 'event_log', ...entry });
    });

    store.on('layer_time', (entry: { layer: number; duration: number; timestamp: number }) => {
      this.broadcast({ type: 'layer_time', ...entry });
    });

    store.on('layer_clear', () => {
      this.broadcast({ type: 'layer_clear' });
    });

    // The service now talks to a different printer (ELEG-95). Browsers start over rather
    // than try to un-merge the old printer's state from their own.
    store.on('printer_switched', () => {
      this.broadcast({ type: 'printer_switched', printerIp: this.bridge.ip });
    });

    store.on('filament_usage', (usage: unknown[]) => {
      this.broadcast({ type: 'filament_usage', usage });
    });

    store.on(
      'zone_change',
      (data: { from: string; to: string; x: number; y: number; timestamp: number }) => {
        this.broadcast({ type: 'zone_change', ...data });
      },
    );

    store.on(
      'ai_chart_data',
      (point: { t: number; motion: number; scores: Record<string, number> }) => {
        this.broadcast({ type: 'ai_chart_data', ...point });
      },
    );

    bridge.on('connected', () => {
      this.broadcast({ type: 'connection', connected: true, sn: bridge.serialNumber });
      // Re-send full init to all clients after reconnect
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          this.sendInit(client);
        }
      }
    });

    bridge.on('disconnected', () => {
      this.broadcast({ type: 'connection', connected: false });
    });

    // Broadcast service status every 5 seconds
    this.statusInterval = setInterval(() => {
      this.broadcast({ type: 'service_status', ...this.getServiceStatus() });
    }, 5000);
  }

  /** Provide references to optional services for status reporting */
  setServices(services: ServiceStatusProvider): void {
    this.services = services;
  }

  private getServiceStatus(): Record<string, unknown> {
    // Detailed MQTT state: 'connected' | 'broker_only' | 'disconnected'
    let mqttState = 'disconnected';
    if (this.bridge.isConnected) {
      mqttState = 'connected';
    } else if (this.bridge.brokerConnected) {
      mqttState = 'broker_only';
    }

    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      // Which build is serving this (ELEG-48). Already on /api/health, but nothing in
      // the browser fetches that, and the UI is where "which build am I looking at?"
      // actually gets asked. Cached per process, so this costs nothing per broadcast.
      build: getBuildInfo(),
      mqtt: mqttState,
      // The coarse `mqtt` above is kept as-is for any existing consumer; `mqttPhase`
      // splits its `broker_only` into awaiting_sn / registering / rejected, which is the
      // distinction a human actually needs (ELEG-59).
      mqttPhase: this.bridge.phase,
      mqttRegisterAttempts: this.bridge.registerAttempts,
      printerSn: this.bridge.serialNumber || null,
      printerIp: this.bridge.ip,
      wsClients: this.wss.clients.size,
      telegram: this.services.telegram
        ? this.services.telegram.isRunning
          ? 'running'
          : 'stopped'
        : 'disabled',
      // `degraded` (ELEG-168): monitoring a print but not getting frames. The panel's
      // config summary carries the reason and timestamps under `aiConfig.health`.
      ai: this.services.aiMonitor ? this.services.aiMonitor.statusValue : 'disabled',
      aiConfig: this.services.aiMonitor?.getConfigSummary() ?? null,
      // `camera` stays a string so the panel's ok/err check is a lookup; `cameraHealth`
      // carries the reason and timestamps (ELEG-178). See `CameraState` in src/types.ts.
      ...this.cameraStatus(),
    };
  }

  private cameraStatus(): { camera: CameraState; cameraHealth: CameraHealth } {
    const health = getCameraHealth({
      enabled: this.config.cameraEnabled,
      printerReportsCamera: printerCameraReport(this.bridge.isConnected, this.store.status),
    });
    return { camera: health.state, cameraHealth: health };
  }

  private sendInit(ws: WebSocket): void {
    const msg = {
      type: 'init',
      connected: this.bridge.isConnected,
      sn: this.bridge.serialNumber,
      printerIp: this.bridge.ip,
      attributes: this.store.attributes,
      status: this.store.status,
      canvas: this.store.canvas,
      files: this.store.files,
      thumbnail: this.store.thumbnail,
      thumbnailFailed: this.store.thumbnailFailed,
      fileTotalLayers: this.store.fileTotalLayers,
      timelapseList: this.store.timelapseList,
      videoUrl: this.store.videoUrl,
      zones: this.store.zones,
      layerTimes: this.store.layerTimes,
      filamentUsage: this.store.getFilamentUsageArray(),
      chartHistory: this.store.getChartHistory(),
      aiChartHistory: this.store.getAIChartHistory(),
      eventLog: this.store.getEventLog(),
      serviceStatus: this.getServiceStatus(),
    };
    ws.send(JSON.stringify(msg));
  }

  /**
   * Check a presented key and record the outcome on the connection. A wrong or empty key
   * leaves (or makes) the connection unauthorised — it can still read, and its writes are
   * refused. Replies `{type:'auth_result', ok}`; never echoes the key.
   */
  private authenticate(ws: WebSocket, presented: unknown): void {
    const expected = this.config.serviceApiKey;
    const key = typeof presented === 'string' ? presented : null;
    // Unset: nothing to prove, everything is forwarded anyway.
    const ok = !expected || (key !== null && checkKey(key, expected));
    if (expected && ok && key !== null) verifiedKeys.set(ws, key);
    else verifiedKeys.delete(ws);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'auth_result', ok }));
  }

  private handleClientMessage(ws: WebSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'auth') {
      this.authenticate(ws, msg.key);
      return;
    }

    if (msg.type === 'command') {
      const method = msg.method as number;
      const params = (msg.params as Record<string, unknown>) ?? {};
      if (typeof method === 'number') {
        // The verified key (or none) goes through the same decision as every HTTP
        // surface; re-checked per frame, so it follows the configured key.
        const verdict = authorize(
          this.config.serviceApiKey,
          verifiedKeys.get(ws) ?? null,
          !isReadMethod(method),
        );
        if (verdict !== 'ok') {
          ws.send(
            JSON.stringify({
              type: 'command_refused',
              method,
              code: 'auth',
              reason: verdict === 'invalid' ? 'Invalid API key' : 'API key required',
            }),
          );
          return;
        }
        // The print guard (ELEG-176): motion, heater-off and filament changes mid-print.
        const busy = printBusyRefusal(method, params, this.store.status);
        if (busy !== null) {
          ws.send(JSON.stringify({ type: 'command_refused', method, code: 'busy', reason: busy }));
          return;
        }
        this.bridge.sendCommand(method, params);
      }
    }
  }

  /** Queued bytes above which superseded messages are skipped for a slow client */
  private static readonly MAX_BUFFERED = 1024 * 1024; // 1 MB
  /** Queued bytes above which the client is dropped; it reconnects and resyncs from init */
  private static readonly MAX_BACKLOG = 32 * 1024 * 1024; // 32 MB
  /** Message types the next one supersedes: safe to skip, unlike responses and status deltas */
  private static readonly LOSSY = new Set(['raw', 'chart_data', 'ai_chart_data', 'service_status']);

  broadcast(data: { type: string; [key: string]: unknown }): void {
    const json = JSON.stringify(data);
    const lossy = WebSocketTransport.LOSSY.has(data.type);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > WebSocketTransport.MAX_BACKLOG) {
        log.warn(`Dropping slow client (buffered: ${client.bufferedAmount}), it will resync`);
        client.terminate();
        continue;
      }
      if (lossy && client.bufferedAmount > WebSocketTransport.MAX_BUFFERED) continue;
      client.send(json);
    }
  }

  close(): void {
    if (this.statusInterval) clearInterval(this.statusInterval);
    this.wss.close();
  }
}
