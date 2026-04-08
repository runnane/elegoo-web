/**
 * MQTT bridge to CC2 printer for the Telegram bot.
 * Connects via TCP (port 1883), registers, and tracks printer state.
 */

import mqtt from 'mqtt';
import { EventEmitter } from 'events';
import type { PrinterStatus, PrinterAttributes, CanvasInfo } from '../types.js';
import {
  STATUS_NAMES, SUB_STATUS_NAMES, SPEED_MODE_NAMES,
  EXCEPTION_NAMES, CRITICAL_EXCEPTIONS,
} from '../types.js';
import { esc } from './notifications.js';

export interface PrinterSnapshot {
  attributes: PrinterAttributes | null;
  status: PrinterStatus | null;
  canvas: CanvasInfo | null;
}

export type BridgeEvent =
  | { type: 'connected'; sn: string }
  | { type: 'disconnected' }
  | { type: 'print_started'; filename: string }
  | { type: 'print_completed'; filename: string; duration: number }
  | { type: 'print_failed'; filename: string; reason: string }
  | { type: 'print_progress'; filename: string; progress: number; layer: number; totalLayers: number; remaining: number }
  | { type: 'error'; codes: number[]; names: string[] }
  | { type: 'filament_runout' }
  | { type: 'first_layer_complete'; filename: string; totalLayers: number; durationSec: number };

/** Deep-merge delta into base (same logic as printer-state.ts) */
function deepMerge(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(update)) {
    const bVal = result[key];
    const uVal = update[key];
    if (bVal && uVal && typeof bVal === 'object' && typeof uVal === 'object' && !Array.isArray(uVal)) {
      result[key] = deepMerge(bVal as Record<string, unknown>, uVal as Record<string, unknown>);
    } else {
      result[key] = uVal;
    }
  }
  return result;
}

