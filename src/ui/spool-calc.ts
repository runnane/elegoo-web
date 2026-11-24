/** Spool Calculator — visualizes remaining filament and estimates remaining spool from print history */

import type { PrinterState } from '../printer-state';
import { escapeAttr, escapeHtml, fetchTimeout, formatTime } from './helpers';
import {
  DEFAULT_RETRO_FILTER,
  SPOOL_MATERIALS,
  type ReportFilamentEntry,
  type RetroFilter,
  type RetroPrintItem,
  calculateRetroSummary,
  classifyOutcome,
  extractFilamentOptions,
  filterRetroPrints,
  getPrintMatchedUsage,
  suggestDensityForFilter,
} from './spool-retro';
import { toast } from './toast';

const STORAGE_KEY = 'elegoo-web-spool-calc';
const RETRO_STORAGE_KEY = 'elegoo-web-spool-retro';

interface SpoolParams {
  hubDiameter: number; // mm — inner diameter (the core around which filament is wound)
  flangeDiameter: number; // mm — outer diameter of the spool flanges
  spoolWidth: number; // mm — width/depth of the spool
  emptyWeight: number; // g — weight of the empty spool (no filament)
  currentWeight: number; // g — current total weight (spool + remaining filament)
  filamentDiameter: number; // mm — 1.75 or 2.85
  material: string; // key into SPOOL_MATERIALS
  fullWeight: number; // g — full spool weight (spool + full filament, e.g. empty + 1000)
  currentOuterDiameter: number; // mm — measured outer diameter of remaining filament on spool
}

const DEFAULTS: SpoolParams = {
  hubDiameter: 55,
  flangeDiameter: 200,
  spoolWidth: 63,
  emptyWeight: 250,
  currentWeight: 1250,
  filamentDiameter: 1.75,
  material: 'PLA',
  fullWeight: 1250,
  currentOuterDiameter: 0,
};

