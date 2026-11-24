/**
 * Pure domain logic for retroactive spool estimation from print reports.
 *
 * Kept free of DOM and storage so it can be unit-tested in Node alongside
 * `card-layout.ts` and `list-sort.ts`.
 */

/** Material densities in g/cm³ shared with the Spool Calculator */
export const SPOOL_MATERIALS: Record<string, number> = {
  PLA: 1.24,
  'PLA+': 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PA: 1.14,
  'PA-CF': 1.17,
  'PA6-CF': 1.2,
  PC: 1.2,
  HIPS: 1.04,
  PVA: 1.23,
};

export interface ReportFilamentEntry {
  trayKey: string;
  filamentType: string;
  color: string;
  extruded_mm: number;
  grams: number;
  meters: number;
}

export interface RetroPrintItem {
  id: string;
  filename: string;
  outcome: string;
  startedAt: number;
  endedAt: number;
  duration: number;
  progressAtEnd: number;
  failureReason?: string;
  filament: ReportFilamentEntry[];
  isActive?: boolean;
}

export interface RetroFilter {
  /** 'ALL', a filament type (e.g. 'PA', 'ABS'), or 'tray:<trayKey>' */
  filamentFilter: string;
  /** Epoch milliseconds lower bound (inclusive), or null for all history */
  sinceMs: number | null;
  includeCompleted: boolean;
  includeFailed: boolean;
  includeStopped: boolean;
  includeActive: boolean;
  includeZeroUsage: boolean;
  /**
   * Some CC2 prints log a small prime/purge under trayKey='mono' (defaulting to
   * filamentType='PLA') before the active Canvas tray reports in. When enabled,
   * attributes a matching print's mono purge to that print's usage.
   */
  includeMonoPurge: boolean;
}

export interface FilamentOption {
  value: string;
  label: string;
  kind: 'type' | 'tray';
  color?: string;
  totalMeters: number;
  printCount: number;
}

export interface MatchedPrintUsage {
  extrudedMm: number;
  meters: number;
  grams: number;
  entries: ReportFilamentEntry[];
}

export interface RetroCalculationInput {
  startingSpoolGrams: number;
  /** Density override in g/cm³; null uses each entry's recorded grams */
  densityOverride: number | null;
  filamentDiameterMm: number;
  plannedPrintGrams: number;
  /** Optional per-print actual-grams overrides keyed by report id */
  manualGramsOverrides: Record<string, number>;
}

export interface RetroSummary {
  selectedCount: number;
  completedCount: number;
  canceledCount: number;
  activeIncluded: boolean;
  usedGrams: number;
  completedGrams: number;
  canceledGrams: number;
  activeGrams: number;
  usedMeters: number;
  remainingGrams: number;
  rawRemainingGrams: number;
  remainingMeters: number;
  percentRemaining: number;
  plannedPrintGrams: number;
  afterPlannedGrams: number;
  hasEnoughForPlanned: boolean | null;
}

export const DEFAULT_RETRO_FILTER: RetroFilter = {
  filamentFilter: 'ALL',
  sinceMs: null,
  includeCompleted: true,
  includeFailed: true,
  includeStopped: true,
  includeActive: false,
  includeZeroUsage: false,
  includeMonoPurge: true,
};

/** Cross-sectional area in cm² for a given filament diameter in mm */
export function filamentCrossSectionCm2(diameterMm: number): number {
  const radiusCm = diameterMm / 2 / 10;
  return Math.PI * radiusCm * radiusCm;
}

/** Convert extruded millimeters to grams using density (g/cm³) and diameter (mm) */
export function extrudedMmToGrams(extrudedMm: number, density: number, diameterMm = 1.75): number {
  if (extrudedMm <= 0 || density <= 0 || diameterMm <= 0) return 0;
  return (extrudedMm / 10) * filamentCrossSectionCm2(diameterMm) * density;
}

/** Convert filament mass (grams) to meters using density (g/cm³) and diameter (mm) */
export function gramsToMeters(grams: number, density: number, diameterMm = 1.75): number {
  if (grams <= 0 || density <= 0 || diameterMm <= 0) return 0;
  const volumeCm3 = grams / density;
  return volumeCm3 / filamentCrossSectionCm2(diameterMm) / 100;
}

/** Human-readable Canvas tray label (e.g. 'canvas_0_tray_1' -> 'Slot 2') */
export function formatTrayKeyLabel(trayKey: string, trayNames?: Record<string, string>): string {
  const custom = trayNames?.[trayKey];
  const match = /^canvas_(\d+)_tray_(\d+)$/.exec(trayKey);
  if (match) {
    const slotNum = Number(match[2]) + 1;
    return custom ? `Slot ${slotNum} (${custom})` : `Slot ${slotNum}`;
  }
  if (trayKey === 'mono') return custom ? `Direct (${custom})` : 'Direct / External';
  return custom ? `${trayKey} (${custom})` : trayKey;
}

