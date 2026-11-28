/**
 * ELEG-197 — the Retroactive Spool Estimator's pure half (ported from contributor PR
 * #182, with the density-override gate, the shared density table and the preference
 * normaliser added). Values are pinned by hand where a formula is under test, so the
 * expected side cannot drift together with the implementation.
 */
import { describe, expect, it } from 'vitest';
import { FILAMENT_DENSITY, filamentDensity } from '../filament-density';
import {
  DEFAULT_RETRO_FILTER,
  DEFAULT_RETRO_PREFS,
  type RetroPrintItem,
  calculateRetroSummary,
  extractFilamentOptions,
  extrudedMmToGrams,
  filterRetroPrints,
  formatTrayKeyLabel,
  getPrintMatchedUsage,
  gramsToMeters,
  normaliseReportsPayload,
  normaliseRetroPrefs,
  requestedDensityOverride,
  resolveDensityScope,
} from '../ui/spool-retro';

const DAY_MS = 86_400_000;
const BASE_TS = Date.UTC(2026, 10, 20, 12, 0, 0);

const SAMPLE_PRINTS: RetroPrintItem[] = [
  {
    id: 'r-abs-done',
    filename: 'sample_part_a.gcode',
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
    filename: 'sample_part_b.gcode',
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
    filename: 'sample_part_c.gcode',
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
    filename: 'sample_part_d.gcode',
    outcome: 'stopped',
    startedAt: BASE_TS + 3 * DAY_MS,
    endedAt: BASE_TS + 3 * DAY_MS + 40_000,
    duration: 40,
    progressAtEnd: 0,
    filament: [],
  },
  {
    id: 'active:live-1',
    filename: 'sample_part_e.gcode',
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

/** A slot that held PLA, then PETG. */
const MIXED_TRAY_PRINTS: RetroPrintItem[] = [
  {
    ...SAMPLE_PRINTS[0],
    id: 'm-1',
    filament: [
      {
        trayKey: 'canvas_0_tray_2',
        filamentType: 'PLA',
        color: '#ffffff',
        extruded_mm: 1000,
        grams: 2.98,
        meters: 1,
      },
    ],
  },
  {
    ...SAMPLE_PRINTS[0],
    id: 'm-2',
    filament: [
      {
        trayKey: 'canvas_0_tray_2',
        filamentType: 'PETG',
        color: '#000000',
        extruded_mm: 1000,
        grams: 3.06,
        meters: 1,
      },
    ],
  },
];

const noOverrides = { plannedPrintGrams: 0, manualGramsOverrides: {} };

describe('the mm → g formula', () => {
  it('converts 1000 mm of 1.75 mm filament at 1.24 g/cm³ to 2.9826 g (hand-computed)', () => {
    // 100 cm × π × (0.0875 cm)² = 2.40528 cm³; × 1.24 g/cm³ = 2.98255 g
    expect(extrudedMmToGrams(1000, 1.24)).toBeCloseTo(2.98255, 4);
    expect(gramsToMeters(2.98255, 1.24)).toBeCloseTo(1, 4);
  });

  it('agrees with the service: recorded grams use the same formula and density table', () => {
    // state-store.ts accumulates (deltaE / 10) × CROSS_SECTION_CM2 × density.
    expect(extrudedMmToGrams(11_425, filamentDensity('PA'))).toBeCloseTo(31.33, 1);
  });
});

describe('the shared density table', () => {
  it('holds the materials the contributor added, for both halves', () => {
    expect(FILAMENT_DENSITY['PA-CF']).toBe(1.17);
    expect(FILAMENT_DENSITY['PA6-CF']).toBe(1.2);
    expect(FILAMENT_DENSITY['PLA+']).toBe(1.24);
  });

  it('is case-insensitive and falls back to PLA for an unknown type', () => {
    expect(filamentDensity('petg')).toBe(1.27);
    expect(filamentDensity('UNOBTAINIUM')).toBe(1.24);
  });
});

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
      includeZeroUsage: true,
    });
    expect(withZero.map((p) => p.id)).toContain('r-pa-zero');
    expect(filterRetroPrints(SAMPLE_PRINTS, DEFAULT_RETRO_FILTER).map((p) => p.id)).not.toContain(
      'r-pa-zero',
    );
  });

  it('attributes mono prime/purge to a filtered print only when includeMonoPurge is true', () => {
    const canceled = SAMPLE_PRINTS[1];
    const withMono = getPrintMatchedUsage(canceled, 'PA', null, true);
    const withoutMono = getPrintMatchedUsage(canceled, 'PA', null, false);
    expect(withMono.extrudedMm).toBe(11_435);
    expect(withoutMono.extrudedMm).toBe(11_425);
    expect(withMono.grams).toBeCloseTo(31.36, 2);
    expect(withoutMono.grams).toBeCloseTo(31.33, 2);
  });

  it('recomputes grams from extruded length when given an override', () => {
    const done = SAMPLE_PRINTS[2];
    expect(getPrintMatchedUsage(done, 'PA', null, false).grams).toBeCloseTo(223.69, 2);
    // 8157.5 cm × 0.0240528 cm² × 1.25 g/cm³ = 245.26 g (hand-computed)
    expect(getPrintMatchedUsage(done, 'PA', 1.25, false).grams).toBeCloseTo(245.26, 1);
  });

  it('aggregates selected prints, supports manual overrides, and checks planned print sufficiency', () => {
    const filter = { ...DEFAULT_RETRO_FILTER, filamentFilter: 'PA', includeMonoPurge: false };
    const visible = filterRetroPrints(SAMPLE_PRINTS, filter);
    const selected = new Set(visible.map((p) => p.id));

    const summary = calculateRetroSummary(visible, selected, filter, {
      startingSpoolGrams: 300,
      densityOverride: null,
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

    const overridden = calculateRetroSummary(visible, selected, filter, {
      startingSpoolGrams: 300,
      densityOverride: null,
      plannedPrintGrams: 60,
      manualGramsOverrides: { 'r-pa-canceled': 10 },
    });
    expect(overridden.usedGrams).toBeCloseTo(233.69, 2);
    expect(overridden.remainingGrams).toBeCloseTo(66.31, 2);
    expect(overridden.hasEnoughForPlanned).toBe(true);
    expect(overridden.afterPlannedGrams).toBeCloseTo(6.31, 2);
  });

  it('keeps the unclamped remainder for an over-used spool, and clamps only the display value', () => {
    const visible = filterRetroPrints(SAMPLE_PRINTS, DEFAULT_RETRO_FILTER);
    const s = calculateRetroSummary(
      visible,
      new Set(visible.map((p) => p.id)),
      DEFAULT_RETRO_FILTER,
      {
        startingSpoolGrams: 250,
        densityOverride: null,
        ...noOverrides,
      },
    );
    // 195.1 + 31.36 + 223.69 = 450.15 g used of 250 g
    expect(s.rawRemainingGrams).toBeCloseTo(-200.15, 2);
    expect(s.remainingGrams).toBe(0);
  });

  it('extracts sorted filament types and tray options with optional Canvas labels', () => {
    const opts = extractFilamentOptions(SAMPLE_PRINTS, { canvas_0_tray_1: 'PA6-CF' });
    const types = opts.filter((o) => o.kind === 'type');
    const trays = opts.filter((o) => o.kind === 'tray');
    expect(types[0].value).toBe('PA');
    expect(trays[0].value).toBe('tray:canvas_0_tray_1');
    expect(trays[0].label).toContain('Slot 2 (PA6-CF)');
    expect(formatTrayKeyLabel('mono')).toBe('Direct / External');
  });
});

