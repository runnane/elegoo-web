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
}

const defaults: UISettings = {
  chartWindows: {},
  cameraOverlay: false,
  slogDirection: 'all',
  slogType: 'all',
  slogMethod: 'all',
  logTab: 'structured',
  theme: 'auto',
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
