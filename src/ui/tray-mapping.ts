/**
 * The pure half of the print dialog's Canvas tray logic — no DOM, so a test can import it
 * without dragging in print-dialog.ts and the modules that bind document listeners on load.
 */

import type { CanvasInfo, CanvasTray } from '../types';

/** All available Canvas trays flattened */
export interface FlatTray {
  canvasId: number;
  tray: CanvasTray;
}

/** Get all available (non-empty) Canvas trays on connected units */
export function getAvailableTrays(canvas: CanvasInfo | null): FlatTray[] {
  if (!canvas?.canvas_list?.length) return [];
  const trays: FlatTray[] = [];
  for (const unit of canvas.canvas_list) {
    if (!unit.connected) continue;
    for (const tray of unit.tray_list) {
      if (tray.status !== 0) {
        // not empty
        trays.push({ canvasId: unit.canvas_id, tray });
      }
    }
  }
  return trays;
}

/**
 * Whether starting this file needs a gcode-colour → Canvas tray mapping.
 *
 * Only when there is a tray to map to. A printer can report a `canvas_list` whose
 * unit is disconnected, or connected with every tray empty, while printing from
 * filament loaded straight into the toolhead — keying this on `canvas_list.length`
 * left every colour unmappable and refused ▶ Print outright (ELEG-113).
 */
export function needsTrayMapping(canvas: CanvasInfo | null, colorMapLength: number): boolean {
  return colorMapLength > 0 && getAvailableTrays(canvas).length > 0;
}
