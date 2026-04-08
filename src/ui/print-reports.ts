/**
 * Print Reports UI — lists saved print reports with download buttons.
 */

import { $, escapeHtml, formatTime, fetchTimeout } from './helpers';

interface ReportSummary {
  id: string;
  filename: string;
  outcome: string;
  startedAt: number;
  endedAt: number;
  duration: number;
}

let reportsLoaded = false;

export function renderReports(): void {
  const container = $('print-reports-entries');
  if (!container) return;
  if (reportsLoaded) return;
  loadReports();
}

async function loadReports(): Promise<void> {
  const container = $('print-reports-entries');
  if (!container) return;

  try {
    const res = await fetchTimeout('/api/reports');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { reports: ReportSummary[]; active: boolean };

    if (data.reports.length === 0 && !data.active) {
      container.innerHTML = '<div class="file-empty">No print reports yet. Reports are automatically generated when prints complete.</div>';
      reportsLoaded = true;
      return;
    }

    let html = '';
    if (data.active) {
      html += '<div class="report-active">📊 Report collection in progress…</div>';
    }

    for (const r of data.reports) {
      const statusIcon = r.outcome === 'completed' ? '✅'
        : r.outcome === 'failed' ? '❌' : '⏹';
      const statusClass = r.outcome === 'completed' ? 'success'
        : r.outcome === 'failed' ? 'danger' : 'warning';
      const date = new Date(r.startedAt).toLocaleString();
      const duration = formatTime(r.duration);

      html += `<div class="report-entry">
        <div class="report-entry-main">
          <span class="history-status ${statusClass}">${statusIcon}</span>
          <span class="report-filename" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</span>
        </div>
        <div class="report-entry-meta">
          <span>🕐 ${escapeHtml(date)}</span>
          <span>⏱ ${escapeHtml(duration)}</span>
        </div>
        <div class="report-actions">
          <a href="/api/reports/${encodeURIComponent(r.id)}/pdf" class="btn btn-sm btn-primary" title="Download PDF report" download>📄 PDF</a>
          <a href="/api/reports/${encodeURIComponent(r.id)}" class="btn btn-sm btn-ghost" title="View raw JSON data" target="_blank">{ }</a>
          <button class="btn btn-sm btn-danger report-delete-btn" data-report-id="${escapeHtml(r.id)}" title="Delete report">🗑</button>
        </div>
      </div>`;
    }

    container.innerHTML = html;
    reportsLoaded = true;

    // Bind delete buttons
    container.querySelectorAll('.report-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.reportId;
        if (!id || !confirm(`Delete report for this print?`)) return;
        try {
          const res = await fetchTimeout(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (res.ok) {
            reportsLoaded = false;
            loadReports();
          }
        } catch { /* ignore */ }
      });
    });
  } catch {
    container.innerHTML = '<div class="file-empty">Failed to load reports</div>';
  }
}

export function refreshReports(): void {
  reportsLoaded = false;
  loadReports();
}

export function bindReportControls(): void {
  const btn = document.getElementById('btn-reports-refresh');
  if (btn) btn.addEventListener('click', () => refreshReports());
}
