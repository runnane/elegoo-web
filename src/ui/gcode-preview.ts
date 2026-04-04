/** Gcode preview — 2D side-view visualization of current print layer progress */

import type { PrinterState } from '../printer-state';
import { $ } from './helpers';

let lastKey = '';

export function renderGcodePreview(state: PrinterState): void {
  const canvas = $('gcode-preview-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;

  const s = state.status;
  const ps = s?.print_status;
  const isPrinting = s?.machine_status?.status === 2;

  if (!isPrinting || !ps) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = '#6a6a80';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Start a print to see layer preview', rect.width / 2, rect.height / 2);
    }
    lastKey = '';
    return;
  }

  const currentLayer = ps.current_layer ?? 0;
  const totalLayer = ps.total_layer ?? state.fileTotalLayers ?? 0;
  const progress = s.machine_status?.progress ?? 0;
  const zPos = s.gcode_move?.z ?? 0;

  const key = `${currentLayer}-${totalLayer}-${progress}-${zPos.toFixed(1)}`;
  if (key === lastKey) return;
  lastKey = key;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { left: 60, right: 20, top: 20, bottom: 30 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Map layer number to Y position (0 = bottom, totalLayer = top)
  const yOf = (layer: number) =>
    pad.top + plotH * (1 - (totalLayer > 0 ? layer / totalLayer : 0));

  // Draw bed plate (bottom)
  ctx.fillStyle = '#343448';
  ctx.fillRect(pad.left, yOf(0), plotW, 4);

  if (totalLayer > 0) {
    // Remaining layers — dark block (current → top)
    const topY = yOf(totalLayer);
    const curY = yOf(currentLayer);
    ctx.fillStyle = 'rgba(160, 160, 184, 0.06)';
    ctx.fillRect(pad.left + 10, topY, plotW - 20, curY - topY);

    // Completed layers — gradient block (bottom → current)
    const bottomY = yOf(0);
    if (currentLayer > 0) {
      const grad = ctx.createLinearGradient(0, bottomY, 0, curY);
      grad.addColorStop(0, 'rgba(33, 150, 243, 0.25)');
      grad.addColorStop(1, 'rgba(33, 150, 243, 0.65)');
      ctx.fillStyle = grad;
      ctx.fillRect(pad.left + 10, curY, plotW - 20, bottomY - curY);

      // Current layer highlight line
      ctx.fillStyle = '#2196f3';
      ctx.fillRect(pad.left + 10, curY - 1, plotW - 20, 3);

      // Nozzle indicator (red triangle, pointing down at current layer)
      const nozzleX = pad.left + plotW / 2;
      ctx.fillStyle = '#ef5350';
      ctx.beginPath();
      ctx.moveTo(nozzleX, curY - 3);
      ctx.lineTo(nozzleX - 6, curY - 14);
      ctx.lineTo(nozzleX + 6, curY - 14);
      ctx.closePath();
      ctx.fill();
      // Nozzle body
      ctx.fillRect(nozzleX - 2, curY - 18, 4, 6);
    }

    // Y-axis layer markers
    ctx.fillStyle = '#a0a0b8';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const markers = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * totalLayer));
    for (const m of markers) {
      const y = yOf(m);
      ctx.fillStyle = '#a0a0b8';
      ctx.fillText(String(m), pad.left - 6, y);
      ctx.strokeStyle = 'rgba(160, 160, 184, 0.12)';
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
    }

    // Current layer label on Y-axis
    if (currentLayer > 0) {
      ctx.fillStyle = '#2196f3';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`→ ${currentLayer}`, pad.left - 6, curY);
    }
  }

  // Info text at bottom
  ctx.fillStyle = '#a0a0b8';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const infoText = `Layer ${currentLayer}/${totalLayer || '??'} · Z: ${zPos.toFixed(1)}mm · ${progress}%`;
  ctx.fillText(infoText, w / 2, h - pad.bottom + 10);
}
