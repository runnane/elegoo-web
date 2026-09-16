/**
 * PrinterState's delta merge (ELEG-91, slice 1 of ELEG-28) — the browser twin of
 * ../server/__tests__/state-store-deepmerge.test.ts.
 *
 * `deepMerge` in ../printer-state.ts is private, so it is driven through the public
 * `applyDelta`, the same entry point the WebSocket 'status' handler in main.ts calls
 * with the raw delta from the server. That keeps the test honest to a refactor that
 * bypasses `deepMerge` internally.
 *
 * The invariant under test: **a field absent from a delta means unchanged, not cleared.**
 * Fixtures are generated, shaped like real CC2 status/canvas payloads, with no data
 * captured from a real printer, per this repo's public visibility.
 */

import { describe, it, expect } from 'vitest';
import { PrinterState } from '../printer-state';
import type { PrinterStatus, CanvasInfo } from '../types';

function baselineStatus(): PrinterStatus {
  return {
    machine_status: {
      status: 1,
      sub_status: 0,
      exception_status: [],
      progress: 0,
    },
    print_status: {
      filename: 'benchy.gcode',
      uuid: 'b6b6b6b6-0000-4000-8000-000000000001',
      current_layer: 12,
      total_layer: 240,
      print_duration: 3600,
      total_duration: 7200,
      remaining_time_sec: 3600,
    },
    extruder: {
      temperature: 205.4,
      target: 205,
      filament_detect_enable: 1,
      filament_detected: 1,
    },
    heater_bed: {
      temperature: 59.8,
      target: 60,
    },
    ztemperature_sensor: {
      temperature: 32.1,
      measured_max_temperature: 33,
      measured_min_temperature: 20,
    },
    fans: {
      fan: { speed: 100 },
      aux_fan: { speed: 80 },
      box_fan: { speed: 60 },
      heater_fan: { speed: 100 },
      controller_fan: { speed: 100 },
    },
    gcode_move: {
      x: 120.5,
      y: 88.2,
      z: 12.4,
      speed: 4800,
      speed_mode: 1,
    },
    led: { status: 1 },
    tool_head: { homed_axes: 'xyz' },
    external_device: { camera: true, u_disk: false, type: 'none' },
  };
}

function baselineCanvas(): CanvasInfo {
  return {
    active_canvas_id: 0,
    active_tray_id: 2,
    auto_refill: true,
    canvas_list: [
      {
        canvas_id: 0,
        connected: 1,
        tray_list: [
          {
            tray_id: 1,
            brand: 'Elegoo',
            filament_type: 'PLA',
            filament_name: 'Generic PLA',
            filament_color: '#FFAA00',
            min_nozzle_temp: 190,
          } as unknown as CanvasInfo['canvas_list'][number]['tray_list'][number],
          {
            tray_id: 2,
            brand: 'Elegoo',
            filament_type: 'PETG',
            filament_name: 'Generic PETG',
            filament_color: '#1144AA',
            min_nozzle_temp: 230,
          } as unknown as CanvasInfo['canvas_list'][number]['tray_list'][number],
        ],
      },
    ],
  };
}

describe('PrinterState.applyDelta merge', () => {
  it('leaves a field absent from the delta unchanged — the core invariant', () => {
    const s = new PrinterState();
    s.applyDelta(baselineStatus() as unknown as Record<string, unknown>);

    s.applyDelta({ extruder: { temperature: 210.1 } });

    expect(s.status?.extruder.temperature).toBe(210.1);
    expect(s.status?.heater_bed).toEqual(baselineStatus().heater_bed);
    expect(s.status?.machine_status).toEqual(baselineStatus().machine_status);
    expect(s.status?.print_status).toEqual(baselineStatus().print_status);
  });

  it('merges a nested object rather than replacing it wholesale', () => {
    const s = new PrinterState();
    s.applyDelta(baselineStatus() as unknown as Record<string, unknown>);

    s.applyDelta({ extruder: { temperature: 212 } });

    expect(s.status?.extruder).toEqual({
      temperature: 212,
      target: 205,
      filament_detect_enable: 1,
      filament_detected: 1,
    });
  });

  it('replaces an array wholesale rather than merging it element-wise', () => {
    const s = new PrinterState();
    s.applyDelta(baselineStatus() as unknown as Record<string, unknown>);

    s.applyDelta({ machine_status: { exception_status: [5001] } });

    expect(s.status?.machine_status.exception_status).toEqual([5001]);
    expect(s.status?.machine_status.status).toBe(1);
  });

  it('applies an explicit falsy value from the delta rather than treating it as absent', () => {
    const s = new PrinterState();
    s.applyDelta(baselineStatus() as unknown as Record<string, unknown>);

    s.applyDelta({
      led: { status: 0 },
      heater_bed: { target: 0 },
      print_status: { filename: '' },
    });

    expect(s.status?.led.status).toBe(0);
    expect(s.status?.heater_bed.target).toBe(0);
    expect(s.status?.heater_bed.temperature).toBe(59.8);
    expect(s.status?.print_status.filename).toBe('');
  });

  it('applies an explicit null from the delta as a value, not an absence', () => {
    const s = new PrinterState();
    s.applyDelta(baselineStatus() as unknown as Record<string, unknown>);

    s.applyDelta({ print_status: { state: null } });

    expect(s.status?.print_status.state).toBeNull();
  });

  it('merges canvas_info deltas the same way, leaving absent fields unchanged', () => {
    const s = new PrinterState();
    s.applyDelta({ ...baselineStatus(), canvas_info: baselineCanvas() } as unknown as Record<
      string,
      unknown
    >);

    s.applyDelta({ canvas_info: { active_tray_id: 1 } });

    expect(s.canvas?.active_tray_id).toBe(1);
    expect(s.canvas?.auto_refill).toBe(true);
    expect(s.canvas?.canvas_list).toEqual(baselineCanvas().canvas_list);
  });
});
