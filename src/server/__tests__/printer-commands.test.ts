import { describe, expect, it } from 'vitest';
import {
  homeCommand,
  moveCommands,
  temperatureCommand,
  translateGcode,
} from '../printer-commands.js';

/** The exact params each gcode is sent as (ELEG-180): the SPA's shapes, nothing else. */
describe('translateGcode', () => {
  it.each([
    ['G28', [[1026, { homed_axes: 'xyz' }]]],
    ['  g28 x  ', [[1026, { homed_axes: 'xyz' }]]],
    ['M104 S215', [[1028, { extruder: 215 }]]],
    ['M140 S60', [[1028, { heater_bed: 60 }]]],
    ['M104', []],
    ['M140 T0', []],
    ['M112', [[1022, {}]]],
    ['SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=0', [[1028, { heater_bed: 0 }]]],
    ['SET_HEATER_TEMPERATURE HEATER=extruder TARGET=210', [[1028, { extruder: 210 }]]],
    ['SET_HEATER_TEMPERATURE HEATER=extruder', []],
    ['SET_HEATER_TEMPERATURE HEATER=extruder0 TARGET=190', [[1028, { extruder: 190 }]]],
    ['SET_HEATER_TEMPERATURE HEATER=chamber TARGET=60', []],
    ['SET_HEATER_TEMPERATURE HEATER=chamber TARGET=0', []],
    ['SET_HEATER_TEMPERATURE HEATER=extrduer TARGET=200', []],
    ['SET_HEATER_TEMPERATURE HEATER=temperature_fan_x TARGET=40', []],
    [
      'TURN_OFF_HEATERS',
      [
        [1028, { extruder: 0 }],
        [1028, { heater_bed: 0 }],
      ],
    ],
    ['SET_GCODE_OFFSET Z_ADJUST=0.01', []],
    ['', []],
  ])('%j → %j', (script, expected) => {
    expect(translateGcode(script)).toEqual(expected);
  });
});

describe('homeCommand', () => {
  it.each([
    [undefined, { homed_axes: 'xyz' }],
    [[], { homed_axes: 'xyz' }],
    [['y', 'X'], { homed_axes: 'xy' }],
    [['z', 'z', 'q'], { homed_axes: 'z' }],
  ])('%j → %j', (axes, params) => {
    expect(homeCommand(axes)).toEqual([1026, params]);
  });

  it('is null when the list names no real axis', () => {
    expect(homeCommand(['e', 3])).toBeNull();
  });
});

describe('moveCommands', () => {
  it('sends one finite, non-zero axis per command, in x/y/z order', () => {
    expect(moveCommands({ z: 0.5, y: 0, x: -10 })).toEqual([
      [1027, { axes: 'x', distance: -10 }],
      [1027, { axes: 'z', distance: 0.5 }],
    ]);
  });

  it('drops non-numbers and non-finite values', () => {
    expect(moveCommands({ x: '5', y: Number.NaN, z: Number.POSITIVE_INFINITY })).toEqual([]);
  });
});

describe('temperatureCommand', () => {
  it('keys the target by heater', () => {
    expect(temperatureCommand('extruder', 215)).toEqual([1028, { extruder: 215 }]);
    expect(temperatureCommand('heater_bed', 0)).toEqual([1028, { heater_bed: 0 }]);
  });

  it('is null for a non-number', () => {
    expect(temperatureCommand('heater_bed', '60')).toBeNull();
    expect(temperatureCommand('extruder', Number.NaN)).toBeNull();
  });
});
