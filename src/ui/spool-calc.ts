/** Spool Calculator — visualizes remaining filament on a spool, and hosts the Retroactive Spool Estimator */

import type { PrinterState } from '../printer-state';
import { DEFAULT_FILAMENT_DENSITY, FILAMENT_DENSITY } from '../filament-density';
import {
  type ApplyResult,
  type SpoolEstimate,
  mountSpoolRetro,
  setSpoolRetroState,
} from './spool-retro-view';

const STORAGE_KEY = 'elegoo-web-spool-calc';

export interface SpoolParams {
  hubDiameter: number; // mm — inner diameter (the core around which filament is wound)
  flangeDiameter: number; // mm — outer diameter of the spool flanges
  spoolWidth: number; // mm — width/depth of the spool
  emptyWeight: number; // g — weight of the empty spool (no filament)
  currentWeight: number; // g — current total weight (spool + remaining filament)
  filamentDiameter: number; // mm — 1.75 or 2.85
  material: string; // key into FILAMENT_DENSITY
  fullWeight: number; // g — full spool weight (spool + full filament, e.g. empty + 1000)
  currentOuterDiameter: number; // mm — measured outer diameter of remaining filament on spool
}

export const DEFAULTS: SpoolParams = {
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

function loadParams(): SpoolParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const loaded = { ...DEFAULTS, ...JSON.parse(raw) } as SpoolParams;
      // A value saved by an older build may be impossible; start over rather than render it.
      if (Object.keys(validateSpool(loaded)).length === 0) return loaded;
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

function saveParams(p: SpoolParams): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

/** Convert outer diameter (mm) to filament mass (grams) using spool geometry */
function outerDiameterToMass(
  outerDiameter: number,
  hubDiameter: number,
  spoolWidth: number,
  material: string,
): number {
  const density = FILAMENT_DENSITY[material] ?? DEFAULT_FILAMENT_DENSITY;
  const outerR = outerDiameter / 2 / 10; // cm
  const hubR = hubDiameter / 2 / 10; // cm
  const width = spoolWidth / 10; // cm
  const volume = Math.PI * (outerR * outerR - hubR * hubR) * width; // cm³
  return Math.max(0, volume * density); // grams
}

type SpoolErrors = Partial<Record<keyof SpoolParams, string>>;

const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * Reject impossible spool geometry and weights. Returns one message per offending
 * field; an empty object means the input is usable. A current outer diameter of 0
 * means "not measured" and is not checked.
 */
export function validateSpool(p: SpoolParams): SpoolErrors {
  const e: SpoolErrors = {};
  if (!isPositive(p.hubDiameter)) e.hubDiameter = 'Enter a hub diameter above 0.';
  if (!isPositive(p.flangeDiameter)) e.flangeDiameter = 'Enter a flange diameter above 0.';
  if (!isPositive(p.spoolWidth)) e.spoolWidth = 'Enter a spool width above 0.';
  if (!isPositive(p.filamentDiameter)) e.filamentDiameter = 'Enter a filament diameter above 0.';
  if (!Number.isFinite(p.emptyWeight) || p.emptyWeight < 0) {
    e.emptyWeight = 'Enter an empty weight of 0 or more.';
  }
  if (!isPositive(p.fullWeight)) e.fullWeight = 'Enter a full weight above 0.';
  if (!isPositive(p.currentWeight)) e.currentWeight = 'Enter a current weight above 0.';

  if (!e.hubDiameter && !e.flangeDiameter && p.hubDiameter >= p.flangeDiameter) {
    e.hubDiameter = 'Hub diameter must be smaller than the flange diameter.';
  }
  if (!e.emptyWeight && !e.fullWeight && p.fullWeight <= p.emptyWeight) {
    e.fullWeight = 'Full weight must be greater than the empty spool weight.';
  }
  if (!e.emptyWeight && !e.currentWeight && p.currentWeight < p.emptyWeight) {
    e.currentWeight = 'Current weight cannot be below the empty spool weight.';
  }

  const od = p.currentOuterDiameter;
  if (od !== 0) {
    if (!isPositive(od)) {
      e.currentOuterDiameter = 'Enter an outer diameter above 0, or leave it empty.';
    } else if (!e.flangeDiameter && od > p.flangeDiameter) {
      e.currentOuterDiameter = 'Outer diameter cannot exceed the flange diameter.';
    } else if (!e.hubDiameter && od <= p.hubDiameter) {
      e.currentOuterDiameter = 'Outer diameter must be larger than the hub diameter.';
    }
  }
  return e;
}

/** Calculate filament remaining stats */
export function calculate(p: SpoolParams) {
  const density = FILAMENT_DENSITY[p.material] ?? DEFAULT_FILAMENT_DENSITY;
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

  // A spool weighed above "full" is still 100%, never more.
  const percentRemaining =
    fullFilamentMass > 0 ? Math.min(100, (filamentMass / fullFilamentMass) * 100) : 0;

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

/** Render the full spool calculator page */
export function renderSpoolCalc(): void {
  const container = document.getElementById('tools-content');
  if (!container) return;

  const p = loadParams();
  const calc = calculate(p);

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
              ${Object.keys(FILAMENT_DENSITY)
                .map(
                  (m) =>
                    `<option value="${m}"${m === p.material ? ' selected' : ''}>${m} (${FILAMENT_DENSITY[m]} g/cm³)</option>`,
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

      <section class="spool-retro" id="spool-retro"></section>
    </div>
  `;

  // Bind input listeners for live update
  const ids: [string, keyof SpoolParams][] = [
    ['sc-hub-dia', 'hubDiameter'],
    ['sc-flange-dia', 'flangeDiameter'],
    ['sc-width', 'spoolWidth'],
    ['sc-empty-weight', 'emptyWeight'],
    ['sc-full-weight', 'fullWeight'],
    ['sc-current-weight', 'currentWeight'],
  ];

  // One inline message slot per validated input, a static sibling of the input row.
  for (const [elemId, key] of [...ids, ['sc-outer-dia', 'currentOuterDiameter'] as const]) {
    const el = document.getElementById(elemId);
    const row = el?.closest('.input-with-unit');
    if (!el || !row) continue;
    const msg = document.createElement('span');
    msg.className = 'settings-hint spool-calc-error';
    msg.id = `sc-err-${key}`;
    msg.hidden = true;
    el.setAttribute('aria-describedby', msg.id);
    row.after(msg);
  }

  for (const [elemId, key] of ids) {
    const el = document.getElementById(elemId) as HTMLInputElement | null;
    if (el) {
      el.addEventListener('input', () => {
        // An empty or non-numeric field is NaN, which validateSpool rejects.
        (p as unknown as Record<string, number>)[key] =
          el.value.trim() === '' ? NaN : Number(el.value);
        // The outer-diameter input is re-derived from these values, so an earlier
        // measurement is stale the moment any of them changes.
        p.currentOuterDiameter = 0;
        updateCalc(p);
      });
    }
  }

  const matEl = document.getElementById('sc-material') as HTMLSelectElement | null;
  if (matEl) {
    matEl.addEventListener('change', () => {
      p.material = matEl.value;
      p.currentOuterDiameter = 0;
      updateCalc(p);
    });
  }

  const diaEl = document.getElementById('sc-filament-dia') as HTMLSelectElement | null;
  if (diaEl) {
    diaEl.addEventListener('change', () => {
      p.filamentDiameter = parseFloat(diaEl.value);
      p.currentOuterDiameter = 0;
      updateCalc(p);
    });
  }

  // Diameter → Weight sync: changing outer diameter auto-calculates currentWeight
  const outerDiaEl = document.getElementById('sc-outer-dia') as HTMLInputElement | null;
  if (outerDiaEl) {
    outerDiaEl.addEventListener('input', () => {
      // Empty means "not measured" (0); anything else non-numeric is NaN and rejected.
      const val = outerDiaEl.value.trim() === '' ? 0 : Number(outerDiaEl.value);
      p.currentOuterDiameter = val;
      // Only derive the weight from a diameter that passes validation.
      if (validateSpool(p).currentOuterDiameter === undefined && val > 0) {
        const mass = outerDiameterToMass(val, p.hubDiameter, p.spoolWidth, p.material);
        p.currentWeight = Math.round(mass + p.emptyWeight);
        const weightEl = document.getElementById('sc-current-weight') as HTMLInputElement | null;
        if (weightEl) weightEl.value = String(p.currentWeight);
      }
      updateCalc(p);
    });
  }

  const retroRoot = document.getElementById('spool-retro');
  if (retroRoot) {
    void mountSpoolRetro(retroRoot, { apply: (estimate) => applyEstimate(p, estimate) });
  }
}

/** Attach live PrinterState for the estimator (Canvas tray names, the active file's grams). */
export function setSpoolCalcState(state: PrinterState): void {
  setSpoolRetroState(state);
}

/**
 * Fill the calculator from an estimate (ELEG-197). Goes through `validateSpool` like any
 * typed input: the values are shown with the calculator's normal inline errors, and an
 * impossible estimate — say, history that used more than the starting spool — is refused
 * and never persisted (ELEG-170). Returns null when accepted, else the first error.
 */
export function applyEstimate(p: SpoolParams, estimate: SpoolEstimate): ApplyResult {
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const candidate: SpoolParams = {
    ...p,
    fullWeight: round1(p.emptyWeight + estimate.netFullGrams),
    currentWeight: round1(p.emptyWeight + estimate.remainingGrams),
    // A measured diameter is stale once the weights change.
    currentOuterDiameter: 0,
    material:
      estimate.material && estimate.material in FILAMENT_DENSITY ? estimate.material : p.material,
  };
  const errors = validateSpool(candidate);

  Object.assign(p, candidate);
  const setValue = (id: string, value: string) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) el.value = value;
  };
  setValue('sc-full-weight', String(p.fullWeight));
  setValue('sc-current-weight', String(p.currentWeight));
  setValue('sc-material', p.material);
  // Shows the inline errors and blanks the tiles when invalid; saves only when valid.
  updateCalc(p);

  const first = Object.values(errors)[0];
  return first ?? null;
}

const INPUT_IDS: Partial<Record<keyof SpoolParams, string>> = {
  hubDiameter: 'sc-hub-dia',
  flangeDiameter: 'sc-flange-dia',
  spoolWidth: 'sc-width',
  emptyWeight: 'sc-empty-weight',
  fullWeight: 'sc-full-weight',
  currentWeight: 'sc-current-weight',
  currentOuterDiameter: 'sc-outer-dia',
};

function updateCalc(p: SpoolParams): void {
  const errors = validateSpool(p);
  const valid = Object.keys(errors).length === 0;

  for (const [key, elemId] of Object.entries(INPUT_IDS)) {
    const msg = errors[key as keyof SpoolParams];
    const input = document.getElementById(elemId);
    const slot = document.getElementById(`sc-err-${key}`);
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    if (slot) {
      slot.textContent = msg ?? '';
      slot.hidden = !msg;
    }
  }

  const setText = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  const svgContainer = document.getElementById('spool-svg-container');
  if (!valid) {
    // Never persist or draw impossible input; the last valid values stay in storage.
    if (svgContainer) svgContainer.innerHTML = '';
    for (const id of ['sc-meters', 'sc-full-meters', 'sc-grams', 'sc-percent']) setText(id, '—');
    return;
  }

  saveParams(p);
  const calc = calculate(p);

  if (svgContainer) svgContainer.innerHTML = renderSVG(p, calc);

  setText('sc-meters', calc.lengthM.toFixed(1));
  setText('sc-full-meters', calc.fullLengthM.toFixed(1));
  setText('sc-grams', calc.filamentMass.toFixed(0));
  setText('sc-percent', `${calc.percentRemaining.toFixed(0)}%`);

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
