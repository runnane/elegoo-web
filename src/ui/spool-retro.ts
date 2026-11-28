/**
 * Retroactive Spool Estimator — the pure half (ELEG-197, from contributor PR #182).
 *
 * Reconstructs what is left on a spool by subtracting the filament that past prints
 * actually extruded — including failed and cancelled ones, and optionally the live print
 * — from a starting weight. The DOM half is `spool-retro-view.ts`; every decision lives
 * here so it can be tested in Node, the same split as `list-sort.ts` / `list-controls.ts`.
 *
 * Known limits, stated rather than fixed:
 * - **Diameter is 1.75 mm.** The service records grams assuming 1.75 mm filament
 *   (`state-store.ts`), so the estimator uses the same figure for every conversion and
 *   ignores the calculator's 2.85 mm option rather than mixing the two.
 * - **A service restart mid-print under-counts the live print.** The live usage is
 *   accumulated in memory from extruder deltas, so whatever was extruded before the
 *   restart is missing from it (and from the report written when that print ends).
 */

import {
  DEFAULT_FILAMENT_DENSITY,
  FILAMENT_DENSITY,
  knownFilamentDensity,
} from '../filament-density';

/** The filament diameter every recorded figure assumes (see the header). */
export const RETRO_DIAMETER_MM = 1.75;

/** One filament entry of a report — the service's `FilamentUsage`. */
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
   * filamentType='PLA') before the active Canvas tray reports in. When enabled, a
   * filtered print's mono purge is attributed to that print's usage.
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
  /**
   * The density override the user *asked for*, in g/cm³, or null for recorded grams.
   * `calculateRetroSummary` applies it only when `resolveDensityScope` allows it.
   */
  densityOverride: number | null;
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
  /** Clamped at 0 — for display. Apply uses `rawRemainingGrams`, so an over-used spool is refused. */
  remainingGrams: number;
  rawRemainingGrams: number;
  remainingMeters: number;
  percentRemaining: number;
  plannedPrintGrams: number;
  afterPlannedGrams: number;
  hasEnoughForPlanned: boolean | null;
  /** The density override actually applied, or null when recorded grams were used. */
  appliedDensityOverride: number | null;
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

/** Convert extruded millimetres to grams using density (g/cm³) and diameter (mm) */
export function extrudedMmToGrams(
  extrudedMm: number,
  density: number,
  diameterMm = RETRO_DIAMETER_MM,
): number {
  if (extrudedMm <= 0 || density <= 0 || diameterMm <= 0) return 0;
  return (extrudedMm / 10) * filamentCrossSectionCm2(diameterMm) * density;
}

/** Convert filament mass (grams) to metres using density (g/cm³) and diameter (mm) */
export function gramsToMeters(
  grams: number,
  density: number,
  diameterMm = RETRO_DIAMETER_MM,
): number {
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

/** Normalise an outcome into completed / failed / stopped / printing */
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
  return (entry.filamentType || '').toUpperCase() === filamentFilter.toUpperCase();
}

/**
 * The single material a filter selects, and the density override that may be applied.
 *
 * A density override recomputes grams from extruded length, which is only meaningful for
 * one material: applied across ABS and PA together it would silently mis-weigh both. So:
 *
 * - `ALL` selects no single material — the override is never applied.
 * - A **type** filter (`PA`) selects that material. Mono purge entries it pulls in are
 *   labelled PLA only because the printer had not reported the tray yet; they are the
 *   same filament (see `includeMonoPurge`), so they do not make the selection mixed.
 * - A **tray** filter selects one material only if every entry recorded for that slot
 *   across `items` has the same type; a slot that held PLA then PETG is mixed.
 */
export function resolveDensityScope(
  items: readonly RetroPrintItem[],
  filter: Pick<RetroFilter, 'filamentFilter'>,
  requestedOverride: number | null,
): { material: string | null; override: number | null } {
  const f = filter.filamentFilter;
  let material: string | null = null;
  if (f && f !== 'ALL') {
    if (f.startsWith('tray:')) {
      const types = new Set<string>();
      for (const item of items) {
        for (const entry of item.filament ?? []) {
          if (entryMatchesFilter(entry, f)) types.add((entry.filamentType || '').toUpperCase());
        }
      }
      material = types.size === 1 ? [...types][0] || null : null;
    } else {
      material = f.toUpperCase();
    }
  }
  const usable =
    requestedOverride != null && Number.isFinite(requestedOverride) && requestedOverride > 0;
  return { material, override: material != null && usable ? requestedOverride : null };
}

