/**
 * ELEG-174 — canvas chart labels stay inside the canvas. The temperature chart's last
 * time label was centred on the right edge and lost its last character ("00:16:4").
 */

import { describe, expect, it } from 'vitest';
import { placeEndLabel, placeTickLabel } from '../ui/chart-labels';

/** The horizontal extent a placement paints, for a label of `width`. */
function extent(p: { x: number; align: string }, width: number): [number, number] {
  if (p.align === 'left') return [p.x, p.x + width];
  if (p.align === 'right') return [p.x - width, p.x];
  return [p.x - width / 2, p.x + width / 2];
}

describe('placeTickLabel', () => {
  it('centres a tick label with room on both sides', () => {
    expect(placeTickLabel(150, 48, 321)).toEqual({ x: 150, align: 'center' });
  });

  it('anchors the last tick (on the right plot edge) to the canvas edge', () => {
    // 321px canvas, 12px right padding: the last tick is at x=309, the label 48px wide.
    const p = placeTickLabel(309, 48, 321);
    expect(p).toEqual({ x: 321, align: 'right' });
    const [l, r] = extent(p, 48);
    expect(l).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(321);
  });

  it('anchors a tick near the left edge to the left', () => {
    expect(placeTickLabel(10, 48, 321)).toEqual({ x: 0, align: 'left' });
  });
});

describe('placeEndLabel', () => {
  it('puts the label to the right of the point when it fits', () => {
    expect(placeEndLabel(100, 60, 321, 4)).toEqual({ x: 104, align: 'left' });
  });

  it('flips the label left of a point on the right edge', () => {
    const p = placeEndLabel(309, 70, 321, 6);
    expect(p).toEqual({ x: 303, align: 'right' });
    expect(extent(p, 70)[1]).toBeLessThanOrEqual(321);
  });
});
