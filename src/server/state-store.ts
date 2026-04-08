/**
 * Shared state store — mirrors PrinterState from the frontend,
 * but lives server-side and feeds data to all consumers.
 *
 * Also detects print events for notifications (Telegram, future webhooks).
 */

import { EventEmitter } from 'events';
import type { MqttBridge } from './mqtt-bridge.js';
import type { PrinterAttributes, PrinterStatus, CanvasInfo, FileEntry } from '../types.js';
import { getLogger } from './logger.js';

const log = getLogger('State');
import {
  STATUS_NAMES, SUB_STATUS_NAMES, SPEED_MODE_NAMES,
  EXCEPTION_NAMES, CRITICAL_EXCEPTIONS,
} from '../types.js';

/** Chart data point — matches the browser ChartStore format */
export interface ChartPoint {
  t: number;
  values: Record<string, number>;
}

const CHART_MAX_POINTS = 300_000; // ~83 hours at 1 sample/sec (safety valve)
const CHART_SAMPLE_MS = 1000;

/** AI chart data point — motion + classification scores */
export interface AIChartPoint {
  t: number;
  motion: number;
  scores: Record<string, number>;
}

const AI_CHART_MAX_POINTS = 300_000; // safety valve matching chart data

/** Filament densities (g/cm³) for weight calculation */
const FILAMENT_DENSITY: Record<string, number> = {
  PLA: 1.24, ABS: 1.04, ASA: 1.07, PETG: 1.27, TPU: 1.21,
  PA: 1.14, PC: 1.20, PVA: 1.23, HIPS: 1.04,
};
const FILAMENT_RADIUS_MM = 1.75 / 2;
const CROSS_SECTION_MM2 = Math.PI * FILAMENT_RADIUS_MM * FILAMENT_RADIUS_MM; // ~2.405 mm²
const CROSS_SECTION_CM2 = Math.PI * (0.175 / 2) ** 2; // in cm² for g/cm³ density

/** Per-spool filament usage tracking */
export interface FilamentUsage {
  trayKey: string;       // 'mono' or 'canvas_<canvasId>_tray_<trayId>'
  filamentType: string;  // PLA, PETG, etc.
  color: string;         // hex color
  extruded_mm: number;   // total mm of filament pushed through extruder
  grams: number;         // computed from extruded_mm + density
  meters: number;        // extruded_mm / 1000
}

/** Deep-merge delta into base */
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



export type PrintEvent =
  | { type: 'connected'; sn: string }
  | { type: 'disconnected' }
  | { type: 'print_started'; filename: string; resumed?: boolean }
  | { type: 'print_completed'; filename: string; duration: number }
  | { type: 'print_failed'; filename: string; reason: string }
  | { type: 'print_progress'; filename: string; progress: number; layer: number; totalLayers: number; remaining: number }
  | { type: 'error'; codes: number[]; names: string[] }
  | { type: 'filament_runout' }
  | { type: 'layer_change'; layer: number; totalLayers: number; durationSec: number }
  | { type: 'first_layer_complete'; filename: string; totalLayers: number; durationSec: number }
  | { type: 'status_change'; from: string; to: string; fromCode: number; toCode: number }
  | { type: 'sub_status_change'; from: string; to: string; fromCode: number; toCode: number };

/** Timestamped event log entry broadcast to clients */
export interface EventLogEntry {
  ts: number;
  event: PrintEvent;
}

export class StateStore extends EventEmitter {
  // Current state
  attributes: PrinterAttributes | null = null;
  status: PrinterStatus | null = null;
  canvas: CanvasInfo | null = null;
  files: FileEntry[] = [];
  thumbnail: string | null = null;
  thumbnailFailed = false;
  fileTotalLayers: number | null = null;
  systemInfo: Record<string, unknown> | null = null;
  timelapseList: Record<string, unknown>[] = [];
  videoUrl: string | null = null;
  bedMesh: number[][] | null = null;

  // Layer time tracking (server-side, survives browser reloads)
  layerTimes: Array<{ layer: number; duration: number; timestamp: number }> = [];
  private _lastLayer = 0;
  private _lastLayerTime = 0;

