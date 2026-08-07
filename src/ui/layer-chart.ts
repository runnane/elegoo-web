/** Layer time chart — plots duration per layer with layer numbers on X-axis */

import type { PrinterState } from '../printer-state';
import { $ } from './helpers';

const PADDING = { top: 10, right: 12, bottom: 28, left: 48 };
const GRID_COLOR = 'rgba(160, 160, 184, 0.12)';
const LABEL_COLOR = '#a0a0b8';
const LABEL_FONT = '10px -apple-system, BlinkMacSystemFont, sans-serif';
const SERIES_COLOR = '#ab47bc';
const MAX_VISIBLE = 200;

/** One entry of the layer-time series, as the server sends it over `/ws`. */
export interface LayerTimePoint {
  layer: number;
  duration: number;
  timestamp: number;
}

/**
 * Pick the window to plot: the last `maxVisible` entries of the **trailing
 * strictly-increasing run**.
 *
 * The series is not guaranteed monotonic. The printer reports the finished job's
 * `current_layer` for a moment after a print ends, so an entry belonging to the previous
 * print can sit in front of the new one (ELEG-16 — the server no longer creates those,
 * but a persisted series from before the fix still has one). Anything at or before the
 * last decrease belongs to a different print, so plotting it would mix two jobs on one
 * axis — and its duration spans the gap between them, which flattens every real layer
 * against the baseline.
 */
export function selectVisibleLayers(
  layerTimes: readonly LayerTimePoint[],
  maxVisible = MAX_VISIBLE,
): LayerTimePoint[] {
  let start = 0;
  for (let i = 1; i < layerTimes.length; i++) {
    if (layerTimes[i].layer <= layerTimes[i - 1].layer) start = i;
  }
  const run = layerTimes.slice(start);
  return run.length > maxVisible ? run.slice(-maxVisible) : run;
}

/**
 * The plot's domain, from the **actual** min/max rather than the first and last entries.
 * Taking the endpoints assumes the window is sorted; when it is not, out-of-domain points
 * map to negative X and paint over the axis gutter instead of staying in the plot.
 */
export function computeDomain(visible: readonly LayerTimePoint[]): {
  xMin: number;
  xMax: number;
  xRange: number;
  yMax: number;
} {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let peak = 0;
  for (const lt of visible) {
    if (lt.layer < xMin) xMin = lt.layer;
    if (lt.layer > xMax) xMax = lt.layer;
    if (lt.duration > peak) peak = lt.duration;
  }
  if (!Number.isFinite(xMin)) {
    xMin = 0;
    xMax = 0;
  }
  return {
    xMin,
    xMax,
    xRange: Math.max(1, xMax - xMin),
    yMax: peak * 1.15 || 10, // 15% headroom
  };
}

let lastDataLen = -1;
let hoverX = -1; // CSS pixels relative to canvas, -1 = not hovering
let hoverBound = false;
let lastState: PrinterState | null = null;

function bindHover(canvas: HTMLCanvasElement): void {
  if (hoverBound) return;
  hoverBound = true;

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    hoverX = e.clientX - rect.left;
    // Force redraw with hover
    if (lastState) drawLayerChart(canvas, lastState);
  });

  canvas.addEventListener('mouseleave', () => {
    hoverX = -1;
    if (lastState) drawLayerChart(canvas, lastState);
  });
}

export function renderLayerTimeChart(state: PrinterState): void {
  const canvas = $('chart-layer-time') as HTMLCanvasElement | null;
  if (!canvas) return;

  bindHover(canvas);
  lastState = state;

  const layerTimes = state.layerTimes;
  // Always redraw when data was cleared (length went to 0 but canvas still has old drawing)
  if (layerTimes.length === lastDataLen && layerTimes.length > 0 && hoverX === -1) return;
  lastDataLen = layerTimes.length;

  drawLayerChart(canvas, state);
}

