/** Filament editing modal for Canvas/AMS tray info */

import type { CC2MqttClient } from '../mqtt-client';
import { $, escapeHtml, escapeAttr } from './helpers';

let modalEl: HTMLElement | null = null;

const FILAMENT_TYPES = ['PLA', 'PETG', 'ABS', 'TPU', 'PA', 'ASA', 'PC', 'PVA', 'HIPS', 'Other'];

function ensureModal(): HTMLElement {
  if (modalEl) return modalEl;
  modalEl = document.createElement('div');
  modalEl.id = 'filament-modal';
  modalEl.className = 'modal-overlay hidden';
  modalEl.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Edit Filament — Slot <span id="fm-slot"></span></h3>
        <button class="btn btn-sm btn-ghost modal-close" id="fm-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="fm-type">Type</label>
          <select id="fm-type" class="log-select">
            ${FILAMENT_TYPES.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label for="fm-color">Color</label>
          <input type="color" id="fm-color" value="#ffffff">
        </div>
        <div class="form-group">
          <label for="fm-name">Name</label>
          <input type="text" id="fm-name" placeholder="e.g. Elegoo PLA+">
        </div>
        <div class="form-group">
          <label>Nozzle Temperature Range</label>
          <div class="temp-range-row">
            <input type="number" id="fm-min-temp" placeholder="190" min="0" max="350" step="5">
            <span>—</span>
            <input type="number" id="fm-max-temp" placeholder="230" min="0" max="350" step="5">
            <span>°C</span>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="fm-cancel">Cancel</button>
        <button class="btn btn-primary" id="fm-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  $('fm-close').addEventListener('click', closeModal);
  $('fm-cancel').addEventListener('click', closeModal);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeModal();
  });

  return modalEl;
}

function closeModal(): void {
  modalEl?.classList.add('hidden');
}

/** Ensure color is a valid 7-char hex like #ff5733 for <input type="color"> */
function normalizeColor(raw: string): string {
  if (!raw) return '#ffffff';
  // Strip any leading # and whitespace
  let hex = raw.trim().replace(/^#/, '');
  // Remove any non-hex chars
  hex = hex.replace(/[^0-9a-fA-F]/g, '');
  // Pad or truncate to 6 chars
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
  current: { type: string; color: string; name: string; minTemp: number; maxTemp: number },
  client: CC2MqttClient,
): void {
  const modal = ensureModal();
  currentCtx = { canvasId, trayId };

  $('fm-slot').textContent = `${trayId + 1}`;
  ($('fm-type') as HTMLSelectElement).value = current.type || 'PLA';
  // Normalize color to 7-char lowercase hex for <input type="color">
  const normalizedColor = normalizeColor(current.color);
  ($('fm-color') as HTMLInputElement).value = normalizedColor;
  ($('fm-name') as HTMLInputElement).value = current.name || '';
  ($('fm-min-temp') as HTMLInputElement).value = current.minTemp ? String(current.minTemp) : '';
  ($('fm-max-temp') as HTMLInputElement).value = current.maxTemp ? String(current.maxTemp) : '';

  // Rebind save to avoid stacking listeners
  const saveBtn = $('fm-save');
  const newSave = saveBtn.cloneNode(true);
  saveBtn.replaceWith(newSave);
  newSave.addEventListener('click', () => {
    if (!currentCtx) return;
    const type = ($('fm-type') as HTMLSelectElement).value;
    const color = ($('fm-color') as HTMLInputElement).value;
    const name = ($('fm-name') as HTMLInputElement).value;
    const minTemp = parseInt(($('fm-min-temp') as HTMLInputElement).value) || 190;
    const maxTemp = parseInt(($('fm-max-temp') as HTMLInputElement).value) || 230;

    client.sendCommand(2003, {
      canvas_id: currentCtx.canvasId,
      tray_id: currentCtx.trayId,
      filament_type: type,
      filament_color: color.replace('#', '').toUpperCase(),
      filament_name: name || type,
      min_nozzle_temp: minTemp,
      max_nozzle_temp: maxTemp,
    });

    closeModal();
    // Refresh canvas info
    client.sendCommand(2005, {});
  });

  modal.classList.remove('hidden');
}
