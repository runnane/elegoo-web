/** Lightweight canvas-based live line chart — no dependencies */

import type { ChartStore, Series } from '../chart-store';
import { saveChartWindow, getChartWindow } from './ui-settings';

const PADDING = { top: 10, right: 12, bottom: 24, left: 48 };
const GRID_COLOR = 'rgba(160, 160, 184, 0.12)';
const LABEL_COLOR = '#a0a0b8';
const LABEL_FONT = '10px -apple-system, BlinkMacSystemFont, sans-serif';

interface ChartConfig {
  canvasId: string;
  seriesKeys: string[];
  /** Fixed Y-axis range, or auto-scale if omitted */
  yMin?: number;
  yMax?: number;
  /** Duration shown on x-axis in seconds (default 300 = 5 min) */
  window?: number;
  unit?: string;
  /** Series keys to show all-time average as dashed horizontal line */
  averageKeys?: string[];
}

/** Per-chart zoom/pan state */
interface ChartInteraction {
  panOffset: number; // ms offset (negative = looking at past)
  zoomFactor: number; // 1.0 = normal, >1 = zoomed in
  isDragging: boolean;
  dragStartX: number;
  dragStartOffset: number;
  /** Mouse X in CSS pixels relative to canvas, or -1 if not hovering */
  hoverX: number;
}

const charts = new Map<string, ChartConfig>();
const interactions = new Map<string, ChartInteraction>();
let store: ChartStore | null = null;
let animating = false;
let interactionsBound = false;

export function registerChart(config: ChartConfig): void {
  charts.set(config.canvasId, config);
  interactions.set(config.canvasId, {
    panOffset: 0,
    zoomFactor: 1.0,
    isDragging: false,
    dragStartX: 0,
    dragStartOffset: 0,
    hoverX: -1,
  });
}

export function initCharts(chartStore: ChartStore): void {
  store = chartStore;
  bindTimeWindowButtons();
  if (!interactionsBound) {
    interactionsBound = true;
    bindChartInteractions();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !animating) {
        animating = true;
        drawLoop();
      }
    });
  }
  if (!animating) {
    animating = true;
    drawLoop();
  }
}

function bindTimeWindowButtons(): void {
  document.querySelectorAll('.chart-time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const canvasId = el.dataset.chart!;
      const seconds = parseInt(el.dataset.window!);
      const config = charts.get(canvasId);
      if (config) {
        config.window = seconds;
        saveChartWindow(canvasId, seconds);
      }
      // Update active state for this chart's buttons
      const parent = el.parentElement;
      parent?.querySelectorAll('.chart-time-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    });
  });

  // Restore saved chart windows
  for (const [canvasId, config] of charts) {
    const saved = getChartWindow(canvasId);
    if (saved) {
      config.window = saved;
      // Update active button state
      const btns = document.querySelectorAll(`.chart-time-btn[data-chart="${canvasId}"]`);
      btns.forEach(b => {
        const el = b as HTMLElement;
        b.classList.toggle('active', parseInt(el.dataset.window!) === saved);
      });
    }
  }
}

function bindChartInteractions(): void {
  for (const [canvasId] of charts) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) continue;

    const inter = interactions.get(canvasId)!;

    // Wheel to zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.8 : 1.25; // scroll down = zoom out, up = zoom in
      inter.zoomFactor = Math.max(0.1, Math.min(10, inter.zoomFactor * delta));
    }, { passive: false });

    // Drag to pan
    canvas.addEventListener('mousedown', (e) => {
      inter.isDragging = true;
      inter.hoverX = -1; // Hide tooltip while dragging
      inter.dragStartX = e.clientX;
      inter.dragStartOffset = inter.panOffset;
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!inter.isDragging) return;
      const config = charts.get(canvasId)!;
      const rect = canvas.getBoundingClientRect();
      const plotW = rect.width - PADDING.left - PADDING.right;
      const windowSec = (config.window ?? 300) / inter.zoomFactor;
      const msPerPx = (windowSec * 1000) / plotW;
      const dx = e.clientX - inter.dragStartX;
      inter.panOffset = inter.dragStartOffset + dx * msPerPx;
      // Prevent panning into the future
      if (inter.panOffset > 0) inter.panOffset = 0;
    });

    canvas.addEventListener('mouseup', () => {
      inter.isDragging = false;
      canvas.style.cursor = 'default';
    });

    canvas.addEventListener('mouseleave', () => {
      inter.isDragging = false;
      canvas.style.cursor = 'default';
      inter.hoverX = -1;
    });

    // Track hover position for tooltip
    canvas.addEventListener('mousemove', (e) => {
      if (inter.isDragging) return; // handled above
      const rect = canvas.getBoundingClientRect();
      inter.hoverX = e.clientX - rect.left;
    });

    // Double-click to reset
    canvas.addEventListener('dblclick', () => {
      inter.panOffset = 0;
      inter.zoomFactor = 1.0;
    });
  }
}

