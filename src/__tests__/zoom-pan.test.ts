import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_SCALE,
  IDENTITY,
  MAX_SCALE,
  clampView,
  panBy,
  toggleZoom,
  wheelFactor,
  zoomAt,
} from '../ui/zoom-pan';

/** ELEG-158: zoom/pan maths behind the enlarged camera view. */
const box = { w: 400, h: 225 };

/** Where an unscaled image point lands on screen under a view. */
const project = (v: { scale: number; x: number; y: number }, px: number, py: number) => [
  v.x + px * v.scale,
  v.y + py * v.scale,
];

describe('zoomAt', () => {
  it('keeps the point under the finger fixed', () => {
    const v = zoomAt(IDENTITY, 2, 100, 50, box);
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    // The image point that was at (100, 50) is still drawn at (100, 50).
    expect(project(v, 100, 50)).toEqual([100, 50]);
  });

  it('keeps the point fixed when zooming an already-zoomed view', () => {
    const start = { scale: 2, x: -100, y: -50 };
    const v = zoomAt(start, 1.5, 300, 150, box);
    expect(v.scale).toBe(3);
    // Screen point (300,150) showed image point ((300+100)/2, (150+50)/2) = (200, 100).
    expect(project(v, 200, 100)).toEqual([300, 150]);
  });

  it('never zooms out past the fitted view', () => {
    expect(zoomAt({ scale: 2, x: -100, y: -50 }, 0.1, 0, 0, box)).toEqual(IDENTITY);
  });

  it('caps the zoom at MAX_SCALE', () => {
    expect(zoomAt(IDENTITY, 100, 0, 0, box).scale).toBe(MAX_SCALE);
  });
});

describe('panBy / clampView', () => {
  it('cannot pan the fitted view at all', () => {
    expect(panBy(IDENTITY, 50, -50, box)).toEqual(IDENTITY);
  });

  it('pans a zoomed view, stopping at the image edges', () => {
    const z = { scale: 2, x: -100, y: -50 };
    expect(panBy(z, 30, -20, box)).toEqual({ scale: 2, x: -70, y: -70 });
    // Past the left/top edge: x, y may not go above 0.
    expect(panBy(z, 500, 500, box)).toEqual({ scale: 2, x: 0, y: 0 });
    // Past the right/bottom edge: x >= w(1-s) = -400, y >= h(1-s) = -225.
    expect(panBy(z, -5000, -5000, box)).toEqual({ scale: 2, x: -400, y: -225 });
  });

  it('pulls an out-of-range scale back into range', () => {
    expect(clampView({ scale: 0.5, x: 10, y: 10 }, box)).toEqual(IDENTITY);
  });
});

describe('toggleZoom', () => {
  it('zooms in on the tapped point from the fitted view', () => {
    const v = toggleZoom(IDENTITY, 200, 100, box);
    expect(v.scale).toBe(DOUBLE_TAP_SCALE);
    expect(project(v, 200, 100)).toEqual([200, 100]);
  });

  it('returns to the fitted view from any zoom', () => {
    expect(toggleZoom({ scale: 3, x: -200, y: -100 }, 10, 10, box)).toEqual(IDENTITY);
  });
});

describe('wheelFactor', () => {
  it('zooms in on scroll up, out on scroll down, symmetrically', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1, 12);
  });
});