  // Extruder position tracking for flow rate calculation
  private _lastExtruderE = 0;
  private _lastExtruderSampleTime = 0;

  // Filament usage tracking (per-spool, server-side, survives browser reloads)
  filamentUsage: Map<string, FilamentUsage> = new Map();

  // Chart data ring buffer (server-side, no gaps)
  private chartData: ChartPoint[] = [];
  private chartTimer: ReturnType<typeof setInterval> | null = null;

  // AI chart data ring buffer (motion + classification scores)
  private aiChartData: AIChartPoint[] = [];

  // Raw log ring buffer for WS clients that want logs
  private rawLog: Array<{ direction: string; topic: string; data: unknown; ts: number }> = [];
  private readonly maxLogEntries = 500;

  // Event log ring buffer (important events for the Event Log panel)
  private eventLog: EventLogEntry[] = [];
  private readonly maxEventLog = 50_000;

  // Event detection state
  private lastMachineStatus = -1;
  private lastSubStatus = -1;
  private lastProgressNotified = -1;
  private lastExceptions: number[] = [];
  private wasFilamentDetected = true;
  private totalLayers = 0;
  /** Baseline is ready only after the first full status (method 1002) is processed */
  private baselineReady = false;
  /** Auto-report sequence tracking for gap detection */
  private lastAutoReportId: number | null = null;
  /** Periodic full-status poll timer (active during printing) */
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private bridge: MqttBridge, private progressInterval: number) {
    super();

    // Wire up MQTT bridge events
    // Listen to our own print_event emissions and log them
    this.on('print_event', (event: PrintEvent) => {
      const entry: EventLogEntry = { ts: Date.now(), event };
      this.eventLog.push(entry);
      if (this.eventLog.length > this.maxEventLog) this.eventLog.shift();
      this.emit('event_log', entry);
    });

    bridge.on('connected', (sn: string) => {
      this.emit('print_event', { type: 'connected', sn } satisfies PrintEvent);
    });

    bridge.on('disconnected', () => {
      this.stopStatusPoll();
      this.emit('print_event', { type: 'disconnected' } satisfies PrintEvent);
    });

    bridge.on('response', (method: number, data: Record<string, unknown>) => {
      this.handleResponse(method, data);
      // Forward raw response to WS clients
      this.emit('response', method, data);
    });

    bridge.on('status', (data: Record<string, unknown>) => {
      this.handleStatusEvent(data);
      // Forward raw delta to WS clients
      this.emit('status', data);
    });

    bridge.on('raw', (direction: string, topic: string, data: unknown) => {
      const entry = { direction, topic, data, ts: Date.now() };
      this.rawLog.push(entry);
      if (this.rawLog.length > this.maxLogEntries) this.rawLog.shift();
      this.emit('raw', entry);
    });

    // Sample chart data every second
    this.chartTimer = setInterval(() => this.sampleChart(), CHART_SAMPLE_MS);

    // Start/stop periodic status poll based on print state
    this.on('print_event', (event: PrintEvent) => {
      if (event.type === 'print_started') this.startStatusPoll();
      if (event.type === 'print_completed' || event.type === 'print_failed') this.stopStatusPoll();
    });
  }

  /** Poll full status (method 1002) every 5s while printing.
   *  Delta status events (method 6000) don't include machine_status.progress. */
  private startStatusPoll(): void {
    if (this.statusPollTimer) return;
    this.statusPollTimer = setInterval(() => {
      if (this.bridge.isConnected) {
        this.bridge.sendCommand(1002, {});
      }
    }, 5000);
  }

  private stopStatusPoll(): void {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  private sampleChart(): void {
    if (!this.status) return;
    const s = this.status;
    const fanPct = (v: number) => Math.round((v / 255) * 100);

    // Compute extrusion rate from Δe/Δt (mm/s of filament)
    const now = Date.now();
    const currentE = s.gcode_move?.extruder ?? s.gcode_move?.e ?? 0;
    let extrusionRate = 0;
    let deltaE = 0;
    if (this._lastExtruderSampleTime > 0) {
      const dt = (now - this._lastExtruderSampleTime) / 1000; // seconds
      if (dt > 0 && currentE > this._lastExtruderE) {
        deltaE = currentE - this._lastExtruderE;
        extrusionRate = deltaE / dt;
      }
    }
    this._lastExtruderE = currentE;
    this._lastExtruderSampleTime = now;

    // Volumetric flow: extrusion_rate (mm/s) * cross-section area of 1.75mm filament
    const flowRate = extrusionRate * CROSS_SECTION_MM2; // mm³/s

    // Mass flow: volumetric flow in cm³/s * density (g/cm³)
    const activeType = this.getActiveFilamentType();
    const density = FILAMENT_DENSITY[activeType.toUpperCase()] ?? FILAMENT_DENSITY.PLA;
    const flowCm3s = (extrusionRate / 10) * CROSS_SECTION_CM2; // mm→cm for rate, cm² cross-section
    const massFlowRate = flowCm3s * density; // g/s

    // Accumulate filament usage per-spool during printing
    if (deltaE > 0 && s.machine_status?.status === 2) {
      this.accumulateFilament(deltaE, activeType, density);
    }

    const point: ChartPoint = {
      t: Date.now(),
      values: {
        nozzle: s.extruder?.temperature ?? 0,
        nozzle_tgt: s.extruder?.target ?? 0,
        bed: s.heater_bed?.temperature ?? 0,
        bed_tgt: s.heater_bed?.target ?? 0,
        chamber: s.ztemperature_sensor?.temperature ?? 0,
        fan_model: fanPct(s.fans?.fan?.speed ?? 0),
        fan_aux: fanPct(s.fans?.aux_fan?.speed ?? 0),
        fan_case: fanPct(s.fans?.box_fan?.speed ?? 0),
        extrusion_rate: Math.round(extrusionRate * 100) / 100,
        flow_rate: Math.round(flowRate * 100) / 100,
        mass_flow_rate: Math.round(massFlowRate * 1000) / 1000,
      },
    };
    this.chartData.push(point);
    if (this.chartData.length > CHART_MAX_POINTS) {
      this.chartData.shift();
    }
    this.emit('chart_data', point);
  }

  /** Get the active filament type from canvas or mono config */
  private getActiveFilamentType(): string {
    if (this.canvas?.canvas_list?.length) {
      for (const unit of this.canvas.canvas_list) {
        if (unit.canvas_id !== this.canvas.active_canvas_id) continue;
        for (const tray of unit.tray_list) {
          if (tray.tray_id === this.canvas.active_tray_id && tray.filament_type) {
            return tray.filament_type;
          }
        }
      }
    }
    const mono = (this.status as unknown as Record<string, unknown>)?.mono_filament_info as Record<string, unknown> | undefined;
    if (mono?.filament_type) return mono.filament_type as string;
    return 'PLA';
  }

  /** Get the active tray key and color for filament tracking */
  private getActiveTrayInfo(): { key: string; color: string } {
    if (this.canvas?.canvas_list?.length) {
      for (const unit of this.canvas.canvas_list) {
        if (unit.canvas_id !== this.canvas.active_canvas_id) continue;
        for (const tray of unit.tray_list) {
          if (tray.tray_id === this.canvas.active_tray_id) {
            return {
              key: `canvas_${unit.canvas_id}_tray_${tray.tray_id}`,
              color: tray.filament_color || '#888888',
            };
          }
        }
      }
    }
    const mono2 = (this.status as unknown as Record<string, unknown>)?.mono_filament_info as Record<string, unknown> | undefined;
    return {
      key: 'mono',
      color: (mono2?.filament_color as string) || '#888888',
    };
  }

  /** Accumulate extruded filament into the active spool's usage bucket */
  private accumulateFilament(deltaE_mm: number, filamentType: string, density: number): void {
    const { key, color } = this.getActiveTrayInfo();
    let usage = this.filamentUsage.get(key);
    if (!usage) {
      usage = { trayKey: key, filamentType, color, extruded_mm: 0, grams: 0, meters: 0 };
      this.filamentUsage.set(key, usage);
    }
    usage.extruded_mm += deltaE_mm;
    usage.meters = usage.extruded_mm / 1000;
    // Volume in cm³ = length_cm * cross_section_cm²
    usage.grams = (usage.extruded_mm / 10) * CROSS_SECTION_CM2 * density;
    // Update type/color in case spool was reconfigured
    usage.filamentType = filamentType;
    usage.color = color;
    this.emit('filament_usage', this.getFilamentUsageArray());
  }

  /** Get filament usage as a serializable array */
  getFilamentUsageArray(): FilamentUsage[] {
    return Array.from(this.filamentUsage.values());
  }

  /** Clear filament usage (on new print start) */
  clearFilamentUsage(): void {
    this.filamentUsage.clear();
    this.emit('filament_usage', []);
  }

  /** Restore filament usage from persistence */
  restoreFilamentUsage(data: FilamentUsage[]): void {
    this.filamentUsage.clear();
    for (const u of data) {
      this.filamentUsage.set(u.trayKey, u);
    }
  }

  /** Get chart history for new WS clients */
  getChartHistory(): ChartPoint[] {
    return this.chartData;
  }

  /** Restore chart data from persistence */
  restoreChartData(data: ChartPoint[]): void {
    if (data && data.length > 0) {
      this.chartData = data;
    }
  }

  /** Record an AI chart data point and broadcast to clients */
  pushAIChartData(point: AIChartPoint): void {
    this.aiChartData.push(point);
    if (this.aiChartData.length > AI_CHART_MAX_POINTS) {
      this.aiChartData.shift();
    }
    this.emit('ai_chart_data', point);
  }

  /** Get AI chart history for new WS clients */
  getAIChartHistory(): AIChartPoint[] {
    return this.aiChartData;
  }

  /** Restore AI chart data from persistence */
  restoreAIChartData(data: AIChartPoint[]): void {
    if (data && data.length > 0) {
      this.aiChartData = data;
    }
  }

  /** Restore layer data from persistence */
  restoreLayerData(
    layerTimes: Array<{ layer: number; duration: number; timestamp: number }>,
    lastLayer: number,
    lastLayerTime: number,
  ): void {
    if (layerTimes && layerTimes.length > 0) {
      this.layerTimes = layerTimes;
      this._lastLayer = lastLayer;
      this._lastLayerTime = lastLayerTime;
    }
  }

  getLastLayer(): number { return this._lastLayer; }
  getLastLayerTime(): number { return this._lastLayerTime; }

  /** Clear layer data and notify WS clients */
  clearLayerData(): void {
    this.layerTimes = [];
    this._lastLayer = 0;
    this._lastLayerTime = 0;
    this.emit('layer_clear');
  }

  /** Clean up timers */
  destroy(): void {
    if (this.chartTimer) clearInterval(this.chartTimer);
    this.stopStatusPoll();
  }

  /** Get recent raw log entries */
  getRecentLogs(count = 100): Array<{ direction: string; topic: string; data: unknown; ts: number }> {
    return this.rawLog.slice(-count);
  }

  /** Get event log history for new WS clients */
  getEventLog(): EventLogEntry[] {
    return this.eventLog;
  }

  /** Restore event log from persistence */
  restoreEventLog(data: EventLogEntry[]): void {
    if (data && data.length > 0) {
      this.eventLog = data;
    }
  }

  /** Clear event log (on new print start) */
  clearEventLog(): void {
    this.eventLog = [];
  }

  private handleResponse(method: number, data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    // Normalize firmware field name variations
    if ('gcode_move_inf' in result && !('gcode_move' in result)) {
      result.gcode_move = result.gcode_move_inf;
      delete result.gcode_move_inf;
    }

    switch (method) {
      case 1001:
        this.attributes = result as unknown as PrinterAttributes;
        break;
      case 1002:
        this.status = result as unknown as PrinterStatus;
        // Extract bed mesh from full status if present
        this.extractBedMesh(result);
        // On first full status, establish baseline without emitting events
        if (!this.baselineReady) {
          this.establishBaseline();
        }
        this.detectEvents();
        break;
      case 2005: {
        const info = result.canvas_info as CanvasInfo | undefined;
        if (info) this.canvas = info;
        break;
      }
      case 1044: {
        const fileList = result.file_list as FileEntry[] | undefined;
        if (fileList) this.files = fileList;
        break;
      }
      case 1045: {
        const errorCode = result.error_code as number | undefined;
        const thumb = result.thumbnail as string | undefined;
        if (thumb && errorCode === 0) {
          this.thumbnail = thumb;
          this.thumbnailFailed = false;
        } else {
          this.thumbnailFailed = true;
        }
        break;
      }
      case 1046: {
        const layers = (result.TotalLayers ?? result.layer ?? result.total_layer) as number | undefined;
        if (layers != null && layers > 0) {
          this.fileTotalLayers = layers;
          this.totalLayers = layers;
        }
        break;
      }
      case 1050: {
        const errorCode = result.error_code as number | undefined;
        const url = result.url as string | undefined;
        if (errorCode === 0 && url) this.videoUrl = url;
        break;
      }
      case 1051: {
        const errorCode = result.error_code as number | undefined;
        const list = result.file_list as Record<string, unknown>[] | undefined;
        if (errorCode === 0 && list) this.timelapseList = list;
        break;
      }
      case 1062: {
        const errorCode = result.error_code as number | undefined;
        if (errorCode === 0) {
          const info = { ...result };
          delete info.error_code;
          this.systemInfo = info;
        }
        break;
      }
    }
  }

  /** Extract bed mesh data from any response/status that may contain it */
  private extractBedMesh(data: Record<string, unknown>): void {
    const meshData = (data.bed_mesh ?? data.bed_level_info) as Record<string, unknown> | undefined;
    if (meshData) {
      const probed = (meshData.probed_matrix ?? meshData.mesh_matrix ?? meshData.data) as number[][] | undefined;
      if (probed && Array.isArray(probed) && probed.length > 0) {
        this.bedMesh = probed;
        log.info(`Bed mesh updated: ${probed.length}x${probed[0].length}`);
      }
    }
  }

  private handleStatusEvent(data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    // Auto-report gap detection: track auto_report_id sequence
    const reportId = data.auto_report_id as number | undefined;
    if (reportId != null) {
      if (this.lastAutoReportId != null && reportId !== this.lastAutoReportId + 1) {
        log.warn(`Auto-report gap: expected ${this.lastAutoReportId + 1}, got ${reportId}. Requesting full refresh.`);
        this.bridge.sendCommand(1002, {});
      }
      this.lastAutoReportId = reportId;
    }

    // Normalize firmware field name variations
    if ('gcode_move_inf' in result && !('gcode_move' in result)) {
      result.gcode_move = result.gcode_move_inf;
      delete result.gcode_move_inf;
    }

    if (!this.status) {
      this.status = result as unknown as PrinterStatus;
    } else {
      this.status = deepMerge(
        this.status as unknown as Record<string, unknown>,
        result,
      ) as unknown as PrinterStatus;
    }

    // Capture bed mesh data if present (arrives during auto-level)
    this.extractBedMesh(result);

    // Capture canvas info updates from delta (active tray changes, etc.)
    const canvasDelta = result.canvas_info as CanvasInfo | undefined;
    if (canvasDelta) {
      if (this.canvas) {
        this.canvas = deepMerge(
          this.canvas as unknown as Record<string, unknown>,
          canvasDelta as unknown as Record<string, unknown>
        ) as unknown as CanvasInfo;
      } else {
        this.canvas = canvasDelta;
      }
    }

    this.detectEvents();
  }

  /**
   * Establish baseline from the first full status (method 1002).
   * Sets all tracking state from authoritative data, then enables event detection.
   */
  private establishBaseline(): void {
    if (!this.status) return;
    const ms = this.status.machine_status;
    const ps = this.status.print_status;
    const ext = this.status.extruder;

    this.lastMachineStatus = ms?.status ?? -1;
    this.lastSubStatus = ms?.sub_status ?? -1;
    this.lastExceptions = [...(ms?.exception_status ?? [])];
    this.wasFilamentDetected = !!ext?.filament_detected;

    if (this.lastMachineStatus === 2) {
      const progress = ms.progress ?? 0;
      this.lastProgressNotified = Math.floor(progress / this.progressInterval) * this.progressInterval;
      this.totalLayers = ps?.total_layer ?? 0;
      if (ps?.filename) {
        this.bridge.sendCommand(1046, { filename: ps.filename });
      }
      // Only reset layer data if it looks stale (last tracked layer is ahead of
      // current, or no data at all). If we're resuming the same print after a
      // restart, keep the accumulated data and just fix the timing baseline so
      // the next layer transition doesn't produce a bogus duration.
      const currentLayer = ps?.current_layer ?? 0;
      if (this._lastLayer > 0 && currentLayer > 0 && this._lastLayer <= currentLayer && this.layerTimes.length > 0) {
        // Data looks consistent with the current print — keep it, just reset
        // the timestamp so the first layer after restart isn't bogus
        this._lastLayer = currentLayer;
        this._lastLayerTime = Date.now();
        log.info(`Baseline from full status — printing at ${progress}%, kept ${this.layerTimes.length} layer entries, rebased timing at L${currentLayer}`);
      } else {
        this.clearLayerData();
        log.info(`Baseline from full status — printing at ${progress}%, layer data reset (stale or empty)`);
      }
    } else {
      log.info(`Baseline from full status — idle (status ${this.lastMachineStatus})`);
    }

    this.trackLayerChange(ps?.current_layer);
    this.baselineReady = true;

    // If already printing when baseline is set, notify listeners so they can
    // start monitoring (e.g. AI monitor joining a print already in progress)
    if (this.lastMachineStatus === 2) {
      this.emit('print_event', {
        type: 'print_started',
        filename: ps?.filename ?? 'unknown',
        resumed: true,
      } satisfies PrintEvent);
    }
  }

  /** Update tracking state silently (before baseline is ready) */
  private updateTrackingState(): void {
    if (!this.status) return;
    const ms = this.status.machine_status;
    const ps = this.status.print_status;
    // Just track layer changes, don't emit any events
    this.trackLayerChange(ps?.current_layer);
  }

  /** Detect state transitions and emit print events */
  private detectEvents(): void {
    if (!this.status || !this.baselineReady) {
      // Before baseline is ready, just silently update tracking state
      this.updateTrackingState();
      return;
    }

    const ms = this.status.machine_status;
    const ps = this.status.print_status;
    const ext = this.status.extruder;

    const machineStatus = ms?.status ?? -1;
    const subStatus = ms?.sub_status ?? -1;

    let printEnded = false;

    // Print started — either machine_status transitions to 2,
    // or sub_status transitions from completed/stopped to active while already printing
    const ENDED_SUBSTATUS = new Set([2077, 2503, 2504]);
    const isNewPrint = (machineStatus === 2 && this.lastMachineStatus !== 2) ||
      (machineStatus === 2 && ENDED_SUBSTATUS.has(this.lastSubStatus) && !ENDED_SUBSTATUS.has(subStatus) && subStatus !== 0);

    if (isNewPrint) {
      this.lastProgressNotified = -1;
      this.totalLayers = ps?.total_layer ?? 0;
      // Reset layer tracking for new print
      this.clearLayerData();
      // Reset filament usage for new print
      this.clearFilamentUsage();
      // Reset event log for new print
      this.clearEventLog();
      // Reset chart data for new print
      this.chartData = [];
      this.aiChartData = [];
      this._lastExtruderE = 0;
      this._lastExtruderSampleTime = 0;
      if (ps?.filename) {
        this.bridge.sendCommand(1046, { filename: ps.filename });
      }
      this.emit('print_event', {
        type: 'print_started',
        filename: ps?.filename ?? 'unknown',
      } satisfies PrintEvent);
    }

    // Print completed
    if (subStatus === 2077 && this.lastSubStatus !== 2077) {
      this.emit('print_event', {
        type: 'print_completed',
        filename: ps?.filename ?? 'unknown',
        duration: ps?.print_duration ?? 0,
      } satisfies PrintEvent);
      this.lastProgressNotified = -1;
      printEnded = true;
    }

    // Print stopped/failed
    if ((subStatus === 2503 || subStatus === 2504) &&
        this.lastSubStatus !== 2503 && this.lastSubStatus !== 2504) {
      const reason = SUB_STATUS_NAMES[subStatus] || `Sub-status ${subStatus}`;
      this.emit('print_event', {
        type: 'print_failed',
        filename: ps?.filename ?? 'unknown',
        reason,
      } satisfies PrintEvent);
      this.lastProgressNotified = -1;
      printEnded = true;
    }

    // Progress at configured intervals (skip if print just ended this cycle)
    if (!printEnded && machineStatus === 2 && ps) {
      const progress = ms.progress ?? 0;
      const nextThreshold = this.lastProgressNotified + this.progressInterval;
      if (progress >= nextThreshold && progress < 100) {
        const notifyAt = Math.floor(progress / this.progressInterval) * this.progressInterval;
        if (notifyAt > this.lastProgressNotified) {
          log.info(`Progress ${progress}% → notify at ${notifyAt}% (next threshold was ${nextThreshold}%)`);
          this.lastProgressNotified = notifyAt;
          this.emit('print_event', {
            type: 'print_progress',
            filename: ps.filename ?? 'unknown',
            progress: notifyAt,
            layer: ps.current_layer ?? 0,
            totalLayers: this.totalLayers || ps.total_layer || 0,
            remaining: ps.remaining_time_sec ?? 0,
          } satisfies PrintEvent);
        }
      }
    }

    // Exceptions
    const exceptions = ms?.exception_status ?? [];
    const newExceptions = exceptions.filter((e: number) => !this.lastExceptions.includes(e));
    if (newExceptions.length > 0) {
      const names = newExceptions.map((code: number) => EXCEPTION_NAMES[code] || `Unknown (${code})`);
      this.emit('print_event', { type: 'error', codes: newExceptions, names } satisfies PrintEvent);

      if (newExceptions.includes(109) || newExceptions.includes(1211)) {
        this.emit('print_event', { type: 'filament_runout' } satisfies PrintEvent);
      }
    }

    // Filament runout from sensor — only during active printing, not when print just ended
    if (ext && ext.filament_detect_enable && machineStatus === 2 && !printEnded) {
      if (!ext.filament_detected && this.wasFilamentDetected) {
        this.emit('print_event', { type: 'filament_runout' } satisfies PrintEvent);
      }
      this.wasFilamentDetected = !!ext.filament_detected;
    }

    // Status change events
    if (machineStatus !== this.lastMachineStatus) {
      this.emit('print_event', {
        type: 'status_change',
        fromCode: this.lastMachineStatus,
        toCode: machineStatus,
        from: STATUS_NAMES[this.lastMachineStatus] ?? `Unknown (${this.lastMachineStatus})`,
        to: STATUS_NAMES[machineStatus] ?? `Unknown (${machineStatus})`,
      } satisfies PrintEvent);
    }

    // Sub-status change events (skip default/0 transitions)
    if (subStatus !== this.lastSubStatus && !(this.lastSubStatus <= 0 && subStatus <= 0)) {
      this.emit('print_event', {
        type: 'sub_status_change',
        fromCode: this.lastSubStatus,
        toCode: subStatus,
        from: SUB_STATUS_NAMES[this.lastSubStatus] ?? `Unknown (${this.lastSubStatus})`,
        to: SUB_STATUS_NAMES[subStatus] ?? `Unknown (${subStatus})`,
      } satisfies PrintEvent);
    }

    this.lastMachineStatus = machineStatus;
    this.lastSubStatus = subStatus;
    this.lastExceptions = [...exceptions];

    // Track layer changes for layer time chart
    this.trackLayerChange(ps?.current_layer);
  }

  private trackLayerChange(layer: number | undefined): void {
    if (layer == null || layer <= 0) return;
    const now = Date.now();
    if (layer !== this._lastLayer) {
      if (this._lastLayer > 0 && this._lastLayerTime > 0) {
        const durationSec = (now - this._lastLayerTime) / 1000;
        // Sanity check: reject bogus durations (> 10 min per layer is implausible,
        // likely caused by stale timestamp across restart or print boundary)
        if (durationSec > 600) {
          log.warn(`Discarding bogus layer duration: L${this._lastLayer} = ${durationSec.toFixed(0)}s`);
        } else {
          const entry = { layer: this._lastLayer, duration: durationSec, timestamp: now };
          this.layerTimes.push(entry);
          if (this.layerTimes.length > 50_000) this.layerTimes.shift();
          // Broadcast to WS clients
          this.emit('layer_time', entry);
        }
        // Emit first_layer_complete when layer 1 finishes
        if (this.baselineReady && this._lastLayer === 1) {
          this.emit('print_event', {
            type: 'first_layer_complete',
            filename: this.status?.print_status?.filename || '',
            totalLayers: this.totalLayers || 0,
            durationSec,
          } satisfies PrintEvent);
        }
        // Emit layer_change event for milestone layers (every 10 layers)
        if (this.baselineReady && layer % 10 === 0) {
          this.emit('print_event', {
            type: 'layer_change',
            layer,
            totalLayers: this.totalLayers || 0,
            durationSec,
          } satisfies PrintEvent);
        }
      }
      this._lastLayer = layer;
      this._lastLayerTime = now;
    }
  }

  /** Get human-readable status summary (used by Telegram) */
  getStatusSummary(): string {
    const esc = (text: string) => text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    const s = this.status;
    if (!s) return 'Printer status unknown \\(not connected\\)';

    const ms = s.machine_status;
    const ps = s.print_status;

    const statusName = STATUS_NAMES[ms?.status ?? 0] || 'Unknown';
    const subName = SUB_STATUS_NAMES[ms?.sub_status ?? 0] || '';
    const speedName = SPEED_MODE_NAMES[s.gcode_move?.speed_mode ?? 1] || '';

    let summary = `*Status:* ${esc(statusName)}`;
    if (subName) summary += ` — ${esc(subName)}`;
    summary += '\n';

    summary += `🌡 *Nozzle:* ${s.extruder?.temperature ?? '?'}°C`;
    if (s.extruder?.target) summary += ` → ${s.extruder.target}°C`;
    summary += '\n';
    summary += `🌡 *Bed:* ${s.heater_bed?.temperature ?? '?'}°C`;
    if (s.heater_bed?.target) summary += ` → ${s.heater_bed.target}°C`;
    summary += '\n';
    if (s.ztemperature_sensor?.temperature) {
      summary += `🌡 *Chamber:* ${s.ztemperature_sensor.temperature}°C\n`;
    }

    if (ms?.status === 2 && ps) {
      const progress = ms.progress ?? 0;
      const remaining = ps.remaining_time_sec ?? 0;
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      const tl = this.totalLayers || ps.total_layer || 0;
      summary += `\n📄 *File:* ${esc(ps.filename || '?')}\n`;
      summary += `📊 *Progress:* ${progress}%\n`;
      summary += `📐 *Layer:* ${ps.current_layer ?? '?'}`;
      if (tl) summary += ` of ${tl}`;
      summary += '\n';
      summary += `⏱ *Remaining:* ${h}h ${m}m\n`;
      summary += `⚡ *Speed:* ${esc(speedName)}\n`;
    }

    if (s.fans) {
      const partFan = Math.round((s.fans.fan?.speed ?? 0) / 255 * 100);
      const auxFan = Math.round((s.fans.aux_fan?.speed ?? 0) / 255 * 100);
      summary += `\n🌀 *Part fan:* ${partFan}%  *Aux fan:* ${auxFan}%\n`;
    }

    const exceptions = ms?.exception_status ?? [];
    if (exceptions.length > 0) {
      const names = exceptions.map((c: number) => EXCEPTION_NAMES[c] || `Code ${c}`);
      summary += `\n⚠️ *Errors:* ${esc(names.join(', '))}\n`;
    }

    return summary;
  }
}
