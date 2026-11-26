/**
 * The param shapes the compat layers send for home (1026), move (1027) and temperature
 * (1028), and the one Klipper gcode translator both Moonraker mounts use (ELEG-180).
 *
 * **Which shape, and why.** The shapes here are the SPA's (`src/ui/controls.ts`), which is
 * the one client known to drive the real printer day to day:
 *   - 1026 `{homed_axes: 'xyz'}` — lowercase, any combination of x/y/z;
 *   - 1027 `{axes: 'x', distance: n}` — one axis per command, mm, negative for reverse;
 *   - 1028 `{extruder: n}` and/or `{heater_bed: n}`.
 * The two local protocol references (`CC2_PROTOCOL_REFERENCE.md`, method table and the
 * 1026/1027 sections; `CC2-OFFICIAL-APP-PATTERNS.md` §7, taken from the official app's
 * method enum) document exactly these. Both are gitignored under `data/` (ELEG-66), so this
 * comment is where the finding survives a clone. The firmware source we hold locally has
 * the method enum (1026 `CTRL_HOME`, 1027 `CTRL_MOVE`, 1028 `SET_TEMPTURE`) but not the
 * handlers that parse their params, so whether the shapes the compat layers used to send —
 * 1026 `{axes: [...]}`, 1027 `{direction, x, y, z, speed}`, 1028 `{target, temperature}` —
 * were *also* accepted is unverified. None of them appears in either reference, and no
 * printer command was sent to find out.
 *
 * Every function here is pure, so the surfaces can translate first, ask the print guard
 * (ELEG-176) about the whole list with `printBusyRefusalAll`, and only then send.
 */

export type PrinterCommand = [method: number, params: Record<string, unknown>];

const HOME = 1026;
const MOVE = 1027;
const TEMPERATURE = 1028;
const CANCEL = 1022;

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

/**
 * 1026 for the given axes, in canonical x/y/z order with duplicates dropped; `undefined`
 * or an empty list homes all three. Returns `null` when a list was given but names no
 * axis this printer has, so the caller can refuse it rather than home everything.
 */
export function homeCommand(axes?: readonly unknown[]): PrinterCommand | null {
  if (!axes || axes.length === 0) return [HOME, { homed_axes: 'xyz' }];
  const wanted = new Set(axes.map((a) => (typeof a === 'string' ? a.toLowerCase() : '')));
  const homed = AXES.filter((a) => wanted.has(a)).join('');
  return homed ? [HOME, { homed_axes: homed }] : null;
}

/**
 * 1027 for a relative jog: one command per axis with a finite, non-zero distance, in
 * x/y/z order — the firmware's move takes a single axis. There is no speed field in the
 * documented shape, so a client's jog speed is not forwarded.
 */
export function moveCommands(distances: Partial<Record<Axis, unknown>>): PrinterCommand[] {
  const sends: PrinterCommand[] = [];
  for (const axis of AXES) {
    const d = distances[axis];
    if (typeof d === 'number' && Number.isFinite(d) && d !== 0) {
      sends.push([MOVE, { axes: axis, distance: d }]);
    }
  }
  return sends;
}

/** 1028 setting one heater's target, or `null` when `temperature` is not a finite number. */
export function temperatureCommand(
  heater: 'extruder' | 'heater_bed',
  temperature: unknown,
): PrinterCommand | null {
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) return null;
  return [TEMPERATURE, { [heater]: temperature }];
}

/**
 * The printer commands a Klipper gcode script maps to, in order. Shared by `/moonraker`
 * on the main port and both the HTTP route and the `printer.gcode.script` RPC of the :7125
 * server, which were three copies in two shapes until ELEG-180. Anything unrecognised maps
 * to nothing. `G28` with arguments still homes all three axes.
 */
export function translateGcode(raw: string): PrinterCommand[] {
  const script = raw.trim().toUpperCase();
  if (script === 'G28' || script.startsWith('G28 ')) return [[HOME, { homed_axes: 'xyz' }]];
  if (script.startsWith('M104 ')) {
    const m = script.match(/S(\d+)/);
    return m ? [[TEMPERATURE, { extruder: parseInt(m[1]) }]] : [];
  }
  if (script.startsWith('M140 ')) {
    const m = script.match(/S(\d+)/);
    return m ? [[TEMPERATURE, { heater_bed: parseInt(m[1]) }]] : [];
  }
  if (script === 'M112') return [[CANCEL, {}]];
  if (script.startsWith('SET_HEATER_TEMPERATURE')) {
    const heater = script.match(/HEATER=(\S+)/)?.[1]?.toLowerCase();
    const target = script.match(/TARGET=(\d+)/)?.[1];
    if (!heater || target === undefined) return [];
    const temp = parseInt(target);
    // Only the two heaters the printer has. Any other name (chamber, a typo, a Klipper
    // temperature_fan) must not fall through to the nozzle (ELEG-185).
    if (heater === 'heater_bed') return [[TEMPERATURE, { heater_bed: temp }]];
    if (heater === 'extruder' || heater === 'extruder0') return [[TEMPERATURE, { extruder: temp }]];
    return [];
  }
  if (script === 'TURN_OFF_HEATERS') {
    return [
      [TEMPERATURE, { extruder: 0 }],
      [TEMPERATURE, { heater_bed: 0 }],
    ];
  }
  return [];
}