interface RetroPersistedState {
  startingSpoolGrams: number;
  filamentFilter: string;
  sinceValue: string;
  densityMode: string; // 'auto' | material key | 'custom'
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

const RETRO_DEFAULTS: RetroPersistedState = {
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

interface ReportsApiResponse {
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

let printerStateRef: PrinterState | null = null;

/** Attach live PrinterState so the retroactive calculator can read Canvas tray names & active gcode weight */
export function setSpoolCalcState(state: PrinterState): void {
  printerStateRef = state;
}

function loadParams(): SpoolParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function saveParams(p: SpoolParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function loadRetroState(): RetroPersistedState {
  try {
    const raw = localStorage.getItem(RETRO_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RetroPersistedState>;
      return {
        ...RETRO_DEFAULTS,
        ...parsed,
        manualGramsOverrides:
          parsed.manualGramsOverrides && typeof parsed.manualGramsOverrides === 'object'
            ? { ...parsed.manualGramsOverrides }
            : {},
      };
    }
  } catch {
    /* ignore */
  }
  return { ...RETRO_DEFAULTS, manualGramsOverrides: {} };
}

function saveRetroState(r: RetroPersistedState): void {
  try {
    localStorage.setItem(RETRO_STORAGE_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

/** Convert outer diameter (mm) to filament mass (grams) using spool geometry */
function outerDiameterToMass(
  outerDiameter: number,
  hubDiameter: number,
  spoolWidth: number,
  material: string,
): number {
  const density = SPOOL_MATERIALS[material] ?? 1.24;
  const outerR = outerDiameter / 2 / 10; // cm
  const hubR = hubDiameter / 2 / 10; // cm
  const width = spoolWidth / 10; // cm
  const volume = Math.PI * (outerR * outerR - hubR * hubR) * width; // cm³
  return Math.max(0, volume * density); // grams
}

/** Calculate filament remaining stats */
function calculate(p: SpoolParams) {
  const density = SPOOL_MATERIALS[p.material] ?? 1.24;
  const filamentMass = Math.max(0, p.currentWeight - p.emptyWeight); // grams
  const fullFilamentMass = Math.max(0, p.fullWeight - p.emptyWeight);
  const filamentRadius = p.filamentDiameter / 2 / 10; // cm
  const crossSection = Math.PI * filamentRadius * filamentRadius; // cm²

  // Volume of remaining filament in cm³
  const volume = filamentMass / density;
  const fullVolume = fullFilamentMass / density;

  // Length in cm, convert to meters
  const lengthCm = volume / crossSection;
  const lengthM = lengthCm / 100;

  const fullLengthCm = fullVolume / crossSection;
  const fullLengthM = fullLengthCm / 100;

  // Current outer radius of wound filament
  const hubRadius = p.hubDiameter / 2; // mm
  const spoolWidthCm = p.spoolWidth / 10; // cm
  const hubRadiusCm = hubRadius / 10; // cm

  // V = π × (R² - r²) × W → R = sqrt(V / (π × W) + r²)
  const currentOuterRadiusCm = Math.sqrt(
    volume / (Math.PI * spoolWidthCm) + hubRadiusCm * hubRadiusCm,
  );
  const currentOuterRadius = currentOuterRadiusCm * 10; // back to mm

  const fullOuterRadiusCm = Math.sqrt(
    fullVolume / (Math.PI * spoolWidthCm) + hubRadiusCm * hubRadiusCm,
  );
  const fullOuterRadius = fullOuterRadiusCm * 10; // mm

  const percentRemaining = fullFilamentMass > 0 ? (filamentMass / fullFilamentMass) * 100 : 0;

  return {
    filamentMass,
    fullFilamentMass,
    lengthM,
    fullLengthM,
    currentOuterRadius: Math.min(currentOuterRadius, p.flangeDiameter / 2),
    fullOuterRadius: Math.min(fullOuterRadius, p.flangeDiameter / 2),
    percentRemaining,
    density,
  };
}

/** Draw spool side-view SVG */
function renderSVG(p: SpoolParams, calc: ReturnType<typeof calculate>): string {
  const W = 360;
  const H = 280;
  const cx = W / 2;
  const cy = H / 2;

  // Scale factor: map flange diameter to fit in the SVG
  const flangeRadius = p.flangeDiameter / 2;
  const maxVisualRadius = 120; // px
  const scale = maxVisualRadius / flangeRadius;

  const hubR = (p.hubDiameter / 2) * scale;
  const flangeR = flangeRadius * scale;
  const filamentR = calc.currentOuterRadius * scale;
  const fullFilamentR = calc.fullOuterRadius * scale;
  const spoolW = Math.min(p.spoolWidth * scale * 0.6, 80); // visual width capped
  const flangeThick = 3;

  // Side view: spool is a rectangle, hub is inner rect, filament fills between
  const left = cx - spoolW / 2;
  const right = cx + spoolW / 2;

  // Build SVG
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="spool-svg" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs>
    <linearGradient id="filament-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent-light)" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.7"/>
    </linearGradient>
    <linearGradient id="ghost-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--text-muted)" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="var(--text-muted)" stop-opacity="0.08"/>
    </linearGradient>
  </defs>`;

  // --- Flange outline (outer frame) ---
  svg += `<rect x="${left - flangeThick}" y="${cy - flangeR}" width="${spoolW + flangeThick * 2}" height="${flangeR * 2}"
    rx="2" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.4"/>`;

  // --- Left flange wall ---
  svg += `<rect x="${left - flangeThick}" y="${cy - flangeR}" width="${flangeThick}" height="${flangeR * 2}"
    rx="1" fill="var(--border)" opacity="0.8"/>`;

  // --- Right flange wall ---
  svg += `<rect x="${right}" y="${cy - flangeR}" width="${flangeThick}" height="${flangeR * 2}"
    rx="1" fill="var(--border)" opacity="0.8"/>`;

  // --- Ghost outline: full spool capacity ---
  if (fullFilamentR > hubR + 1) {
    svg += `<rect x="${left}" y="${cy - fullFilamentR}" width="${spoolW}" height="${fullFilamentR * 2}"
      rx="2" fill="url(#ghost-grad)" stroke="var(--text-muted)" stroke-width="0.5" stroke-dasharray="3,3"/>`;
  }

  // --- Filament (current fill) ---
  if (filamentR > hubR + 0.5) {
    svg += `<rect x="${left}" y="${cy - filamentR}" width="${spoolW}" height="${filamentR * 2}"
      rx="2" fill="url(#filament-grad)"/>`;
  }

  // --- Hub (center core) ---
  svg += `<rect x="${left}" y="${cy - hubR}" width="${spoolW}" height="${hubR * 2}"
    rx="2" fill="var(--bg-secondary)" stroke="var(--border)" stroke-width="1.5"/>`;

  // --- Hub hole (center) ---
  const holeR = hubR * 0.5;
  svg += `<rect x="${left + 2}" y="${cy - holeR}" width="${spoolW - 4}" height="${holeR * 2}"
    rx="2" fill="var(--bg-primary)" opacity="0.6"/>`;

  // --- Dimension labels ---
  const dimX = right + flangeThick + 14;

  // Flange diameter
  svg += `<line x1="${dimX - 6}" y1="${cy - flangeR}" x2="${dimX - 6}" y2="${cy + flangeR}"
    stroke="var(--text-muted)" stroke-width="0.8" marker-start="url(#arr)" marker-end="url(#arr)"/>`;
  svg += `<text x="${dimX}" y="${cy + 4}" fill="var(--text-muted)" font-size="10" font-family="monospace">${p.flangeDiameter}mm</text>`;

  // Hub diameter
  const hubDimX = left - flangeThick - 14;
  svg += `<line x1="${hubDimX + 6}" y1="${cy - hubR}" x2="${hubDimX + 6}" y2="${cy + hubR}"
    stroke="var(--text-muted)" stroke-width="0.8"/>`;
  svg += `<text x="${hubDimX - 2}" y="${cy + 4}" fill="var(--text-muted)" font-size="10" font-family="monospace" text-anchor="end">${p.hubDiameter}mm</text>`;

  // Spool width (bottom)
  const widthY = cy + flangeR + 16;
  svg += `<line x1="${left}" y1="${widthY}" x2="${right}" y2="${widthY}"
    stroke="var(--text-muted)" stroke-width="0.8"/>`;
  svg += `<text x="${cx}" y="${widthY + 14}" fill="var(--text-muted)" font-size="10" font-family="monospace" text-anchor="middle">${p.spoolWidth}mm</text>`;

  // Filament outer radius indicator
  if (filamentR > hubR + 2) {
    svg += `<line x1="${cx}" y1="${cy - filamentR}" x2="${cx}" y2="${cy - filamentR - 8}"
      stroke="var(--accent-light)" stroke-width="0.8"/>`;
    svg += `<text x="${cx}" y="${cy - filamentR - 12}" fill="var(--accent-light)" font-size="9" font-family="monospace" text-anchor="middle">⌀${Math.round(calc.currentOuterRadius * 2)}mm</text>`;
  }

  svg += '</svg>';
  return svg;
}

/** Collect Canvas tray display names (e.g. 'PA6-CF') from live PrinterState if available */
function getCanvasTrayNames(): Record<string, string> {
  const map: Record<string, string> = {};
  const units = printerStateRef?.canvas?.canvas_list;
  if (!units) return map;
  for (const unit of units) {
    for (const tray of unit.tray_list ?? []) {
      const label = (tray.filament_name || tray.filament_type || '').trim();
      if (label) {
        map[`canvas_${unit.canvas_id}_tray_${tray.tray_id}`] = label;
      }
    }
  }
  return map;
}

/** Resolve active density override (g/cm³) from retro state, or null for recorded grams */
function resolveDensityOverride(r: RetroPersistedState): number | null {
  if (r.densityMode === 'auto') return null;
  if (r.densityMode === 'custom') {
    return Number.isFinite(r.customDensity) && r.customDensity > 0 ? r.customDensity : null;
  }
  return SPOOL_MATERIALS[r.densityMode] ?? null;
}

/** Build a RetroFilter from persisted UI state */
function buildRetroFilter(r: RetroPersistedState): RetroFilter {
  let sinceMs: number | null = null;
  if (r.sinceValue) {
    const parsed = new Date(r.sinceValue).getTime();
    if (Number.isFinite(parsed)) sinceMs = parsed;
  }
  return {
    filamentFilter: r.filamentFilter,
    sinceMs,
    includeCompleted: r.includeCompleted,
    includeFailed: r.includeFailed,
    includeStopped: r.includeStopped,
    includeActive: r.includeActive,
    includeZeroUsage: r.includeZeroUsage,
    includeMonoPurge: r.includeMonoPurge,
  };
}

/** Format an epoch timestamp as YYYY-MM-DDTHH:MM for datetime-local inputs */
function toDatetimeLocalValue(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format a compact local date/time label for print rows */
function formatShortDate(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Normalize `/api/reports` payload into RetroPrintItem[] */
function normalizeReportsPayload(payload: ReportsApiResponse): RetroPrintItem[] {
  const items: RetroPrintItem[] = [];
  if (payload.activePrint) {
    items.push({
      id: `active:${payload.activePrint.id}`,
      filename: payload.activePrint.filename,
      outcome: 'printing',
      startedAt: payload.activePrint.startedAt,
      endedAt: Date.now(),
      duration: Math.max(0, Math.round((Date.now() - payload.activePrint.startedAt) / 1000)),
      progressAtEnd: payload.activePrint.progress ?? 0,
      filament: Array.isArray(payload.activePrint.filament) ? payload.activePrint.filament : [],
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

/** Render the full spool calculator page (geometry/weight calculator + retroactive print-history estimator) */
export function renderSpoolCalc(): void {
  const container = document.getElementById('tools-content');
  if (!container) return;

  const p = loadParams();
  const calc = calculate(p);
  const retro = loadRetroState();
  const activeFileGrams =
    printerStateRef?.fileFilamentUsed != null && printerStateRef.fileFilamentUsed > 0
      ? printerStateRef.fileFilamentUsed
      : null;

  container.innerHTML = `
    <div class="spool-calc">
      <div class="spool-calc-grid">
        <div class="spool-calc-viz">
          <div id="spool-svg-container">${renderSVG(p, calc)}</div>
          <div class="spool-calc-stats">
            <div class="spool-stat">
              <span class="spool-stat-value" id="sc-meters">${calc.lengthM.toFixed(1)}</span>
              <span class="spool-stat-label">meters left</span>
            </div>
            <div class="spool-stat">
              <span class="spool-stat-value" id="sc-full-meters">${calc.fullLengthM.toFixed(1)}</span>
              <span class="spool-stat-label">meters full</span>
            </div>
            <div class="spool-stat">
              <span class="spool-stat-value" id="sc-grams">${calc.filamentMass.toFixed(0)}</span>
              <span class="spool-stat-label">grams filament</span>
            </div>
            <div class="spool-stat">
              <span class="spool-stat-value" id="sc-percent">${calc.percentRemaining.toFixed(0)}%</span>
              <span class="spool-stat-label">remaining</span>
            </div>
          </div>
        </div>
        <div class="spool-calc-inputs">
          <h4>Spool Dimensions</h4>
          <div class="form-group">
            <label for="sc-hub-dia">Hub Diameter (inner)</label>
            <div class="input-with-unit">
              <input type="number" id="sc-hub-dia" value="${p.hubDiameter}" min="10" max="120" step="1">
              <span class="input-unit">mm</span>
            </div>
          </div>
          <div class="form-group">
            <label for="sc-flange-dia">Flange Diameter (outer)</label>
            <div class="input-with-unit">
              <input type="number" id="sc-flange-dia" value="${p.flangeDiameter}" min="50" max="400" step="1">
              <span class="input-unit">mm</span>
            </div>
          </div>
          <div class="form-group">
            <label for="sc-width">Spool Width</label>
            <div class="input-with-unit">
              <input type="number" id="sc-width" value="${p.spoolWidth}" min="10" max="150" step="1">
              <span class="input-unit">mm</span>
            </div>
          </div>

          <h4>Weight</h4>
          <div class="form-group">
            <label for="sc-empty-weight">Empty Spool Weight</label>
            <div class="input-with-unit">
              <input type="number" id="sc-empty-weight" value="${p.emptyWeight}" min="0" max="2000" step="1">
              <span class="input-unit">g</span>
            </div>
          </div>
          <div class="form-group">
            <label for="sc-full-weight">Full Spool Weight (spool + filament)</label>
            <div class="input-with-unit">
              <input type="number" id="sc-full-weight" value="${p.fullWeight}" min="0" max="10000" step="1">
              <span class="input-unit">g</span>
            </div>
          </div>
          <div class="form-group">
            <label for="sc-current-weight">Current Weight</label>
            <div class="input-with-unit">
              <input type="number" id="sc-current-weight" value="${p.currentWeight}" min="0" max="10000" step="1">
              <span class="input-unit">g</span>
            </div>
          </div>

          <h4>Measure by Diameter</h4>
          <div class="form-group">
            <label for="sc-outer-dia">Current Outer Diameter</label>
            <div class="input-with-unit">
              <input type="number" id="sc-outer-dia" value="${p.currentOuterDiameter || ''}" min="0" max="400" step="1" placeholder="e.g. 180">
              <span class="input-unit">mm</span>
            </div>
            <span class="settings-hint">Measure the filament wound on the spool with a ruler — updates weight automatically</span>
          </div>

          <h4>Filament</h4>
          <div class="form-group">
            <label for="sc-material">Material</label>
            <select id="sc-material" class="log-select">
              ${Object.keys(SPOOL_MATERIALS)
                .map(
                  (m) =>
                    `<option value="${m}"${m === p.material ? ' selected' : ''}>${m} (${SPOOL_MATERIALS[m]} g/cm³)</option>`,
                )
                .join('')}
            </select>
          </div>
          <div class="form-group">
            <label for="sc-filament-dia">Filament Diameter</label>
            <select id="sc-filament-dia" class="log-select">
              <option value="1.75"${p.filamentDiameter === 1.75 ? ' selected' : ''}>1.75 mm</option>
              <option value="2.85"${p.filamentDiameter === 2.85 ? ' selected' : ''}>2.85 mm</option>
            </select>
          </div>

          <div class="spool-calc-density">
            Density: ${calc.density} g/cm³ · Cross-section: ${(Math.PI * (p.filamentDiameter / 2) ** 2).toFixed(4)} mm²
          </div>
        </div>
      </div>

      <section class="spool-retro" id="spool-retro">
        <div class="spool-retro-header">
          <div>
            <h3>📊 Retroactive Spool Estimator</h3>
            <p class="settings-hint">Subtract actual extruded material from past prints (including canceled and failed runs) to estimate what remains on a spool.</p>
          </div>
          <div class="spool-retro-header-actions">
            <button type="button" class="btn btn-sm btn-ghost" id="sr-refresh">↻ Refresh</button>
            <button type="button" class="btn btn-sm btn-primary" id="sr-apply">Apply to Calculator</button>
          </div>
        </div>

        <div class="spool-retro-setup">
          <div class="form-group">
            <label for="sr-start-grams">Starting Spool (net filament)</label>
            <div class="input-with-unit">
              <input type="number" id="sr-start-grams" value="${retro.startingSpoolGrams}" min="0" max="20000" step="10">
              <span class="input-unit">g</span>
            </div>
            <div class="sr-presets">
              <button type="button" class="btn btn-xs btn-ghost sr-spool-preset" data-grams="250">250g</button>
              <button type="button" class="btn btn-xs btn-ghost sr-spool-preset" data-grams="500">500g</button>
              <button type="button" class="btn btn-xs btn-ghost sr-spool-preset" data-grams="1000">1kg</button>
              <button type="button" class="btn btn-xs btn-ghost sr-spool-preset" data-grams="2000">2kg</button>
            </div>
          </div>

          <div class="form-group">
            <label for="sr-density-mode">Density for Grams Calculation</label>
            <div class="sr-density-row">
              <select id="sr-density-mode" class="log-select">
                <option value="auto"${retro.densityMode === 'auto' ? ' selected' : ''}>Recorded (as logged)</option>
                ${Object.keys(SPOOL_MATERIALS)
                  .map(
                    (m) =>
                      `<option value="${m}"${retro.densityMode === m ? ' selected' : ''}>${m} (${SPOOL_MATERIALS[m]} g/cm³)</option>`,
                  )
                  .join('')}
                <option value="custom"${retro.densityMode === 'custom' ? ' selected' : ''}>Custom g/cm³</option>
              </select>
              <div class="input-with-unit sr-custom-density-wrap${retro.densityMode === 'custom' ? '' : ' hidden'}" id="sr-custom-density-wrap">
                <input type="number" id="sr-custom-density" value="${retro.customDensity}" min="0.5" max="3" step="0.01">
                <span class="input-unit">g/cm³</span>
              </div>
            </div>
            <span class="settings-hint">Recomputes grams from actual extruded length when set</span>
          </div>

          <div class="form-group">
            <label for="sr-planned-grams">Check Against Print (optional)</label>
            <div class="input-with-unit">
              <input type="number" id="sr-planned-grams" value="${retro.plannedPrintGrams || ''}" min="0" max="10000" step="0.1" placeholder="e.g. 90.7">
              <span class="input-unit">g</span>
            </div>
            ${
              activeFileGrams != null
                ? `<button type="button" class="btn btn-xs btn-ghost sr-use-active-btn" id="sr-use-active" data-grams="${activeFileGrams.toFixed(1)}">Use active print (${activeFileGrams.toFixed(1)}g)</button>`
                : '<span class="settings-hint">Enter sliced grams to verify if enough remains</span>'
            }
          </div>
        </div>

        <div class="spool-retro-stats" id="sr-stats">
          <div class="spool-stat">
            <span class="spool-stat-value" id="sr-used-grams">0.0g</span>
            <span class="spool-stat-label" id="sr-used-sub">0.0 m used</span>
          </div>
          <div class="spool-stat">
            <span class="spool-stat-value" id="sr-left-grams">${retro.startingSpoolGrams.toFixed(0)}g</span>
            <span class="spool-stat-label" id="sr-left-sub">100% remaining</span>
          </div>
          <div class="spool-stat">
            <span class="spool-stat-value" id="sr-check-val">—</span>
            <span class="spool-stat-label" id="sr-check-sub">next print check</span>
          </div>
          <div class="spool-stat">
            <span class="spool-stat-value" id="sr-selected-count">0 / 0</span>
            <span class="spool-stat-label" id="sr-selected-sub">prints selected</span>
          </div>
        </div>

        <div class="spool-retro-filters">
          <div class="sr-filter-group">
            <label for="sr-filament">Filament / Slot</label>
            <select id="sr-filament" class="log-select">
              <option value="ALL">All filaments</option>
            </select>
          </div>

          <div class="sr-filter-group">
            <label for="sr-since">Prints Since</label>
            <div class="sr-since-row">
              <input type="datetime-local" id="sr-since" value="${escapeAttr(retro.sinceValue)}">
              <button type="button" class="btn btn-xs btn-ghost sr-date-preset" data-days="0">All</button>
              <button type="button" class="btn btn-xs btn-ghost sr-date-preset" data-days="1">24h</button>
              <button type="button" class="btn btn-xs btn-ghost sr-date-preset" data-days="7">7d</button>
              <button type="button" class="btn btn-xs btn-ghost sr-date-preset" data-days="30">30d</button>
            </div>
          </div>
        </div>

        <div class="spool-retro-toggles">
          <label class="sr-toggle"><input type="checkbox" id="sr-inc-completed"${retro.includeCompleted ? ' checked' : ''}> Completed</label>
          <label class="sr-toggle"><input type="checkbox" id="sr-inc-failed"${retro.includeFailed ? ' checked' : ''}> Failed / Canceled</label>
          <label class="sr-toggle"><input type="checkbox" id="sr-inc-stopped"${retro.includeStopped ? ' checked' : ''}> Stopped</label>
          <label class="sr-toggle"><input type="checkbox" id="sr-inc-active"${retro.includeActive ? ' checked' : ''}> Active print</label>
          <label class="sr-toggle" title="Include small unattributed prime/purge extrusion logged under mono before tray assignment"><input type="checkbox" id="sr-inc-mono"${retro.includeMonoPurge ? ' checked' : ''}> Include mono purge</label>
          <label class="sr-toggle"><input type="checkbox" id="sr-inc-zero"${retro.includeZeroUsage ? ' checked' : ''}> Show 0g prints</label>
          <div class="sr-bulk-actions">
            <button type="button" class="btn btn-xs btn-ghost" id="sr-select-all">Select all</button>
            <button type="button" class="btn btn-xs btn-ghost" id="sr-select-none">Select none</button>
            <button type="button" class="btn btn-xs btn-ghost" id="sr-reset-overrides">Reset overrides</button>
          </div>
        </div>

        <div class="spool-retro-list" id="sr-list">
          <div class="file-empty">Loading print history…</div>
        </div>
      </section>
    </div>
  `;

  // Bind input listeners for live spool calculator update
  const ids: [string, keyof SpoolParams][] = [
    ['sc-hub-dia', 'hubDiameter'],
    ['sc-flange-dia', 'flangeDiameter'],
    ['sc-width', 'spoolWidth'],
    ['sc-empty-weight', 'emptyWeight'],
    ['sc-full-weight', 'fullWeight'],
    ['sc-current-weight', 'currentWeight'],
  ];

  for (const [elemId, key] of ids) {
    const el = document.getElementById(elemId) as HTMLInputElement | null;
    if (el) {
      el.addEventListener('input', () => {
        const val = parseFloat(el.value);
        if (!isNaN(val) && val >= 0) {
          (p as unknown as Record<string, number>)[key] = val;
          updateCalc(p);
        }
      });
    }
  }

  const matEl = document.getElementById('sc-material') as HTMLSelectElement | null;
  if (matEl) {
    matEl.addEventListener('change', () => {
      p.material = matEl.value;
      updateCalc(p);
    });
  }

  const diaEl = document.getElementById('sc-filament-dia') as HTMLSelectElement | null;
  if (diaEl) {
    diaEl.addEventListener('change', () => {
      p.filamentDiameter = parseFloat(diaEl.value);
      updateCalc(p);
      renderRetroRowsAndSummary();
    });
  }

  // Diameter → Weight sync: changing outer diameter auto-calculates currentWeight
  const outerDiaEl = document.getElementById('sc-outer-dia') as HTMLInputElement | null;
  if (outerDiaEl) {
    outerDiaEl.addEventListener('input', () => {
      const val = parseFloat(outerDiaEl.value);
      if (!isNaN(val) && val > 0 && val >= p.hubDiameter) {
        p.currentOuterDiameter = val;
        const mass = outerDiameterToMass(val, p.hubDiameter, p.spoolWidth, p.material);
        p.currentWeight = Math.round(mass + p.emptyWeight);
        const weightEl = document.getElementById('sc-current-weight') as HTMLInputElement | null;
        if (weightEl) weightEl.value = String(p.currentWeight);
        updateCalc(p);
      }
    });
  }

  // ── Retroactive Spool Estimator controller ───────────────────────────
  let allReports: RetroPrintItem[] = [];
  let visibleReports: RetroPrintItem[] = [];
  const excludedIds = new Set<string>();

  function getSelectedSet(): Set<string> {
    const selected = new Set<string>();
    for (const item of visibleReports) {
      if (!excludedIds.has(item.id)) selected.add(item.id);
    }
    return selected;
  }

  function populateFilamentSelect(): void {
    const select = document.getElementById('sr-filament') as HTMLSelectElement | null;
    if (!select) return;
    const trayNames = getCanvasTrayNames();
    const options = extractFilamentOptions(allReports, trayNames);
    const typeOpts = options.filter((o) => o.kind === 'type');
    const trayOpts = options.filter((o) => o.kind === 'tray');

    let html = `<option value="ALL"${retro.filamentFilter === 'ALL' ? ' selected' : ''}>All filaments</option>`;
    if (typeOpts.length > 0) {
      html += '<optgroup label="Filament Types">';
      for (const opt of typeOpts) {
        html += `<option value="${escapeAttr(opt.value)}"${retro.filamentFilter === opt.value ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`;
      }
      html += '</optgroup>';
    }
    if (trayOpts.length > 0) {
      html += '<optgroup label="Canvas Slots">';
      for (const opt of trayOpts) {
        html += `<option value="${escapeAttr(opt.value)}"${retro.filamentFilter === opt.value ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`;
      }
      html += '</optgroup>';
    }
    select.innerHTML = html;

    // Reset filter to ALL if previously persisted filter no longer exists in loaded reports
    if (
      retro.filamentFilter !== 'ALL' &&
      !options.some((opt) => opt.value === retro.filamentFilter)
    ) {
      retro.filamentFilter = 'ALL';
      select.value = 'ALL';
      saveRetroState(retro);
    }
  }

  function updateRetroSummaryOnly(): void {
    const filter = buildRetroFilter(retro);
    const selected = getSelectedSet();
    const summary = calculateRetroSummary(visibleReports, selected, filter, {
      startingSpoolGrams: retro.startingSpoolGrams,
      densityOverride: resolveDensityOverride(retro),
      filamentDiameterMm: p.filamentDiameter,
      plannedPrintGrams: retro.plannedPrintGrams,
      manualGramsOverrides: retro.manualGramsOverrides,
    });

    const usedEl = document.getElementById('sr-used-grams');
    const usedSubEl = document.getElementById('sr-used-sub');
    const leftEl = document.getElementById('sr-left-grams');
    const leftSubEl = document.getElementById('sr-left-sub');
    const checkEl = document.getElementById('sr-check-val');
    const checkSubEl = document.getElementById('sr-check-sub');
    const countEl = document.getElementById('sr-selected-count');
    const countSubEl = document.getElementById('sr-selected-sub');

    if (usedEl) usedEl.textContent = `${summary.usedGrams.toFixed(1)}g`;
    if (usedSubEl) {
      const parts = [`${summary.usedMeters.toFixed(1)} m`];
      if (summary.canceledCount > 0) {
        parts.push(`${summary.canceledGrams.toFixed(1)}g canceled`);
      }
      usedSubEl.textContent = parts.join(' · ');
    }

    if (leftEl) {
      const displayLeft =
        summary.rawRemainingGrams < 0
          ? `${summary.rawRemainingGrams.toFixed(1)}g`
          : `${summary.remainingGrams.toFixed(1)}g`;
      leftEl.textContent = displayLeft;
      leftEl.classList.toggle('sr-status-danger', summary.rawRemainingGrams <= 0);
      leftEl.classList.toggle(
        'sr-status-warn',
        summary.rawRemainingGrams > 0 && summary.percentRemaining < 20,
      );
      leftEl.classList.toggle(
        'sr-status-ok',
        summary.rawRemainingGrams > 0 && summary.percentRemaining >= 20,
      );
    }
    if (leftSubEl) {
      leftSubEl.textContent =
        summary.rawRemainingGrams < 0
          ? 'exceeds spool size'
          : `${summary.remainingMeters.toFixed(1)} m · ${summary.percentRemaining.toFixed(0)}%`;
    }

    if (checkEl && checkSubEl) {
      if (summary.hasEnoughForPlanned === null) {
        checkEl.textContent = '—';
        checkEl.classList.remove('sr-status-ok', 'sr-status-danger', 'sr-status-warn');
        checkSubEl.textContent = 'next print check';
      } else if (summary.hasEnoughForPlanned) {
        checkEl.textContent = `Enough (+${summary.afterPlannedGrams.toFixed(1)}g)`;
        checkEl.classList.add('sr-status-ok');
        checkEl.classList.remove('sr-status-danger', 'sr-status-warn');
        checkSubEl.textContent = `after ${summary.plannedPrintGrams.toFixed(1)}g print`;
      } else {
        checkEl.textContent = `Short (${summary.afterPlannedGrams.toFixed(1)}g)`;
        checkEl.classList.add('sr-status-danger');
        checkEl.classList.remove('sr-status-ok', 'sr-status-warn');
        checkSubEl.textContent = `need ${summary.plannedPrintGrams.toFixed(1)}g`;
      }
    }

    if (countEl) countEl.textContent = `${summary.selectedCount} / ${visibleReports.length}`;
    if (countSubEl) {
      const pieces: string[] = [];
      if (summary.completedCount > 0) pieces.push(`${summary.completedCount} done`);
      if (summary.canceledCount > 0) pieces.push(`${summary.canceledCount} canceled`);
      if (summary.activeIncluded) pieces.push('1 active');
      countSubEl.textContent = pieces.length > 0 ? pieces.join(' · ') : 'prints selected';
    }
  }

  function renderRetroRowsAndSummary(): void {
    const listEl = document.getElementById('sr-list');
    if (!listEl) return;

    const filter = buildRetroFilter(retro);
    visibleReports = filterRetroPrints(allReports, filter);
    const densityOverride = resolveDensityOverride(retro);

    if (allReports.length === 0) {
      listEl.innerHTML =
        '<div class="file-empty">No print reports recorded yet. Reports are saved automatically as prints complete or stop.</div>';
      updateRetroSummaryOnly();
      return;
    }

    if (visibleReports.length === 0) {
      listEl.innerHTML =
        '<div class="file-empty">No prints match the current filament, date, and outcome filters.</div>';
      updateRetroSummaryOnly();
      return;
    }

    let html = '';
    for (const item of visibleReports) {
      const checked = !excludedIds.has(item.id);
      const usage = getPrintMatchedUsage(
        item,
        filter.filamentFilter,
        densityOverride,
        p.filamentDiameter,
        filter.includeMonoPurge,
      );
      const hasOverride = retro.manualGramsOverrides[item.id] != null;
      const displayGrams = hasOverride ? retro.manualGramsOverrides[item.id] : usage.grams;
      const outcome = classifyOutcome(item);
      const outcomeLabel =
        outcome === 'completed'
          ? 'completed'
          : outcome === 'printing'
            ? `printing · ${item.progressAtEnd}%`
            : `${outcome} · ${item.progressAtEnd}%`;
      const outcomeClass =
        outcome === 'completed'
          ? 'success'
          : outcome === 'printing'
            ? 'accent'
            : outcome === 'stopped'
              ? 'warning'
              : 'danger';

      const swatches = usage.entries
        .map(
          (e) =>
            `<span class="sr-filament-chip"><span class="sr-swatch" style="background:${escapeAttr(e.color || '#888888')}"></span>${escapeHtml(e.filamentType || '?')}</span>`,
        )
        .join('');

      html += `
        <div class="sr-row${checked ? '' : ' sr-row-unchecked'}" data-id="${escapeAttr(item.id)}">
          <label class="sr-row-check">
            <input type="checkbox" class="sr-check" data-id="${escapeAttr(item.id)}"${checked ? ' checked' : ''}>
          </label>
          <div class="sr-row-info">
            <div class="sr-row-title" title="${escapeAttr(item.filename)}">${escapeHtml(item.filename)}</div>
            <div class="sr-row-meta">
              <span>${escapeHtml(formatShortDate(item.startedAt))}</span>
              <span>· ${escapeHtml(formatTime(item.duration))}</span>
              <span class="sr-outcome-badge sr-outcome-${outcomeClass}">${escapeHtml(outcomeLabel)}</span>
              ${swatches}
            </div>
          </div>
          <div class="sr-row-usage">
            <span class="sr-meters">${usage.meters.toFixed(1)} m</span>
            <div class="sr-grams-edit">
              <input type="number" class="sr-grams-input${hasOverride ? ' sr-overridden' : ''}" data-id="${escapeAttr(item.id)}" value="${displayGrams.toFixed(1)}" min="0" max="10000" step="0.1" title="Actual grams used (editable override)">
              <span class="input-unit">g</span>
              ${
                hasOverride
                  ? `<button type="button" class="btn btn-xs btn-ghost sr-clear-override" data-id="${escapeAttr(item.id)}" title="Reset to tracked value">×</button>`
                  : ''
              }
            </div>
          </div>
        </div>`;
    }

    listEl.innerHTML = html;

    // Bind row checkboxes
    listEl.querySelectorAll('.sr-check').forEach((box) => {
      box.addEventListener('change', () => {
        const el = box as HTMLInputElement;
        const id = el.dataset.id;
        if (!id) return;
        if (el.checked) {
          excludedIds.delete(id);
        } else {
          excludedIds.add(id);
        }
        el.closest('.sr-row')?.classList.toggle('sr-row-unchecked', !el.checked);
        updateRetroSummaryOnly();
      });
    });

    // Bind per-print grams override inputs (update summary in-place to preserve typing focus)
    listEl.querySelectorAll('.sr-grams-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const el = inp as HTMLInputElement;
        const id = el.dataset.id;
        if (!id) return;
        const val = parseFloat(el.value);
        if (!isNaN(val) && val >= 0) {
          retro.manualGramsOverrides[id] = val;
          el.classList.add('sr-overridden');
          saveRetroState(retro);
          updateRetroSummaryOnly();
        }
      });
    });

    // Bind clear-override buttons
    listEl.querySelectorAll('.sr-clear-override').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id;
        if (!id) return;
        delete retro.manualGramsOverrides[id];
        saveRetroState(retro);
        renderRetroRowsAndSummary();
      });
    });

    updateRetroSummaryOnly();
  }

  async function fetchRetroReports(): Promise<void> {
    const listEl = document.getElementById('sr-list');
    if (listEl) listEl.innerHTML = '<div class="file-empty">Loading print history…</div>';
    try {
      const res = await fetchTimeout('/api/reports');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as ReportsApiResponse;
      allReports = normalizeReportsPayload(payload);
      populateFilamentSelect();
      renderRetroRowsAndSummary();
    } catch {
      if (listEl) {
        listEl.innerHTML =
          '<div class="file-empty">Unable to load print reports from server.</div>';
      }
    }
  }

  // Bind Retroactive controls
  const startGramsEl = document.getElementById('sr-start-grams') as HTMLInputElement | null;
  if (startGramsEl) {
    startGramsEl.addEventListener('input', () => {
      const val = parseFloat(startGramsEl.value);
      if (!isNaN(val) && val >= 0) {
        retro.startingSpoolGrams = val;
        saveRetroState(retro);
        updateRetroSummaryOnly();
      }
    });
  }

  container.querySelectorAll('.sr-spool-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const grams = parseFloat((btn as HTMLElement).dataset.grams ?? '0');
      if (!isNaN(grams) && grams > 0) {
        retro.startingSpoolGrams = grams;
        if (startGramsEl) startGramsEl.value = String(grams);
        saveRetroState(retro);
        updateRetroSummaryOnly();
      }
    });
  });

  const densityModeEl = document.getElementById('sr-density-mode') as HTMLSelectElement | null;
  const customDensityWrap = document.getElementById('sr-custom-density-wrap');
  const customDensityEl = document.getElementById('sr-custom-density') as HTMLInputElement | null;

  if (densityModeEl) {
    densityModeEl.addEventListener('change', () => {
      retro.densityMode = densityModeEl.value;
      customDensityWrap?.classList.toggle('hidden', retro.densityMode !== 'custom');
      saveRetroState(retro);
      renderRetroRowsAndSummary();
    });
  }

  if (customDensityEl) {
    customDensityEl.addEventListener('input', () => {
      const val = parseFloat(customDensityEl.value);
      if (!isNaN(val) && val > 0) {
        retro.customDensity = val;
        saveRetroState(retro);
        renderRetroRowsAndSummary();
      }
    });
  }

  const plannedEl = document.getElementById('sr-planned-grams') as HTMLInputElement | null;
  if (plannedEl) {
    plannedEl.addEventListener('input', () => {
      const val = parseFloat(plannedEl.value);
      retro.plannedPrintGrams = !isNaN(val) && val >= 0 ? val : 0;
      saveRetroState(retro);
      updateRetroSummaryOnly();
    });
  }

  const useActiveBtn = document.getElementById('sr-use-active') as HTMLButtonElement | null;
  if (useActiveBtn) {
    useActiveBtn.addEventListener('click', () => {
      const grams = parseFloat(useActiveBtn.dataset.grams ?? '0');
      if (!isNaN(grams) && grams > 0) {
        retro.plannedPrintGrams = grams;
        if (plannedEl) plannedEl.value = grams.toFixed(1);
        saveRetroState(retro);
        updateRetroSummaryOnly();
      }
    });
  }

  const filamentEl = document.getElementById('sr-filament') as HTMLSelectElement | null;
  if (filamentEl) {
    filamentEl.addEventListener('change', () => {
      retro.filamentFilter = filamentEl.value;
      saveRetroState(retro);
      renderRetroRowsAndSummary();
    });
  }

  const sinceEl = document.getElementById('sr-since') as HTMLInputElement | null;
  if (sinceEl) {
    sinceEl.addEventListener('change', () => {
      retro.sinceValue = sinceEl.value;
      saveRetroState(retro);
      renderRetroRowsAndSummary();
    });
  }

  container.querySelectorAll('.sr-date-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = parseInt((btn as HTMLElement).dataset.days ?? '0', 10);
      retro.sinceValue = days > 0 ? toDatetimeLocalValue(Date.now() - days * 86_400_000) : '';
      if (sinceEl) sinceEl.value = retro.sinceValue;
      saveRetroState(retro);
      renderRetroRowsAndSummary();
    });
  });