/**
 * Matched extrusion and grams for a single print under a filter.
 *
 * `densityOverride` is applied as given; callers get it from `resolveDensityScope`,
 * never straight from the UI.
 */
export function getPrintMatchedUsage(
  item: RetroPrintItem,
  filamentFilter: string,
  densityOverride: number | null,
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
      ? extrudedMmToGrams(extrudedMm, densityOverride)
      : recordedGrams;

  return { extrudedMm, meters: extrudedMm / 1000, grams, entries: matched };
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

    const usage = getPrintMatchedUsage(item, filter.filamentFilter, null, filter.includeMonoPurge);
    if (filter.filamentFilter !== 'ALL' && usage.entries.length === 0) return false;
    if (!filter.includeZeroUsage && usage.extrudedMm <= 0 && usage.grams <= 0) return false;

    return true;
  });
}

/** Aggregate actual usage across the selected prints and compute the remaining estimate */
export function calculateRetroSummary(
  visibleItems: readonly RetroPrintItem[],
  selectedIds: ReadonlySet<string>,
  filter: RetroFilter,
  input: RetroCalculationInput,
): RetroSummary {
  const scope = resolveDensityScope(visibleItems, filter, input.densityOverride);
  // Density for turning grams back into metres: the override, else the selected material,
  // else PLA's (a mixed selection has no single right answer; metres are indicative there).
  const metresDensity =
    scope.override ??
    (scope.material ? knownFilamentDensity(scope.material) : undefined) ??
    DEFAULT_FILAMENT_DENSITY;

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
      scope.override,
      filter.includeMonoPurge,
    );
    const manual = input.manualGramsOverrides[item.id];
    const hasManual = manual != null && Number.isFinite(manual) && manual >= 0;
    const grams = hasManual ? manual : usage.grams;
    const meters = hasManual ? gramsToMeters(manual, metresDensity) : usage.meters;

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
  const remainingMeters = gramsToMeters(remainingGrams, metresDensity);
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
    appliedDensityOverride: scope.override,
  };
}

// ── Preferences ────────────────────────────────────────────────────────────

/** The estimator's persisted preferences, stored in `ui-settings.ts` under `spoolRetro`. */
export interface RetroPrefs {
  startingSpoolGrams: number;
  filamentFilter: string;
  /** `datetime-local` value, or '' for all history */
  sinceValue: string;
  /** 'auto' (recorded grams), a key of FILAMENT_DENSITY, or 'custom' */
  densityMode: string;
  customDensity: number;
  plannedPrintGrams: number;
  includeCompleted: boolean;
  includeFailed: boolean;
  includeStopped: boolean;
  includeActive: boolean;
  includeZeroUsage: boolean;
  includeMonoPurge: boolean;
  manualGramsOverrides: Record<string, number>;
}

export const DEFAULT_RETRO_PREFS: Readonly<RetroPrefs> = {
  startingSpoolGrams: 1000,
  filamentFilter: DEFAULT_RETRO_FILTER.filamentFilter,
  sinceValue: '',
  densityMode: 'auto',
  customDensity: 1.17,
  plannedPrintGrams: 0,
  includeCompleted: DEFAULT_RETRO_FILTER.includeCompleted,
  includeFailed: DEFAULT_RETRO_FILTER.includeFailed,
  includeStopped: DEFAULT_RETRO_FILTER.includeStopped,
  includeActive: DEFAULT_RETRO_FILTER.includeActive,
  includeZeroUsage: DEFAULT_RETRO_FILTER.includeZeroUsage,
  includeMonoPurge: DEFAULT_RETRO_FILTER.includeMonoPurge,
  manualGramsOverrides: {},
};

/**
 * Turn whatever is in storage into usable preferences, field by field. A value of the
 * wrong type — from an older build, or hand-edited — falls back to its default rather
 * than taking the whole object with it.
 */
