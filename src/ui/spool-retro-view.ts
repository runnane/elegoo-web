/**
 * Retroactive Spool Estimator — the DOM half (ELEG-197, from contributor PR #182 by
 * Gavin Boley). The decisions are in `spool-retro.ts`; this owns markup, events and
 * persistence.
 *
 * It follows the list-view rule in AGENTS.md:
 * - **The controls are mounted once**, in `#sr-controls`, a static sibling of the result
 *   tiles (`#sr-stats`) and the print list (`#sr-list`). A result update rewrites only
 *   `#sr-list` and the tiles' text, never a control, so an input keeps focus and caret
 *   while results change under it.
 * - **State lives at module scope**, outside every render function — and outside
 *   `renderSpoolCalc`, which runs again on every visit to Tools. Preferences persist
 *   through `ui-settings.ts`; the fetched reports and the per-session row exclusions do
 *   not persist.
 *
 * The density override is offered only when the filter selects exactly one material
 * (`resolveDensityScope`); otherwise the control is disabled and a note says why.
 */

import type { PrinterState } from '../printer-state';
import { FILAMENT_DENSITY } from '../filament-density';
import { escapeAttr, escapeHtml, fetchTimeout, formatTime } from './helpers';
import {
  type RetroPrefs,
  type RetroPrintItem,
  type ReportsApiResponse,
  calculateRetroSummary,
  classifyOutcome,
  extractFilamentOptions,
  filterFromPrefs,
  filterRetroPrints,
  getPrintMatchedUsage,
  normaliseReportsPayload,
  normaliseRetroPrefs,
  requestedDensityOverride,
  resolveDensityScope,
} from './spool-retro';
import { getSpoolRetroPrefs, saveSpoolRetroPrefs } from './ui-settings';

/** What the estimator hands the Spool Calculator on Apply. */
export interface SpoolEstimate {
  /** Net filament on a full spool, g */
  netFullGrams: number;
  /** Net filament remaining, g — unclamped, so an over-used spool is negative */
  remainingGrams: number;
  /** The single material the filter selects, if it is in the density table */
  material: string | null;
}

/** The calculator's answer: null when it accepted the estimate, else the reason it refused. */
export type ApplyResult = string | null;

export interface SpoolRetroHost {
  apply(estimate: SpoolEstimate): ApplyResult;
}

// ── Module state: survives re-renders and re-visits to Tools ───────────────
let prefs: RetroPrefs | null = null;
let allReports: RetroPrintItem[] = [];
let visibleReports: RetroPrintItem[] = [];
const excludedIds = new Set<string>();
let printerStateRef: PrinterState | null = null;

/** Attach live PrinterState so the estimator can read Canvas tray names and the active file's grams. */
export function setSpoolRetroState(state: PrinterState): void {
  printerStateRef = state;
}

function getPrefs(): RetroPrefs {
  if (!prefs) prefs = normaliseRetroPrefs(getSpoolRetroPrefs());
  return prefs;
}

function persist(): void {
  saveSpoolRetroPrefs(getPrefs());
}

/** Canvas tray display names (e.g. 'PA6-CF') from live PrinterState, if available */
function getCanvasTrayNames(): Record<string, string> {
  const map: Record<string, string> = {};
  const units = printerStateRef?.canvas?.canvas_list;
  if (!units) return map;
  for (const unit of units) {
    for (const tray of unit.tray_list ?? []) {
      const label = (tray.filament_name || tray.filament_type || '').trim();
      if (label) map[`canvas_${unit.canvas_id}_tray_${tray.tray_id}`] = label;
    }
  }
  return map;
}

