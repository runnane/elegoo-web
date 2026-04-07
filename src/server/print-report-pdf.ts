/**
 * Print Report PDF Generator — produces a summary PDF from collected print data.
 *
 * Uses PDFKit to draw charts, embed snapshots, and format statistics.
 */

import PDFDocument from 'pdfkit';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { PrintReport } from './print-report-collector.js';
import type { ChartPoint } from './state-store.js';
import { getLogger } from './logger.js';

const log = getLogger('PDF');

/** Color palette matching the web UI dark theme */
const COLORS = {
  accent: '#4fc3f7',
  nozzle: '#ff6b35',
  nozzleTgt: '#cc5500',
  bed: '#4fc3f7',
  bedTgt: '#2196f3',
  chamber: '#66bb6a',
  fanPart: '#4fc3f7',
  fanAux: '#ffa726',
  fanCase: '#ab47bc',
  layerLine: '#4fc3f7',
  layerAvg: '#ff6b35',
  grid: '#cccccc',
  text: '#333333',
  muted: '#777777',
  success: '#4caf50',
  error: '#ef5350',
  warning: '#ffa726',
  bg: '#ffffff',
  cardBg: '#f8f9fa',
};

/** Generate a PDF report and return it as a Buffer */
export async function generateReportPDF(
  report: PrintReport,
  chartData: ChartPoint[],
  reportsDir: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 40, left: 50, right: 50 },
      info: {
        Title: `Print Report — ${report.filename}`,
        Author: 'Elegoo CC2 Web Frontend',
        Subject: `Print report for ${report.filename}`,
        CreationDate: new Date(),
      },
    });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawReport(doc, report, chartData, reportsDir);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawReport(doc: PDFKit.PDFDocument, report: PrintReport, chartData: ChartPoint[], reportsDir: string): void {
  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // === HEADER ===
  drawHeader(doc, report, pageW);

  // === PRINT SUMMARY CARD ===
  doc.moveDown(0.5);
  drawSummaryCard(doc, report, pageW);

  // === TEMPERATURE CHART ===
  if (chartData.length > 10) {
    doc.moveDown(1);
    drawSectionTitle(doc, 'Temperature History');
    drawTemperatureChart(doc, chartData, pageW);
  }

  // === FAN SPEED CHART ===
  if (chartData.length > 10) {
    doc.moveDown(1);
    drawSectionTitle(doc, 'Fan Speed History');
    drawFanChart(doc, chartData, pageW);
  }

  // === LAYER TIME CHART ===
  if (report.layerStats.layers.length > 2) {
    doc.moveDown(1);
    // Check if we need a new page
    if (doc.y > doc.page.height - 250) doc.addPage();
    drawSectionTitle(doc, 'Layer Duration');
    drawLayerChart(doc, report, pageW);
  }

  // === FILAMENT USAGE ===
  if (report.filament.length > 0) {
    doc.moveDown(1);
    if (doc.y > doc.page.height - 150) doc.addPage();
    drawSectionTitle(doc, 'Filament Usage');
    drawFilamentTable(doc, report, pageW);
  }

  // === SNAPSHOTS ===
  if (report.snapshots.length > 0) {
    doc.addPage();
    drawSectionTitle(doc, 'Camera Snapshots');
    drawSnapshots(doc, report, reportsDir, pageW);
  }

  // === EVENT LOG ===
  if (report.events.length > 0) {
    if (doc.y > doc.page.height - 200) doc.addPage();
    doc.moveDown(1);
    drawSectionTitle(doc, 'Event Log');
    drawEventLog(doc, report);
  }

  // === FOOTER on last page ===
  const footerY = doc.page.height - doc.page.margins.bottom - 15;
  doc.fontSize(8).fillColor(COLORS.muted)
    .text(`Generated ${new Date().toISOString()} — Elegoo CC2 Web Frontend`, doc.page.margins.left, footerY, { align: 'center', width: pageW });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Drawing helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawHeader(doc: PDFKit.PDFDocument, report: PrintReport, pageW: number): void {
  const outcomeColor = report.outcome === 'completed' ? COLORS.success
    : report.outcome === 'failed' ? COLORS.error
    : COLORS.warning;

  doc.fontSize(20).fillColor(COLORS.text).text('Print Report', { continued: false });
  doc.fontSize(12).fillColor(COLORS.muted).text(report.filename);
  doc.moveDown(0.3);

  // Outcome badge
  const outcomeText = report.outcome.charAt(0).toUpperCase() + report.outcome.slice(1);
  doc.fontSize(11).fillColor(outcomeColor).text(`● ${outcomeText}`, { continued: true });
  doc.fillColor(COLORS.muted).text(`  —  ${formatDuration(report.duration)}  —  ${new Date(report.startedAt).toLocaleString()}`);
}

function drawSummaryCard(doc: PDFKit.PDFDocument, report: PrintReport, pageW: number): void {
  const startY = doc.y + 5;
  const cardPad = 10;
  const colW = (pageW - cardPad * 2) / 3;

  // Card background
  doc.save();
  doc.roundedRect(doc.page.margins.left, startY, pageW, 110, 4)
    .fillColor(COLORS.cardBg).fill();
  doc.restore();

  const leftX = doc.page.margins.left + cardPad;
  let y = startY + cardPad;

  // Row 1: Printer info
  doc.fontSize(9).fillColor(COLORS.muted).text('PRINTER', leftX, y);
  doc.text('FIRMWARE', leftX + colW, y);
  doc.text('SERIAL', leftX + colW * 2, y);
  y += 12;
  doc.fontSize(10).fillColor(COLORS.text);
  doc.text(report.printer.model, leftX, y);
  doc.text(report.printer.firmware, leftX + colW, y);
  doc.text(report.printer.sn, leftX + colW * 2, y);
  y += 20;

  // Row 2: Temperature stats
  doc.fontSize(9).fillColor(COLORS.muted).text('NOZZLE TEMP', leftX, y);
  doc.text('BED TEMP', leftX + colW, y);
  doc.text('CHAMBER TEMP', leftX + colW * 2, y);
  y += 12;
  doc.fontSize(10).fillColor(COLORS.text);
  doc.text(formatTempStats(report.temperatureStats.nozzle), leftX, y);
  doc.text(formatTempStats(report.temperatureStats.bed), leftX + colW, y);
  doc.text(formatTempStats(report.temperatureStats.chamber), leftX + colW * 2, y);
  y += 20;

  // Row 3: Print stats
  doc.fontSize(9).fillColor(COLORS.muted).text('LAYERS', leftX, y);
  doc.text('DURATION', leftX + colW, y);
  doc.text('PROGRESS', leftX + colW * 2, y);
  y += 12;
  doc.fontSize(10).fillColor(COLORS.text);
  doc.text(`${report.layerStats.count} / ${report.stats.totalLayers || '?'}`, leftX, y);
  doc.text(formatDuration(report.duration), leftX + colW, y);
  doc.text(`${report.stats.progressAtEnd}%`, leftX + colW * 2, y);

  doc.y = startY + 115;
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  doc.fontSize(13).fillColor(COLORS.accent).text(title);
  doc.moveDown(0.3);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Chart drawing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawTemperatureChart(doc: PDFKit.PDFDocument, data: ChartPoint[], pageW: number): void {
  const chartH = 140;
  const chartW = pageW - 40;
  const chartX = doc.page.margins.left + 35;
  const chartY = doc.y;

  // Find max temp for Y scale
  let maxTemp = 0;
  for (const p of data) {
    const vals = [p.values.nozzle, p.values.nozzle_tgt, p.values.bed, p.values.bed_tgt, p.values.chamber];
    for (const v of vals) {
      if (v > maxTemp) maxTemp = v;
    }
  }
  maxTemp = Math.ceil(maxTemp / 50) * 50 + 20;
  if (maxTemp < 100) maxTemp = 100;

  drawChartGrid(doc, chartX, chartY, chartW, chartH, maxTemp, '°C', data);

  // Draw series
  const series: Array<{ key: string; color: string; dash?: number[] }> = [
    { key: 'bed', color: COLORS.bed },
    { key: 'bed_tgt', color: COLORS.bedTgt, dash: [2, 2] },
    { key: 'chamber', color: COLORS.chamber },
    { key: 'nozzle', color: COLORS.nozzle },
    { key: 'nozzle_tgt', color: COLORS.nozzleTgt, dash: [2, 2] },
  ];

  for (const s of series) {
    drawLineSeries(doc, data, s.key, chartX, chartY, chartW, chartH, maxTemp, s.color, s.dash);
  }

  // Legend
  const legendY = chartY + chartH + 8;
  let legendX = chartX;
  const legendItems = [
    { label: 'Nozzle', color: COLORS.nozzle },
    { label: 'Nozzle Target', color: COLORS.nozzleTgt },
    { label: 'Bed', color: COLORS.bed },
    { label: 'Bed Target', color: COLORS.bedTgt },
    { label: 'Chamber', color: COLORS.chamber },
  ];
  doc.fontSize(7).fillColor(COLORS.muted);
  for (const item of legendItems) {
    doc.save().rect(legendX, legendY + 1, 8, 6).fillColor(item.color).fill().restore();
    doc.text(item.label, legendX + 10, legendY, { continued: false });
    legendX += doc.widthOfString(item.label) + 20;
  }

  doc.y = legendY + 18;
}

function drawFanChart(doc: PDFKit.PDFDocument, data: ChartPoint[], pageW: number): void {
  const chartH = 100;
  const chartW = pageW - 40;
  const chartX = doc.page.margins.left + 35;
  const chartY = doc.y;
  const maxVal = 100;

  drawChartGrid(doc, chartX, chartY, chartW, chartH, maxVal, '%', data);

  drawLineSeries(doc, data, 'fan_model', chartX, chartY, chartW, chartH, maxVal, COLORS.fanPart);
  drawLineSeries(doc, data, 'fan_aux', chartX, chartY, chartW, chartH, maxVal, COLORS.fanAux);
  drawLineSeries(doc, data, 'fan_case', chartX, chartY, chartW, chartH, maxVal, COLORS.fanCase);

  // Legend
  const legendY = chartY + chartH + 8;
  let legendX = chartX;
  for (const item of [
    { label: 'Part Fan', color: COLORS.fanPart },
    { label: 'Aux Fan', color: COLORS.fanAux },
    { label: 'Case Fan', color: COLORS.fanCase },
  ]) {
    doc.save().rect(legendX, legendY + 1, 8, 6).fillColor(item.color).fill().restore();
    doc.fontSize(7).fillColor(COLORS.muted).text(item.label, legendX + 10, legendY, { continued: false });
    legendX += doc.widthOfString(item.label) + 20;
  }
  doc.y = legendY + 18;
}

function drawLayerChart(doc: PDFKit.PDFDocument, report: PrintReport, pageW: number): void {
  const layers = report.layerStats.layers;
  if (layers.length < 2) return;

  const chartH = 100;
  const chartW = pageW - 40;
  const chartX = doc.page.margins.left + 35;
  const chartY = doc.y;

  const maxDuration = Math.ceil(report.layerStats.maxDuration / 5) * 5 + 2;
  const maxLayer = layers[layers.length - 1][0];

  // Grid
  doc.save();
  doc.rect(chartX, chartY, chartW, chartH).strokeColor(COLORS.grid).lineWidth(0.5).stroke();

  // Y grid lines + labels
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxDuration / ySteps) * i;
    const y = chartY + chartH - (chartH * (val / maxDuration));
    doc.moveTo(chartX, y).lineTo(chartX + chartW, y).strokeColor(COLORS.grid).lineWidth(0.25).stroke();
    doc.fontSize(7).fillColor(COLORS.muted).text(`${val.toFixed(0)}s`, chartX - 30, y - 4, { width: 25, align: 'right' });
  }
  doc.restore();

  // Layer bars/line
  doc.save();
  doc.rect(chartX, chartY, chartW, chartH).clip();

  const step = layers.length > 1 ? chartW / (layers.length - 1) : chartW;
  doc.strokeColor(COLORS.layerLine).lineWidth(0.8);

  let first = true;
  for (let i = 0; i < layers.length; i++) {
    const x = chartX + i * step;
    const y = chartY + chartH - (chartH * (layers[i][1] / maxDuration));
    if (first) { doc.moveTo(x, y); first = false; }
    else doc.lineTo(x, y);
  }
  doc.stroke();

  // Average line
  const avgY = chartY + chartH - (chartH * (report.layerStats.avgDuration / maxDuration));
  doc.strokeColor(COLORS.layerAvg).lineWidth(0.5).dash(3, { space: 2 });
  doc.moveTo(chartX, avgY).lineTo(chartX + chartW, avgY).stroke();
  doc.undash();

  doc.restore();

  // X-axis labels
  doc.fontSize(7).fillColor(COLORS.muted);
  doc.text(`L1`, chartX, chartY + chartH + 3);
  doc.text(`L${maxLayer}`, chartX + chartW - 20, chartY + chartH + 3);

  // Legend
  const legendY = chartY + chartH + 15;
  doc.save().rect(chartX, legendY + 1, 8, 6).fillColor(COLORS.layerLine).fill().restore();
  doc.fontSize(7).fillColor(COLORS.muted).text('Layer Time', chartX + 10, legendY);
  doc.save().rect(chartX + 70, legendY + 1, 8, 6).fillColor(COLORS.layerAvg).fill().restore();
  doc.text(`Average (${report.layerStats.avgDuration.toFixed(1)}s)`, chartX + 80, legendY);

  doc.y = legendY + 18;
}

