/**
 * Standalone Moonraker-compatible server.
 *
 * Runs on a separate port (default 7125) with:
 *  - REST API at root level (no prefix)
 *  - WebSocket JSON-RPC with printer.objects.subscribe + notify_status_update
 *
 * This allows Fluidd, Mainsail, and KlipperScreen to connect directly.
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFile as fsRead, writeFile as fsWrite, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { hostname, cpus, totalmem, freemem, uptime, loadavg, networkInterfaces, platform, release, arch } from 'os';
import { execSync } from 'child_process';
import type { StateStore } from './state-store.js';
import type { MqttBridge } from './mqtt-bridge.js';
import type { ServiceConfig } from './config.js';
import type { FanInfo } from '../types.js';
import {
  MOONRAKER_VERSION,
  AVAILABLE_OBJECTS,
  queryObjects,
} from './moonraker-compat.js';
import { getLogger } from './logger.js';

const log = getLogger('MoonrakerSrv');

// ── Helpers ──────────────────────────────────────────────────────

function jsonResult(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify({ result: data });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  });
  res.end(body);
}

function jsonError(res: ServerResponse, message: string, code = 400): void {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: { code, message } }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function readBodyRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params: Record<string, string> = {};
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return params;
}

const fanPct = (f?: FanInfo) => f ? f.speed / 255 : 0;

// ── Simple file-backed key/value database ────────────────────────

class MoonrakerDatabase {
  private namespaces = new Map<string, Record<string, unknown>>();
  private filePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'moonraker-db.json');
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.filePath)) {
        const raw = await fsRead(this.filePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
        for (const [ns, entries] of Object.entries(data)) {
          this.namespaces.set(ns, entries);
        }
        log.info(`Database loaded (${this.namespaces.size} namespaces)`);
      }
    } catch (e: unknown) {
      log.warn('Failed to load database:', (e as Error).message);
    }
    // Auto-save every 10s when dirty
    this.saveTimer = setInterval(() => { if (this.dirty) void this.save(); }, 10_000);
  }

  async save(): Promise<void> {
    try {
      const obj: Record<string, Record<string, unknown>> = {};
      for (const [ns, entries] of this.namespaces) obj[ns] = entries;
      await mkdir(join(this.filePath, '..'), { recursive: true });
      await fsWrite(this.filePath, JSON.stringify(obj, null, 2));
      this.dirty = false;
    } catch (e: unknown) {
      log.warn('Failed to save database:', (e as Error).message);
    }
  }

  stop(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.dirty) void this.save();
  }

  listNamespaces(): string[] {
    return Array.from(this.namespaces.keys());
  }

  getItem(namespace: string, key?: string): { namespace: string; key?: string; value: unknown } {
    const ns = this.namespaces.get(namespace);
    if (!ns) return { namespace, key, value: key ? undefined : {} };
    if (!key) return { namespace, value: ns };
    // Support dotted key paths (e.g. "uiSettings.general")
    const parts = key.split('.');
    let current: unknown = ns;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return { namespace, key, value: undefined };
      current = (current as Record<string, unknown>)[part];
    }
    return { namespace, key, value: current };
  }

  postItem(namespace: string, key: string, value: unknown): { namespace: string; key: string; value: unknown } {
    if (!this.namespaces.has(namespace)) this.namespaces.set(namespace, {});
    const ns = this.namespaces.get(namespace)!;
    // Support dotted key paths for nested writes
    const parts = key.split('.');
    if (parts.length === 1) {
      ns[key] = value;
    } else {
      let current: Record<string, unknown> = ns;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    }
    this.dirty = true;
    return { namespace, key, value };
  }

  deleteItem(namespace: string, key?: string): { namespace: string; key?: string; value: unknown } {
    if (!key) {
      const value = this.namespaces.get(namespace) ?? {};
      this.namespaces.delete(namespace);
      this.dirty = true;
      return { namespace, value };
    }
    const ns = this.namespaces.get(namespace);
    if (!ns) return { namespace, key, value: undefined };
    const value = ns[key];
    delete ns[key];
    this.dirty = true;
    return { namespace, key, value };
  }
}

// ── JSON-RPC types ───────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: number | string | null;
}

function rpcResult(id: number | string | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', result, id: id ?? null });
}

function rpcError(id: number | string | null | undefined, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: id ?? null });
}

function rpcNotify(method: string, params: unknown[]): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

// ── Per-client subscription state ────────────────────────────────

interface ClientState {
  ws: WebSocket;
  connectionId: number;
  identified: boolean;
  subscribedObjects: Record<string, string[] | null>;  // object name → attrs or null (all)
  /** Snapshot of last sent values per object.attr to compute deltas */
  lastSent: Record<string, Record<string, unknown>>;
  /** Timestamp of last message sent to this client (for keepalive) */
  lastMessageTime: number;
}

let nextConnectionId = 1;

// ── Standalone Moonraker Server ──────────────────────────────────

export class MoonrakerServer {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();
  private statusListener: (() => void) | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private procStatInterval: ReturnType<typeof setInterval> | null = null;
  private db: MoonrakerDatabase;