describe('the density override applies to a single material only', () => {
  it('selects no material for ALL, so an override is never applied', () => {
    expect(resolveDensityScope(SAMPLE_PRINTS, { filamentFilter: 'ALL' }, 1.5)).toEqual({
      material: null,
      override: null,
    });
  });

  it('selects the type for a type filter, mono purge included', () => {
    expect(resolveDensityScope(SAMPLE_PRINTS, { filamentFilter: 'PA' }, 1.5)).toEqual({
      material: 'PA',
      override: 1.5,
    });
  });

  it('selects a tray only if every entry recorded for it is one material', () => {
    expect(
      resolveDensityScope(SAMPLE_PRINTS, { filamentFilter: 'tray:canvas_0_tray_1' }, 1.5),
    ).toEqual({
      material: 'PA',
      override: 1.5,
    });
    expect(
      resolveDensityScope(MIXED_TRAY_PRINTS, { filamentFilter: 'tray:canvas_0_tray_2' }, 1.5),
    ).toEqual({
      material: null,
      override: null,
    });
  });

  it('ignores an override across mixed materials: the summary uses recorded grams', () => {
    const visible = filterRetroPrints(SAMPLE_PRINTS, DEFAULT_RETRO_FILTER);
    const selected = new Set(visible.map((p) => p.id));
    const s = calculateRetroSummary(visible, selected, DEFAULT_RETRO_FILTER, {
      startingSpoolGrams: 1000,
      densityOverride: 1.5,
      ...noOverrides,
    });
    expect(s.appliedDensityOverride).toBeNull();
    expect(s.usedGrams).toBeCloseTo(450.15, 2);
  });

  it('ignores an override for a slot that held two materials', () => {
    const filter = { ...DEFAULT_RETRO_FILTER, filamentFilter: 'tray:canvas_0_tray_2' };
    const visible = filterRetroPrints(MIXED_TRAY_PRINTS, filter);
    const s = calculateRetroSummary(visible, new Set(visible.map((p) => p.id)), filter, {
      startingSpoolGrams: 1000,
      densityOverride: 1.5,
      ...noOverrides,
    });
    expect(s.usedGrams).toBeCloseTo(6.04, 2);
  });

  it('applies the override for a single material', () => {
    const filter = { ...DEFAULT_RETRO_FILTER, filamentFilter: 'PA', includeMonoPurge: false };
    const visible = filterRetroPrints(SAMPLE_PRINTS, filter);
    const s = calculateRetroSummary(visible, new Set(visible.map((p) => p.id)), filter, {
      startingSpoolGrams: 1000,
      densityOverride: 1.25,
      ...noOverrides,
    });
    expect(s.appliedDensityOverride).toBe(1.25);
    // (11 425 + 81 575) mm = 9300 cm × 0.0240528 cm² × 1.25 = 279.61 g
    expect(s.usedGrams).toBeCloseTo(279.61, 1);
  });
});

