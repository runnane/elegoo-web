/**
 * Zoom and pan maths for the enlarged camera view (ELEG-158) — the pure half.
 *
 * Free of the DOM so it can be tested directly; `camera-zoom.ts` owns the pointer and
 * wheel events and applies the result as `transform: translate(x, y) scale(scale)` with
 * `transform-origin: 0 0`.
 *
 * Coordinates are in the element's own layout box (`w` × `h`, before the transform).
 * A point `p` of the unscaled image is drawn at `t + p * scale`, so keeping the point
 * under the finger fixed while zooming means solving that for the new `t`.
 */

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Box {
  w: number;
  h: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
/** The zoom a double-tap jumps to from the fitted view. */
export const DOUBLE_TAP_SCALE = 2.5;

export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Keep the scaled image covering its box: no zooming out past the fitted view, and no
 * panning that would show empty space beside the image.
 */
export function clampView(v: View, box: Box): View {
  const scale = clamp(v.scale, MIN_SCALE, MAX_SCALE);
  return {
    scale,
    x: clamp(v.x, box.w * (1 - scale), 0),
    y: clamp(v.y, box.h * (1 - scale), 0),
  };
}

/** Multiply the zoom by `factor`, keeping the image point under (`px`, `py`) still. */
export function zoomAt(v: View, factor: number, px: number, py: number, box: Box): View {
  const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = scale / v.scale;
  return clampView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, box);
}

export function panBy(v: View, dx: number, dy: number, box: Box): View {
  return clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, box);
}

/** Double-tap: zoom in on the tapped point from the fitted view, otherwise back out. */
export function toggleZoom(v: View, px: number, py: number, box: Box): View {
  if (v.scale > MIN_SCALE) return { ...IDENTITY };
  return zoomAt(v, DOUBLE_TAP_SCALE, px, py, box);
}

/** Wheel delta (pixels) → zoom factor. Smooth, and symmetric in and out. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0015);
}