  constructor(
    private store: StateStore,
    private bridge: MqttBridge,
    private config: ServiceConfig,
  ) {
    this.db = new MoonrakerDatabase(config.dataDir);
    // ── HTTP Server ──
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));

    // ── WebSocket Server ──
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/websocket' });
    // Also accept connections at root path for clients that connect to ws://host:7125/
    const wssRoot = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (req, socket, head) => {
      const pathname = (req.url || '/').split('?')[0];
      if (pathname === '/websocket') {
        // Let the primary WSS handle it
        return;
      }
      // Accept all other upgrade paths (/, /klippy, etc.)
      wssRoot.handleUpgrade(req, socket, head, (ws) => {
        wssRoot.emit('connection', ws, req);
      });
    });

    const setupWs = (ws: WebSocket) => {
      const client: ClientState = {
        ws,
        connectionId: nextConnectionId++,
        identified: false,
        subscribedObjects: {},
        lastSent: {},
        lastMessageTime: Date.now(),
      };
      this.clients.set(ws, client);
      log.info(`WS client connected (id: ${client.connectionId}, total: ${this.clients.size})`);

      // Mark alive on pong response (for server-initiated ping keepalive)
      (ws as any).isAlive = true;
      ws.on('pong', () => { (ws as any).isAlive = true; });

      ws.on('message', (raw) => {
        this.handleWsMessage(client, raw.toString());
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info(`WS client disconnected (id: ${client.connectionId}, total: ${this.clients.size})`);
      });

      ws.on('error', (err) => {
        log.error(`WS error (id: ${client.connectionId}):`, err.message);
      });
    };

    this.wss.on('connection', setupWs);
    wssRoot.on('connection', setupWs);

    // ── WebSocket keepalive: ping every 10s, terminate unresponsive clients ──
    this.pingInterval = setInterval(() => {
      for (const [ws] of this.clients) {
        if ((ws as any).isAlive === false) {
          ws.terminate();
          continue;
        }
        (ws as any).isAlive = false;
        ws.ping();
      }
    }, 10_000);

    // ── Subscribe to state changes for notification push ──
    this.statusListener = () => this.pushStatusUpdates();
    this.store.on('status', this.statusListener);
    this.store.on('response', this.statusListener);

    // ── Periodic status push (Fluidd times out after 10s without messages) ──
    this.statusInterval = setInterval(() => this.pushStatusUpdates(), 2000);

    // ── Periodic proc stat updates (Fluidd charts) ──
    this.procStatInterval = setInterval(() => this.pushProcStatUpdates(), 5000);
  }

  start(): void {
    void this.db.load().then(() => this.seedDefaultWebcam());
    this.httpServer.listen(this.config.moonrakerPort, '0.0.0.0', () => {
      log.info(`Moonraker compat server on :${this.config.moonrakerPort}`);
    });
  }

  stop(): void {
    this.db.stop();
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.statusInterval) clearInterval(this.statusInterval);
    if (this.procStatInterval) clearInterval(this.procStatInterval);
    if (this.statusListener) {
      this.store.removeListener('status', this.statusListener);
      this.store.removeListener('response', this.statusListener);
    }
    for (const [ws] of this.clients) {
      ws.close();
    }
    this.wss.close();
    this.httpServer.close();
  }

  /** Seed a default webcam entry if the webcams namespace is empty. */
  private seedDefaultWebcam(): void {
    const existing = this.db.getItem('webcams');
    if (existing.value && typeof existing.value === 'object' && Object.keys(existing.value as object).length > 0) return;
    if (!this.config.cameraEnabled) return;
    this.db.postItem('webcams', 'default', {
      name: 'default',
      location: 'printer',
      service: 'mjpegstreamer',
      enabled: true,
      icon: 'mdiWebcam',
      target_fps: 15,
      target_fps_idle: 5,
      stream_url: '/webcam/?action=stream',
      snapshot_url: '/webcam/?action=snapshot',
      flip_horizontal: false,
      flip_vertical: false,
      rotation: 0,
      aspect_ratio: '4:3',
      extra_data: {},
      source: 'database',
      uid: 'default-webcam',
    });
    log.info('Seeded default webcam entry');
  }

  /** Get list of all webcams from the database. */
  private getWebcams(): Record<string, unknown>[] {
    const result = this.db.getItem('webcams');
    if (!result.value || typeof result.value !== 'object') return [];
    return Object.values(result.value as Record<string, unknown>)
      .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object');
  }

  // ── Push status updates to subscribed clients ──
  private pushStatusUpdates(): void {
    const eventtime = Date.now() / 1000;
    const now = Date.now();

    for (const client of this.clients.values()) {
      if (Object.keys(client.subscribedObjects).length === 0) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // If no message sent in 5s, reset lastSent to force a full update.
      // Fluidd has a 10s application-level timeout (SOCKET_PING_INTERVAL)
      // and will mark the connection dead if no WS messages arrive.
      const stale = now - client.lastMessageTime > 5000;
      if (stale) {
        client.lastSent = {};
      }

      // Query all subscribed objects
      const fullStatus = queryObjects(this.store, client.subscribedObjects);

      // Compute delta from last sent
      const delta: Record<string, Record<string, unknown>> = {};
      let hasChanges = false;

      for (const [objName, objData] of Object.entries(fullStatus)) {
        const prev = client.lastSent[objName] || {};
        const objDelta: Record<string, unknown> = {};
        let objChanged = false;

        for (const [key, val] of Object.entries(objData)) {
          const oldVal = prev[key];
          if (JSON.stringify(val) !== JSON.stringify(oldVal)) {
            objDelta[key] = val;
            objChanged = true;
          }
        }

        if (objChanged) {
          delta[objName] = objDelta;
          hasChanges = true;
          client.lastSent[objName] = { ...prev, ...objDelta };
        }
      }

      if (hasChanges) {
        client.ws.send(rpcNotify('notify_status_update', [delta, eventtime]));
        client.lastMessageTime = now;
      }
    }
  }

  /** Push proc stat updates to all connected WS clients (for Fluidd System Utilization charts) */
  private pushProcStatUpdates(): void {
    if (this.clients.size === 0) return;
    const stats = this.getProcStats();
    // Fluidd expects a single stats object (not array) in the notification
    const notification = {
      ...stats,
      moonraker_stats: (stats.moonraker_stats as unknown[])[0],
    };
    const msg = rpcNotify('notify_proc_stat_update', [notification]);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
        client.lastMessageTime = Date.now();
      }
    }
  }

  // ── WebSocket JSON-RPC handler ──
  private handleWsMessage(client: ClientState, raw: string): void {
    // Any response we send resets the client's keepalive timer
    client.lastMessageTime = Date.now();

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(raw);
    } catch {
      client.ws.send(rpcError(null, -32700, 'Parse error'));
      return;
    }

    if (msg.jsonrpc !== '2.0' || !msg.method) {
      client.ws.send(rpcError(msg.id, -32600, 'Invalid Request'));
      return;
    }

    const params = msg.params || {};

    switch (msg.method) {
      // ── Connection ──
      case 'server.connection.identify':
        client.identified = true;
        log.info(`Client identified: ${params.client_name} v${params.version} (type: ${params.type})`);
        client.ws.send(rpcResult(msg.id, { connection_id: client.connectionId }));
        break;

      case 'server.websocket.id':
        client.ws.send(rpcResult(msg.id, { websocket_id: client.connectionId }));
        break;

      // ── Server info ──
      case 'server.info':
        client.ws.send(rpcResult(msg.id, {
          klippy_connected: this.bridge.isConnected,
          klippy_state: this.bridge.isConnected ? 'ready' : 'error',
          components: [
            'klippy_apis', 'file_manager', 'machine',
            'data_store', 'history', 'octoprint_compat',
            'webcam', 'database', 'authorization',
            'announcements', 'job_queue',
          ],
          failed_components: [],
          registered_directories: ['gcodes'],
          warnings: [],
          websocket_count: this.clients.size,
          moonraker_version: MOONRAKER_VERSION,
          api_version: [1, 5, 0],
          api_version_string: '1.5.0',
        }));
        break;

      case 'server.config':
        client.ws.send(rpcResult(msg.id, {
          config: { server: { host: '0.0.0.0', port: this.config.moonrakerPort } },
          orig: {},
          files: [],
        }));
        break;

      // ── Printer info ──
      case 'printer.info':
        client.ws.send(rpcResult(msg.id, {
          state: this.bridge.isConnected ? 'ready' : 'error',
          state_message: this.bridge.isConnected ? 'Printer is ready' : 'Printer not connected',
          hostname: this.store.attributes?.hostname ?? 'elegoo-cc2',
          software_version: this.store.attributes?.software_version?.ota_version ?? 'unknown',
          cpu_info: 'Elegoo CC2',
          klipper_path: '/opt/elegoo',
          python_path: '/usr/bin/python3',
          log_file: '/var/log/elegoo.log',
          config_file: '/etc/elegoo/printer.cfg',
          process_id: process.pid,
          user_id: 1000,
          group_id: 1000,
        }));
        break;

      // ── Printer objects ──
      case 'printer.objects.list':
        client.ws.send(rpcResult(msg.id, { objects: AVAILABLE_OBJECTS }));
        break;

      case 'printer.objects.query': {
        const objects = (params.objects || {}) as Record<string, string[] | null>;
        const status = queryObjects(this.store, objects);
        client.ws.send(rpcResult(msg.id, {
          eventtime: Date.now() / 1000,
          status,
        }));
        break;
      }

      case 'printer.objects.subscribe': {
        const objects = (params.objects || {}) as Record<string, string[] | null>;
        // Update subscription — merge with existing or replace
        if (Object.keys(objects).length === 0) {
          // Empty objects = cancel subscription
          client.subscribedObjects = {};
          client.lastSent = {};
        } else {
          client.subscribedObjects = { ...client.subscribedObjects, ...objects };
        }

        // Return current state of subscribed objects (acts as initial snapshot)
        const status = queryObjects(this.store, client.subscribedObjects);
        // Store as last sent baseline
        for (const [objName, objData] of Object.entries(status)) {
          client.lastSent[objName] = { ...objData };
        }

        client.ws.send(rpcResult(msg.id, {
          eventtime: Date.now() / 1000,
          status,
        }));
        break;
      }

      // ── Print control ──
      case 'printer.print.start': {
        const filename = params.filename as string;
        if (filename) {
          this.bridge.sendCommand(1020, { filename, storage_media: 'udisk' });
        }
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;
      }

      case 'printer.print.pause':
        this.bridge.sendCommand(1021, {});
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      case 'printer.print.resume':
        this.bridge.sendCommand(1023, {});
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      case 'printer.print.cancel':
        this.bridge.sendCommand(1022, {});
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      case 'printer.emergency_stop':
        this.bridge.sendCommand(1022, {});
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      // ── GCode ──
      case 'printer.gcode.script': {
        const script = ((params.script as string) || '').trim().toUpperCase();
        log.info(`GCode script: ${script}`);
        if (script === 'G28' || script.startsWith('G28 ')) {
          this.bridge.sendCommand(1026, { axes: ['x', 'y', 'z'] });
        } else if (script.startsWith('M104 ')) {
          const m = script.match(/S(\d+)/);
          if (m) this.bridge.sendCommand(1028, { extruder: parseInt(m[1]) });
        } else if (script.startsWith('M140 ')) {
          const m = script.match(/S(\d+)/);
          if (m) this.bridge.sendCommand(1028, { heater_bed: parseInt(m[1]) });
        } else if (script === 'M112') {
          this.bridge.sendCommand(1022, {});
        } else if (script.startsWith('SET_HEATER_TEMPERATURE')) {
          const heater = script.match(/HEATER=(\S+)/)?.[1]?.toLowerCase();
          const target = script.match(/TARGET=(\d+)/)?.[1];
          if (heater && target !== undefined) {
            const temp = parseInt(target);
            if (heater === 'heater_bed') {
              this.bridge.sendCommand(1028, { heater_bed: temp });
            } else {
              this.bridge.sendCommand(1028, { extruder: temp });
            }
          }
        } else if (script === 'TURN_OFF_HEATERS') {
          this.bridge.sendCommand(1028, { extruder: 0 });
          this.bridge.sendCommand(1028, { heater_bed: 0 });
        }
        client.ws.send(rpcResult(msg.id, 'ok'));
        // Also notify gcode response
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(rpcNotify('notify_gcode_response', [`// ${script}: ok`]));
        }
        break;
      }

      case 'printer.gcode.help':
        client.ws.send(rpcResult(msg.id, {
          G28: 'Home all axes',
          M104: 'Set extruder temperature',
          M140: 'Set bed temperature',
          M112: 'Emergency stop',
          SET_HEATER_TEMPERATURE: 'Set heater temperature (HEATER= TARGET=)',
          TURN_OFF_HEATERS: 'Turn off all heaters',
        }));
        break;

      // ── Files ──
      case 'server.files.list': {
        const files = this.store.files
          .filter((f) => f.type !== 'folder')
          .map((f) => ({
            path: f.filename,
            modified: f.create_time ?? Date.now() / 1000,
            size: f.size,
            permissions: 'rw',
          }));
        client.ws.send(rpcResult(msg.id, files));
        break;
      }

      case 'server.files.get_directory': {
        const dirs = this.store.files
          .filter((f) => f.type === 'folder')
          .map((f) => ({
            dirname: f.filename,
            modified: f.create_time ?? Date.now() / 1000,
            size: 4096,
            permissions: 'rw',
          }));
        const files = this.store.files
          .filter((f) => f.type !== 'folder')
          .map((f) => ({
            filename: f.filename,
            modified: f.create_time ?? Date.now() / 1000,
            size: f.size,
            permissions: 'rw',
          }));
        client.ws.send(rpcResult(msg.id, {
          dirs,
          files,
          disk_usage: this.getDiskUsage(),
          root_info: { name: 'gcodes', permissions: 'rw' },
        }));
        break;
      }

      case 'server.files.metadata': {
        const filename = params.filename as string;
        const file = filename ? this.store.files.find((f) => f.filename === filename) : null;
        if (file) {
          client.ws.send(rpcResult(msg.id, {
            size: file.size,
            modified: file.create_time ?? Date.now() / 1000,
            filename: file.filename,
            estimated_time: file.print_time ?? null,
            layer_height: null,
            first_layer_height: null,
            object_height: null,
            slicer: null,
            slicer_version: null,
            thumbnails: [],
          }));
        } else if (filename && this.store.status?.print_status?.filename === filename) {
          // Synthesize metadata from active print status when file list is unavailable
          const ps = this.store.status.print_status;
          client.ws.send(rpcResult(msg.id, {
            size: 0,
            modified: Date.now() / 1000,
            filename,
            estimated_time: ps.total_duration && ps.remaining_time_sec ? ps.total_duration + ps.remaining_time_sec : null,
            layer_height: null,
            first_layer_height: null,
            object_height: null,
            slicer: null,
            slicer_version: null,
            thumbnails: [],
          }));
        } else {
          client.ws.send(rpcError(msg.id, 404, 'File not found'));
        }
        break;
      }

      case 'server.files.roots':
        client.ws.send(rpcResult(msg.id, [
          { name: 'gcodes', path: '/gcodes', permissions: 'rw' },
          { name: 'config', path: '/config', permissions: 'r' },
        ]));
        break;

      // ── Temperature store ──
      case 'server.temperature_store': {
        const chartData = this.store.getChartHistory();
        const temps = chartData.map((p) => p.values.nozzle ?? 0);
        const bedTemps = chartData.map((p) => p.values.bed ?? 0);
        const chamberTemps = chartData.map((p) => p.values.chamber ?? 0);
        const nozzleTargets = chartData.map((p) => p.values.nozzleTarget ?? 0);
        const bedTargets = chartData.map((p) => p.values.bedTarget ?? 0);
        client.ws.send(rpcResult(msg.id, {
          extruder: {
            temperatures: temps,
            targets: nozzleTargets,
            powers: nozzleTargets.map((t: number) => t > 0 ? 1 : 0),
          },
          heater_bed: {
            temperatures: bedTemps,
            targets: bedTargets,
            powers: bedTargets.map((t: number) => t > 0 ? 1 : 0),
          },
          'temperature_sensor chamber': {
            temperatures: chamberTemps,
          },
        }));
        break;
      }

      // ── GCode store ──
      case 'server.gcode_store':
        client.ws.send(rpcResult(msg.id, { gcode_store: [] }));
        break;

      // ── Webcams ──
      case 'server.webcams.list':
        client.ws.send(rpcResult(msg.id, { webcams: this.getWebcams() }));
        break;

      case 'server.webcams.get_item': {
        const wcName = String(msg.params?.name ?? msg.params?.uid ?? '');
        const webcams = this.getWebcams();
        const wc = webcams.find((w) => w.name === wcName || w.uid === wcName);
        client.ws.send(wc
          ? rpcResult(msg.id, { webcam: wc })
          : rpcError(msg.id, 404, `Webcam '${wcName}' not found`));
        break;
      }

      case 'server.webcams.post_item': {
        const wcData = (msg.params ?? {}) as Record<string, unknown>;
        const wcName = String(wcData.name ?? `cam-${Date.now()}`);
        const entry = { ...wcData, uid: wcData.uid ?? wcName, source: 'database' };
        this.db.postItem('webcams', wcName, entry);
        client.ws.send(rpcResult(msg.id, { webcam: entry }));
        // Notify all clients with the full updated list
        const notif = rpcNotify('notify_webcams_changed', [{ webcams: this.getWebcams() }]);
        for (const c of this.clients.values()) c.ws.send(notif);
        break;
      }

      case 'server.webcams.delete_item': {
        const wcId = String(msg.params?.name ?? msg.params?.uid ?? '');
        const webcams = this.getWebcams();
        const wc = webcams.find((w) => w.name === wcId || w.uid === wcId);
        // Delete by the DB key (name), not uid
        const dbKey = wc ? String(wc.name ?? wcId) : wcId;
        this.db.deleteItem('webcams', dbKey);
        client.ws.send(rpcResult(msg.id, { webcam: wc ?? {} }));
        // Notify all clients with the full updated list
        const delNotif = rpcNotify('notify_webcams_changed', [{ webcams: this.getWebcams() }]);
        for (const c of this.clients.values()) c.ws.send(delNotif);
        break;
      }

      // ── History ──
      case 'server.history.list':
        client.ws.send(rpcResult(msg.id, { count: 0, jobs: [] }));
        break;

      case 'server.history.totals':
        client.ws.send(rpcResult(msg.id, {
          job_totals: {
            total_jobs: 0,
            total_time: 0,
            total_print_time: 0,
            total_filament_used: 0,
            longest_job: 0,
            longest_print: 0,
          },
          auxiliary_totals: [],
        }));
        break;

      case 'server.history.get_job':
        client.ws.send(rpcError(msg.id, 404, 'Job not found'));
        break;

      case 'server.history.delete_job':
        client.ws.send(rpcResult(msg.id, { deleted_jobs: [] }));
        break;

      case 'server.history.reset_totals':
        client.ws.send(rpcResult(msg.id, {
          last_totals: {
            total_jobs: 0, total_time: 0, total_print_time: 0,
            total_filament_used: 0, longest_job: 0, longest_print: 0,
          },
          last_auxiliary_totals: [],
        }));
        break;

      // ── Machine ──
      case 'machine.system_info':
        client.ws.send(rpcResult(msg.id, this.getSystemInfo()));
        break;

      case 'machine.proc_stats':
        client.ws.send(rpcResult(msg.id, this.getProcStats()));
        break;

      // ── Announcements ──
      case 'server.announcements.list':
        client.ws.send(rpcResult(msg.id, { entries: [], feeds: [] }));
        break;

      case 'server.announcements.update':
      case 'server.announcements.dismiss':
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      case 'server.announcements.list_feeds':
        client.ws.send(rpcResult(msg.id, { feeds: [] }));
        break;

      case 'server.announcements.post_feed':
      case 'server.announcements.delete_feed':
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      // ── Update manager ──
      case 'machine.update.status':
        client.ws.send(rpcResult(msg.id, {
          busy: false,
          github_rate_limit: null,
          github_requests_remaining: null,
          github_limit_reset_time: null,
          version_info: {},
        }));
        break;

      // ── Job queue ──
      case 'server.job_queue.status':
        client.ws.send(rpcResult(msg.id, { queued_jobs: [], queue_state: 'ready' }));
        break;

      case 'server.job_queue.post_job':
        client.ws.send(rpcResult(msg.id, { queued_jobs: [], queue_state: 'ready' }));
        break;

      case 'server.job_queue.delete_job':
        client.ws.send(rpcResult(msg.id, { queued_jobs: [], queue_state: 'ready' }));
        break;

      case 'server.job_queue.pause':
        client.ws.send(rpcResult(msg.id, { queued_jobs: [], queue_state: 'paused' }));
        break;

      case 'server.job_queue.start':
        client.ws.send(rpcResult(msg.id, { queued_jobs: [], queue_state: 'ready' }));
        break;

      case 'server.job_queue.jump':
        client.ws.send(rpcResult(msg.id, { queued_jobs: [], queue_state: 'ready' }));
        break;

      // ── Access / Auth (stub — always permitted) ──
      case 'access.get_user':
        client.ws.send(rpcResult(msg.id, {
          username: 'elegoo',
          source: 'moonraker',
          created_on: Date.now() / 1000,
        }));
        break;

      case 'access.oneshot_token':
        client.ws.send(rpcResult(msg.id, 'elegoo-compat-token'));
        break;

      case 'access.login':
        client.ws.send(rpcResult(msg.id, {
          username: String(msg.params?.username ?? 'elegoo'),
          token: 'elegoo-compat-jwt-token',
          refresh_token: 'elegoo-compat-refresh-token',
          action: 'user_logged_in',
          source: 'moonraker',
        }));
        break;

      case 'access.logout':
        client.ws.send(rpcResult(msg.id, { username: 'elegoo', action: 'user_logged_out' }));
        break;

      case 'access.post_user':
        client.ws.send(rpcResult(msg.id, {
          username: String(msg.params?.username ?? 'elegoo'),
          token: 'elegoo-compat-jwt-token',
          refresh_token: 'elegoo-compat-refresh-token',
          action: 'user_created',
          source: 'moonraker',
        }));
        break;

      case 'access.delete_user':
        client.ws.send(rpcResult(msg.id, { username: String(msg.params?.username ?? ''), action: 'user_deleted' }));
        break;

      case 'access.users.list':
        client.ws.send(rpcResult(msg.id, {
          users: [{ username: 'elegoo', source: 'moonraker', created_on: Date.now() / 1000 }],
        }));
        break;

      case 'access.user.password':
        client.ws.send(rpcResult(msg.id, { username: 'elegoo', action: 'user_password_reset' }));
        break;

      case 'access.refresh_jwt':
        client.ws.send(rpcResult(msg.id, {
          username: 'elegoo',
          token: 'elegoo-compat-jwt-token',
          source: 'moonraker',
          action: 'user_jwt_refresh',
        }));
        break;

      case 'access.get_api_key':
      case 'access.post_api_key':
        client.ws.send(rpcResult(msg.id, 'elegoo-compat-api-key'));
        break;

      case 'access.info':
        client.ws.send(rpcResult(msg.id, {
          default_source: 'moonraker',
          available_sources: ['moonraker'],
          login_required: false,
          trusted: true,
        }));
        break;

      // ── Machine services (stubs) ──
      case 'machine.services.restart':
      case 'machine.services.start':
      case 'machine.services.stop':
      case 'machine.shutdown':
      case 'machine.reboot':
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      // ── File management extras ──
      case 'server.files.post_directory':
        client.ws.send(rpcResult(msg.id, {
          item: { path: String(msg.params?.path ?? ''), root: 'gcodes', modified: Date.now() / 1000, size: 4096, permissions: 'rw' },
          action: 'create_dir',
        }));
        break;

      case 'server.files.delete_directory':
        client.ws.send(rpcResult(msg.id, {
          item: { path: String(msg.params?.path ?? ''), root: 'gcodes', modified: 0, size: 0, permissions: '' },
          action: 'delete_dir',
        }));
        break;

      case 'server.files.move':
        client.ws.send(rpcResult(msg.id, {
          item: { root: 'gcodes', path: String(msg.params?.dest ?? ''), modified: Date.now() / 1000, size: 0, permissions: 'rw' },
          source_item: { path: String(msg.params?.source ?? ''), root: 'gcodes' },
          action: 'move_file',
        }));
        break;

      case 'server.files.copy':
        client.ws.send(rpcResult(msg.id, {
          item: { root: 'gcodes', path: String(msg.params?.dest ?? ''), modified: Date.now() / 1000, size: 0, permissions: 'rw' },
          action: 'create_file',
        }));
        break;

      case 'server.files.delete_file':
        client.ws.send(rpcResult(msg.id, {
          item: { path: String(msg.params?.path ?? ''), root: 'gcodes', size: 0, modified: 0, permissions: '' },
          action: 'delete_file',
        }));
        break;

      case 'server.files.metascan':
        client.ws.send(rpcResult(msg.id, { size: 0, modified: Date.now() / 1000, filename: String(msg.params?.filename ?? '') }));
        break;

      case 'server.files.thumbnails': {
        client.ws.send(rpcResult(msg.id, []));
        break;
      }

      // ── Logs ──
      case 'server.logs.rollover':
        client.ws.send(rpcResult(msg.id, { rolled_over: [], failed: {} }));
        break;

      // ── Database ──
      case 'server.database.list':
        client.ws.send(rpcResult(msg.id, { namespaces: this.db.listNamespaces() }));
        break;

      case 'server.database.get_item': {
        const ns = String(msg.params?.namespace ?? '');
        const key = msg.params?.key != null ? String(msg.params.key) : undefined;
        client.ws.send(rpcResult(msg.id, this.db.getItem(ns, key)));
        break;
      }

      case 'server.database.post_item': {
        const ns = String(msg.params?.namespace ?? '');
        const key = String(msg.params?.key ?? '');
        const value = msg.params?.value;
        client.ws.send(rpcResult(msg.id, this.db.postItem(ns, key, value)));
        break;
      }

      case 'server.database.delete_item': {
        const ns = String(msg.params?.namespace ?? '');
        const key = msg.params?.key != null ? String(msg.params.key) : undefined;
        client.ws.send(rpcResult(msg.id, this.db.deleteItem(ns, key)));
        break;
      }

      // ── Server restart (no-op) ──
      case 'server.restart':
      case 'printer.restart':
      case 'printer.firmware_restart':
        client.ws.send(rpcResult(msg.id, 'ok'));
        break;

      // ── Endstops ──
      case 'printer.query_endstops.status':
        client.ws.send(rpcResult(msg.id, { x: 'open', y: 'open', z: 'open' }));
        break;

      default:
        log.warn(`Unknown JSON-RPC method: ${msg.method}`);
        client.ws.send(rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
        break;
    }
  }

  // ── HTTP REST handler ──
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method || 'GET';
    const fullUrl = req.url || '';
    const [urlPath] = fullUrl.split('?');
    const query = parseQuery(fullUrl);

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // --- GET /server/info ---
    if (urlPath === '/server/info' && method === 'GET') {
      jsonResult(res, {
        klippy_connected: this.bridge.isConnected,
        klippy_state: this.bridge.isConnected ? 'ready' : 'error',
        components: [
          'klippy_apis', 'file_manager', 'machine',
          'data_store', 'history', 'octoprint_compat',
          'webcam', 'database', 'authorization',
          'announcements', 'job_queue',
        ],
        failed_components: [],
        registered_directories: ['gcodes'],
        warnings: [],
        websocket_count: this.clients.size,
        moonraker_version: MOONRAKER_VERSION,
        api_version: [1, 5, 0],
        api_version_string: '1.5.0',
      });
      return;
    }

    // --- GET /server/config ---
    if (urlPath === '/server/config' && method === 'GET') {
      jsonResult(res, {
        config: { server: { host: '0.0.0.0', port: this.config.moonrakerPort } },
        orig: {},
        files: [],
      });
      return;
    }

    // --- GET /printer/info ---
    if (urlPath === '/printer/info' && method === 'GET') {
      jsonResult(res, {
        state: this.bridge.isConnected ? 'ready' : 'error',
        state_message: this.bridge.isConnected ? 'Printer is ready' : 'Printer not connected',
        hostname: this.store.attributes?.hostname ?? 'elegoo-cc2',
        software_version: this.store.attributes?.software_version?.ota_version ?? 'unknown',
        cpu_info: 'Elegoo CC2',
        klipper_path: '/opt/elegoo',
        python_path: '/usr/bin/python3',
        log_file: '/var/log/elegoo.log',
        config_file: '/etc/elegoo/printer.cfg',
        process_id: process.pid,
        user_id: 1000,
        group_id: 1000,
      });
      return;
    }

    // --- GET /printer/objects/list ---
    if (urlPath === '/printer/objects/list' && method === 'GET') {
      jsonResult(res, { objects: AVAILABLE_OBJECTS });
      return;
    }

    // --- GET/POST /printer/objects/query ---
    if (urlPath === '/printer/objects/query' && (method === 'GET' || method === 'POST')) {
      const handleQuery = (objects: Record<string, string[] | null>) => {
        const status = queryObjects(this.store, objects);
        jsonResult(res, { eventtime: Date.now() / 1000, status });
      };

      if (method === 'POST') {
        readBody(req).then((body) => {
          const parsed = JSON.parse(body);
          handleQuery(parsed.objects || {});
        }).catch(() => jsonError(res, 'Invalid JSON'));
      } else {
        const objects: Record<string, string[] | null> = {};
        for (const [key, val] of Object.entries(query)) {
          if (AVAILABLE_OBJECTS.includes(key)) {
            objects[key] = val ? val.split(',') : null;
          }
        }
        handleQuery(objects);
      }
      return;
    }

    // --- POST /printer/print/* ---
    if (urlPath === '/printer/print/start' && method === 'POST') {
      const filename = query.filename;
      if (filename) {
        this.bridge.sendCommand(1020, { filename, storage_media: 'udisk' });
        jsonResult(res, 'ok');
      } else {
        readBody(req).then((body) => {
          const parsed = JSON.parse(body);
          if (parsed.filename) {
            this.bridge.sendCommand(1020, { filename: parsed.filename, storage_media: 'udisk' });
            jsonResult(res, 'ok');
          } else {
            jsonError(res, 'filename required');
          }
        }).catch(() => jsonError(res, 'Invalid JSON'));
      }
      return;
    }
    if (urlPath === '/printer/print/pause' && method === 'POST') {
      this.bridge.sendCommand(1021, {});
      jsonResult(res, 'ok');
      return;
    }
    if (urlPath === '/printer/print/resume' && method === 'POST') {
      this.bridge.sendCommand(1023, {});
      jsonResult(res, 'ok');
      return;
    }
    if (urlPath === '/printer/print/cancel' && method === 'POST') {
      this.bridge.sendCommand(1022, {});
      jsonResult(res, 'ok');
      return;
    }

    // --- POST /printer/emergency_stop ---
    if (urlPath === '/printer/emergency_stop' && method === 'POST') {
      this.bridge.sendCommand(1022, {});
      jsonResult(res, 'ok');
      return;
    }

    // --- POST /printer/gcode/script ---
    if (urlPath === '/printer/gcode/script' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        const script = ((parsed.script as string) || '').trim().toUpperCase();
        if (script === 'G28' || script.startsWith('G28 ')) {
          this.bridge.sendCommand(1026, { axes: ['x', 'y', 'z'] });
        } else if (script.startsWith('M104 ')) {
          const m = script.match(/S(\d+)/);
          if (m) this.bridge.sendCommand(1028, { extruder: parseInt(m[1]) });
        } else if (script.startsWith('M140 ')) {
          const m = script.match(/S(\d+)/);
          if (m) this.bridge.sendCommand(1028, { heater_bed: parseInt(m[1]) });
        } else if (script === 'M112') {
          this.bridge.sendCommand(1022, {});
        } else if (script.startsWith('SET_HEATER_TEMPERATURE')) {
          const heater = script.match(/HEATER=(\S+)/)?.[1]?.toLowerCase();
          const target = script.match(/TARGET=(\d+)/)?.[1];
          if (heater && target !== undefined) {
            const temp = parseInt(target);
            if (heater === 'heater_bed') {
              this.bridge.sendCommand(1028, { heater_bed: temp });
            } else {
              this.bridge.sendCommand(1028, { extruder: temp });
            }
          }
        } else if (script === 'TURN_OFF_HEATERS') {
          this.bridge.sendCommand(1028, { extruder: 0 });
          this.bridge.sendCommand(1028, { heater_bed: 0 });
        }
        jsonResult(res, 'ok');
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // --- GET /server/files/* ---
    if (urlPath === '/server/files/list' && method === 'GET') {
      const files = this.store.files
        .filter((f) => f.type !== 'folder')
        .map((f) => ({
          path: f.filename,
          modified: f.create_time ?? Date.now() / 1000,
          size: f.size,
          permissions: 'rw',
        }));
      jsonResult(res, files);
      return;
    }

    if (urlPath === '/server/files/directory' && method === 'GET') {
      const dirs = this.store.files
        .filter((f) => f.type === 'folder')
        .map((f) => ({
          dirname: f.filename,
          modified: f.create_time ?? Date.now() / 1000,
          size: 4096,
          permissions: 'rw',
        }));
      const files = this.store.files
        .filter((f) => f.type !== 'folder')
        .map((f) => ({
          filename: f.filename,
          modified: f.create_time ?? Date.now() / 1000,
          size: f.size,
          permissions: 'rw',
        }));
      jsonResult(res, {
        dirs,
        files,
        disk_usage: this.getDiskUsage(),
        root_info: { name: 'gcodes', permissions: 'rw' },
      });
      return;
    }

    if (urlPath === '/server/files/metadata' && method === 'GET') {
      const filename = query.filename;
      if (!filename) { jsonError(res, 'filename required'); return; }
      const file = this.store.files.find((f) => f.filename === filename);
      if (file) {
        jsonResult(res, {
          size: file.size,
          modified: file.create_time ?? Date.now() / 1000,
          filename: file.filename,
          estimated_time: file.print_time ?? null,
          layer_height: null,
          first_layer_height: null,
          object_height: null,
          slicer: null,
          slicer_version: null,
          thumbnails: [],
        });
      } else if (this.store.status?.print_status?.filename === filename) {
        const ps = this.store.status.print_status;
        jsonResult(res, {
          size: 0,
          modified: Date.now() / 1000,
          filename,
          estimated_time: ps.total_duration && ps.remaining_time_sec ? ps.total_duration + ps.remaining_time_sec : null,
          layer_height: null,
          first_layer_height: null,
          object_height: null,
          slicer: null,
          slicer_version: null,
          thumbnails: [],
        });
      } else {
        jsonError(res, 'File not found', 404);
      }
      return;
    }

    if (urlPath === '/server/files/roots' && method === 'GET') {
      jsonResult(res, [
        { name: 'gcodes', path: '/gcodes', permissions: 'rw' },
        { name: 'config', path: '/config', permissions: 'r' },
      ]);
      return;
    }

    // --- GET /server/temperature_store ---
    if (urlPath === '/server/temperature_store' && method === 'GET') {
      const chartData = this.store.getChartHistory();
      const temps = chartData.map((p) => p.values.nozzle ?? 0);
      const bedTemps = chartData.map((p) => p.values.bed ?? 0);
      const chamberTemps = chartData.map((p) => p.values.chamber ?? 0);
      const nozzleTargets = chartData.map((p) => p.values.nozzleTarget ?? 0);
      const bedTargets = chartData.map((p) => p.values.bedTarget ?? 0);
      jsonResult(res, {
        extruder: {
          temperatures: temps,
          targets: nozzleTargets,
          powers: nozzleTargets.map((t) => t > 0 ? 1 : 0),
        },
        heater_bed: {
          temperatures: bedTemps,
          targets: bedTargets,
          powers: bedTargets.map((t) => t > 0 ? 1 : 0),
        },
        'temperature_sensor chamber': {
          temperatures: chamberTemps,
        },
      });
      return;
    }

    // --- GET /server/webcams/list ---
    if (urlPath === '/server/webcams/list' && method === 'GET') {
      jsonResult(res, { webcams: this.getWebcams() });
      return;
    }

    // --- GET /server/webcams/item ---
    if (urlPath === '/server/webcams/item' && method === 'GET') {
      const name = query.name ?? query.uid ?? '';
      const wc = this.getWebcams().find((w) => w.name === name || w.uid === name);
      if (wc) { jsonResult(res, { webcam: wc }); } else { jsonError(res, `Webcam '${name}' not found`, 404); }
      return;
    }

    // --- POST /server/webcams/item ---
    if (urlPath === '/server/webcams/item' && method === 'POST') {
      readBody(req).then((body) => {
        const wcData = JSON.parse(body) as Record<string, unknown>;
        const wcName = String(wcData.name ?? `cam-${Date.now()}`);
        const entry = { ...wcData, uid: wcData.uid ?? wcName, source: 'database' };
        this.db.postItem('webcams', wcName, entry);
        jsonResult(res, { webcam: entry });
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // --- DELETE /server/webcams/item ---
    if (urlPath === '/server/webcams/item' && method === 'DELETE') {
      const id = query.name ?? query.uid ?? '';
      const webcams = this.getWebcams();
      const wc = webcams.find((w) => w.name === id || w.uid === id);
      const dbKey = wc ? String(wc.name ?? id) : id;
      this.db.deleteItem('webcams', dbKey);
      jsonResult(res, { webcam: wc ?? {} });
      return;
    }

    // --- GET /api/version ---
    if (urlPath === '/api/version' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(MOONRAKER_VERSION);
      return;
    }

    // --- GET /server/database/list ---
    if (urlPath === '/server/database/list' && method === 'GET') {
      jsonResult(res, { namespaces: this.db.listNamespaces() });
      return;
    }

    // --- GET /server/database/item ---
    if (urlPath === '/server/database/item' && method === 'GET') {
      const ns = query.namespace ?? '';
      const key = query.key;
      jsonResult(res, this.db.getItem(ns, key));
      return;
    }

    // --- POST /server/database/item ---
    if (urlPath === '/server/database/item' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        const ns = String(parsed.namespace ?? '');
        const key = String(parsed.key ?? '');
        jsonResult(res, this.db.postItem(ns, key, parsed.value));
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // --- DELETE /server/database/item ---
    if (urlPath === '/server/database/item' && method === 'DELETE') {
      const ns = query.namespace ?? '';
      const key = query.key;
      jsonResult(res, this.db.deleteItem(ns, key));
      return;
    }

    // --- POST /server/restart ---
    if (urlPath === '/server/restart' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- GET /access/info ---
    if (urlPath === '/access/info' && method === 'GET') {
      jsonResult(res, {
        default_source: 'moonraker',
        available_sources: ['moonraker'],
      });
      return;
    }

    // --- GET /access/oneshot_token ---
    if (urlPath === '/access/oneshot_token' && method === 'GET') {
      jsonResult(res, 'elegoo-compat-token');
      return;
    }

    // --- GET /access/user ---
    if (urlPath === '/access/user' && method === 'GET') {
      jsonResult(res, {
        username: 'elegoo',
        source: 'moonraker',
        created_on: Date.now() / 1000,
      });
      return;
    }

    // --- GET /server/gcode_store ---
    if (urlPath === '/server/gcode_store' && method === 'GET') {
      jsonResult(res, { gcode_store: [] });
      return;
    }

    // --- GET /server/history/list ---
    if (urlPath === '/server/history/list' && method === 'GET') {
      jsonResult(res, { count: 0, jobs: [] });
      return;
    }

    // --- GET /server/history/totals ---
    if (urlPath === '/server/history/totals' && method === 'GET') {
      jsonResult(res, {
        job_totals: {
          total_jobs: 0, total_time: 0, total_print_time: 0,
          total_filament_used: 0, longest_job: 0, longest_print: 0,
        },
        auxiliary_totals: [],
      });
      return;
    }

    // --- GET /server/history/job ---
    if (urlPath === '/server/history/job' && method === 'GET') {
      jsonError(res, 'Job not found', 404);
      return;
    }

    // --- DELETE /server/history/job ---
    if (urlPath === '/server/history/job' && method === 'DELETE') {
      jsonResult(res, { deleted_jobs: [] });
      return;
    }

    // --- POST /server/history/reset_totals ---
    if (urlPath === '/server/history/reset_totals' && method === 'POST') {
      jsonResult(res, {
        last_totals: {
          total_jobs: 0, total_time: 0, total_print_time: 0,
          total_filament_used: 0, longest_job: 0, longest_print: 0,
        },
        last_auxiliary_totals: [],
      });
      return;
    }

    // --- GET /server/announcements/list ---
    if (urlPath === '/server/announcements/list' && method === 'GET') {
      jsonResult(res, { entries: [], feeds: [] });
      return;
    }

    // --- POST /server/announcements/update ---
    if (urlPath === '/server/announcements/update' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- POST /server/announcements/dismiss ---
    if (urlPath === '/server/announcements/dismiss' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- GET /server/announcements/feeds ---
    if (urlPath === '/server/announcements/feeds' && method === 'GET') {
      jsonResult(res, { feeds: [] });
      return;
    }

    // --- POST /server/announcements/feed ---
    if (urlPath === '/server/announcements/feed' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- DELETE /server/announcements/feed ---
    if (urlPath === '/server/announcements/feed' && method === 'DELETE') {
      jsonResult(res, 'ok');
      return;
    }

    // --- GET /server/job_queue/status ---
    if (urlPath === '/server/job_queue/status' && method === 'GET') {
      jsonResult(res, { queued_jobs: [], queue_state: 'ready' });
      return;
    }

    // --- POST /server/job_queue/job ---
    if (urlPath === '/server/job_queue/job' && method === 'POST') {
      jsonResult(res, { queued_jobs: [], queue_state: 'ready' });
      return;
    }

    // --- DELETE /server/job_queue/job ---
    if (urlPath === '/server/job_queue/job' && method === 'DELETE') {
      jsonResult(res, { queued_jobs: [], queue_state: 'ready' });
      return;
    }

    // --- POST /server/job_queue/pause ---
    if (urlPath === '/server/job_queue/pause' && method === 'POST') {
      jsonResult(res, { queued_jobs: [], queue_state: 'paused' });
      return;
    }

    // --- POST /server/job_queue/start ---
    if (urlPath === '/server/job_queue/start' && method === 'POST') {
      jsonResult(res, { queued_jobs: [], queue_state: 'ready' });
      return;
    }

    // --- GET /machine/system_info ---
    if (urlPath === '/machine/system_info' && method === 'GET') {
      jsonResult(res, this.getSystemInfo());
      return;
    }

    // --- GET /machine/proc_stats ---
    if (urlPath === '/machine/proc_stats' && method === 'GET') {
      jsonResult(res, this.getProcStats());
      return;
    }

    // --- GET /machine/update/status ---
    if (urlPath === '/machine/update/status' && method === 'GET') {
      jsonResult(res, {
        busy: false,
        github_rate_limit: null,
        github_requests_remaining: null,
        github_limit_reset_time: null,
        version_info: {},
      });
      return;
    }

    // --- POST /machine/services/* ---
    if (urlPath === '/machine/services/restart' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }
    if (urlPath === '/machine/services/start' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }
    if (urlPath === '/machine/services/stop' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- POST /machine/shutdown ---
    if (urlPath === '/machine/shutdown' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- POST /machine/reboot ---
    if (urlPath === '/machine/reboot' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- GET /printer/query_endstops/status ---
    if (urlPath === '/printer/query_endstops/status' && method === 'GET') {
      jsonResult(res, {});
      return;
    }

    // --- GET /printer/gcode/help ---
    if (urlPath === '/printer/gcode/help' && method === 'GET') {
      jsonResult(res, {});
      return;
    }

    // --- POST /printer/restart ---
    if (urlPath === '/printer/restart' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- POST /printer/firmware_restart ---
    if (urlPath === '/printer/firmware_restart' && method === 'POST') {
      jsonResult(res, 'ok');
      return;
    }

    // --- Auth endpoints ---
    // POST /access/login
    if (urlPath === '/access/login' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        jsonResult(res, {
          username: String(parsed.username ?? 'elegoo'),
          token: 'elegoo-compat-jwt-token',
          refresh_token: 'elegoo-compat-refresh-token',
          action: 'user_logged_in',
          source: 'moonraker',
        });
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // POST /access/logout
    if (urlPath === '/access/logout' && method === 'POST') {
      jsonResult(res, { username: 'elegoo', action: 'user_logged_out' });
      return;
    }

    // GET /access/users/list
    if (urlPath === '/access/users/list' && method === 'GET') {
      jsonResult(res, {
        users: [{ username: 'elegoo', source: 'moonraker', created_on: Date.now() / 1000 }],
      });
      return;
    }

    // POST /access/refresh_jwt
    if (urlPath === '/access/refresh_jwt' && method === 'POST') {
      jsonResult(res, {
        username: 'elegoo',
        token: 'elegoo-compat-jwt-token',
        source: 'moonraker',
        action: 'user_jwt_refresh',
      });
      return;
    }

    // GET/POST /access/api_key
    if (urlPath === '/access/api_key' && (method === 'GET' || method === 'POST')) {
      jsonResult(res, 'elegoo-compat-api-key');
      return;
    }

    // POST /access/user (create user)
    if (urlPath === '/access/user' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        jsonResult(res, {
          username: String(parsed.username ?? 'elegoo'),
          token: 'elegoo-compat-jwt-token',
          refresh_token: 'elegoo-compat-refresh-token',
          action: 'user_created',
          source: 'moonraker',
        });
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // DELETE /access/user
    if (urlPath === '/access/user' && method === 'DELETE') {
      jsonResult(res, { username: query.username ?? '', action: 'user_deleted' });
      return;
    }

    // POST /access/user/password
    if (urlPath === '/access/user/password' && method === 'POST') {
      jsonResult(res, { username: 'elegoo', action: 'user_password_reset' });
      return;
    }

    // --- POST /server/files/directory ---
    if (urlPath === '/server/files/directory' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        jsonResult(res, {
          item: { path: String(parsed.path ?? ''), root: 'gcodes', modified: Date.now() / 1000, size: 4096, permissions: 'rw' },
          action: 'create_dir',
        });
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // --- DELETE /server/files/directory ---
    if (urlPath === '/server/files/directory' && method === 'DELETE') {
      jsonResult(res, {
        item: { path: query.path ?? '', root: 'gcodes', modified: 0, size: 0, permissions: '' },
        action: 'delete_dir',
      });
      return;
    }

    // --- POST /server/files/move ---
    if (urlPath === '/server/files/move' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        jsonResult(res, {
          item: { root: 'gcodes', path: String(parsed.dest ?? ''), modified: Date.now() / 1000, size: 0, permissions: 'rw' },
          source_item: { path: String(parsed.source ?? ''), root: 'gcodes' },
          action: 'move_file',
        });
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // --- POST /server/files/copy ---
    if (urlPath === '/server/files/copy' && method === 'POST') {
      readBody(req).then((body) => {
        const parsed = JSON.parse(body);
        jsonResult(res, {
          item: { root: 'gcodes', path: String(parsed.dest ?? ''), modified: Date.now() / 1000, size: 0, permissions: 'rw' },
          action: 'create_file',
        });
      }).catch(() => jsonError(res, 'Invalid JSON'));
      return;
    }

    // --- POST /server/logs/rollover ---
    if (urlPath === '/server/logs/rollover' && method === 'POST') {
      jsonResult(res, { rolled_over: [], failed: {} });
      return;
    }

    // --- POST /server/files/upload ---
    if (urlPath === '/server/files/upload' && method === 'POST') {
      this.handleFileUpload(req, res);
      return;
    }

    // --- GET /server/files/{root}/{filepath} (file download) ---
    // Matches paths like /server/files/gcodes/benchy.gcode
    const fileDownloadMatch = urlPath.match(/^\/server\/files\/([^/]+)\/(.+)$/);
    if (fileDownloadMatch && method === 'GET') {
      const [, root, filePath] = fileDownloadMatch;
      // Only handle known roots (not actual API endpoints)
      if (!['list', 'directory', 'metadata', 'roots', 'upload'].includes(root)) {
        this.handleFileDownload(res, decodeURIComponent(filePath));
        return;
      }
    }

    // --- DELETE /server/files/{root}/{filepath} (file delete) ---
    if (fileDownloadMatch && method === 'DELETE') {
      const [, , filePath] = fileDownloadMatch;
      const decoded = decodeURIComponent(filePath);
      log.info(`File delete: ${decoded}`);
      // Notify clients about delete
      for (const client of this.clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(rpcNotify('notify_filelist_changed', [{
            action: 'delete_file',
            item: { path: decoded, root: 'gcodes', size: 0, modified: Date.now() / 1000 },
          }]));
        }
      }
      jsonResult(res, {
        item: { path: decoded, root: 'gcodes', modified: 0, size: 0, permissions: '' },
        action: 'delete_file',
      });
      return;
    }

    // --- GET / (root) ---
    if (urlPath === '/' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        elegoo_cc2_compat: true,
        moonraker_version: MOONRAKER_VERSION,
        message: 'Moonraker compatibility server for Elegoo CC2',
        websocket: `ws://HOST:${this.config.moonrakerPort}/websocket`,
      }));
      return;
    }

    // Not found
    jsonError(res, `Not found: ${urlPath}`, 404);
  }

  // ── System info helpers ────────────────────────────────────────

  private getSystemInfo(): Record<string, unknown> {
    const printerName = this.store.attributes?.hostname || this.store.attributes?.machine_model || 'Elegoo Centauri Carbon 2';
    const totalMem = Math.round(totalmem() / 1024); // kB
    const cpuCount = cpus().length;

    // Build network info
    const netIfs = networkInterfaces();
    const network: Record<string, { mac_address: string; ip_addresses: Array<{ family: string; address: string; is_link_local: boolean }> }> = {};
    for (const [name, addrs] of Object.entries(netIfs)) {
      if (!addrs || name === 'lo') continue;
      network[name] = {
        mac_address: addrs[0]?.mac || '00:00:00:00:00:00',
        ip_addresses: addrs
          .filter((a) => !a.internal)
          .map((a) => ({
            family: a.family === 'IPv4' ? 'ipv4' : 'ipv6',
            address: a.address,
            is_link_local: a.address.startsWith('fe80') || a.address.startsWith('169.254'),
          })),
      };
    }

    // Distribution info
    let distroName = `${platform()} ${release()}`;
    try {
      const prettyName = execSync('grep PRETTY_NAME /etc/os-release 2>/dev/null', { encoding: 'utf8' });
      const match = prettyName.match(/PRETTY_NAME="(.+)"/);
      if (match) distroName = match[1];
    } catch { /* ignore */ }

    return {
      system_info: {
        cpu_info: {
          cpu_count: cpuCount,
          bits: arch().includes('64') ? '64bit' : '32bit',
          processor: arch(),
          cpu_desc: cpus()[0]?.model || arch(),
          serial_number: '',
          hardware_desc: '',
          model: printerName,
          total_memory: totalMem,
          memory_units: 'kB',
        },
        sd_info: null,
        distribution: {
          name: distroName,
          id: platform(),
          version: release(),
          version_parts: { major: release().split('.')[0] || '', minor: release().split('.')[1] || '', build_number: '' },
          like: '',
          codename: '',
        },
        available_services: ['klipper', 'moonraker'],
        instance_ids: { moonraker: 'moonraker', klipper: 'klipper' },
        service_state: {
          klipper: { active_state: 'active', sub_state: 'running' },
          moonraker: { active_state: 'active', sub_state: 'running' },
        },
        network,
        python: { version: [3, 11, 0, 'final', 0], version_string: 'Node.js ' + process.version },
        virtualization: { virt_type: 'none', virt_identifier: 'none' },
      },
    };
  }

  private getProcStats(): Record<string, unknown> {
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = process.memoryUsage();
    const cpuCount = cpus().length;
    const load = loadavg();
    // Moonraker reports cpu_usage as percentage (0-100)
    const cpuUsage = Math.min(100, (load[0] / cpuCount) * 100);

    return {
      moonraker_stats: [
        {
          time: Date.now() / 1000,
          cpu_usage: parseFloat(cpuUsage.toFixed(2)),
          memory: Math.round(memUsage.rss / 1024),
          mem_units: 'kB',
        },
      ],
      throttled_state: { bits: 0, flags: [] },
      cpu_temp: null,
      network: {},
      system_cpu_usage: { cpu: parseFloat(cpuUsage.toFixed(2)) },
      system_memory: {
        total: Math.round(totalMem / 1024),
        available: Math.round(freeMem / 1024),
        used: Math.round(usedMem / 1024),
      },
      system_uptime: uptime(),
      websocket_connections: this.clients.size,
    };
  }

  private getDiskUsage(): { total: number; used: number; free: number } {
    try {
      const line = execSync('df -B1 / 2>/dev/null', { encoding: 'utf8' }).split('\n')[1];
      if (line) {
        const parts = line.trim().split(/\s+/);
        return { total: parseInt(parts[1]) || 0, used: parseInt(parts[2]) || 0, free: parseInt(parts[3]) || 0 };
      }
    } catch { /* ignore */ }
    return { total: 0, used: 0, free: 0 };
  }

  // ── File download proxy ────────────────────────────────────────
  // GET /server/files/{root}/{filepath}
  // e.g. GET /server/files/gcodes/benchy.gcode
  private handleFileDownload(res: ServerResponse, filePath: string): void {
    log.info(`File download: ${filePath}`);
    const proxyReq = httpRequest({
      hostname: this.config.printerIp,
      port: 80,
      path: `/download?X-Token=${encodeURIComponent(this.config.printerPassword)}&file_name=${encodeURIComponent(filePath)}`,
      method: 'GET',
      timeout: 60_000,
      // Printer sends both Content-Length and Transfer-Encoding: chunked (invalid HTTP)
      insecureHTTPParser: true,
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        jsonError(res, `Printer returned ${proxyRes.statusCode}`, proxyRes.statusCode ?? 502);
        proxyRes.resume();
        return;
      }
      const baseName = filePath.split('/').pop() || 'file';
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${baseName}"`,
        'Access-Control-Allow-Origin': '*',
        ...(proxyRes.headers['content-length'] ? { 'Content-Length': proxyRes.headers['content-length'] } : {}),
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      log.error(`File download error: ${(err as NodeJS.ErrnoException).code} ${err.message}`);
      if (!res.headersSent) jsonError(res, 'Failed to connect to printer', 502);
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) jsonError(res, 'Download timed out', 504);
    });
    proxyReq.end();
  }

  // ── File upload proxy ──────────────────────────────────────────
  // POST /server/files/upload  (multipart/form-data: file, path, root, print)
  private handleFileUpload(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
    if (!boundaryMatch) {
      jsonError(res, 'Missing multipart boundary');
      return;
    }
    const boundary = boundaryMatch[1];
    const MAX_UPLOAD = 500 * 1024 * 1024; // 500 MB

    readBodyRaw(req, MAX_UPLOAD).then(async (body) => {
      // Parse all multipart parts
      const parts = parseMultipartParts(body, boundary);
      let fileData: Buffer | null = null;
      let fileName = '';
      let root = 'gcodes';
      let path = '';
      let startPrint = false;

      for (const part of parts) {
        if (part.name === 'file') {
          fileData = part.data;
          fileName = part.filename || 'upload.gcode';
        } else if (part.name === 'root') {
          root = part.data.toString('utf-8');
        } else if (part.name === 'path') {
          path = part.data.toString('utf-8');
        } else if (part.name === 'print') {
          startPrint = part.data.toString('utf-8') === 'true';
        }
      }

      if (!fileData) {
        jsonError(res, 'No file found in upload');
        return;
      }

      // Build full path
      const fullPath = path ? `${path}/${fileName}` : fileName;
      log.info(`File upload: ${fullPath} (${formatSize(fileData.length)}, root: ${root})`);

      // Only proxy gcodes to printer; config files are not supported
      if (root !== 'gcodes') {
        jsonResult(res, {
          item: { path: fullPath, root, modified: Date.now() / 1000, size: fileData.length, permissions: 'rw' },
          action: 'create_file',
        });
        return;
      }

      // Upload to printer in 1MB chunks via PUT
      const md5 = createHash('md5').update(fileData).digest('hex');
      const CHUNK_SIZE = 1024 * 1024;
      const totalBytes = fileData.length;
      let offset = 0;

      while (offset < totalBytes) {
        const end = Math.min(offset + CHUNK_SIZE, totalBytes);
        const chunk = fileData.subarray(offset, end);
        const result = await this.uploadChunk(fileName, md5, chunk, offset, end - 1, totalBytes);
        if (result.error_code !== 0) {
          // Retry once on offset mismatch
          if (result.error_code === 9000) {
            const retry = await this.uploadChunk(fileName, md5, chunk, offset, end - 1, totalBytes);
            if (retry.error_code !== 0) {
              jsonError(res, `Upload failed at offset ${offset} (error ${retry.error_code})`, 502);
              return;
            }
          } else {
            jsonError(res, `Upload failed at offset ${offset} (error ${result.error_code})`, 502);
            return;
          }
        }
        offset = end;
      }

      log.info(`Upload complete: ${fileName} (${formatSize(totalBytes)}, MD5: ${md5})`);

      // Refresh file list from printer
      this.bridge.sendCommand(1044, { storage_media: 'udisk' });

      // Start print if requested
      if (startPrint) {
        this.bridge.sendCommand(1020, { filename: fileName, storage_media: 'udisk' });
      }

      jsonResult(res, {
        item: { path: fullPath, root: 'gcodes', modified: Date.now() / 1000, size: totalBytes, permissions: 'rw' },
        print_started: startPrint,
        action: 'create_file',
      });

      // Notify WS clients about file change
      for (const client of this.clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(rpcNotify('notify_filelist_changed', [{
            action: 'create_file',
            item: { path: fullPath, root: 'gcodes', size: totalBytes, modified: Date.now() / 1000 },
          }]));
        }
      }
    }).catch((err) => {
      log.error(`Upload error: ${(err as Error).message}`);
      if (!res.headersSent) jsonError(res, 'Upload failed', 500);
    });
  }

  private uploadChunk(
    fileName: string, md5: string, chunk: Buffer,
    rangeStart: number, rangeEnd: number, totalSize: number,
  ): Promise<{ error_code: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: this.config.printerIp,
        port: 80,
        path: '/upload',
        method: 'PUT',
        timeout: 30_000,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk.length,
          'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${totalSize}`,
          'X-Token': this.config.printerPassword,
          'X-File-Name': encodeURIComponent(fileName),
          'X-File-MD5': md5,
        },
      }, (proxyRes) => {
        let body = '';
        proxyRes.on('data', (d: Buffer) => { body += d.toString(); });
        proxyRes.on('end', () => {
          try { resolve(JSON.parse(body) as { error_code: number }); }
          catch { resolve({ error_code: -1 }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Upload chunk timeout')); });
      req.write(chunk);
      req.end();
    });
  }
}

/* ── Multipart parsing ────────────────────────────────────────────── */

interface MultipartPart {
  name: string;
  filename?: string;
  data: Buffer;
}

function parseMultipartParts(body: Buffer, boundary: string): MultipartPart[] {
  const sep = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let start = body.indexOf(sep);
  if (start === -1) return parts;

  while (start !== -1) {
    start += sep.length;
    // Skip \r\n after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    // Check for closing boundary (--)
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;

    const headers = body.subarray(start, headerEnd).toString('utf-8');
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      const dataStart = headerEnd + 4;
      const nextBoundary = body.indexOf(sep, dataStart);
      // -2 for \r\n before the next boundary
      const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : body.length;
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1],
        data: body.subarray(dataStart, dataEnd),
      });
    }

    start = body.indexOf(sep, headerEnd);
  }
  return parts;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
