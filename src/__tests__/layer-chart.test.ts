/**
 * Layer-time chart geometry (ELEG-16).
 *
 * The chart used to take its X domain from the **first and last** entries of the window,
 * which silently assumes the series is sorted. It is not always: an entry from the
 * previous print can sit in front of the current one (see
 * `src/server/__tests__/layer-tracking.test.ts` for how it gets there). With a domain of
 * 29..63, layer 1 mapped to x ≈ -358 and was drawn straight over the Y-axis labels and
 * off the canvas, while its 155s duration flattened every real layer against the
 * baseline.
 *
 * These cover the two pure helpers only. Nothing here paints: there is no jsdom or
 * canvas in this suite, so the `ctx.clip()` that bounds the series to the plot rect is
 * verified by eye, not by a test.
 */

import { describe, it, expect } from 'vitest';
import { computeDomain, selectVisibleLayers, type LayerTimePoint } from '../ui/layer-chart';

const pt = (layer: number, duration: number): LayerTimePoint => ({
  layer,
  duration,
  timestamp: 1_786_110_795_370 + layer * 1000,
});

describe('selectVisibleLayers', () => {
  it('keeps a healthy monotonic series intact', () => {
    const series = [pt(1, 33), pt(2, 24), pt(3, 20)];
    expect(selectVisibleLayers(series)).toEqual(series);
  });

  it('drops a previous print left sitting in front of the current one', () => {
    const series = [pt(29, 155.259), pt(1, 33), pt(2, 24), pt(3, 20)];
    expect(selectVisibleLayers(series).map((p) => p.layer)).toEqual([1, 2, 3]);
  });

  it('keeps only the run after the last decrease when there are several', () => {
    const series = [pt(9, 5), pt(1, 5), pt(2, 5), pt(40, 5), pt(1, 5), pt(2, 5)];
    expect(selectVisibleLayers(series).map((p) => p.layer)).toEqual([1, 2]);
  });

  it('treats a repeated layer as a boundary too', () => {
    expect(
      selectVisibleLayers([pt(1, 5), pt(2, 5), pt(2, 9), pt(3, 5)]).map((p) => p.layer),
    ).toEqual([2, 3]);
  });

  it('caps the window at maxVisible, keeping the most recent layers', () => {
    const series = Array.from({ length: 250 }, (_, i) => pt(i + 1, 10));
    const visible = selectVisibleLayers(series);
    expect(visible).toHaveLength(200);
    expect(visible[0].layer).toBe(51);
    expect(visible[199].layer).toBe(250);
  });

  it('handles an empty series', () => {
    expect(selectVisibleLayers([])).toEqual([]);
  });
});

describe('computeDomain', () => {
  it('spans the real min and max, not the first and last entries', () => {
    // Out of order on purpose. The endpoints alone give 29..63, which is what mapped
    // layer 1 to a negative X and painted it over the axis gutter.
    const d = computeDomain([pt(29, 155.259), pt(1, 33), pt(63, 15)]);
    expect(d.xMin).toBe(1);
    expect(d.xMax).toBe(63);
    expect(d.xRange).toBe(62);
  });

  it('keeps every point inside the plot rect for an unsorted window', () => {
    const visible = [pt(29, 155.259), pt(1, 33), pt(2, 24), pt(63, 15)];
    const { xMin, xRange, yMax } = computeDomain(visible);
    const [padLeft, padTop, plotW, plotH] = [48, 10, 500, 122];
    const xMap = (layer: number) => padLeft + ((layer - xMin) / xRange) * plotW;
    const yMap = (dur: number) => padTop + plotH - (dur / yMax) * plotH;
    for (const p of visible) {
      expect(xMap(p.layer)).toBeGreaterThanOrEqual(padLeft);
      expect(xMap(p.layer)).toBeLessThanOrEqual(padLeft + plotW);
      expect(yMap(p.duration)).toBeGreaterThanOrEqual(padTop);
      expect(yMap(p.duration)).toBeLessThanOrEqual(padTop + plotH);
    }
  });

  it('gives the Y axis 15% headroom above the tallest layer', () => {
    expect(computeDomain([pt(1, 10), pt(2, 20)]).yMax).toBeCloseTo(23);
  });

  it('falls back to a usable scale for an empty or all-zero window', () => {
    expect(computeDomain([]).yMax).toBe(10);
    expect(computeDomain([]).xRange).toBe(1);
    expect(computeDomain([pt(1, 0), pt(2, 0)]).yMax).toBe(10);
  });

  it('never collapses the X range to zero for a single-layer window', () => {
    expect(computeDomain([pt(7, 12)]).xRange).toBe(1);
  });
});