export class MqttBridge extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private clientId: string;
  private requestId: string;
  private sn = '';
  private commandId = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Tracked state
  attributes: PrinterAttributes | null = null;
  status: PrinterStatus | null = null;
  canvas: CanvasInfo | null = null;

  // Event detection state
  private lastMachineStatus = -1;
  private lastSubStatus = -1;
  private lastProgressNotified = -1;
  private lastExceptions: number[] = [];
  private wasFilamentDetected = true;
  private totalLayers = 0;
  private lastLayer = 0;
  private lastLayerTime = 0;

  constructor(
    private printerIp: string,
    private password: string,
    private progressInterval: number,
  ) {
    super();
    this.clientId = this.generateId(10);
    this.requestId = this.generateId(26);
  }

  private generateId(len: number): string {
    const chars = '0123456789abcdef';
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * 16)]).join('');
  }

  connect(): void {
    const url = `mqtt://${this.printerIp}:1883`;
    console.log(`[MQTT] Connecting to ${url}...`);

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
      console.log('[MQTT] Connected, discovering printer...');
      this.client!.subscribe('elegoo/+/api_status');
      if (this.sn) this.register();
    });

    this.client.on('message', (_topic: string, payload: Buffer) => {
      this.handleMessage(_topic, payload);
    });

    this.client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
    });

    this.client.on('close', () => {
      this.stopHeartbeat();
      this.emit('event', { type: 'disconnected' } satisfies BridgeEvent);
    });
  }

  private handleMessage(topic: string, payload: Buffer): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }

    // Discover SN
    if (topic.includes('/api_status') && !this.sn) {
      const parts = topic.split('/');
      if (parts.length >= 3) {
        this.sn = parts[1];
        console.log(`[MQTT] Discovered printer SN: ${this.sn}`);
        this.client!.unsubscribe('elegoo/+/api_status');
        this.register();
      }
    }

    if (topic.includes('/register_response')) {
      if (data.error === 'ok') {
        console.log('[MQTT] Registered successfully');
        this.subscribeAll();
        this.startHeartbeat();
        this.sendCommand(1001, {}); // GET_ATTRIBUTES
        this.sendCommand(1002, {}); // GET_STATUS
        this.sendCommand(2005, {}); // GET_CANVAS_STATUS
        this.emit('event', { type: 'connected', sn: this.sn } satisfies BridgeEvent);
      }
    } else if (topic.includes('/api_response')) {
      this.handleResponse(data);
    } else if (topic.includes('/api_status')) {
      this.applyDelta(data);
    }
  }

  private register(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/${this.requestId}/register_response`);
    this.client.publish(
      `elegoo/${this.sn}/api_register`,
      JSON.stringify({ client_id: this.clientId, request_id: this.requestId }),
    );
  }

  private subscribeAll(): void {
    if (!this.client || !this.sn) return;
    this.client.subscribe(`elegoo/${this.sn}/api_status`);
    this.client.subscribe(`elegoo/${this.sn}/${this.clientId}/api_response`);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.client && this.sn) {
        this.client.publish(
          `elegoo/${this.sn}/${this.clientId}/api_request`,
          JSON.stringify({ type: 'PING' }),
        );
      }
    }, 10_000);
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
    this.client.publish(
      `elegoo/${this.sn}/${this.clientId}/api_request`,
      JSON.stringify({ id: this.commandId, method, params }),
    );
  }

  private handleResponse(data: Record<string, unknown>): void {
    const method = data.method as number;
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    switch (method) {
      case 1001:
        this.attributes = result as unknown as PrinterAttributes;
        break;
      case 1002:
        this.status = result as unknown as PrinterStatus;
        this.detectEvents();
        break;
      case 2005: {
        const info = result.canvas_info as CanvasInfo | undefined;
        if (info) this.canvas = info;
        break;
      }
      case 1046: {
        const layers = (result.TotalLayers ?? result.layer ?? result.total_layer) as number | undefined;
        if (layers != null && layers > 0) {
          this.totalLayers = layers;
          console.log(`[MQTT] File total layers: ${layers}`);
        }
        break;
      }
    }
  }

  private applyDelta(data: Record<string, unknown>): void {
    if (!this.status) {
      this.status = data as unknown as PrinterStatus;
    } else {
      this.status = deepMerge(
        this.status as unknown as Record<string, unknown>,
        data,
      ) as unknown as PrinterStatus;
    }
    this.detectEvents();
  }

  /** Detect state transitions and emit notification events */
  private detectEvents(): void {
    if (!this.status) return;

    const ms = this.status.machine_status;
    const ps = this.status.print_status;
    const ext = this.status.extruder;

    const machineStatus = ms?.status ?? -1;
    const subStatus = ms?.sub_status ?? -1;

    // Print started
    if (machineStatus === 2 && this.lastMachineStatus !== 2) {
      this.lastProgressNotified = -1;
      this.lastLayer = 0;
      this.lastLayerTime = 0;
      this.totalLayers = ps?.total_layer ?? 0;
      // Request file detail to get total layers
      if (ps?.filename) {
        this.sendCommand(1046, { filename: ps.filename });
      }
      this.emit('event', {
        type: 'print_started',
        filename: ps?.filename ?? 'unknown',
      } satisfies BridgeEvent);
    }

    // Print completed
    if (subStatus === 2077 && this.lastSubStatus !== 2077) {
      this.emit('event', {
        type: 'print_completed',
        filename: ps?.filename ?? 'unknown',
        duration: ps?.print_duration ?? 0,
      } satisfies BridgeEvent);
      this.lastProgressNotified = -1;
    }

    // Print stopped/failed
    if ((subStatus === 2503 || subStatus === 2504) &&
        this.lastSubStatus !== 2503 && this.lastSubStatus !== 2504) {
      const reason = SUB_STATUS_NAMES[subStatus] || `Sub-status ${subStatus}`;
      this.emit('event', {
        type: 'print_failed',
        filename: ps?.filename ?? 'unknown',
        reason,
      } satisfies BridgeEvent);
      this.lastProgressNotified = -1;
    }

    // First layer complete detection + progress updates
    if (machineStatus === 2 && ps) {
      const currentLayer = ps.current_layer ?? 0;
      const now = Date.now();

      // Detect first layer completion (transition from layer 1 to layer 2)
      if (currentLayer > 1 && this.lastLayer === 1 && this.lastLayerTime > 0) {
        const durationSec = (now - this.lastLayerTime) / 1000;
        if (durationSec < 600) {
          this.emit('event', {
            type: 'first_layer_complete',
            filename: ps.filename ?? 'unknown',
            totalLayers: this.totalLayers || ps.total_layer || 0,
            durationSec,
          } satisfies BridgeEvent);
        }
      }

      if (currentLayer !== this.lastLayer && currentLayer > 0) {
        this.lastLayer = currentLayer;
        this.lastLayerTime = now;
      }

      // Progress updates at configured intervals
      const progress = ms.progress ?? 0;
      const nextThreshold = this.lastProgressNotified + this.progressInterval;
      if (progress >= nextThreshold && progress < 100) {
        // Snap to the interval boundary
        const notifyAt = Math.floor(progress / this.progressInterval) * this.progressInterval;
        if (notifyAt > this.lastProgressNotified) {
          this.lastProgressNotified = notifyAt;
          this.emit('event', {
            type: 'print_progress',
            filename: ps.filename ?? 'unknown',
            progress: notifyAt,
            layer: ps.current_layer ?? 0,
            totalLayers: this.totalLayers || ps.total_layer || 0,
            remaining: ps.remaining_time_sec ?? 0,
          } satisfies BridgeEvent);
        }
      }
    }

    // Exception/error detection
    const exceptions = ms?.exception_status ?? [];
    const newExceptions = exceptions.filter((e: number) => !this.lastExceptions.includes(e));
    if (newExceptions.length > 0) {
      const names = newExceptions.map((code: number) => EXCEPTION_NAMES[code] || `Unknown (${code})`);
      this.emit('event', {
        type: 'error',
        codes: newExceptions,
        names,
      } satisfies BridgeEvent);

      // Specifically check filament runout
      if (newExceptions.includes(109) || newExceptions.includes(1211)) {
        this.emit('event', { type: 'filament_runout' } satisfies BridgeEvent);
      }
    }

    // Also detect filament runout from extruder sensor
    if (ext && ext.filament_detect_enable) {
      if (!ext.filament_detected && this.wasFilamentDetected) {
        this.emit('event', { type: 'filament_runout' } satisfies BridgeEvent);
      }
      this.wasFilamentDetected = !!ext.filament_detected;
    }

    // Update tracking state
    this.lastMachineStatus = machineStatus;
    this.lastSubStatus = subStatus;
    this.lastExceptions = [...exceptions];
  }

  /** Get a snapshot of current printer state */
  getSnapshot(): PrinterSnapshot {
    return {
      attributes: this.attributes,
      status: this.status,
      canvas: this.canvas,
    };
  }

  /** Human-readable status summary */
  getStatusSummary(): string {
    const s = this.status;
    if (!s) return 'Printer status unknown (not connected)';

    const ms = s.machine_status;
    const ps = s.print_status;

    const statusName = STATUS_NAMES[ms?.status ?? 0] || 'Unknown';
    const subName = SUB_STATUS_NAMES[ms?.sub_status ?? 0] || '';
    const speedName = SPEED_MODE_NAMES[s.gcode_move?.speed_mode ?? 1] || '';

    let summary = `*Status:* ${esc(statusName)}`;
    if (subName) summary += ` — ${esc(subName)}`;
    summary += '\n';

    // Temperatures
    summary += `🌡 *Nozzle:* ${s.extruder?.temperature ?? '?'}°C`;
    if (s.extruder?.target) summary += ` → ${s.extruder.target}°C`;
    summary += '\n';
    summary += `🌡 *Bed:* ${s.heater_bed?.temperature ?? '?'}°C`;
    if (s.heater_bed?.target) summary += ` → ${s.heater_bed.target}°C`;
    summary += '\n';
    if (s.ztemperature_sensor?.temperature) {
      summary += `🌡 *Chamber:* ${s.ztemperature_sensor.temperature}°C\n`;
    }

    // Print info
    if (ms?.status === 2 && ps) {
      const progress = ms.progress ?? 0;
      const remaining = ps.remaining_time_sec ?? 0;
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      summary += `\n📄 *File:* ${esc(ps.filename || '?')}\n`;
      summary += `📊 *Progress:* ${progress}%\n`;
      const tl = this.totalLayers || ps.total_layer || 0;
      summary += `📐 *Layer:* ${ps.current_layer ?? '?'}`;
      if (tl) summary += ` of ${tl}`;
      summary += '\n';
      summary += `⏱ *Remaining:* ${h}h ${m}m\n`;
      summary += `⚡ *Speed:* ${esc(speedName)}\n`;
    }

    // Fans
    if (s.fans) {
      const partFan = Math.round((s.fans.fan?.speed ?? 0) / 255 * 100);
      const auxFan = Math.round((s.fans.aux_fan?.speed ?? 0) / 255 * 100);
      summary += `\n🌀 *Part fan:* ${partFan}%  *Aux fan:* ${auxFan}%\n`;
    }

    // Exceptions
    const exceptions = ms?.exception_status ?? [];
    if (exceptions.length > 0) {
      const names = exceptions.map((c: number) => EXCEPTION_NAMES[c] || `Code ${c}`);
      summary += `\n⚠️ *Errors:* ${esc(names.join(', '))}\n`;
    }

    return summary;
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