export function normaliseRetroPrefs(raw: unknown): RetroPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_RETRO_PREFS;
  const num = (v: unknown, fallback: number, min = 0): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

  const densityMode = str(r.densityMode, d.densityMode);
  const overrides: Record<string, number> = {};
  if (r.manualGramsOverrides && typeof r.manualGramsOverrides === 'object') {
    for (const [k, v] of Object.entries(r.manualGramsOverrides as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) overrides[k] = v;
    }
  }
  return {
    startingSpoolGrams: num(r.startingSpoolGrams, d.startingSpoolGrams),
    filamentFilter: str(r.filamentFilter, d.filamentFilter) || 'ALL',
    sinceValue: str(r.sinceValue, d.sinceValue),
    densityMode:
      densityMode === 'auto' || densityMode === 'custom' || densityMode in FILAMENT_DENSITY
        ? densityMode
        : d.densityMode,
    customDensity: num(r.customDensity, d.customDensity, Number.MIN_VALUE),
    plannedPrintGrams: num(r.plannedPrintGrams, d.plannedPrintGrams),
    includeCompleted: bool(r.includeCompleted, d.includeCompleted),
    includeFailed: bool(r.includeFailed, d.includeFailed),
    includeStopped: bool(r.includeStopped, d.includeStopped),
    includeActive: bool(r.includeActive, d.includeActive),
    includeZeroUsage: bool(r.includeZeroUsage, d.includeZeroUsage),
    includeMonoPurge: bool(r.includeMonoPurge, d.includeMonoPurge),
    manualGramsOverrides: overrides,
  };
}

/** The density override the user asked for (before `resolveDensityScope` gates it). */
export function requestedDensityOverride(
  prefs: Pick<RetroPrefs, 'densityMode' | 'customDensity'>,
): number | null {
  if (prefs.densityMode === 'auto') return null;
  if (prefs.densityMode === 'custom') {
    return Number.isFinite(prefs.customDensity) && prefs.customDensity > 0
      ? prefs.customDensity
      : null;
  }
  return FILAMENT_DENSITY[prefs.densityMode] ?? null;
}

/** Build a RetroFilter from preferences */
export function filterFromPrefs(prefs: RetroPrefs): RetroFilter {
  let sinceMs: number | null = null;
  if (prefs.sinceValue) {
    const parsed = new Date(prefs.sinceValue).getTime();
    if (Number.isFinite(parsed)) sinceMs = parsed;
  }
  return {
    filamentFilter: prefs.filamentFilter,
    sinceMs,
    includeCompleted: prefs.includeCompleted,
    includeFailed: prefs.includeFailed,
    includeStopped: prefs.includeStopped,
    includeActive: prefs.includeActive,
    includeZeroUsage: prefs.includeZeroUsage,
    includeMonoPurge: prefs.includeMonoPurge,
  };
}

// ── The /api/reports payload ───────────────────────────────────────────────

/** The fields of `GET /api/reports` the estimator reads (ELEG-196). */
export interface ReportsApiResponse {
  reports?: Array<{
    id: string;
    filename: string;
    outcome: string;
    startedAt: number;
    endedAt: number;
    duration: number;
    progressAtEnd?: number;
    failureReason?: string;
    filament?: ReportFilamentEntry[];
  }>;
  active?: boolean;
  activePrint?: {
    id: string;
    filename: string;
    startedAt: number;
    progress: number;
    filament: ReportFilamentEntry[];
  } | null;
}

/**
 * Normalise the payload into print items, the live print first. The live print is never
 * double counted: its report.json is written only when it ends, so it is not in `reports`.
 */
export function normaliseReportsPayload(
  payload: ReportsApiResponse,
  now = Date.now(),
): RetroPrintItem[] {
  const items: RetroPrintItem[] = [];
  const a = payload.activePrint;
  if (a) {
    items.push({
      id: `active:${a.id}`,
      filename: a.filename,
      outcome: 'printing',
      startedAt: a.startedAt,
      endedAt: now,
      duration: Math.max(0, Math.round((now - a.startedAt) / 1000)),
      progressAtEnd: a.progress ?? 0,
      filament: Array.isArray(a.filament) ? a.filament : [],
      isActive: true,
    });
  }
  for (const r of payload.reports ?? []) {
    items.push({
      id: r.id,
      filename: r.filename,
      outcome: r.outcome,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      duration: r.duration,
      progressAtEnd: r.progressAtEnd ?? 0,
      failureReason: r.failureReason,
      filament: Array.isArray(r.filament) ? r.filament : [],
    });
  }
  return items;
}