function drawLoop(): void {
  if (document.hidden) {
    animating = false;
    return;
  }
  for (const [, config] of charts) {
    drawChart(config);
  }
  requestAnimationFrame(drawLoop);
}

function drawChart(config: ChartConfig): void {
  if (!store) return;
  const canvas = document.getElementById(config.canvasId) as HTMLCanvasElement | null;
  if (!canvas) return;

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

  const plotW = w - PADDING.left - PADDING.right;
  const plotH = h - PADDING.top - PADDING.bottom;
  const inter = interactions.get(config.canvasId);
  const zoomFactor = inter?.zoomFactor ?? 1.0;
  const panOffset = inter?.panOffset ?? 0;
  const windowSec = (config.window ?? 300) / zoomFactor;
  const now = Date.now();
  const tMax = now + panOffset;
  const tMin = tMax - windowSec * 1000;

  // Collect all series
  const allSeries: Series[] = [];
  for (const key of config.seriesKeys) {
    const s = store.getSeries(key);
    if (s) allSeries.push(s);
  }

  // Y-axis range
  let yMin = config.yMin ?? Infinity;
  let yMax = config.yMax ?? -Infinity;
  if (yMin === Infinity || yMax === -Infinity) {
    for (const s of allSeries) {
      for (const p of s.data) {
        if (p.t >= tMin) {
          if (p.v < yMin) yMin = p.v;
          if (p.v > yMax) yMax = p.v;
        }
      }
    }
    if (yMin === Infinity) { yMin = 0; yMax = 100; }
    const padding = (yMax - yMin) * 0.1 || 10;
    yMin = Math.max(0, yMin - padding);
    yMax = yMax + padding;
  }

  const xMap = (t: number) => PADDING.left + ((t - tMin) / (tMax - tMin)) * plotW;
  const yMap = (v: number) => PADDING.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Grid lines (Y)
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  const ySteps = 5;
  const yStep = (yMax - yMin) / ySteps;
  ctx.font = LABEL_FONT;
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= ySteps; i++) {
    const val = yMin + i * yStep;
    const y = yMap(val);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(w - PADDING.right, y);
    ctx.stroke();
    const label = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : Math.round(val).toString();
    ctx.fillText(label + (config.unit ?? ''), PADDING.left - 4, y);
  }

  // Grid lines (X) — time labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xGridCount = Math.min(6, Math.floor(plotW / 60));
  for (let i = 0; i <= xGridCount; i++) {
    const t = tMin + (i / xGridCount) * (tMax - tMin);
    const x = xMap(t);
    ctx.beginPath();
    ctx.moveTo(x, PADDING.top);
    ctx.lineTo(x, PADDING.top + plotH);
    ctx.stroke();
    const d = new Date(t);
    ctx.fillText(
      `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`,
      x, PADDING.top + plotH + 4
    );
  }

  // Draw each series
  for (const s of allSeries) {
    const visible = s.data.filter(p => p.t >= tMin);
    if (visible.length < 2) continue;

    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();

    let started = false;
    for (const p of visible) {
      const x = xMap(p.t);
      const y = yMap(p.v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current value label at the right end
    const last = visible[visible.length - 1];
    if (last) {
      ctx.fillStyle = s.color;
      ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        `${s.label}: ${last.v.toFixed(1)}`,
        xMap(last.t) + 4,
        yMap(last.v)
      );
    }
  }

  // Draw average lines (dashed) for configured series
  if (config.averageKeys?.length) {
    for (const key of config.averageKeys) {
      const s = allSeries.find(sr => store!.getSeries(key) === sr);
      if (!s) continue;
      // Compute average over ALL data (not just visible window) — represents whole print
      const allData = s.data.filter(p => p.v > 0);
      if (allData.length < 2) continue;
      const avg = allData.reduce((sum, p) => sum + p.v, 0) / allData.length;
      const y = yMap(avg);
      if (y < PADDING.top || y > PADDING.top + plotH) continue;

      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(w - PADDING.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.6;
      ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`avg ${avg.toFixed(1)}`, w - PADDING.right - 2, y - 2);
      ctx.restore();
    }
  }

  // Show zoom/pan indicator if not at defaults
  if (inter && (inter.zoomFactor !== 1.0 || inter.panOffset !== 0)) {
    ctx.fillStyle = 'rgba(33, 150, 243, 0.3)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const zoomLabel = `${inter.zoomFactor.toFixed(1)}x`;
    const panLabel = inter.panOffset !== 0 ? ` pan:${(inter.panOffset / 1000).toFixed(0)}s` : '';
    ctx.fillText(`🔍 ${zoomLabel}${panLabel} (dblclick to reset)`, PADDING.left + 4, PADDING.top + 2);
  }

  // ── Tooltip on hover ──
  if (inter && inter.hoverX >= PADDING.left && inter.hoverX <= w - PADDING.right) {
    const hoverT = tMin + ((inter.hoverX - PADDING.left) / plotW) * (tMax - tMin);

    // Vertical crosshair line
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(inter.hoverX, PADDING.top);
    ctx.lineTo(inter.hoverX, PADDING.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Find nearest data point per series and build tooltip lines
    const tooltipLines: { color: string; label: string; value: string; y: number }[] = [];
    for (const s of allSeries) {
      // Binary-ish search: find nearest point to hoverT
      let best = s.data[0];
      let bestDist = Infinity;
      for (const p of s.data) {
        const dist = Math.abs(p.t - hoverT);
        if (dist < bestDist) { bestDist = dist; best = p; }
        if (p.t > hoverT) break; // data is sorted by time
      }
      if (best && bestDist < (tMax - tMin) * 0.05) {
        tooltipLines.push({
          color: s.color,
          label: s.label,
          value: best.v.toFixed(1) + (config.unit ?? ''),
          y: yMap(best.v),
        });
      }
    }

    if (tooltipLines.length > 0) {
      // Draw dots on the crosshair at each series value
      for (const line of tooltipLines) {
        ctx.fillStyle = line.color;
        ctx.beginPath();
        ctx.arc(inter.hoverX, line.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Tooltip box
      const tooltipFont = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.font = tooltipFont;

      // Time header
      const d = new Date(hoverT);
      const timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

      // Measure tooltip dimensions
      const lineHeight = 16;
      const tooltipPadding = 8;
      let maxTextWidth = ctx.measureText(timeStr).width;
      for (const line of tooltipLines) {
        const text = `${line.label}: ${line.value}`;
        const tw = ctx.measureText(text).width;
        if (tw > maxTextWidth) maxTextWidth = tw;
      }
      const boxW = maxTextWidth + tooltipPadding * 2 + 12; // 12 for color dot
      const boxH = lineHeight * (tooltipLines.length + 1) + tooltipPadding * 2;

      // Position: prefer right of cursor, flip if near edge
      let boxX = inter.hoverX + 12;
      if (boxX + boxW > w - 4) {
        boxX = inter.hoverX - boxW - 12;
      }
      let boxY = PADDING.top + 4;

      // Background
      ctx.fillStyle = 'rgba(30, 30, 44, 0.92)';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 4);
      ctx.fill();
      ctx.stroke();

      // Time header
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = tooltipFont;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(timeStr, boxX + tooltipPadding, boxY + tooltipPadding);

      // Series values
      for (let i = 0; i < tooltipLines.length; i++) {
        const line = tooltipLines[i];
        const ty = boxY + tooltipPadding + (i + 1) * lineHeight;
        // Color dot
        ctx.fillStyle = line.color;
        ctx.beginPath();
        ctx.arc(boxX + tooltipPadding + 4, ty + 6, 3, 0, Math.PI * 2);
        ctx.fill();
        // Text
        ctx.fillStyle = '#e0e0e8';
        ctx.fillText(`${line.label}: ${line.value}`, boxX + tooltipPadding + 12, ty);
      }
    }
  }
}
