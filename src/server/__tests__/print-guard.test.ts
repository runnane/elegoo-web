/**
 * ELEG-176: the print guard's policy, as a table. Pure: no bridge, no server, no printer.
 * Every expected verdict is written out, never computed from the module under test.
 */
import { describe, expect, it } from 'vitest';
import { printBusyRefusal, printBusyRefusalAll } from '../print-guard.js';
import type { PrinterStatus } from '../../types.js';

const status = (code: number) => ({ machine_status: { status: code } }) as unknown as PrinterStatus;

const PRINTING = status(2);
const POWER_LOSS = status(15);
const IDLE = status(1);
const LOADING_FILAMENT = status(3);

const refused = (m: number, p: unknown, s: PrinterStatus | null) =>
  printBusyRefusal(m, p, s) !== null;

// ── method by method ─────────────────────────────────────────────────────────

/** [method, params, refused while a job is active] */
const METHODS: Array<[number, unknown, boolean]> = [
  [1026, { homed_axes: 'xyz' }, true],
  [1026, {}, true],
  [1027, { axes: 'z', distance: 0.1 }, true],
  [1024, {}, true],
  [1025, {}, true],
  [1032, {}, true],
  [1033, {}, true],
  [1034, {}, true],
  [1035, {}, true],
  [2001, {}, true],
  [2002, {}, true],
  [1021, {}, false], // pause
  [1022, {}, false], // stop
  [1023, {}, false], // resume
  [1007, {}, false], // emergency stop
  [1029, { power: 1 }, false], // light
  [1030, { fan: 255 }, false], // fan
  [1031, { mode: 2 }, false], // speed
  [1002, {}, false], // status read
  [2004, { auto_refill: true }, false],
];

describe.each([
  ['printing (2)', PRINTING],
  ['power-loss recovery (15)', POWER_LOSS],
])('while %s', (_label, s) => {
  it.each(METHODS)('method %i %j refused: %s', (method, params, expected) => {
    expect(refused(method, params, s)).toBe(expected);
  });
});

describe.each([
  ['idle (1)', IDLE],
  ['loading filament (3), which is not a job', LOADING_FILAMENT],
  ['unknown (null status: before the first 1002)', null],
])('while %s, nothing is refused', (_label, s) => {
  it.each(METHODS)('method %i %j is allowed', (method, params) => {
    expect(printBusyRefusal(method, params, s)).toBeNull();
  });
  it('not even heater-off', () => {
    expect(printBusyRefusal(1028, { extruder: 0, heater_bed: 0 }, s)).toBeNull();
  });
});

// ── 1028, both shapes ────────────────────────────────────────────────────────

/** [params, refused while printing] */
const TEMPERATURES: Array<[unknown, boolean]> = [
  // {extruder}/{heater_bed} shape (SPA, MCP, :7125)
  [{ extruder: 0 }, true],
  [{ extruder: 169 }, true],
  [{ extruder: 170 }, false],
  [{ extruder: 210 }, false],
  [{ heater_bed: 0 }, true],
  [{ heater_bed: 60 }, false],
  [{ extruder: 210, heater_bed: 60 }, false],
  [{ extruder: 210, heater_bed: 0 }, true],
  [{ extruder: 0, heater_bed: 60 }, true],
  [{ extruder: Number.NaN }, true],
  [{ extruder: Number.POSITIVE_INFINITY }, true],
  [{ extruder: '210' }, true], // a numeric string is not a number
  // {target, temperature} shape (/moonraker, OctoPrint)
  [{ target: 'extruder', temperature: 0 }, true],
  [{ target: 'extruder', temperature: 169 }, true],
  [{ target: 'extruder', temperature: 170 }, false],
  [{ target: 'extruder', temperature: 210 }, false],
  [{ target: 'heater_bed', temperature: 0 }, true],
  [{ target: 'heater_bed', temperature: 60 }, false],
  [{ target: 'heater_bed', temperature: '60' }, true], // OctoPrint forwards it raw
  [{ target: 'extruder' }, true], // no temperature
  [{ target: 'chamber', temperature: 40 }, true], // unknown heater
  // both shapes in one frame: every recognised target must pass
  [{ target: 'extruder', temperature: 210, heater_bed: 60 }, false],
  [{ target: 'extruder', temperature: 210, heater_bed: 0 }, true],
  // nothing recognisable: refused rather than guessed at
  [{}, true],
  [{ foo: 1 }, true],
  [null, true],
  [undefined, true],
  ['{"extruder":210}', true],
  [[210], true],
];

describe('1028 while printing', () => {
  it.each(TEMPERATURES)('%j refused: %s', (params, expected) => {
    expect(refused(1028, params, PRINTING)).toBe(expected);
  });
});

describe('1028 during power-loss recovery follows the same rule', () => {
  it.each(TEMPERATURES)('%j refused: %s', (params, expected) => {
    expect(refused(1028, params, POWER_LOSS)).toBe(expected);
  });
});

// ── the message ──────────────────────────────────────────────────────────────

describe('the refusal message', () => {
  it('is pinned for home', () => {
    expect(printBusyRefusal(1026, {}, PRINTING)).toBe(
      'Printer is busy printing — homing is refused while a job is active. ' +
        'Pause/stop/e-stop stay available; retry once the printer is idle.',
    );
  });

  it('is pinned for heater-off', () => {
    expect(printBusyRefusal(1028, { heater_bed: 0 }, PRINTING)).toBe(
      'Printer is busy printing — turning a heater off or setting the nozzle below ' +
        '170 °C is refused while a job is active. ' +
        'Pause/stop/e-stop stay available; retry once the printer is idle.',
    );
  });
});

// ── compound requests ────────────────────────────────────────────────────────

describe('printBusyRefusalAll', () => {
  const OFF: Array<[number, unknown]> = [
    [1028, { extruder: 0 }],
    [1028, { heater_bed: 0 }],
  ];

  it('refuses TURN_OFF_HEATERS while printing', () => {
    expect(printBusyRefusalAll(OFF, PRINTING)).toBe(
      printBusyRefusal(1028, { extruder: 0 }, PRINTING),
    );
    expect(printBusyRefusalAll(OFF, PRINTING)).not.toBeNull();
  });

  it('refuses when only one part is refused', () => {
    const mixed: Array<[number, unknown]> = [
      [1028, { heater_bed: 60 }],
      [1026, {}],
    ];
    expect(printBusyRefusalAll(mixed, PRINTING)).toContain('homing');
  });

  it('allows it when idle', () => {
    expect(printBusyRefusalAll(OFF, IDLE)).toBeNull();
  });

  it('allows an empty script (unrecognised gcode) while printing', () => {
    expect(printBusyRefusalAll([], PRINTING)).toBeNull();
  });
});