/** Normalize outcome into completed / failed / stopped / printing */
export function classifyOutcome(
  item: Pick<RetroPrintItem, 'outcome' | 'isActive'>,
): 'completed' | 'failed' | 'stopped' | 'printing' {
  if (item.isActive || item.outcome === 'printing') return 'printing';
  if (item.outcome === 'completed') return 'completed';
  if (item.outcome === 'stopped') return 'stopped';
  return 'failed';
}

/** Whether a single filament entry matches the active filamentFilter */
function entryMatchesFilter(entry: ReportFilamentEntry, filamentFilter: string): boolean {
  if (!filamentFilter || filamentFilter === 'ALL') return true;
  if (filamentFilter.startsWith('tray:')) {
    return entry.trayKey === filamentFilter.slice('tray:'.length);
  }
  return entry.filamentType.toUpperCase() === filamentFilter.toUpperCase();
}

/** Compute matched extrusion and grams for a single print under current filter & density */
export function getPrintMatchedUsage(
  item: RetroPrintItem,
  filamentFilter: string,
  densityOverride: number | null,
  filamentDiameterMm = 1.75,
  includeMonoPurge = true,
): MatchedPrintUsage {
  const filament = Array.isArray(item.filament) ? item.filament : [];
  if (filament.length === 0) {
    return { extrudedMm: 0, meters: 0, grams: 0, entries: [] };
  }

  let matched: ReportFilamentEntry[];
  if (!filamentFilter || filamentFilter === 'ALL') {
    matched = filament;
  } else {
    matched = filament.filter((entry) => entryMatchesFilter(entry, filamentFilter));
    if (
      includeMonoPurge &&
      matched.length > 0 &&
      filamentFilter !== 'tray:mono' &&
      filamentFilter.toUpperCase() !== 'PLA'
    ) {
      const monoEntries = filament.filter(
        (entry) => entry.trayKey === 'mono' && !matched.includes(entry),
      );
      if (monoEntries.length > 0) {
        matched = [...matched, ...monoEntries];
      }
    }
  }

  let extrudedMm = 0;
  let recordedGrams = 0;
  for (const entry of matched) {
    const mm = Number.isFinite(entry.extruded_mm) && entry.extruded_mm > 0 ? entry.extruded_mm : 0;
    const g = Number.isFinite(entry.grams) && entry.grams > 0 ? entry.grams : 0;
    extrudedMm += mm;
    recordedGrams += g;
  }

  const grams =
    densityOverride != null && densityOverride > 0 && extrudedMm > 0
      ? extrudedMmToGrams(extrudedMm, densityOverride, filamentDiameterMm)
      : recordedGrams;

  return {
    extrudedMm,
    meters: extrudedMm / 1000,
    grams,
    entries: matched,
  };
}

/** Collect distinct filament types and trays present across reports for the filter selector */
export function extractFilamentOptions(
  items: readonly RetroPrintItem[],
  trayNames?: Record<string, string>,
): FilamentOption[] {
  const typeMap = new Map<string, { meters: number; prints: Set<string>; color?: string }>();
  const trayMap = new Map<
    string,
    { meters: number; prints: Set<string>; color?: string; lastType: string }
  >();

  for (const item of items) {
    for (const entry of item.filament ?? []) {
      const mm = Number.isFinite(entry.extruded_mm) ? Math.max(0, entry.extruded_mm) : 0;
      const meters = mm / 1000;
      const typeKey = (entry.filamentType || 'Unknown').toUpperCase();

      const t = typeMap.get(typeKey) ?? {
        meters: 0,
        prints: new Set<string>(),
        color: entry.color,
      };
      t.meters += meters;
      t.prints.add(item.id);
      if (!t.color && entry.color) t.color = entry.color;
      typeMap.set(typeKey, t);

      if (entry.trayKey) {
        const tr = trayMap.get(entry.trayKey) ?? {
          meters: 0,
          prints: new Set<string>(),
          color: entry.color,
          lastType: typeKey,
        };
        tr.meters += meters;
        tr.prints.add(item.id);
        if (entry.color) tr.color = entry.color;
        tr.lastType = typeKey;
        trayMap.set(entry.trayKey, tr);
      }
    }
  }

  const typeOptions: FilamentOption[] = Array.from(typeMap.entries())
    .map(([typeKey, info]) => ({
      value: typeKey,
      label: `${typeKey} (${info.prints.size} prints)`,
      kind: 'type' as const,
      color: info.color,
      totalMeters: info.meters,
      printCount: info.prints.size,
    }))
    .sort((a, b) => b.totalMeters - a.totalMeters);

  const trayOptions: FilamentOption[] = Array.from(trayMap.entries())
    .map(([trayKey, info]) => ({
      value: `tray:${trayKey}`,
      label: `${formatTrayKeyLabel(trayKey, trayNames)} · ${info.lastType} (${info.prints.size})`,
      kind: 'tray' as const,
      color: info.color,
      totalMeters: info.meters,
      printCount: info.prints.size,
    }))
    .sort((a, b) => b.totalMeters - a.totalMeters);

  return [...typeOptions, ...trayOptions];
}

