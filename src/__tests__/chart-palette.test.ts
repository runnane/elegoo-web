import { describe, it, expect } from 'vitest';
import { resolvePalette, chartPalette, FALLBACK_PALETTE } from '../ui/chart-palette';
import { resolveTheme, isThemeChoice } from '../ui/theme';

describe('resolvePalette', () => {
  it('takes every colour from the stylesheet when they are all defined', () => {
    const p = resolvePalette((name) => `var(${name})`);
    expect(p.grid).toBe('var(--chart-grid)');
    expect(p.label).toBe('var(--chart-label)');
    expect(p.gcodeBg).toBe('var(--gcode-bg)');
    // Nothing may silently keep a dark default when the stylesheet has an answer.
    for (const value of Object.values(p)) {
      expect(value.startsWith('var(--')).toBe(true);
    }
  });

  it('trims the whitespace getPropertyValue leaves behind', () => {
    // getPropertyValue returns the declaration verbatim, leading space included.
    expect(resolvePalette(() => '  #123456  ').label).toBe('#123456');
  });

  it('falls back for a property the stylesheet does not define', () => {
    // getPropertyValue returns '' for an unknown property. Assigning that to fillStyle
    // silently keeps the *previous* colour, which is a miserable bug to chase — so an
    // empty value must fall back rather than be used.
    expect(resolvePalette(() => '')).toEqual(FALLBACK_PALETTE);
    expect(resolvePalette(() => undefined)).toEqual(FALLBACK_PALETTE);
  });

  it('falls back per property, not all-or-nothing', () => {
    const p = resolvePalette((name) => (name === '--chart-label' ? '#ffffff' : ''));
    expect(p.label).toBe('#ffffff');
    expect(p.grid).toBe(FALLBACK_PALETTE.grid);
  });
});

describe('chartPalette without a DOM', () => {
  it('returns the fallback rather than throwing', () => {
    // vitest runs environment: "node". The charts must stay drawable, and the render
    // test in layer-chart-render.test.ts depends on this.
    expect(chartPalette()).toEqual(FALLBACK_PALETTE);
  });
});

describe('FALLBACK_PALETTE', () => {
  it('defines a non-empty colour for every field', () => {
    for (const [key, value] of Object.entries(FALLBACK_PALETTE)) {
      expect(value, `${key} is empty`).toBeTruthy();
    }
  });
});

describe('resolveTheme', () => {
  it('lets an explicit choice override the system preference', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('follows the system when the choice is auto', () => {
    expect(resolveTheme('auto', true)).toBe('light');
    expect(resolveTheme('auto', false)).toBe('dark');
  });
});

describe('isThemeChoice', () => {
  it('accepts the three valid choices', () => {
    for (const v of ['auto', 'dark', 'light']) expect(isThemeChoice(v)).toBe(true);
  });

  it('rejects anything else, so a corrupt stored value cannot be applied', () => {
    for (const v of ['', 'Light', null, undefined, 42, {}]) expect(isThemeChoice(v)).toBe(false);
  });
});