  const toggleBindings: Array<[string, keyof RetroPersistedState]> = [
    ['sr-inc-completed', 'includeCompleted'],
    ['sr-inc-failed', 'includeFailed'],
    ['sr-inc-stopped', 'includeStopped'],
    ['sr-inc-active', 'includeActive'],
    ['sr-inc-mono', 'includeMonoPurge'],
    ['sr-inc-zero', 'includeZeroUsage'],
  ];

  for (const [id, key] of toggleBindings) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.addEventListener('change', () => {
        (retro as unknown as Record<string, boolean>)[key] = el.checked;
        saveRetroState(retro);
        renderRetroRowsAndSummary();
      });
    }
  }

  document.getElementById('sr-select-all')?.addEventListener('click', () => {
    for (const item of visibleReports) excludedIds.delete(item.id);
    renderRetroRowsAndSummary();
  });

  document.getElementById('sr-select-none')?.addEventListener('click', () => {
    for (const item of visibleReports) excludedIds.add(item.id);
    renderRetroRowsAndSummary();
  });

  document.getElementById('sr-reset-overrides')?.addEventListener('click', () => {
    retro.manualGramsOverrides = {};
    saveRetroState(retro);
    renderRetroRowsAndSummary();
  });

  document.getElementById('sr-refresh')?.addEventListener('click', () => {
    void fetchRetroReports();
  });

  document.getElementById('sr-apply')?.addEventListener('click', () => {
    const filter = buildRetroFilter(retro);
    const summary = calculateRetroSummary(visibleReports, getSelectedSet(), filter, {
      startingSpoolGrams: retro.startingSpoolGrams,
      densityOverride: resolveDensityOverride(retro),
      filamentDiameterMm: p.filamentDiameter,
      plannedPrintGrams: retro.plannedPrintGrams,
      manualGramsOverrides: retro.manualGramsOverrides,
    });

    p.fullWeight = Math.round(p.emptyWeight + retro.startingSpoolGrams);
    p.currentWeight = Math.round((p.emptyWeight + summary.remainingGrams) * 10) / 10;

    // Sync material dropdown if density preset or filament filter maps cleanly to SPOOL_MATERIALS
    const candidateMaterial =
      retro.densityMode !== 'auto' && retro.densityMode !== 'custom'
        ? retro.densityMode
        : filter.filamentFilter.toUpperCase();
    if (SPOOL_MATERIALS[candidateMaterial] != null) {
      p.material = candidateMaterial;
    } else {
      const suggested = suggestDensityForFilter(filter.filamentFilter, getCanvasTrayNames());
      const matchedMat =
        suggested != null
          ? Object.keys(SPOOL_MATERIALS).find((k) => SPOOL_MATERIALS[k] === suggested)
          : undefined;
      if (matchedMat) p.material = matchedMat;
    }

    const fullEl = document.getElementById('sc-full-weight') as HTMLInputElement | null;
    const currEl = document.getElementById('sc-current-weight') as HTMLInputElement | null;
    if (fullEl) fullEl.value = String(p.fullWeight);
    if (currEl) currEl.value = String(p.currentWeight);
    if (matEl) matEl.value = p.material;

    updateCalc(p);
    toast(
      `Applied ${summary.remainingGrams.toFixed(0)}g remaining (${summary.percentRemaining.toFixed(0)}%) to Spool Calculator`,
      'success',
    );
  });

  void fetchRetroReports();
}

