import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRO_FILTER,
  type RetroPrintItem,
  calculateRetroSummary,
  extractFilamentOptions,
  extrudedMmToGrams,
  filterRetroPrints,
  formatTrayKeyLabel,
  getPrintMatchedUsage,
  suggestDensityForFilter,
} from '../ui/spool-retro';

const DAY_MS = 86_400_000;
const BASE_TS = Date.UTC(2026, 10, 20, 12, 0, 0);

const SAMPLE_PRINTS: RetroPrintItem[] = [
  {
    id: 'r-abs-done',
    filename: 'drybox_base_abs.gcode',
    outcome: 'completed',
    startedAt: BASE_TS,
    endedAt: BASE_TS + 16_000_000,
    duration: 16_000,
    progressAtEnd: 99,
    filament: [
      {
        trayKey: 'canvas_0_tray_0',
        filamentType: 'ABS',
        color: '#898989',
        extruded_mm: 78_000,
        grams: 195.1,
        meters: 78,
      },
    ],
  },
  {
    id: 'r-pa-canceled',
    filename: 'frame_pa6cf.gcode',
    outcome: 'failed',
    failureReason: 'Stopping',
    startedAt: BASE_TS + DAY_MS,
    endedAt: BASE_TS + DAY_MS + 10_000_000,
    duration: 10_000,
    progressAtEnd: 31,
    filament: [
      {
        trayKey: 'mono',
        filamentType: 'PLA',
        color: '#888888',
        extruded_mm: 10,
        grams: 0.03,
        meters: 0.01,
      },
      {
        trayKey: 'canvas_0_tray_1',
        filamentType: 'PA',
        color: '#262626',
        extruded_mm: 11_425,
        grams: 31.33,
        meters: 11.425,
      },
    ],
  },
  {
    id: 'r-pa-done',
    filename: 'body_pa6cf.gcode',
    outcome: 'completed',
    startedAt: BASE_TS + 2 * DAY_MS,
    endedAt: BASE_TS + 2 * DAY_MS + 80_000_000,
    duration: 80_000,
    progressAtEnd: 99,
    filament: [
      {
        trayKey: 'canvas_0_tray_1',
        filamentType: 'PA',
        color: '#262626',
        extruded_mm: 81_575,
        grams: 223.69,
        meters: 81.575,
      },
    ],
  },
  {
    id: 'r-pa-zero',
    filename: 'aborted_early_pa6cf.gcode',
    outcome: 'stopped',
    startedAt: BASE_TS + 3 * DAY_MS,
    endedAt: BASE_TS + 3 * DAY_MS + 40_000,
    duration: 40,
    progressAtEnd: 0,
    filament: [],
  },
  {
    id: 'active:live-1',
    filename: 'current_pa6cf.gcode',
    outcome: 'printing',
    startedAt: BASE_TS + 4 * DAY_MS,
    endedAt: BASE_TS + 4 * DAY_MS + 300_000,
    duration: 300,
    progressAtEnd: 2,
    isActive: true,
    filament: [
      {
        trayKey: 'canvas_0_tray_1',
        filamentType: 'PA',
        color: '#262626',
        extruded_mm: 500,
        grams: 1.37,
        meters: 0.5,
      },
    ],
  },
];

