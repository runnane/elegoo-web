/** Persistent UI settings stored in localStorage */

const STORAGE_KEY = 'elegoo-web-ui-settings';

export interface UISettings {
  /** Per-chart time window in seconds, keyed by canvasId */
  chartWindows: Record<string, number>;
  /** Camera overlay enabled */
  cameraOverlay: boolean;
  /** Structured log direction filter */
  slogDirection: string;
  /** Structured log type filter */
  slogType: string;
  /** Structured log method filter */
  slogMethod: string;
  /** Active log tab (structured/raw) */
  logTab: string;
  /** Theme choice: 'auto' follows the OS, 'dark'/'light' override it (ELEG-34) */
  theme: string;
  /** Per-list sort choice, keyed by the list's control id (ELEG-49) */
  listSort: Record<string, { key: string; dir: string }>;
  /** Per-list dropdown filter selections, keyed by `<listId>.<selectId>` (ELEG-49) */
  listSelect: Record<string, string>;
}

const defaults: UISettings = {
  chartWindows: {},
  cameraOverlay: false,
  slogDirection: 'all',
  slogType: 'all',
  slogMethod: 'all',
  logTab: 'structured',
  theme: 'auto',
  listSort: {},
  listSelect: {},
};

let cached: UISettings | null = null;

export function loadUISettings(): UISettings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      cached = { ...defaults, ...JSON.parse(raw) };
      return cached!;
    }
  } catch {
    /* use defaults */
  }
  cached = { ...defaults };
  return cached;
}

export function saveUISettings(partial: Partial<UISettings>): void {
  const current = loadUISettings();
  Object.assign(current, partial);
  cached = current;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage full, ignore */
  }
}

/** Save a single chart window setting */
export function saveChartWindow(canvasId: string, seconds: number): void {
  const s = loadUISettings();
  s.chartWindows[canvasId] = seconds;
  saveUISettings({ chartWindows: s.chartWindows });
}

/** Get saved chart window or undefined for default */
export function getChartWindow(canvasId: string): number | undefined {
  return loadUISettings().chartWindows[canvasId];
}

/**
 * Save one list view's sort choice (ELEG-49).
 *
 * Sort lives here rather than in `persistence.ts`, which the parent issue pointed at:
 * that key holds chart and layer data for the *current print* and is cleared when the
 * print changes, so a sort preference stored there would quietly evaporate.
 */
export function saveListSort(listId: string, sort: { key: string; dir: string }): void {
  const s = loadUISettings();
  const listSort = s.listSort ?? {};
  listSort[listId] = sort;
  saveUISettings({ listSort });
}

/** Get a saved list sort, or undefined — the caller supplies and validates the default. */
export function getListSort(listId: string): unknown {
  return loadUISettings().listSort?.[listId];
}

/** Save one dropdown filter selection, keyed `<listId>.<selectId>` (ELEG-49). */
export function saveListSelect(key: string, value: string): void {
  const s = loadUISettings();
  const listSelect = s.listSelect ?? {};
  listSelect[key] = value;
  saveUISettings({ listSelect });
}

/** Get a saved dropdown filter selection, or undefined for "all". */
export function getListSelect(key: string): string | undefined {
  return loadUISettings().listSelect?.[key];
}