function toDatetimeLocalValue(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatShortDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function setText(id: string, text: string): void {
  const el = byId(id);
  if (el) el.textContent = text;
}

function densityOptionsHtml(selected: string): string {
  return [
    `<option value="auto"${selected === 'auto' ? ' selected' : ''}>Recorded (as logged)</option>`,
    ...Object.keys(FILAMENT_DENSITY).map(
      (m) =>
        `<option value="${escapeAttr(m)}"${selected === m ? ' selected' : ''}>${escapeHtml(m)} (${FILAMENT_DENSITY[m]} g/cm³)</option>`,
    ),
    `<option value="custom"${selected === 'custom' ? ' selected' : ''}>Custom g/cm³</option>`,
  ].join('');
}

/** The static skeleton. Called once per mount; nothing below rewrites `#sr-controls`. */
function skeletonHtml(r: RetroPrefs): string {
  const activeFileGrams =
    printerStateRef?.fileFilamentUsed != null && printerStateRef.fileFilamentUsed > 0
      ? printerStateRef.fileFilamentUsed
      : null;
  const toggle = (id: string, on: boolean, label: string, title = '') =>
    `<label class="sr-toggle"${title ? ` title="${escapeAttr(title)}"` : ''}><input type="checkbox" id="${id}"${on ? ' checked' : ''}> ${label}</label>`;

  return `
    <div class="spool-retro-header">
      <div>
        <h3>Retroactive Spool Estimator</h3>
        <p class="settings-hint">Subtract the filament past prints actually extruded — including failed and cancelled runs — to estimate what remains on a spool.</p>
      </div>
      <div class="spool-retro-header-actions">
        <button type="button" class="btn btn-sm btn-ghost" id="sr-refresh">↻ Refresh</button>
        <button type="button" class="btn btn-sm btn-primary" id="sr-apply">Apply to Calculator</button>
      </div>
    </div>

    <div id="sr-controls">
      <div class="spool-retro-setup">
        <div class="form-group">
          <label for="sr-start-grams">Starting Spool (net filament)</label>
          <div class="input-with-unit">
            <input type="number" id="sr-start-grams" value="${r.startingSpoolGrams}" min="0" max="20000" step="10">
            <span class="input-unit">g</span>
          </div>
          <div class="sr-presets">
            ${[250, 500, 1000, 2000]
              .map(
                (g) =>
                  `<button type="button" class="btn btn-sm btn-ghost sr-spool-preset" data-grams="${g}">${g >= 1000 ? `${g / 1000}kg` : `${g}g`}</button>`,
              )
              .join('')}
          </div>
        </div>

        <div class="form-group">
          <label for="sr-density-mode">Density for Grams Calculation</label>
          <div class="sr-density-row">
            <select id="sr-density-mode" class="log-select">${densityOptionsHtml(r.densityMode)}</select>
            <div class="input-with-unit sr-custom-density-wrap${r.densityMode === 'custom' ? '' : ' hidden'}" id="sr-custom-density-wrap">
              <input type="number" id="sr-custom-density" value="${r.customDensity}" min="0.5" max="3" step="0.01">
              <span class="input-unit">g/cm³</span>
            </div>
          </div>
          <span class="settings-hint" id="sr-density-note"></span>
        </div>

        <div class="form-group">
          <label for="sr-planned-grams">Check Against Print (optional)</label>
          <div class="input-with-unit">
            <input type="number" id="sr-planned-grams" value="${r.plannedPrintGrams || ''}" min="0" max="10000" step="0.1" placeholder="e.g. 90.7">
            <span class="input-unit">g</span>
          </div>
          ${
            activeFileGrams != null
              ? `<button type="button" class="btn btn-sm btn-ghost sr-use-active-btn" id="sr-use-active" data-grams="${activeFileGrams.toFixed(1)}">Use active print (${activeFileGrams.toFixed(1)}g)</button>`
              : '<span class="settings-hint">Enter sliced grams to check whether enough remains</span>'
          }
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
            <input type="datetime-local" id="sr-since" value="${escapeAttr(r.sinceValue)}">
            ${[
              [0, 'All'],
              [1, '24h'],
              [7, '7d'],
              [30, '30d'],
            ]
              .map(
                ([d, l]) =>
                  `<button type="button" class="btn btn-sm btn-ghost sr-date-preset" data-days="${d}">${l}</button>`,
              )
              .join('')}
          </div>
        </div>
      </div>

      <div class="spool-retro-toggles">
        ${toggle('sr-inc-completed', r.includeCompleted, 'Completed')}
        ${toggle('sr-inc-failed', r.includeFailed, 'Failed / Cancelled')}
        ${toggle('sr-inc-stopped', r.includeStopped, 'Stopped')}
        ${toggle('sr-inc-active', r.includeActive, 'Active print')}
        ${toggle('sr-inc-mono', r.includeMonoPurge, 'Include mono purge', 'Include the small prime/purge logged under the direct (mono) feed before the Canvas tray reports in')}
        ${toggle('sr-inc-zero', r.includeZeroUsage, 'Show 0 g prints')}
        <div class="sr-bulk-actions">
          <button type="button" class="btn btn-sm btn-ghost" id="sr-select-all">Select all</button>
          <button type="button" class="btn btn-sm btn-ghost" id="sr-select-none">Select none</button>
          <button type="button" class="btn btn-sm btn-ghost" id="sr-reset-overrides">Reset overrides</button>
        </div>
      </div>
    </div>

    <div class="spool-retro-stats" id="sr-stats">
      <div class="spool-stat">
        <span class="spool-stat-value" id="sr-used-grams">0.0g</span>
        <span class="spool-stat-label" id="sr-used-sub">0.0 m used</span>
      </div>
      <div class="spool-stat">
        <span class="spool-stat-value" id="sr-left-grams">${r.startingSpoolGrams.toFixed(0)}g</span>
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
    <p class="settings-hint" id="sr-apply-status" role="status"></p>

    <div class="spool-retro-list" id="sr-list">
      <div class="file-empty">Loading print history…</div>
    </div>

    <p class="settings-hint sr-limits">Assumes 1.75 mm filament, as the service records it. If the service restarted during the live print, that print's usage is under-counted.</p>
  `;
}

function currentSummary() {
  const r = getPrefs();
  return calculateRetroSummary(visibleReports, selectedSet(), filterFromPrefs(r), {
    startingSpoolGrams: r.startingSpoolGrams,
    densityOverride: requestedDensityOverride(r),
    plannedPrintGrams: r.plannedPrintGrams,
    manualGramsOverrides: r.manualGramsOverrides,
  });
}

function selectedSet(): Set<string> {
  const selected = new Set<string>();
  for (const item of visibleReports) if (!excludedIds.has(item.id)) selected.add(item.id);
  return selected;
}

function populateFilamentSelect(): void {
  const select = byId<HTMLSelectElement>('sr-filament');
  if (!select) return;
  const r = getPrefs();
  const options = extractFilamentOptions(allReports, getCanvasTrayNames());
  // A saved filter for a material no longer in history falls back to all — judged only
  // once there is history to judge by, not on the empty list before the first fetch.
  if (
    allReports.length > 0 &&
    r.filamentFilter !== 'ALL' &&
    !options.some((o) => o.value === r.filamentFilter)
  ) {
    r.filamentFilter = 'ALL';
    persist();
  }
  const group = (label: string, kind: 'type' | 'tray') => {
    const opts = options.filter((o) => o.kind === kind);
    if (opts.length === 0) return '';
    return `<optgroup label="${label}">${opts
      .map(
        (o) =>
          `<option value="${escapeAttr(o.value)}"${r.filamentFilter === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
      )
      .join('')}</optgroup>`;
  };
  // Replacing a select's options leaves the select itself — and its focus — in place.
  select.innerHTML = `<option value="ALL"${r.filamentFilter === 'ALL' ? ' selected' : ''}>All filaments</option>${group('Filament Types', 'type')}${group('Canvas Slots', 'tray')}`;
  select.value = r.filamentFilter;
}

/** Enable the density control only for a single-material selection, and say so otherwise. */
function updateDensityAvailability(): void {
  const r = getPrefs();
  const scope = resolveDensityScope(
    visibleReports,
    filterFromPrefs(r),
    requestedDensityOverride(r),
  );
  const allowed = scope.material != null;
  const mode = byId<HTMLSelectElement>('sr-density-mode');
  const custom = byId<HTMLInputElement>('sr-custom-density');
  if (mode) mode.disabled = !allowed;
  if (custom) custom.disabled = !allowed;
  setText(
    'sr-density-note',
    allowed
      ? `Recomputes grams from extruded length for ${scope.material} (1.75 mm)`
      : 'Pick one filament type, or a slot that held one material, to override density. Mixed materials use the recorded grams.',
  );
}

function updateSummaryOnly(): void {
  const summary = currentSummary();

  const usedParts = [`${summary.usedMeters.toFixed(1)} m`];
  if (summary.canceledCount > 0) usedParts.push(`${summary.canceledGrams.toFixed(1)}g cancelled`);
  setText('sr-used-grams', `${summary.usedGrams.toFixed(1)}g`);
  setText('sr-used-sub', usedParts.join(' · '));

  const leftEl = byId('sr-left-grams');
  if (leftEl) {
    leftEl.textContent = `${(summary.rawRemainingGrams < 0 ? summary.rawRemainingGrams : summary.remainingGrams).toFixed(1)}g`;
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
  setText(
    'sr-left-sub',
    summary.rawRemainingGrams < 0
      ? 'exceeds spool size'
      : `${summary.remainingMeters.toFixed(1)} m · ${summary.percentRemaining.toFixed(0)}%`,
  );

  const checkEl = byId('sr-check-val');
  if (checkEl) {
    checkEl.classList.remove('sr-status-ok', 'sr-status-danger', 'sr-status-warn');
    if (summary.hasEnoughForPlanned === null) {
      checkEl.textContent = '—';
      setText('sr-check-sub', 'next print check');
    } else if (summary.hasEnoughForPlanned) {
      checkEl.textContent = `Enough (+${summary.afterPlannedGrams.toFixed(1)}g)`;
      checkEl.classList.add('sr-status-ok');
      setText('sr-check-sub', `after ${summary.plannedPrintGrams.toFixed(1)}g print`);
    } else {
      checkEl.textContent = `Short (${summary.afterPlannedGrams.toFixed(1)}g)`;
      checkEl.classList.add('sr-status-danger');
      setText('sr-check-sub', `need ${summary.plannedPrintGrams.toFixed(1)}g`);
    }
  }

  setText('sr-selected-count', `${summary.selectedCount} / ${visibleReports.length}`);
  const pieces: string[] = [];
  if (summary.completedCount > 0) pieces.push(`${summary.completedCount} done`);
  if (summary.canceledCount > 0) pieces.push(`${summary.canceledCount} cancelled`);
  if (summary.activeIncluded) pieces.push('1 active');
  setText('sr-selected-sub', pieces.length > 0 ? pieces.join(' · ') : 'prints selected');
}

/** Re-render the result: the list and the tiles. Never touches `#sr-controls`. */
function renderResults(): void {
  const listEl = byId('sr-list');
  if (!listEl) return;
  const r = getPrefs();
  const filter = filterFromPrefs(r);
  visibleReports = filterRetroPrints(allReports, filter);
  const scope = resolveDensityScope(visibleReports, filter, requestedDensityOverride(r));
  updateDensityAvailability();

  if (allReports.length === 0 || visibleReports.length === 0) {
    listEl.innerHTML =
      allReports.length === 0
        ? '<div class="file-empty">No print reports recorded yet. Reports are saved automatically as prints complete or stop.</div>'
        : '<div class="file-empty">No prints match the current filament, date and outcome filters.</div>';
    updateSummaryOnly();
    return;
  }

  listEl.innerHTML = visibleReports
    .map((item) => {
      const checked = !excludedIds.has(item.id);
      const usage = getPrintMatchedUsage(
        item,
        filter.filamentFilter,
        scope.override,
        filter.includeMonoPurge,
      );
      const manual = r.manualGramsOverrides[item.id];
      const hasOverride = manual != null;
      const displayGrams = hasOverride ? manual : usage.grams;
      const outcome = classifyOutcome(item);
      const outcomeLabel =
        outcome === 'completed' ? 'completed' : `${outcome} · ${item.progressAtEnd}%`;
      const outcomeClass = {
        completed: 'success',
        printing: 'accent',
        stopped: 'warning',
        failed: 'danger',
      }[outcome];
      const chips = usage.entries
        .map(
          (e) =>
            `<span class="sr-filament-chip"><span class="sr-swatch" style="background:${escapeAttr(e.color || '#888888')}"></span>${escapeHtml(e.filamentType || '?')}</span>`,
        )
        .join('');
      const id = escapeAttr(item.id);
      return `
        <div class="sr-row${checked ? '' : ' sr-row-unchecked'}" data-id="${id}">
          <label class="sr-row-check">
            <input type="checkbox" class="sr-check" data-id="${id}"${checked ? ' checked' : ''} aria-label="Count ${escapeAttr(item.filename)}">
          </label>
          <div class="sr-row-info">
            <div class="sr-row-title" title="${escapeAttr(item.filename)}">${escapeHtml(item.filename)}</div>
            <div class="sr-row-meta">
              <span>${escapeHtml(formatShortDate(item.startedAt))}</span>
              <span>· ${escapeHtml(formatTime(item.duration))}</span>
              <span class="sr-outcome-badge sr-outcome-${outcomeClass}">${escapeHtml(outcomeLabel)}</span>
              ${chips}
            </div>
          </div>
          <div class="sr-row-usage">
            <span class="sr-meters">${usage.meters.toFixed(1)} m</span>
            <div class="sr-grams-edit">
              <input type="number" class="sr-grams-input${hasOverride ? ' sr-overridden' : ''}" data-id="${id}" value="${displayGrams.toFixed(1)}" min="0" max="10000" step="0.1" title="Actual grams used (editable override)" aria-label="Grams used by ${escapeAttr(item.filename)}">
              <span class="input-unit">g</span>
              ${hasOverride ? `<button type="button" class="btn btn-sm btn-ghost sr-clear-override" data-id="${id}" title="Reset to the recorded value">×</button>` : ''}
            </div>
          </div>
        </div>`;
    })
    .join('');

  updateSummaryOnly();
}

async function fetchReports(): Promise<void> {
  try {
    const res = await fetchTimeout('/api/reports');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allReports = normaliseReportsPayload((await res.json()) as ReportsApiResponse);
    populateFilamentSelect();
    renderResults();
  } catch {
    const listEl = byId('sr-list');
    if (listEl)
      listEl.innerHTML =
        '<div class="file-empty">Unable to load print reports from the service.</div>';
  }
}

/** Bind the static controls. Runs once per mount, against elements nothing re-renders. */
function bindControls(root: HTMLElement, host: SpoolRetroHost): void {
  const r = getPrefs();
  const onChange = (rerender: boolean) => {
    persist();
    if (rerender) renderResults();
    else updateSummaryOnly();
  };

  const startEl = byId<HTMLInputElement>('sr-start-grams');
  startEl?.addEventListener('input', () => {
    const val = parseFloat(startEl.value);
    if (!Number.isNaN(val) && val >= 0) {
      r.startingSpoolGrams = val;
      onChange(false);
    }
  });
  root.querySelectorAll<HTMLElement>('.sr-spool-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const grams = parseFloat(btn.dataset.grams ?? '0');
      if (grams > 0) {
        r.startingSpoolGrams = grams;
        if (startEl) startEl.value = String(grams);
        onChange(false);
      }
    });
  });

  const modeEl = byId<HTMLSelectElement>('sr-density-mode');
  const customWrap = byId('sr-custom-density-wrap');
  const customEl = byId<HTMLInputElement>('sr-custom-density');
  modeEl?.addEventListener('change', () => {
    r.densityMode = modeEl.value;
    customWrap?.classList.toggle('hidden', r.densityMode !== 'custom');
    onChange(true);
  });
  customEl?.addEventListener('input', () => {
    const val = parseFloat(customEl.value);
    if (!Number.isNaN(val) && val > 0) {
      r.customDensity = val;
      onChange(true);
    }
  });

  const plannedEl = byId<HTMLInputElement>('sr-planned-grams');
  plannedEl?.addEventListener('input', () => {
    const val = parseFloat(plannedEl.value);
    r.plannedPrintGrams = !Number.isNaN(val) && val >= 0 ? val : 0;
    onChange(false);
  });
  const useActive = byId<HTMLButtonElement>('sr-use-active');
  useActive?.addEventListener('click', () => {
    const grams = parseFloat(useActive.dataset.grams ?? '0');
    if (grams > 0) {
      r.plannedPrintGrams = grams;
      if (plannedEl) plannedEl.value = grams.toFixed(1);
      onChange(false);
    }
  });

  const filamentEl = byId<HTMLSelectElement>('sr-filament');
  filamentEl?.addEventListener('change', () => {
    r.filamentFilter = filamentEl.value;
    onChange(true);
  });

  const sinceEl = byId<HTMLInputElement>('sr-since');
  sinceEl?.addEventListener('change', () => {
    r.sinceValue = sinceEl.value;
    onChange(true);
  });
  root.querySelectorAll<HTMLElement>('.sr-date-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.dataset.days ?? '0', 10);
      r.sinceValue = days > 0 ? toDatetimeLocalValue(Date.now() - days * 86_400_000) : '';
      if (sinceEl) sinceEl.value = r.sinceValue;
      onChange(true);
    });
  });

  const toggles: Array<[string, keyof RetroPrefs]> = [
    ['sr-inc-completed', 'includeCompleted'],
    ['sr-inc-failed', 'includeFailed'],
    ['sr-inc-stopped', 'includeStopped'],
    ['sr-inc-active', 'includeActive'],
    ['sr-inc-mono', 'includeMonoPurge'],
    ['sr-inc-zero', 'includeZeroUsage'],
  ];
  for (const [id, key] of toggles) {
    const el = byId<HTMLInputElement>(id);
    el?.addEventListener('change', () => {
      (r as unknown as Record<string, boolean>)[key] = el.checked;
      onChange(true);
    });
  }

  byId('sr-select-all')?.addEventListener('click', () => {
    for (const item of visibleReports) excludedIds.delete(item.id);
    renderResults();
  });
  byId('sr-select-none')?.addEventListener('click', () => {
    for (const item of visibleReports) excludedIds.add(item.id);
    renderResults();
  });
  byId('sr-reset-overrides')?.addEventListener('click', () => {
    r.manualGramsOverrides = {};
    onChange(true);
  });
  byId('sr-refresh')?.addEventListener('click', () => {
    void fetchReports();
  });

  // Row events are delegated from the list container, so a re-render needs no re-binding.
  const listEl = byId('sr-list');
  listEl?.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (!el.classList.contains('sr-check') || !el.dataset.id) return;
    if (el.checked) excludedIds.delete(el.dataset.id);
    else excludedIds.add(el.dataset.id);
    el.closest('.sr-row')?.classList.toggle('sr-row-unchecked', !el.checked);
    updateSummaryOnly();
  });
  listEl?.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (!el.classList.contains('sr-grams-input') || !el.dataset.id) return;
    const val = parseFloat(el.value);
    if (!Number.isNaN(val) && val >= 0) {
      // Summary only: re-rendering the list here would take focus out of this input.
      r.manualGramsOverrides[el.dataset.id] = val;
      el.classList.add('sr-overridden');
      onChange(false);
    }
  });
  listEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.sr-clear-override');
    if (!btn?.dataset.id) return;
    delete r.manualGramsOverrides[btn.dataset.id];
    onChange(true);
  });

  byId('sr-apply')?.addEventListener('click', () => {
    const summary = currentSummary();
    const scope = resolveDensityScope(visibleReports, filterFromPrefs(r), null);
    const material = scope.material && scope.material in FILAMENT_DENSITY ? scope.material : null;
    const refused = host.apply({
      netFullGrams: r.startingSpoolGrams,
      remainingGrams: summary.rawRemainingGrams,
      material,
    });
    const status = byId('sr-apply-status');
    if (status) {
      status.classList.toggle('sr-status-danger', refused != null);
      status.classList.toggle('sr-status-ok', refused == null);
      status.textContent =
        refused == null
          ? `Applied ${summary.remainingGrams.toFixed(0)}g remaining (${summary.percentRemaining.toFixed(0)}%) to the Spool Calculator.`
          : `Not applied: ${refused} Nothing was saved.`;
    }
  });
}

/**
 * Mount the estimator into `root`. Builds the skeleton and binds the controls once, then
 * fetches the reports; later updates touch only the results.
 */
export function mountSpoolRetro(root: HTMLElement, host: SpoolRetroHost): Promise<void> {
  root.innerHTML = skeletonHtml(getPrefs());
  bindControls(root, host);
  populateFilamentSelect();
  if (allReports.length > 0) {
    // A re-visit: show the last results at once while the fresh fetch runs.
    renderResults();
  } else {
    updateDensityAvailability();
    updateSummaryOnly();
  }
  return fetchReports();
}
