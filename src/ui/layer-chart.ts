/** Layer time chart — plots duration per layer with layer numbers on X-axis */

import type { PrinterState } from '../printer-state';
import { $ } from './helpers';

const PADDING = { top: 10, right: 12, bottom: 28, left: 48 };
const GRID_COLOR = 'rgba(160, 160, 184, 0.12)';
const LABEL_COLOR = '#a0a0b8';
const LABEL_FONT = '10px -apple-system, BlinkMacSystemFont, sans-serif';
const SERIES_COLOR = '#ab47bc';

let lastDataLen = -1;

export function renderLayerTimeChart(state: PrinterState): void {
  const canvas = $('chart-layer-time') as HTMLCanvasElement | null;
  if (!canvas) return;

  const layerTimes = state.layerTimes;
  if (layerTimes.length === lastDataLen) return;
  lastDataLen = layerTimes.length;

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

  if (layerTimes.length < 2) {
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for layer data...', w / 2, h / 2);
    return;
  }

  // Determine visible range — show last N layers that fit, or all
  const maxVisible = Math.min(layerTimes.length, 200);
  const visible = layerTimes.slice(-maxVisible);

  const plotW = w - PADDING.left - PADDING.right;
  const plotH = h - PADDING.top - PADDING.bottom;

  // X: layer numbers
  const xMin = visible[0].layer;
  const xMax = visible[visible.length - 1].layer;
  const xRange = Math.max(1, xMax - xMin);

  // Y: duration in seconds
  let yMax = 0;
  for (const lt of visible) {
    if (lt.duration > yMax) yMax = lt.duration;
  }
  yMax = yMax * 1.15 || 10; // 15% headroom

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

  // Draw line
  ctx.strokeStyle = SERIES_COLOR;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (const lt of visible) {
    const x = xMap(lt.layer);
    const y = yMap(lt.duration);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill area under the curve
  if (visible.length >= 2) {
    ctx.fillStyle = 'rgba(171, 71, 188, 0.12)';
    ctx.beginPath();
    ctx.moveTo(xMap(visible[0].layer), yMap(0));
    for (const lt of visible) {
      ctx.lineTo(xMap(lt.layer), yMap(lt.duration));
    }
    ctx.lineTo(xMap(visible[visible.length - 1].layer), yMap(0));
    ctx.closePath();
    ctx.fill();
  }

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

  // Current value label at rightmost point
  const last = visible[visible.length - 1];
  ctx.fillStyle = SERIES_COLOR;
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `L${last.layer}: ${last.duration.toFixed(1)}s`,
    xMap(last.layer) + 6,
    yMap(last.duration)
  );

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
}
