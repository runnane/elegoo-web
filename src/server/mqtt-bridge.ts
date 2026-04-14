/**
 * Singleton MQTT bridge — single connection to the CC2 printer.
 * Emits raw events for consumers (state store, WebSocket, etc.)
 */

import mqtt from 'mqtt';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { getLogger } from './logger.js';

const log = getLogger('MQTT');

export interface MqttBridgeEvents {
  connected: [sn: string];
  disconnected: [];
  /** A method response from api_response topic */
  response: [method: number, data: Record<string, unknown>];
  /** A delta status update from api_status topic */
  status: [data: Record<string, unknown>];
  /** Raw MQTT message (for logging) */
  raw: [direction: 'sent' | 'received', topic: string, data: unknown];
}

export class MqttBridge extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private clientId: string;
  private requestId: string;
  private sn = '';
  private commandId = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private registerTimer: ReturnType<typeof setInterval> | null = null;
  private slowRegisterTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _brokerConnected = false;
  private _registerAttempts = 0;
  private heartbeatMissed = 0;

  constructor(
    private printerIp: string,
    private password: string,
  ) {
    super();
    this.clientId = this.generateId(10);
    this.requestId = this.generateId(26);
  }

  private generateId(len: number): string {
    const chars = '0123456789abcdef';
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * 16)]).join('');
  }

  get isConnected(): boolean { return this._connected; }
  get brokerConnected(): boolean { return this._brokerConnected; }
  get registerAttempts(): number { return this._registerAttempts; }
  get serialNumber(): string { return this.sn; }
  get ip(): string { return this.printerIp; }

  connect(): void {
    const url = `mqtt://${this.printerIp}:1883`;
    log.info(`Connecting to ${url}...`);

    this.client = mqtt.connect(url, {
      clientId: this.clientId,
      username: 'elegoo',
      password: this.password,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 5000,
      protocolVersion: 4,
    });

    this.client.on('connect', () => {
      log.info('Connected, discovering printer...');
      this._brokerConnected = true;
      // Subscribe broadly for SN discovery — printer may not publish
      // api_status until a client registers, so catch any elegoo topic
      this.client!.subscribe('elegoo/#', { qos: 1 });
      if (this.sn) this.register();
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('error', (err) => {
      log.error(`Error: ${err.message}`);
    });

    this.client.on('close', () => {
      this._connected = false;
      this._brokerConnected = false;
      this._registerAttempts = 0;
      this.stopHeartbeat();
      this.stopRegisterRetry();
      this.stopSlowRegisterRetry();
      this.emit('disconnected');
    });
  }

  private handleMessage(topic: string, payload: Buffer): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }

    this.emit('raw', 'received', topic, data);

    // Any message from the printer resets the heartbeat miss counter
    this.heartbeatMissed = 0;

    // Discover SN from any elegoo/<sn>/... topic
    if (!this.sn && topic.startsWith('elegoo/')) {
      const parts = topic.split('/');
      if (parts.length >= 3 && parts[1].length > 0) {
        this.sn = parts[1];
        log.info(`Discovered printer SN: ${this.sn}`);
        this.client!.unsubscribe('elegoo/#');
        this.register();
      }
    }

    if (topic.includes('/register_response')) {
      if (data.error === 'ok') {
        log.info('Registered successfully');
        this._connected = true;
        this._registerAttempts = 0;
        this.stopRegisterRetry();
        this.stopSlowRegisterRetry();
        this.subscribeAll();
        this.startHeartbeat();
        // Request initial data
        this.sendCommand(1001, {}); // GET_ATTRIBUTES
        this.sendCommand(1002, {}); // GET_STATUS
        this.sendCommand(2005, {}); // GET_CANVAS_STATUS
        this.sendCommand(1044, { storage_media: 'udisk', dir: '', offset: 0, limit: 200 }); // GET_FILE_LIST
        this.enableVideoStream(); // Enable camera via SDCP + MQTT
        this.emit('connected', this.sn);
      } else if ((data.code as number) === 3) {
        log.warn('Registration rejected: too many clients (max 2). Will retry every 30s...');
        this.stopRegisterRetry();
        this.startSlowRegisterRetry();
      }
    } else if (topic.includes('/api_response')) {
      const method = data.method as number;
      this.emit('response', method, data);
    } else if (topic.includes('/api_status')) {
      this.emit('status', data);
    }
  }

  private register(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/${this.requestId}/register_response`, { qos: 1 });
    this.sendRegister();
    // Retry registration every 5 seconds until successful
    this.stopRegisterRetry();
    this.registerTimer = setInterval(() => {
      if (this._connected) {
        this.stopRegisterRetry();
        return;
      }
      log.info('Retrying registration...');
      this._registerAttempts++;
      this.sendRegister();
    }, 5000);
  }

  private sendRegister(): void {
    if (!this.client || !this.sn) return;
    this.client.publish(
      `elegoo/${this.sn}/api_register`,
      JSON.stringify({ client_id: this.clientId, request_id: this.requestId }),
    );
  }

  private stopRegisterRetry(): void {
    if (this.registerTimer) {
      clearInterval(this.registerTimer);
      this.registerTimer = null;
    }
  }

  /** Slow retry for when registration is rejected (code 3 — too many clients) */
  private startSlowRegisterRetry(): void {
    this.stopSlowRegisterRetry();
    this.slowRegisterTimer = setInterval(() => {
      if (this._connected) {
        this.stopSlowRegisterRetry();
        return;
      }
      log.info('Retrying registration (slow)...');
      this._registerAttempts++;
      this.sendRegister();
    }, 30_000);
  }

  private stopSlowRegisterRetry(): void {
    if (this.slowRegisterTimer) {
      clearInterval(this.slowRegisterTimer);
      this.slowRegisterTimer = null;
    }
  }

  private subscribeAll(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/api_status`, { qos: 1 });
    this.client.subscribe(`elegoo/${this.sn}/${this.clientId}/api_response`, { qos: 1 });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatMissed = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.client && this.sn) {
        this.heartbeatMissed++;
        if (this.heartbeatMissed >= 2) {
          log.warn('Heartbeat timeout (2 missed) — forcing reconnect...');
          this.stopHeartbeat();
          this._connected = false;
          // Reconnect: destroy the dead client and create a fresh one
          this.reconnect();
          return;
        }
        this.client.publish(
          `elegoo/${this.sn}/${this.clientId}/api_request`,
          JSON.stringify({ type: 'PING' }),
        );
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendCommand(method: number, params: Record<string, unknown>): void {
    if (!this.client || !this.sn) return;
    this.commandId++;
    const topic = `elegoo/${this.sn}/${this.clientId}/api_request`;
    const msg = { id: this.commandId, method, params };
    this.client.publish(topic, JSON.stringify(msg));
    this.emit('raw', 'sent', topic, msg);
  }

  /** Force a reconnect by tearing down the old client and calling connect() again */
  private reconnect(): void {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
    this.stopSlowRegisterRetry();
    this._brokerConnected = false;
    log.info('Reconnecting in 5s...');
    setTimeout(() => this.connect(), 5000);
  }

  /**
   * Enable video streaming on the printer camera.
   * Tries both approaches in parallel — the official app uses SDCP (Option 1a),
   * and we also try MQTT method 1054 (Option 1b) as a fallback.
   */
  private enableVideoStream(): void {
    log.info('Enabling video stream...');
    this.enableVideoStreamSDCP();
    this.enableVideoStreamMQTT();
  }

  /**
   * Option 1a: Send CmdVideoStreamControl via SDCP WebSocket (port 3030).
   * This is what the official Elegoo app does on every connect.
   */
  private enableVideoStreamSDCP(): void {
    const url = `ws://${this.printerIp}:3030/websocket`;
    log.info(`[VideoStream] SDCP: connecting to ${url}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 5000 });
    } catch (err: any) {
      log.warn(`[VideoStream] SDCP: failed to create WebSocket: ${err.message}`);
      return;
    }

    const timeout = setTimeout(() => {
      log.warn('[VideoStream] SDCP: timed out after 10s');
      ws.terminate();
    }, 10_000);

    ws.on('open', () => {
      const msg = {
        Id: '',
        Topic: '',
        Data: {
          Cmd: 386,
          Data: { Enable: 1 },
          MainboardID: '',
          RequestID: this.generateId(26),
          TimeStamp: Math.floor(Date.now() / 1000),
          From: 2, // SDCPFromWeb
        },
      };
      ws.send(JSON.stringify(msg));
      log.info('[VideoStream] SDCP: sent CmdVideoStreamControl Enable=1');
    });

    ws.on('message', (data: Buffer) => {
      try {
        const resp = JSON.parse(data.toString());
        const ack = resp?.Data?.Data?.Ack ?? resp?.Data?.Ack ?? resp?.Ack;
        const videoUrl = resp?.Data?.Data?.VideoUrl ?? resp?.Data?.VideoUrl ?? resp?.VideoUrl;
        if (ack === 0) {
          log.info(`[VideoStream] SDCP: success — VideoUrl: ${videoUrl || '(not returned)'}`);
        } else {
          log.warn(`[VideoStream] SDCP: response Ack=${ack}`);
        }
      } catch {
        log.debug('[VideoStream] SDCP: non-JSON response');
      }
      clearTimeout(timeout);
      ws.close();
    });

    ws.on('error', (err: Error) => {
      log.warn(`[VideoStream] SDCP: error: ${err.message}`);
      clearTimeout(timeout);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });
  }

  /**
   * Option 1b: Send method 1054 (CTRL_LIVE_STREAM) via MQTT.
   * Simpler since we already have the MQTT connection, but the handler
   * may not be implemented on all firmware versions.
   */
  private enableVideoStreamMQTT(): void {
    log.info('[VideoStream] MQTT: sending method 1054 (CTRL_LIVE_STREAM) Enable=1');
    this.sendCommand(1054, { Enable: 1 });
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.stopRegisterRetry();
    this.stopSlowRegisterRetry();
    this._connected = false;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