describe('spool-retro filtering and usage math', () => {
  it('filters by filament type and includes failed/canceled prints by default', () => {
    const filtered = filterRetroPrints(SAMPLE_PRINTS, {
      ...DEFAULT_RETRO_FILTER,
      filamentFilter: 'PA',
    });
    expect(filtered.map((p) => p.id)).toEqual(['r-pa-canceled', 'r-pa-done']);
  });

  it('filters by date since (inclusive) and by specific tray', () => {
    const filtered = filterRetroPrints(SAMPLE_PRINTS, {
      ...DEFAULT_RETRO_FILTER,
      filamentFilter: 'tray:canvas_0_tray_1',
      sinceMs: BASE_TS + 2 * DAY_MS,
    });
    expect(filtered.map((p) => p.id)).toEqual(['r-pa-done']);
  });

  it('includes active print and zero-usage prints only when opted in', () => {
    const withActive = filterRetroPrints(SAMPLE_PRINTS, {
      ...DEFAULT_RETRO_FILTER,
      filamentFilter: 'PA',
      includeActive: true,
    });
    expect(withActive.map((p) => p.id)).toEqual(['r-pa-canceled', 'r-pa-done', 'active:live-1']);

    const withZero = filterRetroPrints(SAMPLE_PRINTS, {
      ...DEFAULT_RETRO_FILTER,
      filamentFilter: 'ALL',
      includeZeroUsage: true,
    });
    expect(withZero.map((p) => p.id)).toContain('r-pa-zero');
  });

  it('attributes mono prime/purge to a filtered print only when includeMonoPurge is true', () => {
    const canceled = SAMPLE_PRINTS[1];
    const withMono = getPrintMatchedUsage(canceled, 'PA', null, 1.75, true);
    const withoutMono = getPrintMatchedUsage(canceled, 'PA', null, 1.75, false);

    expect(withMono.extrudedMm).toBe(11_435);
    expect(withoutMono.extrudedMm).toBe(11_425);
    expect(withMono.grams).toBeCloseTo(31.36, 2);
    expect(withoutMono.grams).toBeCloseTo(31.33, 2);
  });

  it('recomputes grams from extruded_mm when a density override is provided', () => {
    const done = SAMPLE_PRINTS[2];
    const atDefault = getPrintMatchedUsage(done, 'PA', null, 1.75, false);
    const atPa6Cf = getPrintMatchedUsage(done, 'PA', 1.25, 1.75, false);

    expect(atDefault.grams).toBeCloseTo(223.69, 2);
    expect(atPa6Cf.grams).toBeCloseTo(extrudedMmToGrams(81_575, 1.25, 1.75), 5);
    expect(atPa6Cf.grams).toBeGreaterThan(atDefault.grams);
  });

  it('aggregates selected prints, supports manual overrides, and checks planned print sufficiency', () => {
    const filter = {
      ...DEFAULT_RETRO_FILTER,
      filamentFilter: 'PA',
      includeMonoPurge: false,
    };
    const visible = filterRetroPrints(SAMPLE_PRINTS, filter);
    const selected = new Set(visible.map((p) => p.id));

    const summary = calculateRetroSummary(visible, selected, filter, {
      startingSpoolGrams: 300,
      densityOverride: null,
      filamentDiameterMm: 1.75,
      plannedPrintGrams: 90,
      manualGramsOverrides: {},
    });

    expect(summary.selectedCount).toBe(2);
    expect(summary.completedCount).toBe(1);
    expect(summary.canceledCount).toBe(1);
    expect(summary.usedGrams).toBeCloseTo(255.02, 2);
    expect(summary.canceledGrams).toBeCloseTo(31.33, 2);
    expect(summary.remainingGrams).toBeCloseTo(44.98, 2);
    expect(summary.hasEnoughForPlanned).toBe(false);
    expect(summary.afterPlannedGrams).toBeCloseTo(-45.02, 2);

    // Override canceled print manually to 10g -> now enough for a 60g print
    const overridden = calculateRetroSummary(visible, selected, filter, {
      startingSpoolGrams: 300,
      densityOverride: null,
      filamentDiameterMm: 1.75,
      plannedPrintGrams: 60,
      manualGramsOverrides: { 'r-pa-canceled': 10 },
    });
    expect(overridden.usedGrams).toBeCloseTo(233.69, 2);
    expect(overridden.remainingGrams).toBeCloseTo(66.31, 2);
    expect(overridden.hasEnoughForPlanned).toBe(true);
    expect(overridden.afterPlannedGrams).toBeCloseTo(6.31, 2);
  });

  it('extracts sorted filament types and tray options with optional Canvas labels', () => {
    const opts = extractFilamentOptions(SAMPLE_PRINTS, { canvas_0_tray_1: 'PA6-CF' });
    const types = opts.filter((o) => o.kind === 'type');
    const trays = opts.filter((o) => o.kind === 'tray');

    expect(types[0].value).toBe('PA');
    expect(trays[0].value).toBe('tray:canvas_0_tray_1');
    expect(trays[0].label).toContain('Slot 2 (PA6-CF)');
    expect(formatTrayKeyLabel('mono')).toBe('Direct / External');
    expect(suggestDensityForFilter('tray:canvas_0_tray_1', { canvas_0_tray_1: 'PA6-CF' })).toBe(
      1.2,
    );
  });
});
