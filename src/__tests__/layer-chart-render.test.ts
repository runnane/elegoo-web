/**
 * Layer-time chart render path (ELEG-16).
 *
 * This is the repo's only test that exercises drawing code, and it does it without a
 * browser: there is no jsdom and no canvas here, so it hands `renderLayerTimeChart` a
 * recording 2D-context stub and asserts on the *operations* it emitted. That covers the
 * two things the pure-helper tests cannot — that the series is clipped to the plot rect,
 * and that the rightmost value label stays on the canvas.
 *
 * It is not a substitute for looking at the page. Colours, fonts, overlap and anything
 * about how it actually looks are still unverified by any gate.
 *
 * Both were real bugs: without the clip, an out-of-domain point painted over the Y-axis
 * labels, and the value label was drawn at x=608 on a 554px-wide canvas, so all that
 * survived of `L63: 15.0s` was the `L`.
 */

import { describe, it, expect } from 'vitest';
import { renderLayerTimeChart } from '../ui/layer-chart';
import type { PrinterState } from '../printer-state';

const W = 554;
const H = 160;
/** Must match PADDING in layer-chart.ts */
const PAD = { top: 10, right: 12, bottom: 28, left: 48 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
/** The stub's stand-in for text metrics — 6px per character */
const CHAR_W = 6;

interface Op {
  op: string;
  args: unknown[];
}

type LayerTime = { layer: number; duration: number; timestamp: number };

/**
 * Render one series and return the ops the chart emitted.
 *
 * `renderLayerTimeChart` skips a redraw when the series length is unchanged, so each
 * call here uses a series of a different length.
 */
function render(layerTimes: LayerTime[]): Op[] {
  const ops: Op[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      ops.push({ op, args });
    };

  const ctx = {
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    rect: record('rect'),
    roundRect: record('roundRect'),
    clip: record('clip'),
    save: record('save'),
    restore: record('restore'),
    stroke: record('stroke'),
    fill: record('fill'),
    setLineDash: record('setLineDash'),
    measureText: (t: string) => ({ width: t.length * CHAR_W }),
    fillText(t: string, x: number, y: number) {
      // textAlign decides which side of x the text extends, so capture it per call.
      ops.push({ op: 'fillText', args: [t, x, y, ctx.textAlign] });
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  };

  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: W, height: H }),
    getContext: () => ctx,
    addEventListener: () => {},
  };

  const g = globalThis as unknown as { window: unknown; document: unknown };
  g.window = { devicePixelRatio: 1 };
  g.document = { getElementById: () => canvas };

  renderLayerTimeChart({ layerTimes } as unknown as PrinterState);
  return ops;
}

/** The ops emitted between `clip()` and the matching `restore()` */
function clippedOps(ops: Op[]): Op[] {
  const from = ops.findIndex((o) => o.op === 'clip');
  expect(from).toBeGreaterThan(-1);
  const to = ops.findIndex((o, i) => i > from && o.op === 'restore');
  expect(to).toBeGreaterThan(from);
  return ops.slice(from, to);
}

describe('layer chart render path', () => {
  it('clips the series to the plot rect', () => {
    // A previous print's L29 in front of the current one — the live ELEG-16 repro.
    const series: LayerTime[] = [
      { layer: 29, duration: 155.259, timestamp: 1 },
      ...Array.from({ length: 63 }, (_, i) => ({
        layer: i + 1,
        duration: 14,
        timestamp: i + 2,
      })),
    ];
    const ops = render(series);

    const clipIdx = ops.findIndex((o) => o.op === 'clip');
    expect(ops[clipIdx - 1]).toEqual({
      op: 'rect',
      args: [PAD.left, PAD.top, PLOT_W, PLOT_H],
    });
  });

  it('draws no series point outside the plot rect', () => {
    const series: LayerTime[] = [
      { layer: 29, duration: 155.259, timestamp: 1 },
      ...Array.from({ length: 40 }, (_, i) => ({
        layer: i + 1,
        duration: 14,
        timestamp: i + 2,
      })),
    ];

    for (const o of clippedOps(render(series))) {
      if (o.op !== 'moveTo' && o.op !== 'lineTo' && o.op !== 'arc') continue;
      const [x, y] = o.args as number[];
      expect(x).toBeGreaterThanOrEqual(PAD.left);
      expect(x).toBeLessThanOrEqual(W - PAD.right);
      expect(y).toBeGreaterThanOrEqual(PAD.top);
      expect(y).toBeLessThanOrEqual(H - PAD.bottom);
    }
  });

  it('keeps the rightmost value label on the canvas', () => {
    const series: LayerTime[] = Array.from({ length: 30 }, (_, i) => ({
      layer: i + 1,
      duration: 14,
      timestamp: i,
    }));

    const label = render(series)
      .filter((o) => o.op === 'fillText')
      .find((o) => String(o.args[0]).startsWith('L30: '));
    expect(label).toBeDefined();

    const [text, x, , align] = label!.args as [string, number, number, string];
    const width = text.length * CHAR_W;
    const [left, right] = align === 'right' ? [x - width, x] : [x, x + width];
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(W);
  });
});