function updateCalc(p: SpoolParams): void {
  saveParams(p);
  const calc = calculate(p);

  const svgContainer = document.getElementById('spool-svg-container');
  if (svgContainer) svgContainer.innerHTML = renderSVG(p, calc);

  const metersEl = document.getElementById('sc-meters');
  if (metersEl) metersEl.textContent = calc.lengthM.toFixed(1);

  const fullMetersEl = document.getElementById('sc-full-meters');
  if (fullMetersEl) fullMetersEl.textContent = calc.fullLengthM.toFixed(1);

  const gramsEl = document.getElementById('sc-grams');
  if (gramsEl) gramsEl.textContent = calc.filamentMass.toFixed(0);

  const percentEl = document.getElementById('sc-percent');
  if (percentEl) percentEl.textContent = `${calc.percentRemaining.toFixed(0)}%`;

  // Update density line
  const densityEl = document.querySelector('.spool-calc-density');
  if (densityEl) {
    densityEl.textContent = `Density: ${calc.density} g/cm³ · Cross-section: ${(Math.PI * (p.filamentDiameter / 2) ** 2).toFixed(4)} mm²`;
  }

  // Sync outer diameter display from calculated value (when weight is edited manually)
  const outerDiaEl = document.getElementById('sc-outer-dia') as HTMLInputElement | null;
  if (outerDiaEl && document.activeElement !== outerDiaEl) {
    outerDiaEl.value =
      calc.currentOuterRadius > p.hubDiameter / 2
        ? Math.round(calc.currentOuterRadius * 2).toString()
        : '';
  }
}
