/**
 * Where to draw a canvas chart label so it stays inside the canvas (ELEG-174).
 *
 * Pure: the caller measures the text with `ctx.measureText` and applies the result.
 * Canvas text is clipped at the bitmap edge, and CSS cannot help (see the truncation
 * rule at the top of `styles/main.css`), so the placement has to be decided here.
 */

export interface LabelPlacement {
  x: number;
  align: 'left' | 'center' | 'right';
}

/**
 * An axis tick label, centred on its tick unless that would run off either edge — then
 * it is anchored to the edge instead. The last time label of the temperature chart sat
 * centred on the plot's right edge with 12px of padding, so half of "00:16:40" fell off
 * the canvas and it read "00:16:4".
 */
export function placeTickLabel(
  tickX: number,
  textWidth: number,
  canvasWidth: number,
): LabelPlacement {
  const half = textWidth / 2;
  if (tickX + half > canvasWidth) return { x: canvasWidth, align: 'right' };
  if (tickX - half < 0) return { x: 0, align: 'left' };
  return { x: tickX, align: 'center' };
}

/**
 * A value label beside a series' last point: to its right when it fits, otherwise to its
 * left. The last point normally sits on the plot's right edge, so the label usually goes
 * left.
 */
export function placeEndLabel(
  pointX: number,
  textWidth: number,
  canvasWidth: number,
  gap: number,
): LabelPlacement {
  if (pointX + gap + textWidth <= canvasWidth) return { x: pointX + gap, align: 'left' };
  return { x: pointX - gap, align: 'right' };
}
