/** Filament editing modal for Canvas/AMS tray info */

import type { CommandSender } from '../ws-client';
import { $, escapeHtml, escapeAttr } from './helpers';
import { toast } from './toast';

/**
 * Predefined filament database — matches the official Elegoo web UI exactly.
 * Each entry has a type (material family), name (specific variant), hex code,
 * temperature range, and availability flags for ELEGOO / Generic brands.
 */
interface FilamentDef {
  type: string;
  name: string;
  code: string;
  temperature: { min: number; max: number };
  elegoo: boolean;
  generic: boolean;
}

const FILAMENT_DB: Record<string, FilamentDef> = {
  'PLA':             { type: 'PLA',  name: 'PLA',             code: '0x0000', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA+':            { type: 'PLA',  name: 'PLA+',            code: '0x0001', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA PRO':         { type: 'PLA',  name: 'PLA PRO',         code: '0x0002', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA Silk':        { type: 'PLA',  name: 'PLA Silk',        code: '0x0003', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA-CF':          { type: 'PLA',  name: 'PLA-CF',          code: '0x0004', temperature: { min: 210, max: 240 }, elegoo: true,  generic: true  },
  'PLA Carbon':      { type: 'PLA',  name: 'PLA Carbon',      code: '0x0005', temperature: { min: 190, max: 230 }, elegoo: false, generic: true  },
  'PLA Matte':       { type: 'PLA',  name: 'PLA Matte',       code: '0x0006', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA Fluo':        { type: 'PLA',  name: 'PLA Fluo',        code: '0x0007', temperature: { min: 190, max: 230 }, elegoo: false, generic: true  },
  'PLA Wood':        { type: 'PLA',  name: 'PLA Wood',        code: '0x0008', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA Basic':       { type: 'PLA',  name: 'PLA Basic',       code: '0x0009', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'RAPID PLA+':      { type: 'PLA',  name: 'RAPID PLA+',      code: '0x000A', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA Marble':      { type: 'PLA',  name: 'PLA Marble',      code: '0x000B', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA Galaxy':      { type: 'PLA',  name: 'PLA Galaxy',      code: '0x000C', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA Red Copper':  { type: 'PLA',  name: 'PLA Red Copper',  code: '0x000D', temperature: { min: 190, max: 230 }, elegoo: true,  generic: true  },
  'PLA Sparkle':     { type: 'PLA',  name: 'PLA Sparkle',     code: '0x000E', temperature: { min: 190, max: 230 }, elegoo: false, generic: true  },
  'PETG':            { type: 'PETG', name: 'PETG',            code: '0x0100', temperature: { min: 230, max: 260 }, elegoo: true,  generic: true  },
  'PETG-CF':         { type: 'PETG', name: 'PETG-CF',         code: '0x0101', temperature: { min: 240, max: 270 }, elegoo: true,  generic: true  },
  'PETG-GF':         { type: 'PETG', name: 'PETG-GF',         code: '0x0102', temperature: { min: 240, max: 270 }, elegoo: true,  generic: true  },
  'PETG PRO':        { type: 'PETG', name: 'PETG PRO',        code: '0x0103', temperature: { min: 230, max: 260 }, elegoo: true,  generic: true  },
  'PETG Translucent':{ type: 'PETG', name: 'PETG Translucent',code: '0x0104', temperature: { min: 230, max: 260 }, elegoo: true,  generic: true  },
  'RAPID PETG':      { type: 'PETG', name: 'RAPID PETG',      code: '0x0105', temperature: { min: 230, max: 260 }, elegoo: true,  generic: true  },
  'ABS':             { type: 'ABS',  name: 'ABS',             code: '0x0200', temperature: { min: 240, max: 280 }, elegoo: true,  generic: true  },
  'ABS-GF':          { type: 'ABS',  name: 'ABS-GF',          code: '0x0201', temperature: { min: 240, max: 280 }, elegoo: false, generic: true  },
  'TPU':             { type: 'TPU',  name: 'TPU',             code: '0x0300', temperature: { min: 220, max: 240 }, elegoo: false, generic: true  },
  'TPU 95A':         { type: 'TPU',  name: 'TPU 95A',         code: '0x0301', temperature: { min: 220, max: 240 }, elegoo: true,  generic: true  },
  'RAPID TPU 95A':   { type: 'TPU',  name: 'RAPID TPU 95A',   code: '0x0302', temperature: { min: 220, max: 240 }, elegoo: true,  generic: true  },
  'PA':              { type: 'PA',   name: 'PA',              code: '0x0400', temperature: { min: 260, max: 290 }, elegoo: false, generic: true  },
  'PA-CF':           { type: 'PA',   name: 'PA-CF',           code: '0x0401', temperature: { min: 260, max: 300 }, elegoo: false, generic: true  },
  'PAHT-CF':         { type: 'PA',   name: 'PAHT-CF',         code: '0x0402', temperature: { min: 280, max: 320 }, elegoo: true,  generic: true  },
  'PA6':             { type: 'PA',   name: 'PA6',             code: '0x0403', temperature: { min: 260, max: 290 }, elegoo: false, generic: true  },
  'PA6-CF':          { type: 'PA',   name: 'PA6-CF',          code: '0x0404', temperature: { min: 270, max: 310 }, elegoo: false, generic: true  },
  'PA12':            { type: 'PA',   name: 'PA12',            code: '0x0405', temperature: { min: 240, max: 270 }, elegoo: false, generic: true  },
  'PA12-CF':         { type: 'PA',   name: 'PA12-CF',         code: '0x0406', temperature: { min: 260, max: 290 }, elegoo: false, generic: true  },
  'CPE':             { type: 'CPE',  name: 'CPE',             code: '0x0500', temperature: { min: 220, max: 250 }, elegoo: false, generic: true  },
  'PC':              { type: 'PC',   name: 'PC',              code: '0x0600', temperature: { min: 260, max: 290 }, elegoo: true,  generic: true  },
  'PCTG':            { type: 'PC',   name: 'PCTG',            code: '0x0601', temperature: { min: 260, max: 290 }, elegoo: false, generic: true  },
  'PC-FR':           { type: 'PC',   name: 'PC-FR',           code: '0x0602', temperature: { min: 260, max: 290 }, elegoo: true,  generic: true  },
  'PVA':             { type: 'PVA',  name: 'PVA',             code: '0x0700', temperature: { min: 180, max: 210 }, elegoo: false, generic: true  },
  'ASA':             { type: 'ASA',  name: 'ASA',             code: '0x0800', temperature: { min: 240, max: 280 }, elegoo: true,  generic: true  },
  'BVOH':            { type: 'BVOH', name: 'BVOH',            code: '0x0900', temperature: { min: 190, max: 210 }, elegoo: false, generic: true  },
  'EVA':             { type: 'EVA',  name: 'EVA',             code: '0x0A00', temperature: { min: 180, max: 220 }, elegoo: false, generic: true  },
  'HIPS':            { type: 'HIPS', name: 'HIPS',            code: '0x0B00', temperature: { min: 220, max: 250 }, elegoo: false, generic: true  },
  'PP':              { type: 'PP',   name: 'PP',              code: '0x0C00', temperature: { min: 210, max: 250 }, elegoo: false, generic: true  },
  'PP-CF':           { type: 'PP',   name: 'PP-CF',           code: '0x0C01', temperature: { min: 220, max: 260 }, elegoo: false, generic: true  },
  'PP-GF':           { type: 'PP',   name: 'PP-GF',           code: '0x0C02', temperature: { min: 230, max: 250 }, elegoo: false, generic: true  },
  'PPA':             { type: 'PPA',  name: 'PPA',             code: '0x0D00', temperature: { min: 290, max: 310 }, elegoo: false, generic: true  },
  'PPA-CF':          { type: 'PPA',  name: 'PPA-CF',          code: '0x0D01', temperature: { min: 300, max: 320 }, elegoo: false, generic: true  },
  'PPA-GF':          { type: 'PPA',  name: 'PPA-GF',          code: '0x0D02', temperature: { min: 290, max: 310 }, elegoo: false, generic: true  },
  'PPS':             { type: 'PPS',  name: 'PPS',             code: '0x0E00', temperature: { min: 330, max: 340 }, elegoo: false, generic: true  },
  'PPS-CF':          { type: 'PPS',  name: 'PPS-CF',          code: '0x0E01', temperature: { min: 340, max: 360 }, elegoo: false, generic: true  },
};

/** Get unique material type families */
function getTypeList(): string[] {
  return [...new Set(Object.values(FILAMENT_DB).map(f => f.type))];
}

/** Get filament names filtered by brand and optionally by type family */
function getFilteredNames(brand: string, typeFilter?: string): string[] {
  return Object.values(FILAMENT_DB)
    .filter(f => {
      if (brand === 'ELEGOO' && !f.elegoo) return false;
      if (brand === 'Generic' && !f.generic) return false;
      if (typeFilter && f.type !== typeFilter) return false;
      return true;
    })
    .map(f => f.name);
}

const PRESET_COLORS = [
  '#FFFFFF', '#FFF242', '#DBF47A', '#09CC3A', '#077747', '#0B6283',
  '#0BE2A0', '#74D9F3', '#48A7FA', '#2850DF', '#433089', '#A03BF7',
  '#F32FF8', '#D4B1DD', '#F95D77', '#F72221', '#7C4C00', '#F88D36',
  '#FCEBD7', '#D2C5A3', '#AF7832', '#898989', '#BCBCBC', '#000000',
];

let modalEl: HTMLElement | null = null;

function buildModal(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'filament-modal';
  el.className = 'modal-overlay hidden';
  el.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Edit Filament — Slot <span id="fm-slot"></span></h3>
        <button class="btn btn-sm btn-ghost modal-close" id="fm-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="fm-brand">Brand</label>
          <select id="fm-brand" class="log-select">
            <option value="ELEGOO">ELEGOO</option>
            <option value="Generic">Generic</option>
          </select>
        </div>
        <div class="form-group">
          <label for="fm-type">Type Filter</label>
          <select id="fm-type" class="log-select">
            <option value="">All</option>
          </select>
        </div>
        <div class="form-group">
          <label for="fm-name">Filament</label>
          <select id="fm-name" class="log-select"></select>
        </div>
        <div class="form-group">
          <label>Nozzle Temp</label>
          <div id="fm-temp-info" class="fm-temp-info">—</div>
        </div>
        <div class="form-group">
          <label for="fm-color">Color</label>
          <div class="fm-color-row">
            <input type="color" id="fm-color" value="#ffffff">
            <div id="fm-presets" class="fm-color-presets"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="fm-cancel">Cancel</button>
        <button class="btn btn-primary" id="fm-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  el.querySelector('#fm-close')!.addEventListener('click', closeModal);
  el.querySelector('#fm-cancel')!.addEventListener('click', closeModal);
  el.addEventListener('click', (e) => { if (e.target === el) closeModal(); });

  // Wire up cascading brand → type → name selects
  el.querySelector('#fm-brand')!.addEventListener('change', () => {
    populateTypeFilter();
    populateNameSelect();
    updateTempDisplay();
  });
  el.querySelector('#fm-type')!.addEventListener('change', () => {
    populateNameSelect();
    updateTempDisplay();
  });
  el.querySelector('#fm-name')!.addEventListener('change', updateTempDisplay);

  // Build preset color swatches
  const presetsEl = el.querySelector('#fm-presets')!;
  for (const c of PRESET_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'fm-swatch';
    swatch.style.background = c;
    swatch.dataset.color = c;
    swatch.addEventListener('click', () => {
      (el.querySelector('#fm-color') as HTMLInputElement).value = c.toLowerCase();
    });
    presetsEl.appendChild(swatch);
  }

  return el;
}

function populateTypeFilter(): void {
  const typeSelect = document.querySelector('#fm-type') as HTMLSelectElement;
  const currentType = typeSelect.value;
  const types = getTypeList();
  typeSelect.innerHTML = `<option value="">All</option>` +
    types.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');
  if (types.includes(currentType)) typeSelect.value = currentType;
}

function populateNameSelect(selectName?: string): void {
  const brand = (document.querySelector('#fm-brand') as HTMLSelectElement).value;
  const typeFilter = (document.querySelector('#fm-type') as HTMLSelectElement).value || undefined;
  const nameSelect = document.querySelector('#fm-name') as HTMLSelectElement;
  const names = getFilteredNames(brand, typeFilter);
  nameSelect.innerHTML = names.map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
  if (selectName && names.includes(selectName)) {
    nameSelect.value = selectName;
  }
}

function updateTempDisplay(): void {
  const name = (document.querySelector('#fm-name') as HTMLSelectElement).value;
  const def = FILAMENT_DB[name];
  const el = document.querySelector('#fm-temp-info')!;
  if (def) {
    el.textContent = `${def.temperature.min}–${def.temperature.max}°C`;
  } else {
    el.textContent = '—';
  }
}

function ensureModal(): HTMLElement {
  if (!modalEl) modalEl = buildModal();
  return modalEl;
}

function closeModal(): void {
  modalEl?.classList.add('hidden');
}

/** Ensure color is a valid 7-char hex like #ff5733 for <input type="color"> */
function normalizeColor(raw: string): string {
  if (!raw) return '#ffffff';
  let hex = raw.trim().replace(/^#/, '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 6) hex = hex.padEnd(6, '0');
  else if (hex.length > 6) hex = hex.slice(0, 6);
  return `#${hex.toLowerCase()}`;
}

interface EditContext {
  canvasId: number;
  trayId: number;
}

let currentCtx: EditContext | null = null;

export function openFilamentEditor(
  canvasId: number,
  trayId: number,
  current: { type: string; color: string; name: string; brand: string; minTemp: number; maxTemp: number },
  client: CommandSender,
  isPrinting?: boolean,
): void {
  if (isPrinting) {
    toast('Cannot edit filament while printing', 'error');
    return;
  }
  const modal = ensureModal();
  currentCtx = { canvasId, trayId };

  document.querySelector('#fm-slot')!.textContent = `${trayId + 1}`;

  // Set brand (default ELEGOO)
  const brand = (current.brand === 'Generic') ? 'Generic' : 'ELEGOO';
  (document.querySelector('#fm-brand') as HTMLSelectElement).value = brand;

  // Populate type filter and try to match current type
  populateTypeFilter();
  const currentDef = FILAMENT_DB[current.name];
  if (currentDef) {
    (document.querySelector('#fm-type') as HTMLSelectElement).value = currentDef.type;
  } else if (current.type) {
    (document.querySelector('#fm-type') as HTMLSelectElement).value = current.type;
  }

  // Populate name list and select current
  populateNameSelect(current.name || 'PLA');

  // Set color
  (document.querySelector('#fm-color') as HTMLInputElement).value = normalizeColor(current.color);

  updateTempDisplay();

  // Rebind save to avoid stacking listeners
  const saveBtn = document.querySelector('#fm-save')!;
  const newSave = saveBtn.cloneNode(true);
  saveBtn.replaceWith(newSave);
  newSave.addEventListener('click', () => {
    if (!currentCtx) return;
    const selectedBrand = (document.querySelector('#fm-brand') as HTMLSelectElement).value;
    const selectedName = (document.querySelector('#fm-name') as HTMLSelectElement).value;
    const color = (document.querySelector('#fm-color') as HTMLInputElement).value;
    const def = FILAMENT_DB[selectedName];
    if (!def) {
      toast('Unknown filament type', 'error');
      return;
    }

    client.sendCommand(2003, {
      canvas_id: currentCtx.canvasId,
      tray_id: currentCtx.trayId,
      brand: selectedBrand,
      filament_type: def.type,
      filament_name: def.name,
      filament_code: def.code,
      filament_color: `#${color.replace('#', '').toUpperCase()}`,
      filament_min_temp: def.temperature.min,
      filament_max_temp: def.temperature.max,
    });

    closeModal();
  });

  modal.classList.remove('hidden');
}
