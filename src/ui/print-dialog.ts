/**
 * Print start confirmation dialog with filament-to-Canvas slot mapping.
 *
 * Flow:
 * 1. Request file detail (method 1046) to get color_map, thumbnail, metadata
 * 2. Auto-map gcode colors to Canvas trays (exact color match, then closest match)
 * 3. User can reassign mappings via dropdown
 * 4. On confirm: send method 1020 with slot_map
 */

import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import type { CanvasInfo, CanvasTray } from '../types';
import { escapeHtml, escapeAttr, formatTime, applyDarkThumbnailCheck } from './helpers';
import { toast } from './toast';
import { currentFileSource } from './files';

/** Pending dialog state while waiting for 1046 response */
let pendingPrint: { filename: string; fullPath: string; client: CommandSender; state: PrinterState } | null = null;

/** Each color from the gcode mapped to a Canvas tray */
interface ColorMapping {
  /** Index in color_map (the 't' field) */
  t: number;
  /** Gcode filament color hex */
  gcodeColor: string;
  /** Gcode filament type name */
  gcodeType: string;
  /** Mapped Canvas unit & tray (-1 if unmapped) */
  canvasId: number;
  trayId: number;
  /** Mapped tray color */
  mappedColor: string;
  /** Mapped tray filament type */
  mappedType: string;
}

/** All available Canvas trays flattened */
interface FlatTray {
  canvasId: number;
  tray: CanvasTray;
}

/**
 * Called from files.ts when user clicks Print.
 * Requests file detail (1046) and waits for the response to show the dialog.
 */
export function requestPrintDialog(
  filename: string,
  fullPath: string,
  client: CommandSender,
  state: PrinterState,
): void {
  pendingPrint = { filename, fullPath, client, state };
  // Request file detail to get color_map + thumbnail + metadata
  client.sendCommand(1046, { storage_media: currentFileSource(), filename: fullPath });
}

/**
 * Called from main.ts when method 1046 response arrives.
 * If we have a pending print dialog, show it now.
 */
export function handleFileDetailForPrint(state: PrinterState): void {
  if (!pendingPrint) return;
  const { filename, fullPath, client } = pendingPrint;
  pendingPrint = null;
  showDialog(filename, fullPath, state, client);
}

/** Compute color distance (simple Euclidean in RGB space) */
function colorDistance(hex1: string, hex2: string): number {
  const parse = (h: string) => {
    const c = h.replace('#', '');
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
  };
  try {
    const [r1, g1, b1] = parse(hex1);
    const [r2, g2, b2] = parse(hex2);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  } catch {
    return Infinity;
  }
}

/** Contrast color for text on a given background */
function contrastColor(hex: string): string {
  try {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    // Relative luminance
    return (r * 0.299 + g * 0.587 + b * 0.114) > 128 ? '#000' : '#fff';
  } catch {
    return '#fff';
  }
}

/** Get all available (non-empty) Canvas trays */
function getAvailableTrays(canvas: CanvasInfo | null): FlatTray[] {
  if (!canvas?.canvas_list?.length) return [];
  const trays: FlatTray[] = [];
  for (const unit of canvas.canvas_list) {
    if (!unit.connected) continue;
    for (const tray of unit.tray_list) {
      if (tray.status !== 0) { // not empty
        trays.push({ canvasId: unit.canvas_id, tray });
      }
    }
  }
  return trays;
}

/** Auto-map gcode colors to Canvas trays */
function autoMap(
  colorMap: Array<{ t: number; color: string; name: string }>,
  canvas: CanvasInfo | null,
): ColorMapping[] {
  const trays = getAvailableTrays(canvas);
  const usedTrays = new Set<string>(); // "canvasId:trayId"

  return colorMap.map(cm => {
    const mapping: ColorMapping = {
      t: cm.t,
      gcodeColor: cm.color.startsWith('#') ? cm.color : `#${cm.color}`,
      gcodeType: cm.name || 'Unknown',
      canvasId: -1,
      trayId: -1,
      mappedColor: '',
      mappedType: '',
    };

    // Try exact color match first (case-insensitive), preferring same filament type
    let bestMatch: FlatTray | null = null;
    let bestDist = Infinity;

    for (const ft of trays) {
      const key = `${ft.canvasId}:${ft.tray.tray_id}`;
      if (usedTrays.has(key)) continue;

      const trayColor = ft.tray.filament_color.startsWith('#')
        ? ft.tray.filament_color
        : `#${ft.tray.filament_color}`;
      const dist = colorDistance(mapping.gcodeColor, trayColor);

      // Penalize type mismatch
      const typeMatch = ft.tray.filament_type.toUpperCase() === mapping.gcodeType.toUpperCase();
      const adjustedDist = typeMatch ? dist : dist + 100;

      if (adjustedDist < bestDist) {
        bestDist = adjustedDist;
        bestMatch = ft;
      }
    }

    if (bestMatch && bestDist < 200) { // threshold: allow reasonable matches
      const key = `${bestMatch.canvasId}:${bestMatch.tray.tray_id}`;
      usedTrays.add(key);
      mapping.canvasId = bestMatch.canvasId;
      mapping.trayId = bestMatch.tray.tray_id;
      mapping.mappedColor = bestMatch.tray.filament_color.startsWith('#')
        ? bestMatch.tray.filament_color
        : `#${bestMatch.tray.filament_color}`;
      mapping.mappedType = bestMatch.tray.filament_type;
    }

    return mapping;
  });
}