describe('preferences', () => {
  it('normalises a stored value field by field, dropping wrong types', () => {
    const prefs = normaliseRetroPrefs({
      startingSpoolGrams: 500,
      filamentFilter: 'PA',
      densityMode: 'NOT-A-MATERIAL',
      includeFailed: 'yes',
      manualGramsOverrides: { a: 12, b: -1, c: 'x' },
    });
    expect(prefs.startingSpoolGrams).toBe(500);
    expect(prefs.filamentFilter).toBe('PA');
    expect(prefs.densityMode).toBe('auto');
    expect(prefs.includeFailed).toBe(true);
    expect(prefs.manualGramsOverrides).toEqual({ a: 12 });
  });

  it('falls back to the defaults for garbage', () => {
    expect(normaliseRetroPrefs('garbage')).toEqual(DEFAULT_RETRO_PREFS);
    expect(normaliseRetroPrefs(null)).toEqual(DEFAULT_RETRO_PREFS);
  });

  it('turns a density choice into the requested override', () => {
    expect(requestedDensityOverride({ densityMode: 'auto', customDensity: 1.3 })).toBeNull();
    expect(requestedDensityOverride({ densityMode: 'PA-CF', customDensity: 1.3 })).toBe(1.17);
    expect(requestedDensityOverride({ densityMode: 'custom', customDensity: 1.3 })).toBe(1.3);
  });
});

describe('the /api/reports payload', () => {
  it('puts the live print first, marked active, and keeps every report', () => {
    const items = normaliseReportsPayload(
      {
        reports: [
          {
            id: 'r1',
            filename: 'a.gcode',
            outcome: 'completed',
            startedAt: 1,
            endedAt: 2,
            duration: 1,
          },
        ],
        active: true,
        activePrint: { id: 'p1', filename: 'b.gcode', startedAt: 1000, progress: 40, filament: [] },
      },
      61_000,
    );
    expect(items.map((i) => i.id)).toEqual(['active:p1', 'r1']);
    expect(items[0]).toMatchObject({
      isActive: true,
      outcome: 'printing',
      progressAtEnd: 40,
      duration: 60,
    });
    expect(items[1].filament).toEqual([]);
  });
});