function drawFilamentTable(doc: PDFKit.PDFDocument, report: PrintReport, pageW: number): void {
  const colWidths = [pageW * 0.25, pageW * 0.2, pageW * 0.15, pageW * 0.2, pageW * 0.2];
  const headers = ['Spool', 'Material', 'Color', 'Used (m)', 'Used (g)'];
  const x = doc.page.margins.left;
  let y = doc.y;

  // Header row
  doc.fontSize(8).fillColor(COLORS.muted);
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], x + sumBefore(colWidths, i), y, { width: colWidths[i] });
  }
  y += 14;
  doc.moveTo(x, y).lineTo(x + pageW, y).strokeColor(COLORS.grid).lineWidth(0.5).stroke();
  y += 4;

  // Data rows
  doc.fontSize(9).fillColor(COLORS.text);
  for (const f of report.filament) {
    doc.text(f.trayKey, x, y, { width: colWidths[0] });
    doc.text(f.filamentType, x + colWidths[0], y, { width: colWidths[1] });

    // Color swatch
    const swatchX = x + colWidths[0] + colWidths[1] + 2;
    if (f.color) {
      doc.save().rect(swatchX, y + 1, 10, 8).fillColor(f.color).fill().restore();
      doc.fillColor(COLORS.text).text(f.color, swatchX + 14, y, { width: colWidths[2] - 14 });
    }

    doc.text(f.meters.toFixed(2), x + colWidths[0] + colWidths[1] + colWidths[2], y, { width: colWidths[3] });
    doc.text(f.grams.toFixed(1), x + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3], y, { width: colWidths[4] });
    y += 16;
  }

  doc.y = y + 4;
}