/** Filter print items by filament type/tray, date since, outcome toggles, and zero-usage toggle */
export function filterRetroPrints(
  items: readonly RetroPrintItem[],
  filter: RetroFilter,
): RetroPrintItem[] {
  return items.filter((item) => {
    const outcome = classifyOutcome(item);
    if (outcome === 'printing' && !filter.includeActive) return false;
    if (outcome === 'completed' && !filter.includeCompleted) return false;
    if (outcome === 'failed' && !filter.includeFailed) return false;
    if (outcome === 'stopped' && !filter.includeStopped) return false;

    if (filter.sinceMs != null && item.startedAt < filter.sinceMs) return false;

    const usage = getPrintMatchedUsage(
      item,
      filter.filamentFilter,
      null,
      1.75,
      filter.includeMonoPurge,
    );

    if (filter.filamentFilter !== 'ALL' && usage.entries.length === 0) {
      return false;
    }

    if (!filter.includeZeroUsage && usage.extrudedMm <= 0 && usage.grams <= 0) {
      return false;
    }

    return true;
  });
}

/** Suggest a sensible default density when a filament filter is selected */
export function suggestDensityForFilter(
  filamentFilter: string,
  trayNames?: Record<string, string>,
): number | null {
  if (!filamentFilter || filamentFilter === 'ALL') return null;
  if (filamentFilter.startsWith('tray:')) {
    const key = filamentFilter.slice('tray:'.length);
    const name = (trayNames?.[key] ?? '').toUpperCase();
    if (name.includes('PA6-CF') || name.includes('PA6CF')) return SPOOL_MATERIALS['PA6-CF'];
    if (name.includes('PA-CF') || name.includes('PACF') || name.includes('PAHT-CF')) {
      return SPOOL_MATERIALS['PA-CF'];
    }
    if (name && SPOOL_MATERIALS[name] != null) return SPOOL_MATERIALS[name];
    return null;
  }
  const upper = filamentFilter.toUpperCase();
  if (SPOOL_MATERIALS[upper] != null) return SPOOL_MATERIALS[upper];
  return null;
}

/** Aggregate actual usage across the selected prints and compute remaining spool estimate */
export function calculateRetroSummary(
  visibleItems: readonly RetroPrintItem[],
  selectedIds: ReadonlySet<string>,
  filter: RetroFilter,
  input: RetroCalculationInput,
): RetroSummary {
  let selectedCount = 0;
  let completedCount = 0;
  let canceledCount = 0;
  let activeIncluded = false;
  let usedGrams = 0;
  let completedGrams = 0;
  let canceledGrams = 0;
  let activeGrams = 0;
  let usedMeters = 0;

  for (const item of visibleItems) {
    if (!selectedIds.has(item.id)) continue;
    selectedCount += 1;

    const usage = getPrintMatchedUsage(
      item,
      filter.filamentFilter,
      input.densityOverride,
      input.filamentDiameterMm,
      filter.includeMonoPurge,
    );
    const override = input.manualGramsOverrides[item.id];
    const grams =
      override != null && Number.isFinite(override) && override >= 0 ? override : usage.grams;
    const effectiveDensity = input.densityOverride ?? 1.24;
    const meters =
      override != null && Number.isFinite(override) && override >= 0
        ? gramsToMeters(override, effectiveDensity, input.filamentDiameterMm)
        : usage.meters;

    usedGrams += grams;
    usedMeters += meters;

    const outcome = classifyOutcome(item);
    if (outcome === 'printing') {
      activeIncluded = true;
      activeGrams += grams;
    } else if (outcome === 'completed') {
      completedCount += 1;
      completedGrams += grams;
    } else {
      canceledCount += 1;
      canceledGrams += grams;
    }
  }

  const startG = Math.max(
    0,
    Number.isFinite(input.startingSpoolGrams) ? input.startingSpoolGrams : 0,
  );
  const rawRemainingGrams = startG - usedGrams;
  const remainingGrams = Math.max(0, rawRemainingGrams);
  const densityForRemaining =
    input.densityOverride != null && input.densityOverride > 0
      ? input.densityOverride
      : (suggestDensityForFilter(filter.filamentFilter) ?? 1.24);
  const remainingMeters = gramsToMeters(
    remainingGrams,
    densityForRemaining,
    input.filamentDiameterMm,
  );
  const percentRemaining =
    startG > 0 ? Math.max(0, Math.min(100, (remainingGrams / startG) * 100)) : 0;

  const plannedG =
    Number.isFinite(input.plannedPrintGrams) && input.plannedPrintGrams > 0
      ? input.plannedPrintGrams
      : 0;
  const afterPlannedGrams = rawRemainingGrams - plannedG;
  const hasEnoughForPlanned = plannedG > 0 ? rawRemainingGrams >= plannedG : null;

  return {
    selectedCount,
    completedCount,
    canceledCount,
    activeIncluded,
    usedGrams,
    completedGrams,
    canceledGrams,
    activeGrams,
    usedMeters,
    remainingGrams,
    rawRemainingGrams,
    remainingMeters,
    percentRemaining,
    plannedPrintGrams: plannedG,
    afterPlannedGrams,
    hasEnoughForPlanned,
  };
}
