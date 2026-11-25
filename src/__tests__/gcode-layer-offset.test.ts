import { describe, expect, it } from 'vitest';
import { previewLayerOffset } from '../ui/gcode-layer-offset';

describe('previewLayerOffset (ELEG-120)', () => {
  it('is 1 when the preview has one more layer than the printer: the preamble layer', () => {
    // 11 preview layers for a 10-layer print — a file without slicer layer comments
    expect(previewLayerOffset(11, 10, false)).toBe(1);
  });

  it('is 0 when the counts agree: slicer layer comments fold the preamble in', () => {
    // gcode-preview 3.0.0-alpha.7 on a ;LAYER_CHANGE file: 10 preview layers for 10
    expect(previewLayerOffset(10, 10, true)).toBe(0);
  });

  it('trusts the printer count over the slicer detection when they disagree', () => {
    expect(previewLayerOffset(11, 10, true)).toBe(1);
    expect(previewLayerOffset(10, 10, false)).toBe(0);
  });

  it('falls back to the slicer detection when the printer count is unknown or off', () => {
    expect(previewLayerOffset(10, undefined, true)).toBe(0);
    expect(previewLayerOffset(11, null, false)).toBe(1);
    expect(previewLayerOffset(10, 0, false)).toBe(1);
    // A count that matches neither shape says nothing about the preamble
    expect(previewLayerOffset(40, 10, true)).toBe(0);
    expect(previewLayerOffset(40, 10, false)).toBe(1);
  });
});
