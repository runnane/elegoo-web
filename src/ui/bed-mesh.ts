/** Bed mesh visualization — renders a heatmap of bed leveling data */

import type { PrinterState } from '../printer-state';
import { $ } from './helpers';

let lastDataKey = '';

export function renderBedMesh(state: PrinterState): void {
  const container = $('bed-mesh-canvas');
  if (!container || !(container instanceof HTMLCanvasElement)) return;

  const mesh = state.bedMesh;
  if (!mesh || !mesh.length) {
    const ctx = container.getContext('2d');
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      container.width = rect.width * dpr;
      container.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = '#6a6a80';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No bed mesh data available', rect.width / 2, rect.height / 2);
    }
    return;
  }

  const key = JSON.stringify(mesh);
  if (key === lastDataKey) return;
  lastDataKey = key;

  const rows = mesh.length;
  const cols = mesh[0].length;

  // Collect all values for min/max
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const row of mesh) {
    for (const val of row) {
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
  }

  const range = maxVal - minVal || 0.1;

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  container.width = w * dpr;
  container.height = h * dpr;

  const ctx = container.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { left: 30, right: 50, top: 10, bottom: 10 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const cellW = plotW / cols;
  const cellH = plotH / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = mesh[r][c];
      const norm = (val - minVal) / range; // 0..1
      const color = meshColor(norm);
      const x = pad.left + c * cellW;
      const y = pad.top + r * cellH;

      ctx.fillStyle = color;
      ctx.fillRect(x, y, cellW - 1, cellH - 1);

      // Show value
      ctx.fillStyle = norm > 0.5 ? '#000' : '#fff';
      ctx.font = `${Math.min(11, cellW / 4)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(val.toFixed(3), x + cellW / 2, y + cellH / 2);
    }
  }

  // Color scale legend
  const legendW = 16;
  const legendH = plotH;
  const lx = w - pad.right + 10;
  const ly = pad.top;

  for (let i = 0; i < legendH; i++) {
    const norm = 1 - i / legendH;
    ctx.fillStyle = meshColor(norm);
    ctx.fillRect(lx, ly + i, legendW, 1);
  }

  ctx.fillStyle = '#a0a0b8';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${maxVal.toFixed(3)}`, lx + legendW + 4, ly);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${minVal.toFixed(3)}`, lx + legendW + 4, ly + legendH);
}

/** Map 0..1 to a blue→green→yellow→red gradient */
function meshColor(norm: number): string {
  let r: number, g: number, b: number;
  if (norm < 0.25) {
    const t = norm / 0.25;
    r = 0; g = Math.round(t * 255); b = 255;
  } else if (norm < 0.5) {
    const t = (norm - 0.25) / 0.25;
    r = 0; g = 255; b = Math.round(255 * (1 - t));
  } else if (norm < 0.75) {
    const t = (norm - 0.5) / 0.25;
    r = Math.round(t * 255); g = 255; b = 0;
  } else {
    const t = (norm - 0.75) / 0.25;
    r = 255; g = Math.round(255 * (1 - t)); b = 0;
  }
  return `rgb(${r}, ${g}, ${b})`;
}