function drawSnapshots(doc: PDFKit.PDFDocument, report: PrintReport, reportsDir: string, pageW: number): void {
  const imgW = (pageW - 15) / 2;
  const imgH = imgW * 0.75;
  let col = 0;
  const x = doc.page.margins.left;

  for (const snap of report.snapshots) {
    // Check page space
    if (doc.y + imgH + 30 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }

    const imgX = col === 0 ? x : x + imgW + 15;
    const imgY = doc.y;

    try {
      const imgPath = join(reportsDir, report.id, snap.filename);
      doc.image(imgPath, imgX, imgY, { width: imgW, height: imgH, fit: [imgW, imgH] });
    } catch {
      // If image fails, draw placeholder
      doc.save()
        .rect(imgX, imgY, imgW, imgH)
        .fillColor('#eeeeee').fill()
        .restore();
      doc.fontSize(9).fillColor(COLORS.muted)
        .text('Image unavailable', imgX + imgW / 2 - 30, imgY + imgH / 2 - 5);
    }

    // Caption
    const captionY = imgY + imgH + 2;
    const time = new Date(snap.timestamp).toLocaleTimeString();
    doc.fontSize(7).fillColor(COLORS.muted)
      .text(`${time} — ${snap.progress}% — Layer ${snap.layer}`, imgX, captionY, { width: imgW });

    col++;
    if (col >= 2) {
      col = 0;
      doc.y = captionY + 14;
    }
  }

  if (col !== 0) {
    doc.y = doc.y + imgH + 18;
  }
}

