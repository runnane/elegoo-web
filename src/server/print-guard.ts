/**
 * The print guard (ELEG-176): which printer commands are refused while a job is active.
 *
 * ELEG-163 locked the SPA's jog, Home, heater and tray buttons mid-print, but only in the
 * browser. Every other way in - `/ws` frames from any client, the `/mcp` tools, Moonraker
 * gcode, OctoPrint's printhead/tool/bed - still forwarded them. This module is the one
 * policy all of them consult; it does no I/O, so it is tested as a table
 * (`__tests__/print-guard.test.ts`).
 *
 * Two layers use it:
 *   1. **every surface**, before it sends and before it answers. `sendCommand` returns
 *      nothing, so a surface that did not ask would go on answering `ok` / 204 for a
 *      command that never left. A compound request (`TURN_OFF_HEATERS`'s two sends) is
 *      decided up front with `printBusyRefusalAll`: if any part is refused, none is sent.
 *   2. **the bridge**, as a backstop (`MqttBridge.setCommandGuard`, wired in `index.ts`),
 *      so a surface added later that forgets step 1 still cannot reach the printer.
 *
 * "A job is active" is `isJobActive` from `src/types.ts`, shared with the SPA's lock.
 * A `null` status (before the first 1002, or just after a printer switch) fails open; a
 * stale "printing" status after a disconnect keeps refusing, which is the safe direction.
 *
 * Policy (only while a job is active):
 *   - 1026 home, 1027 move: refused, any params.
 *   - 1024/1025 feed/retract, 2001/2002 tray load/unload: refused (a filament change
 *     under a print).
 *   - 1032..1035 calibrations: refused (they home and probe).
 *   - 1028 temperature: allowed only when it carries at least one recognised target and
 *     every recognised target is a finite number with nozzle >= 170 C and bed > 0 C.
 *     Changing a target mid-print is normal; heater-off and a cold nozzle are not. Anything
 *     unrecognised is refused rather than guessed at.
 *   - everything else (pause/resume/stop, e-stop, fans, light, speed, reads): allowed.
 *
 * The server is deliberately more permissive on 1028 than the SPA lock, which also locks
 * Set and the presets against a mis-tap on a phone.
 */

import { isJobActive, type PrinterStatus } from '../types.js';

/**
 * Below this the nozzle cannot extrude: a lower target mid-print is a cold extrusion. The
 * same threshold Moonraker-compat's `can_extrude` reports.
 */
const MIN_EXTRUDE_TEMP = 170;

/** What each refused method is called in the refusal message. */
const REFUSED: ReadonlyMap<number, string> = new Map([
  [1024, 'loading filament'],
  [1025, 'unloading filament'],
  [1026, 'homing'],
  [1027, 'moving the toolhead'],
  [1032, 'auto-levelling'],
  [1033, 'vibration calibration'],
  [1034, 'PID calibration'],
  [1035, 'self-check'],
  [2001, 'loading a tray'],
  [2002, 'unloading a tray'],
]);

const TEMPERATURE = 1028;
const TEMPERATURE_REFUSED = `turning a heater off or setting the nozzle below ${MIN_EXTRUDE_TEMP} °C`;

/** The one refusal sentence every surface returns, so they cannot drift apart. */
function busyMessage(what: string): string {
  return (
    `Printer is busy printing — ${what} is refused while a job is active. ` +
    'Pause/stop/e-stop stay available; retry once the printer is idle.'
  );
}

type Heater = 'extruder' | 'heater_bed';

/**
 * Whether a mid-print 1028 is a safe target change. Both shapes in the tree are read:
 * `{extruder: n}` / `{heater_bed: n}` (SPA, MCP, :7125) and `{target, temperature}`
 * (`/moonraker`, OctoPrint). Which one the firmware honours is ELEG-180, not this.
 */
function temperatureAllowed(params: unknown): boolean {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const p = params as Record<string, unknown>;
  const targets: Array<[Heater, unknown]> = [];
  if ('extruder' in p) targets.push(['extruder', p.extruder]);
  if ('heater_bed' in p) targets.push(['heater_bed', p.heater_bed]);
  if ('target' in p) {
    if (p.target !== 'extruder' && p.target !== 'heater_bed') return false;
    targets.push([p.target, p.temperature]);
  }
  if (!targets.length) return false;
  return targets.every(([heater, v]) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    return heater === 'extruder' ? v >= MIN_EXTRUDE_TEMP : v > 0;
  });
}

/**
 * The verdict for one command: `null` to send it, or the refusal message to return.
 * `params` is typed `unknown` because `/ws` and `send_command` pass whatever arrived.
 */
export function printBusyRefusal(
  method: number,
  params: unknown,
  status: PrinterStatus | null | undefined,
): string | null {
  if (!isJobActive(status)) return null;
  const what = REFUSED.get(method);
  if (what) return busyMessage(what);
  if (method === TEMPERATURE && !temperatureAllowed(params)) {
    return busyMessage(TEMPERATURE_REFUSED);
  }
  return null;
}

/**
 * The verdict for a compound request, decided before anything is sent: the first refusal
 * among `commands`, or `null` when every one may go.
 */
export function printBusyRefusalAll(
  commands: ReadonlyArray<readonly [number, unknown]>,
  status: PrinterStatus | null | undefined,
): string | null {
  for (const [method, params] of commands) {
    const refusal = printBusyRefusal(method, params, status);
    if (refusal) return refusal;
  }
  return null;
}
