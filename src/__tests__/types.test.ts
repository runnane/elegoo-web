import { describe, it, expect } from 'vitest';
import {
  detectZone,
  isFilamentChangeSubStatus,
  classifyCommandOutcome,
  describeCommandError,
  COMMAND_METHOD_NAMES,
  ERROR_CODE_NAMES,
  BUSY_ERROR_CODES,
  REJECTED_ERROR_CODES,
  powerLossState,
} from '../types';

describe('detectZone', () => {
  it('returns cutter_area for cutter coordinates', () => {
    expect(detectZone(254, 3.5)).toBe('cutter_area');
  });

  it('returns purge_area for purge coordinates', () => {
    expect(detectZone(52.5, 264)).toBe('purge_area');
  });

  it('returns print_area for normal bed coordinates', () => {
    expect(detectZone(128, 128)).toBe('print_area');
    expect(detectZone(0, 0)).toBe('print_area');
    expect(detectZone(256, 256)).toBe('print_area');
  });

  it('returns outside for out-of-bounds coordinates', () => {
    expect(detectZone(-10, -10)).toBe('outside');
    expect(detectZone(300, 300)).toBe('outside');
  });
});

describe('isFilamentChangeSubStatus', () => {
  it('returns true for filament change sub-statuses', () => {
    expect(isFilamentChangeSubStatus(1045)).toBe(true);
    expect(isFilamentChangeSubStatus(1061)).toBe(true);
    expect(isFilamentChangeSubStatus(1066)).toBe(true);
    expect(isFilamentChangeSubStatus(1150)).toBe(true);
    expect(isFilamentChangeSubStatus(1166)).toBe(true);
  });

  it('returns false for non-filament-change sub-statuses', () => {
    expect(isFilamentChangeSubStatus(0)).toBe(false);
    expect(isFilamentChangeSubStatus(1000)).toBe(false);
    expect(isFilamentChangeSubStatus(2075)).toBe(false);
  });
});

describe('classifyCommandOutcome', () => {
  it('treats 0 as success', () => {
    expect(classifyCommandOutcome(0)).toBe('ok');
  });

  it('treats an absent code as success', () => {
    // Several methods answer with no error_code at all; classifying that as a failure
    // would toast an error on every one of them.
    expect(classifyCommandOutcome(undefined)).toBe('ok');
    expect(classifyCommandOutcome(null)).toBe('ok');
  });

  it('classifies 1009 as busy rather than as an error', () => {
    // The whole point of ELEG-40: "busy" is transient and must not read as a failure.
    expect(classifyCommandOutcome(1009)).toBe('busy');
  });

  it('classifies understood-but-refused codes as rejected', () => {
    expect(classifyCommandOutcome(1003)).toBe('rejected'); // invalid parameter
    expect(classifyCommandOutcome(1010)).toBe('rejected'); // not currently printing
    expect(classifyCommandOutcome(1021)).toBe('rejected'); // file not found
    expect(classifyCommandOutcome(1026)).toBe('rejected'); // needs levelling first
  });

  it('classifies genuine failures as errors', () => {
    expect(classifyCommandOutcome(1004)).toBe('error'); // file write failed
    expect(classifyCommandOutcome(1013)).toBe('error'); // database failure
    expect(classifyCommandOutcome(9999)).toBe('error');
  });

  it('falls back to error for a code the table has never seen', () => {
    expect(classifyCommandOutcome(4242)).toBe('error');
  });
});

describe('describeCommandError', () => {
  it('names a known code', () => {
    expect(describeCommandError(1009)).toBe('Printer busy');
    expect(describeCommandError(1021)).toBe('File not found');
  });

  it('falls back to the raw number for an unknown code', () => {
    expect(describeCommandError(4242)).toBe('error 4242');
  });

  it('describes an absent code without rendering "undefined"', () => {
    expect(describeCommandError(undefined)).toBe('unknown error');
  });
});

describe('command tables', () => {
  it('names every busy/rejected code it classifies', () => {
    // A code classified but unnamed would surface to the user as a bare number, which
    // is the thing describeCommandError exists to avoid. Derived from the sets rather
    // than a second copy of them, so adding a code cannot pass this by omission.
    for (const code of [...BUSY_ERROR_CODES, ...REJECTED_ERROR_CODES]) {
      expect(ERROR_CODE_NAMES[code], `code ${code} has no name`).toBeTruthy();
    }
  });

  it('lists only writes, never the polled reads', () => {
    // A read that comes back busy is re-polled seconds later; toasting it is noise.
    for (const readMethod of [1002, 1036, 1044, 1045, 1046, 1048, 1050, 1062]) {
      expect(COMMAND_METHOD_NAMES[readMethod], `read ${readMethod} must not toast`).toBeUndefined();
    }
    expect(COMMAND_METHOD_NAMES[1027]).toBe('Move');
    expect(COMMAND_METHOD_NAMES[1032]).toBe('Auto-level');
  });
});

describe('powerLossState', () => {
  it('reports none for any status that is not 15', () => {
    for (const status of [0, 1, 2, 14, undefined, null]) {
      expect(powerLossState(status, 0)).toBe('none');
    }
  });

  it('reports awaiting_decision for a bare status 15', () => {
    // The printer is sitting on a half-finished job with nobody having told it what to
    // do. This is the state that must prompt.
    expect(powerLossState(15, 0)).toBe('awaiting_decision');
    expect(powerLossState(15, undefined)).toBe('awaiting_decision');
  });

  it('reports resuming once 2405 arrives, so it stops prompting', () => {
    // Prompting again here would invite a second resume on a print already recovering.
    expect(powerLossState(15, 2405)).toBe('resuming');
  });

  it('reports resumed on 2406', () => {
    expect(powerLossState(15, 2406)).toBe('resumed');
  });

  it('does not confuse a normal resume sub-status with a power-loss one', () => {
    // 2401/2402 are an ordinary resume and never accompany status 15.
    expect(powerLossState(2, 2401)).toBe('none');
    expect(powerLossState(15, 2401)).toBe('awaiting_decision');
  });
});