function drawEventLog(doc: PDFKit.PDFDocument, report: PrintReport): void {
  const x = doc.page.margins.left;

  for (const evt of report.events) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
    }
    const time = new Date(evt.ts).toLocaleTimeString();
    doc.fontSize(8).fillColor(COLORS.muted).text(time, x, doc.y, { continued: true, width: 60 });
    doc.fillColor(COLORS.text).text(`  ${evt.summary}`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Low-level chart primitives
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawChartGrid(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number, h: number,
  maxVal: number, unit: string,
  data: ChartPoint[],
): void {
  doc.save();

  // Box
  doc.rect(x, y, w, h).strokeColor(COLORS.grid).lineWidth(0.5).stroke();

  // Y grid lines + labels
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxVal / ySteps) * i;
    const lineY = y + h - (h * (val / maxVal));
    if (i > 0 && i < ySteps) {
      doc.moveTo(x, lineY).lineTo(x + w, lineY).strokeColor(COLORS.grid).lineWidth(0.25).stroke();
    }
    doc.fontSize(7).fillColor(COLORS.muted).text(`${val.toFixed(0)}${unit}`, x - 35, lineY - 4, { width: 30, align: 'right' });
  }

  // X time labels
  if (data.length > 1) {
    const startT = data[0].t;
    const endT = data[data.length - 1].t;
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const t = startT + ((endT - startT) / ticks) * i;
      const px = x + (w * ((t - startT) / (endT - startT)));
      const label = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      doc.fontSize(6).fillColor(COLORS.muted).text(label, px - 15, y + h + 3, { width: 30, align: 'center' });
    }
  }

  doc.restore();
}

