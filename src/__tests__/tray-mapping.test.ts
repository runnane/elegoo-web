import { describe, it, expect } from 'vitest';
import { needsTrayMapping } from '../ui/tray-mapping';
import type { CanvasInfo, CanvasTray, CanvasUnit } from '../types';

function tray(tray_id: number, status: number): CanvasTray {
  return {
    tray_id,
    brand: 'ELEGOO',
    filament_type: 'PLA',
    filament_name: 'PLA',
    filament_color: '#ffffff',
    min_nozzle_temp: 190,
    max_nozzle_temp: 230,
    status,
  };
}

function canvas(...units: CanvasUnit[]): CanvasInfo {
  return { active_canvas_id: 0, active_tray_id: -1, auto_refill: false, canvas_list: units };
}

const EMPTY_TRAYS = [tray(0, 0), tray(1, 0), tray(2, 0), tray(3, 0)];

describe('needsTrayMapping (ELEG-113)', () => {
  it('does not map when the printer reports no canvas at all', () => {
    expect(needsTrayMapping(null, 1)).toBe(false);
    expect(needsTrayMapping(canvas(), 1)).toBe(false);
  });

  // The case behind GitHub #135: a canvas_list is reported but nothing in it is usable,
  // so every colour would be unmappable and ▶ Print refused.
  it('does not map when the only Canvas unit is disconnected, even with loaded trays', () => {
    const c = canvas({ canvas_id: 0, connected: 0, tray_list: [tray(0, 1), tray(1, 1)] });
    expect(needsTrayMapping(c, 1)).toBe(false);
  });

  it('does not map when a connected Canvas has every tray empty', () => {
    const c = canvas({ canvas_id: 0, connected: 1, tray_list: EMPTY_TRAYS });
    expect(needsTrayMapping(c, 2)).toBe(false);
  });

  it('still maps when a connected Canvas has a loaded tray', () => {
    const c = canvas({ canvas_id: 0, connected: 1, tray_list: [tray(0, 0), tray(1, 1)] });
    expect(needsTrayMapping(c, 1)).toBe(true);
  });

  it('does not map a file with no colour map', () => {
    const c = canvas({ canvas_id: 0, connected: 1, tray_list: [tray(0, 1)] });
    expect(needsTrayMapping(c, 0)).toBe(false);
  });
});
