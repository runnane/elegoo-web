/**
 * Persistence — save/restore chart and layer data to localStorage
 * so data survives page reloads during a print.
 */

import type { PrinterState } from './printer-state';
import type { ChartStore } from './chart-store';

const STORAGE_KEY = 'elegoo-web-state';
const SAVE_INTERVAL = 10_000; // 10 seconds

interface PersistedData {
  /** Print file name — used to detect new prints */
  printFile: string;
  /** Layer timing data */
  layerTimes: Array<{ layer: number; duration: number; timestamp: number }>;
  /** Last tracked layer number */
  lastLayer: number;
  /** Timestamp when last layer started */
  lastLayerTime: number;
  /** Chart store series data: key → {t,v}[] */
  chartData: Record<string, Array<{ t: number; v: number }>>;
  /** When data was saved */
  savedAt: number;
}

let saveTimer: ReturnType<typeof setInterval> | null = null;

/** Get current print file name from state, or empty string */
function getPrintFile(state: PrinterState): string {
  return (state.status?.print_status as Record<string, unknown> | undefined)?.filename as string
    ?? (state.status?.print_status as Record<string, unknown> | undefined)?.file_name as string
    ?? '';
}

/** Save state + chart data to localStorage */
function save(state: PrinterState, chartStore: ChartStore): void {
  const printFile = getPrintFile(state);
  if (!printFile) return; // Nothing to save if not printing

  const chartData: Record<string, Array<{ t: number; v: number }>> = {};
  for (const [key, series] of chartStore.getAllSeries()) {
    if (series.data.length > 0) {
      chartData[key] = series.data;
    }
  }

  const data: PersistedData = {
    printFile,
    layerTimes: state.layerTimes,
    lastLayer: state.getLastLayer(),
    lastLayerTime: state.getLastLayerTime(),
    chartData,
    savedAt: Date.now(),
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

/** Restore persisted data if it matches the current print */
export function restoreIfMatch(state: PrinterState, chartStore: ChartStore): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;

    const data: PersistedData = JSON.parse(raw);

    // Only restore if same print file and data is less than 24h old
    const printFile = getPrintFile(state);
    if (!printFile || data.printFile !== printFile) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }

    const age = Date.now() - data.savedAt;
    if (age > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }

    // Restore layer times
    if (data.layerTimes?.length > 0) {
      state.restoreLayerData(data.layerTimes, data.lastLayer, data.lastLayerTime);
    }

    // Restore chart data
    if (data.chartData) {
      for (const [key, points] of Object.entries(data.chartData)) {
        chartStore.restoreSeries(key, points);
      }
    }

    return true;
  } catch {
    return false;
  }
}

/** Start periodic saving. Call after connection + first status received. */
export function startPersistence(state: PrinterState, chartStore: ChartStore): void {
  if (saveTimer) return;
  saveTimer = setInterval(() => save(state, chartStore), SAVE_INTERVAL);
  // Also save on page unload
  window.addEventListener('beforeunload', () => save(state, chartStore));
}

/** Stop periodic saving (e.g. on disconnect). */
export function stopPersistence(): void {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
}

/** Clear persisted data (e.g. when print completes/is cancelled). */
export function clearPersistedData(): void {
  localStorage.removeItem(STORAGE_KEY);
}