function drawLineSeries(
  doc: PDFKit.PDFDocument,
  data: ChartPoint[],
  key: string,
  chartX: number, chartY: number, chartW: number, chartH: number,
  maxVal: number,
  color: string,
  dash?: number[],
): void {
  if (data.length < 2) return;

  const startT = data[0].t;
  const endT = data[data.length - 1].t;
  const timeRange = endT - startT;
  if (timeRange <= 0) return;

  doc.save();
  doc.rect(chartX, chartY, chartW, chartH).clip();

  doc.strokeColor(color).lineWidth(0.6);
  if (dash) doc.dash(dash[0], { space: dash[1] });

  // Downsample if too many points (max ~500 for clean PDF lines)
  const step = Math.max(1, Math.floor(data.length / 500));
  let started = false;

  for (let i = 0; i < data.length; i += step) {
    const p = data[i];
    const v = p.values[key] ?? 0;
    const px = chartX + chartW * ((p.t - startT) / timeRange);
    const py = chartY + chartH - (chartH * (v / maxVal));

    if (!started) {
      doc.moveTo(px, py);
      started = true;
    } else {
      doc.lineTo(px, py);
    }
  }
  doc.stroke();
  if (dash) doc.undash();
  doc.restore();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Formatting helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTempStats(s: { min: number; max: number; avg: number }): string {
  if (s.max === 0) return '—';
  return `${s.avg.toFixed(0)}°C (${s.min.toFixed(0)}–${s.max.toFixed(0)})`;
}

function sumBefore(arr: number[], idx: number): number {
  let s = 0;
  for (let i = 0; i < idx; i++) s += arr[i];
  return s;
}
