import { describe, expect, it } from 'vitest';
import { calculate, DEFAULTS, type SpoolParams, validateSpool } from '../ui/spool-calc';

const valid = (over: Partial<SpoolParams> = {}): SpoolParams => ({ ...DEFAULTS, ...over });

describe('validateSpool', () => {
  it('accepts the defaults', () => {
    expect(validateSpool(DEFAULTS)).toEqual({});
  });

  it('rejects a hub at or above the flange', () => {
    expect(validateSpool(valid({ hubDiameter: 250 })).hubDiameter).toMatch(
      /smaller than the flange/,
    );
    expect(validateSpool(valid({ hubDiameter: 200 })).hubDiameter).toMatch(
      /smaller than the flange/,
    );
  });

  it('rejects an outer diameter above the flange', () => {
    expect(validateSpool(valid({ currentOuterDiameter: 300 })).currentOuterDiameter).toMatch(
      /exceed the flange/,
    );
  });

  it('rejects an outer diameter at or below the hub', () => {
    expect(validateSpool(valid({ currentOuterDiameter: 55 })).currentOuterDiameter).toMatch(
      /larger than the hub/,
    );
  });

  it('treats an outer diameter of 0 as not measured', () => {
    expect(validateSpool(valid({ currentOuterDiameter: 0 })).currentOuterDiameter).toBeUndefined();
  });

  it('rejects a current weight below the empty spool weight', () => {
    expect(validateSpool(valid({ currentWeight: 100 })).currentWeight).toMatch(/below the empty/);
  });

  it('rejects a full weight not above the empty weight', () => {
    expect(validateSpool(valid({ fullWeight: 250 })).fullWeight).toMatch(/greater than the empty/);
  });

  it('rejects non-positive and non-finite values', () => {
    expect(validateSpool(valid({ hubDiameter: 0 })).hubDiameter).toMatch(/hub diameter above 0/);
    expect(validateSpool(valid({ flangeDiameter: -5 })).flangeDiameter).toMatch(
      /flange diameter above 0/,
    );
    expect(validateSpool(valid({ spoolWidth: 0 })).spoolWidth).toMatch(/spool width above 0/);
    expect(validateSpool(valid({ filamentDiameter: 0 })).filamentDiameter).toMatch(
      /filament diameter above 0/,
    );
    expect(validateSpool(valid({ emptyWeight: -1 })).emptyWeight).toMatch(/0 or more/);
    expect(validateSpool(valid({ currentWeight: 0 })).currentWeight).toMatch(
      /current weight above 0/,
    );
    expect(validateSpool(valid({ fullWeight: Number.NaN })).fullWeight).toMatch(
      /full weight above 0/,
    );
    expect(validateSpool(valid({ spoolWidth: Number.NaN })).spoolWidth).toMatch(
      /spool width above 0/,
    );
    expect(validateSpool(valid({ currentOuterDiameter: -3 })).currentOuterDiameter).toMatch(
      /above 0, or leave it empty/,
    );
  });
});

describe('calculate', () => {
  it('pins a valid half-full spool to exact values', () => {
    const c = calculate(valid({ currentWeight: 750 }));
    expect(c.filamentMass).toBe(500);
    expect(c.fullFilamentMass).toBe(1000);
    expect(c.percentRemaining).toBe(50);
    // 500 g / 1.24 g/cm3 / (pi * 0.0875^2 cm2) / 100 = 167.6 m
    expect(c.lengthM).toBeCloseTo(167.6, 1);
    expect(c.lengthM.toFixed(1)).toBe('167.6');
  });

  it('never reports more than 100 percent remaining', () => {
    const c = calculate(valid({ currentWeight: 5586 }));
    expect(c.percentRemaining).toBe(100);
  });

  it('never reports below 0 percent or a negative length', () => {
    const c = calculate(valid({ currentWeight: 100 }));
    expect(c.percentRemaining).toBe(0);
    expect(c.lengthM).toBe(0);
  });
});