/** Show the print confirmation dialog */
function showDialog(
  filename: string,
  fullPath: string,
  state: PrinterState,
  client: CommandSender,
): void {
  // Remove any existing dialog
  document.getElementById('print-dialog-overlay')?.remove();

  const canvas = state.canvas;
  const hasCanvas = !!(canvas?.canvas_list?.length);
  const colorMap = state.colorMap;
  const isMultiColor = hasCanvas && colorMap.length > 0;
  const detail = state.lastFileDetail;
  const trays = getAvailableTrays(canvas);

  // Auto-map colors to Canvas trays
  let mappings = isMultiColor ? autoMap(colorMap, canvas) : [];

  // Build dialog HTML
  const overlay = document.createElement('div');
  overlay.id = 'print-dialog-overlay';
  overlay.className = 'print-dialog-overlay';

  const timeStr = detail?.print_time ? formatTime(detail.print_time) : '';
  const layerStr = detail?.layer ? `${detail.layer} layers` : '';
  const filamentStr = state.fileFilamentUsed ? `${state.fileFilamentUsed.toFixed(1)}g` : '';
  const metaParts = [timeStr, layerStr, filamentStr].filter(Boolean);

  let mappingHtml = '';
  if (isMultiColor) {
    mappingHtml = `
      <div class="print-dialog-section">
        <div class="print-dialog-section-title">Filament Mapping</div>
        <div class="print-dialog-mappings" id="print-dialog-mappings">
          ${renderMappings(mappings, trays)}
        </div>
      </div>`;
  }

  overlay.innerHTML = `
    <div class="print-dialog">
      <div class="print-dialog-header">
        <span>Start Print</span>
        <button class="print-dialog-close" id="print-dialog-cancel-x">&times;</button>
      </div>
      <div class="print-dialog-body">
        <div class="print-dialog-file-info">
          <div class="print-dialog-thumbnail" id="print-dialog-thumb">
            ${detail?.thumbnail
              ? `<img src="data:image/png;base64,${detail.thumbnail}" alt="Preview" id="print-dialog-thumb-img">`
              : '<div class="print-dialog-no-thumb">No preview</div>'}
          </div>
          <div class="print-dialog-meta">
            <div class="print-dialog-filename">${escapeHtml(filename)}</div>
            ${metaParts.length ? `<div class="print-dialog-meta-row">${metaParts.map(p => `<span>${escapeHtml(p)}</span>`).join(' · ')}</div>` : ''}
          </div>
        </div>
        ${mappingHtml}
        <div class="print-dialog-section">
          <div class="print-dialog-section-title">Print Settings</div>
          <div class="print-dialog-settings">
            <div class="print-dialog-setting">
              <label>Build Plate</label>
              <div class="print-dialog-radio-group">
                <label class="print-dialog-radio"><input type="radio" name="print-bed" value="A" checked><span>Textured (A)</span></label>
                <label class="print-dialog-radio"><input type="radio" name="print-bed" value="B"><span>Smooth (B)</span></label>
              </div>
            </div>
            <div class="print-dialog-checkboxes">
              <label class="print-dialog-checkbox"><input type="checkbox" id="print-opt-leveling" checked><span>Bed Leveling</span></label>
              <label class="print-dialog-checkbox"><input type="checkbox" id="print-opt-timelapse"><span>Timelapse</span></label>
            </div>
          </div>
        </div>
      </div>
      <div class="print-dialog-footer">
        <button class="btn btn-ghost" id="print-dialog-cancel">Cancel</button>
        <button class="btn btn-primary" id="print-dialog-confirm">▶ Print</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Apply dark thumbnail check
  const thumbImg = document.getElementById('print-dialog-thumb-img') as HTMLImageElement | null;
  const thumbContainer = document.getElementById('print-dialog-thumb') as HTMLElement | null;
  if (thumbImg && thumbContainer) {
    applyDarkThumbnailCheck(thumbImg, thumbContainer);
  }

  // Bind mapping dropdowns
  if (isMultiColor) {
    bindMappingDropdowns(mappings, trays);
  }

  // Close handlers
  const close = () => overlay.remove();
  document.getElementById('print-dialog-cancel')!.addEventListener('click', close);
  document.getElementById('print-dialog-cancel-x')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Confirm handler
  document.getElementById('print-dialog-confirm')!.addEventListener('click', () => {
    // Check all colors are mapped if multi-color
    if (isMultiColor) {
      const unmapped = mappings.filter(m => m.trayId === -1);
      if (unmapped.length > 0) {
        toast(`${unmapped.length} color(s) not mapped to Canvas trays`, 'error');
        return;
      }
    }

    const bedType = (overlay.querySelector('input[name="print-bed"]:checked') as HTMLInputElement)?.value || 'A';
    const leveling = (document.getElementById('print-opt-leveling') as HTMLInputElement).checked;
    const timelapse = (document.getElementById('print-opt-timelapse') as HTMLInputElement).checked;

    const slotMap = isMultiColor
      ? mappings.map(m => ({ t: m.t, canvas_id: m.canvasId, tray_id: m.trayId }))
      : [];

    client.sendCommand(1020, {
      storage_media: currentFileSource(),
      filename: fullPath,
      config: {
        delay_video: timelapse,
        printer_check: leveling,
        print_layout: bedType,
        bedlevel_force: false,
        slot_map: slotMap,
      },
    });

    close();
    toast(`Starting print: ${filename}`, 'success');
  });
}

/** Render the filament mapping rows */
function renderMappings(mappings: ColorMapping[], trays: FlatTray[]): string {
  return mappings.map((m, idx) => {
    const gcColor = m.gcodeColor;
    const gcContrast = contrastColor(gcColor);
    const mapped = m.trayId !== -1;
    const mapColor = mapped ? m.mappedColor : '#555';
    const mapContrast = mapped ? contrastColor(mapColor) : '#aaa';

    // Build tray options for dropdown
    const options = trays.map(ft => {
      const tc = ft.tray.filament_color.startsWith('#') ? ft.tray.filament_color : `#${ft.tray.filament_color}`;
      const selected = ft.canvasId === m.canvasId && ft.tray.tray_id === m.trayId;
      return `<option value="${ft.canvasId}:${ft.tray.tray_id}" ${selected ? 'selected' : ''} data-color="${escapeAttr(tc)}">${ft.tray.filament_type} (C${ft.canvasId + 1}:T${ft.tray.tray_id + 1})</option>`;
    }).join('');

    return `
      <div class="print-mapping-row" data-idx="${idx}">
        <div class="print-mapping-gcode" style="background:${escapeAttr(gcColor)};color:${gcContrast}">
          ${escapeHtml(m.gcodeType)}
        </div>
        <div class="print-mapping-arrow">→</div>
        <div class="print-mapping-tray">
          <select class="print-mapping-select" data-idx="${idx}" style="background:${escapeAttr(mapColor)};color:${mapContrast}">
            <option value="-1:-1" ${!mapped ? 'selected' : ''}>-- Select tray --</option>
            ${options}
          </select>
        </div>
      </div>`;
  }).join('');
}

