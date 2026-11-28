import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceConfig } from '../config.js';
import { PrintReportCollector } from '../print-report-collector.js';
import type { FilamentUsage, StateStore } from '../state-store.js';

class StubStore extends EventEmitter {
  status: Record<string, unknown> | null = {
    print_status: { filename: 'active_part.gcode', current_layer: 5, total_layer: 100 },
    machine_status: { progress: 12 },
  };
  attributes: Record<string, unknown> | null = null;
  thumbnail: string | null = null;
  fileTotalLayers: number | null = 100;
  layerTimes: Array<{ layer: number; duration: number; timestamp: number }> = [];
  private filament: FilamentUsage[] = [
    {
      trayKey: 'canvas_0_tray_1',
      filamentType: 'PA',
      color: '#262626',
      extruded_mm: 1500,
      grams: 4.11,
      meters: 1.5,
    },
  ];
  getChartHistory() {
    return [];
  }
  getFilamentUsageArray(): FilamentUsage[] {
    return this.filament;
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elegoo-reports-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PrintReportCollector.listReports and active summary', () => {
  it('returns filament usage, progressAtEnd, and failureReason in listReports()', async () => {
    const reportsDir = join(dir, 'reports');
    mkdirSync(join(reportsDir, 'rep-1'), { recursive: true });
    mkdirSync(join(reportsDir, 'rep-legacy'), { recursive: true });

    writeFileSync(
      join(reportsDir, 'rep-1', 'report.json'),
      JSON.stringify({
        version: 1,
        id: 'rep-1',
        filename: 'frame_pa6cf.gcode',
        startedAt: 2000,
        endedAt: 5000,
        outcome: 'failed',
        failureReason: 'Stopping',
        duration: 3,
        stats: { totalLayers: 100, progressAtEnd: 31, fileTotalLayers: 100 },
        filament: [
          {
            trayKey: 'canvas_0_tray_1',
            filamentType: 'PA',
            color: '#262626',
            extruded_mm: 11425,
            grams: 31.33,
            meters: 11.425,
          },
        ],
      }),
    );

    // Legacy report missing stats/filament should still list safely
    writeFileSync(
      join(reportsDir, 'rep-legacy', 'report.json'),
      JSON.stringify({
        version: 1,
        id: 'rep-legacy',
        filename: 'old_part.gcode',
        startedAt: 1000,
        endedAt: 2000,
        outcome: 'completed',
        duration: 1,
      }),
    );

    const store = new StubStore();
    const collector = new PrintReportCollector(
      store as unknown as StateStore,
      { dataDir: dir, cameraEnabled: false } as ServiceConfig,
    );

    const listed = await collector.listReports();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      id: 'rep-1',
      outcome: 'failed',
      failureReason: 'Stopping',
      progressAtEnd: 31,
    });
    expect(listed[0].filament).toHaveLength(1);
    expect(listed[0].filament[0].grams).toBeCloseTo(31.33, 2);

    expect(listed[1]).toMatchObject({
      id: 'rep-legacy',
      outcome: 'completed',
      progressAtEnd: 0,
      filament: [],
    });
    expect('failureReason' in listed[1]).toBe(false);
  });

  it('exposes active print summary with live filament usage while a print is running', () => {
    const store = new StubStore();
    const collector = new PrintReportCollector(
      store as unknown as StateStore,
      { dataDir: dir, cameraEnabled: false } as ServiceConfig,
    );

    expect(collector.getActiveSummary()).toBeNull();

    store.emit('print_event', {
      type: 'print_started',
      filename: 'active_part.gcode',
      resumed: false,
    });
    const active = collector.getActiveSummary();
    expect(active).not.toBeNull();
    expect(active?.filename).toBe('active_part.gcode');
    expect(active?.progress).toBe(12);
    expect(active?.filament[0].extruded_mm).toBe(1500);

    // Clean up internal snapshot timer by simulating printer switch
    store.emit('printer_switched');
    expect(collector.getActiveSummary()).toBeNull();
  });
});
