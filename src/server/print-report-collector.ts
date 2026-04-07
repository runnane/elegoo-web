/**
 * Print Report Collector — captures per-print data for post-print summary reports.
 *
 * Listens to StateStore print lifecycle events. When a print starts, begins
 * capturing snapshots at intervals + chart data. When the print ends, finalizes
 * the report data and saves to disk.
 */

import { EventEmitter } from 'events';
import { mkdir, writeFile, readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import type { StateStore, ChartPoint, PrintEvent, EventLogEntry, FilamentUsage } from './state-store.js';
import type { ServiceConfig } from './config.js';
import { getSnapshot } from './rest-api.js';
import { getLogger } from './logger.js';

const log = getLogger('Report');

/** A captured camera snapshot during printing */
export interface ReportSnapshot {
  timestamp: number;
  /** Progress % at time of capture */
  progress: number;
  /** Current layer at time of capture */
  layer: number;
  /** JPEG filename (relative to report dir) */
  filename: string;
}

/** Completed print report metadata */
export interface PrintReport {
  version: 1;
  id: string;
  filename: string;
  startedAt: number;
  endedAt: number;
  outcome: 'completed' | 'failed' | 'stopped';
  failureReason?: string;
  duration: number;
  /** Printer info */
  printer: {
    model: string;
    sn: string;
    firmware: string;
    hostname: string;
  };
  /** Print stats */
  stats: {
    totalLayers: number;
    progressAtEnd: number;
    fileTotalLayers: number | null;
  };
  /** Filament used per spool */
  filament: FilamentUsage[];
  /** Temperature stats computed from chart data */
  temperatureStats: {
    nozzle: MinMaxAvg;
    bed: MinMaxAvg;
    chamber: MinMaxAvg;
  };
  /** Fan stats */
  fanStats: {
    partFan: MinMaxAvg;
    auxFan: MinMaxAvg;
    caseFan: MinMaxAvg;
  };
  /** Layer time stats */
  layerStats: {
    count: number;
    avgDuration: number;
    minDuration: number;
    maxDuration: number;
    /** Layer durations for charting [layer, duration_sec] */
    layers: Array<[number, number]>;
  };
  /** Thumbnail base64 PNG (from print start) */
  thumbnail: string | null;
  /** Captured JPEG snapshots */
  snapshots: ReportSnapshot[];
  /** Number of chart data points */
  chartPointCount: number;
  /** Key events during print */
  events: Array<{ ts: number; summary: string }>;
}

interface MinMaxAvg {
  min: number;
  max: number;
  avg: number;
}

/** Interval between snapshot captures (ms) — default 2 minutes */
const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
/** Max snapshots per print */
const MAX_SNAPSHOTS = 60;

export class PrintReportCollector extends EventEmitter {
  private reportsDir: string;
  private activeReport: ActivePrint | null = null;

  constructor(
    private store: StateStore,
    private config: ServiceConfig,
  ) {
    super();
    this.reportsDir = join(config.dataDir, 'reports');
    this.store.on('print_event', (event: PrintEvent) => this.handleEvent(event));
  }

  async init(): Promise<void> {
    await mkdir(this.reportsDir, { recursive: true });
  }

  private handleEvent(event: PrintEvent): void {
    switch (event.type) {
      case 'print_started':
        if (event.resumed && this.activeReport) {
          log.info(`Print resumed: ${event.filename} — continuing report`);
          return;
        }
        this.startReport(event.filename);
        break;
      case 'print_completed':
        this.finalizeReport('completed', event.duration);
        break;
      case 'print_failed':
        this.finalizeReport('failed', undefined, event.reason);
        break;
      case 'print_progress':
        this.recordEvent(`Progress ${event.progress}% — Layer ${event.layer}/${event.totalLayers}`);
        break;
      case 'error':
        this.recordEvent(`Error: ${event.names.join(', ')}`);
        break;
      case 'filament_runout':
        this.recordEvent('Filament runout detected');
        break;
      case 'layer_change':
        // Only log milestone layers
        if (event.layer % 50 === 0 || event.layer === event.totalLayers) {
          this.recordEvent(`Layer ${event.layer}/${event.totalLayers} (${event.durationSec.toFixed(1)}s)`);
        }
        break;
    }
  }

  private startReport(filename: string): void {
    // Finalize any lingering report
    if (this.activeReport) {
      this.finalizeReport('stopped');
    }

    const id = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    log.info(`Starting report: ${id}`);

    this.activeReport = {
      id,
      filename,
      startedAt: Date.now(),
      thumbnail: this.store.thumbnail,
      snapshots: [],
      events: [],
      snapshotTimer: null,
      reportDir: join(this.reportsDir, id),
    };

    this.recordEvent('Print started');

    // Start snapshot capture timer
    this.captureSnapshot();
    this.activeReport!.snapshotTimer = setInterval(() => this.captureSnapshot(), SNAPSHOT_INTERVAL_MS);
  }

  private async finalizeReport(outcome: 'completed' | 'failed' | 'stopped', duration?: number, failureReason?: string): Promise<void> {
    const active = this.activeReport;
    if (!active) return;

    // Stop snapshot timer
    if (active.snapshotTimer) {
      clearInterval(active.snapshotTimer);
      active.snapshotTimer = null;
    }

    // Capture final snapshot
    await this.captureSnapshot();

    this.recordEvent(`Print ${outcome}${failureReason ? ': ' + failureReason : ''}`);

    const endedAt = Date.now();
    const attrs = this.store.attributes;
    const status = this.store.status;

    // Compute chart statistics from data collected during print window
    const chartData = this.store.getChartHistory().filter(
      p => p.t >= active.startedAt && p.t <= endedAt,
    );
    const layerTimes = this.store.layerTimes;

    const report: PrintReport = {
      version: 1,
      id: active.id,
      filename: active.filename,
      startedAt: active.startedAt,
      endedAt,
      outcome,
      failureReason,
      duration: duration ?? Math.round((endedAt - active.startedAt) / 1000),
      printer: {
        model: attrs?.machine_model ?? 'Unknown',
        sn: attrs?.sn ?? 'Unknown',
        firmware: attrs?.software_version?.ota_version ?? 'Unknown',
        hostname: attrs?.hostname ?? 'Unknown',
      },
      stats: {
        totalLayers: status?.print_status?.total_layer ?? 0,
        progressAtEnd: status?.machine_status?.progress ?? 0,
        fileTotalLayers: this.store.fileTotalLayers,
      },
      filament: this.store.getFilamentUsageArray(),
      temperatureStats: {
        nozzle: computeStats(chartData, 'nozzle'),
        bed: computeStats(chartData, 'bed'),
        chamber: computeStats(chartData, 'chamber'),
      },
      fanStats: {
        partFan: computeStats(chartData, 'fan_model'),
        auxFan: computeStats(chartData, 'fan_aux'),
        caseFan: computeStats(chartData, 'fan_case'),
      },
      layerStats: computeLayerStats(layerTimes),
      thumbnail: active.thumbnail,
      snapshots: active.snapshots,
      chartPointCount: chartData.length,
      events: active.events,
    };

    // Save report JSON + chart data
    try {
      await mkdir(active.reportDir, { recursive: true });
      await writeFile(join(active.reportDir, 'report.json'), JSON.stringify(report, null, 2));
      // Save chart data separately (can be large)
      await writeFile(join(active.reportDir, 'chart-data.json'), JSON.stringify(chartData));
      log.info(`Report saved: ${active.id} (${active.snapshots.length} snapshots, ${chartData.length} chart points)`);
    } catch (err) {
      log.error(`Failed to save report: ${err}`);
    }

    this.activeReport = null;
    this.emit('report_saved', report);
  }

  private async captureSnapshot(): Promise<void> {
    const active = this.activeReport;
    if (!active || !this.config.cameraEnabled) return;
    if (active.snapshots.length >= MAX_SNAPSHOTS) return;

    try {
      const jpeg = await getSnapshot(this.config);
      if (!jpeg) return;

      const status = this.store.status;
      const progress = status?.machine_status?.progress ?? 0;
      const layer = status?.print_status?.current_layer ?? 0;
      const ts = Date.now();
      const snapFilename = `snapshot-${ts}.jpg`;

      await mkdir(active.reportDir, { recursive: true });
      await writeFile(join(active.reportDir, snapFilename), jpeg);

      active.snapshots.push({
        timestamp: ts,
        progress,
        layer,
        filename: snapFilename,
      });
    } catch (err) {
      log.warn(`Snapshot capture failed: ${err}`);
    }
  }

  private recordEvent(summary: string): void {
    if (!this.activeReport) return;
    this.activeReport.events.push({ ts: Date.now(), summary });
  }

  /** List all saved reports (most recent first) */
  async listReports(): Promise<Array<{ id: string; filename: string; outcome: string; startedAt: number; endedAt: number; duration: number }>> {
    try {
      const entries = await readdir(this.reportsDir, { withFileTypes: true });
      const reports: Array<{ id: string; filename: string; outcome: string; startedAt: number; endedAt: number; duration: number }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const data = await readFile(join(this.reportsDir, entry.name, 'report.json'), 'utf-8');
          const report = JSON.parse(data) as PrintReport;
          reports.push({
            id: report.id,
            filename: report.filename,
            outcome: report.outcome,
            startedAt: report.startedAt,
            endedAt: report.endedAt,
            duration: report.duration,
          });
        } catch {
          // Skip broken reports
        }
      }

      reports.sort((a, b) => b.startedAt - a.startedAt);
      return reports;
    } catch {
      return [];
    }
  }

  /** Get a report by ID */
  async getReport(id: string): Promise<PrintReport | null> {
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
    try {
      const data = await readFile(join(this.reportsDir, safeId, 'report.json'), 'utf-8');
      return JSON.parse(data) as PrintReport;
    } catch {
      return null;
    }
  }

  /** Get chart data for a report */
  async getChartData(id: string): Promise<ChartPoint[] | null> {
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
    try {
      const data = await readFile(join(this.reportsDir, safeId, 'chart-data.json'), 'utf-8');
      return JSON.parse(data) as ChartPoint[];
    } catch {
      return null;
    }
  }

  /** Get a snapshot JPEG buffer */
  async getSnapshot(id: string, snapFilename: string): Promise<Buffer | null> {
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeName = snapFilename.replace(/[^a-zA-Z0-9._-]/g, '');
    try {
      return await readFile(join(this.reportsDir, safeId, safeName)) as Buffer;
    } catch {
      return null;
    }
  }

  /** Delete a report and all its data */
  async deleteReport(id: string): Promise<boolean> {
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
    try {
      await rm(join(this.reportsDir, safeId), { recursive: true, force: true });
      log.info(`Report deleted: ${safeId}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if a print is currently being tracked */
  isActive(): boolean {
    return this.activeReport !== null;
  }
}

interface ActivePrint {
  id: string;
  filename: string;
  startedAt: number;
  thumbnail: string | null;
  snapshots: ReportSnapshot[];
  events: Array<{ ts: number; summary: string }>;
  snapshotTimer: ReturnType<typeof setInterval> | null;
  reportDir: string;
}

function computeStats(data: ChartPoint[], key: string): MinMaxAvg {
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  for (const p of data) {
    const v = p.values[key];
    if (v == null || v === 0) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  if (count === 0) return { min: 0, max: 0, avg: 0 };
  return {
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    avg: Math.round((sum / count) * 10) / 10,
  };
}

function computeLayerStats(layerTimes: Array<{ layer: number; duration: number; timestamp: number }>): PrintReport['layerStats'] {
  if (layerTimes.length === 0) {
    return { count: 0, avgDuration: 0, minDuration: 0, maxDuration: 0, layers: [] };
  }
  let min = Infinity, max = -Infinity, sum = 0;
  const layers: Array<[number, number]> = [];
  for (const lt of layerTimes) {
    const d = lt.duration;
    if (d < min) min = d;
    if (d > max) max = d;
    sum += d;
    layers.push([lt.layer, Math.round(d * 10) / 10]);
  }
  return {
    count: layerTimes.length,
    avgDuration: Math.round((sum / layerTimes.length) * 10) / 10,
    minDuration: Math.round(min * 10) / 10,
    maxDuration: Math.round(max * 10) / 10,
    layers,
  };
}