/** Bind change events on mapping dropdowns */
function bindMappingDropdowns(mappings: ColorMapping[], trays: FlatTray[]): void {
  const container = document.getElementById('print-dialog-mappings');
  if (!container) return;

  container.querySelectorAll('.print-mapping-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const select = sel as HTMLSelectElement;
      const idx = parseInt(select.dataset.idx ?? '-1');
      if (idx < 0 || idx >= mappings.length) return;

      const [canvasStr, trayStr] = select.value.split(':');
      const canvasId = parseInt(canvasStr);
      const trayId = parseInt(trayStr);

      if (canvasId === -1) {
        mappings[idx].canvasId = -1;
        mappings[idx].trayId = -1;
        mappings[idx].mappedColor = '';
        mappings[idx].mappedType = '';
      } else {
        const ft = trays.find(t => t.canvasId === canvasId && t.tray.tray_id === trayId);
        if (ft) {
          mappings[idx].canvasId = canvasId;
          mappings[idx].trayId = trayId;
          mappings[idx].mappedColor = ft.tray.filament_color.startsWith('#')
            ? ft.tray.filament_color : `#${ft.tray.filament_color}`;
          mappings[idx].mappedType = ft.tray.filament_type;
        }
      }

      // Update select styling
      const color = mappings[idx].mappedColor || '#555';
      select.style.background = color;
      select.style.color = contrastColor(color);
    });
  });
}