function drawLayerChart(canvas: HTMLCanvasElement, state: PrinterState): void {
  const layerTimes = state.layerTimes;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Determine visible range — the current print's last N layers
  const visible = selectVisibleLayers(layerTimes);
  if (visible.length < 2) {
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for layer data...', w / 2, h / 2);
    return;
  }

  const plotW = w - PADDING.left - PADDING.right;
  const plotH = h - PADDING.top - PADDING.bottom;

  const { xMin, xRange, yMax } = computeDomain(visible);

  const xMap = (layer: number) => PADDING.left + ((layer - xMin) / xRange) * plotW;
  const yMap = (dur: number) => PADDING.top + plotH - (dur / yMax) * plotH;

  // Y grid
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.font = LABEL_FONT;
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const ySteps = 5;
  const yStep = yMax / ySteps;
  for (let i = 0; i <= ySteps; i++) {
    const val = i * yStep;
    const y = yMap(val);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(w - PADDING.right, y);
    ctx.stroke();
    ctx.fillText(`${Math.round(val)}s`, PADDING.left - 4, y);
  }

  // X grid — layer labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xGridCount = Math.min(8, Math.floor(plotW / 50));
  for (let i = 0; i <= xGridCount; i++) {
    const layer = Math.round(xMin + (i / xGridCount) * xRange);
    const x = xMap(layer);
    ctx.beginPath();
    ctx.moveTo(x, PADDING.top);
    ctx.lineTo(x, PADDING.top + plotH);
    ctx.stroke();
    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(`L${layer}`, x, PADDING.top + plotH + 4);
  }

  // Series, fill and dots are clipped to the plot rect — the domain above keeps every
  // point inside it, and this keeps that true for any data shape we have not thought of
  // rather than letting a stray point paint over the axis labels.
  ctx.save();
  ctx.beginPath();
  ctx.rect(PADDING.left, PADDING.top, plotW, plotH);
  ctx.clip();

  // Draw line
  ctx.strokeStyle = SERIES_COLOR;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (const lt of visible) {
    const x = xMap(lt.layer);
    const y = yMap(lt.duration);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill area under the curve
  ctx.fillStyle = 'rgba(171, 71, 188, 0.12)';
  ctx.beginPath();
  ctx.moveTo(xMap(visible[0].layer), yMap(0));
  for (const lt of visible) {
    ctx.lineTo(xMap(lt.layer), yMap(lt.duration));
  }
  ctx.lineTo(xMap(visible[visible.length - 1].layer), yMap(0));
  ctx.closePath();
  ctx.fill();

  // Draw dots on data points (only if not too many)
  if (visible.length <= 80) {
    ctx.fillStyle = SERIES_COLOR;
    for (const lt of visible) {
      const x = xMap(lt.layer);
      const y = yMap(lt.duration);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();

  // Current value label at rightmost point. The last point sits on the plot's right
  // edge, so the label only ever fits to its left.
  const last = visible[visible.length - 1];
  ctx.fillStyle = SERIES_COLOR;
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';
  const lastLabel = `L${last.layer}: ${last.duration.toFixed(1)}s`;
  const lastX = xMap(last.layer);
  if (lastX + 6 + ctx.measureText(lastLabel).width <= w) {
    ctx.textAlign = 'left';
    ctx.fillText(lastLabel, lastX + 6, yMap(last.duration));
  } else {
    ctx.textAlign = 'right';
    ctx.fillText(lastLabel, lastX - 6, yMap(last.duration));
  }

  // Average line
  const avgDuration = visible.reduce((s, lt) => s + lt.duration, 0) / visible.length;
  const avgY = yMap(avgDuration);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(171, 71, 188, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING.left, avgY);
  ctx.lineTo(w - PADDING.right, avgY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(171, 71, 188, 0.5)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`avg ${avgDuration.toFixed(1)}s`, w - PADDING.right - 4, avgY - 8);

  // ── Tooltip on hover ──
  if (hoverX >= PADDING.left && hoverX <= w - PADDING.right) {
    // Map hover X to layer number
    const hoverLayer = xMin + ((hoverX - PADDING.left) / plotW) * xRange;

    // Find nearest data point
    let best = visible[0];
    let bestDist = Infinity;
    for (const lt of visible) {
      const dist = Math.abs(lt.layer - hoverLayer);
      if (dist < bestDist) {
        bestDist = dist;
        best = lt;
      }
    }

    if (best && bestDist < xRange * 0.05 + 1) {
      const bx = xMap(best.layer);
      const by = yMap(best.duration);

      // Vertical crosshair line
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(bx, PADDING.top);
      ctx.lineTo(bx, PADDING.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Highlight dot
      ctx.fillStyle = SERIES_COLOR;
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();

      // Tooltip box
      const tooltipFont = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.font = tooltipFont;

      const line1 = `Layer ${best.layer}`;
      const line2 = `Duration: ${best.duration.toFixed(1)}s`;
      const diffFromAvg = best.duration - avgDuration;
      const line3 = `vs avg: ${diffFromAvg >= 0 ? '+' : ''}${diffFromAvg.toFixed(1)}s`;

      const lineHeight = 16;
      const tooltipPadding = 8;
      const maxTextWidth = Math.max(
        ctx.measureText(line1).width,
        ctx.measureText(line2).width,
        ctx.measureText(line3).width,
      );
      const boxW = maxTextWidth + tooltipPadding * 2;
      const boxH = lineHeight * 3 + tooltipPadding * 2;

      // Position: prefer right of point, flip if near edge
      let boxX = bx + 12;
      if (boxX + boxW > w - 4) {
        boxX = bx - boxW - 12;
      }
      const boxY = Math.max(PADDING.top, by - boxH / 2);

      // Background
      ctx.fillStyle = 'rgba(30, 30, 44, 0.92)';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 4);
      ctx.fill();
      ctx.stroke();

      // Text
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText(line1, boxX + tooltipPadding, boxY + tooltipPadding);
      ctx.fillStyle = '#e0e0e8';
      ctx.fillText(line2, boxX + tooltipPadding, boxY + tooltipPadding + lineHeight);
      ctx.fillStyle = diffFromAvg > 0 ? '#ef5350' : '#66bb6a';
      ctx.fillText(line3, boxX + tooltipPadding, boxY + tooltipPadding + lineHeight * 2);
    }
  }
}
