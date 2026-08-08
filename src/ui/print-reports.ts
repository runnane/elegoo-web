/**
 * Print Reports UI — lists saved print reports with download buttons.
 */

import { $, escapeHtml, formatTime, fetchTimeout } from './helpers';
import { type ListControls, createListControls } from './list-controls';
import { nonZero } from './list-sort';

interface ReportSummary {
  id: string;
  filename: string;
  outcome: string;
  startedAt: number;
  endedAt: number;
  duration: number;
}

let reportsLoaded = false;
/**
 * The last fetched payload, kept so that changing the sort or the filter re-renders from
 * memory instead of re-fetching `/api/reports` — the controls change what you see, not
 * what the server has.
 */
let reportData: { reports: ReportSummary[]; active: boolean } | null = null;

/** Kept outside the render function — see `list-controls.ts` on why that matters. */
let reportControls: ListControls<ReportSummary> | null = null;

function ensureReportControls(): ListControls<ReportSummary> {
  if (reportControls) return reportControls;
  reportControls = createListControls<ReportSummary>({
    id: 'print-reports',
    container: $('print-reports-controls'),
    noun: 'reports',
    filterPlaceholder: 'Filter reports…',
    // `.report-filename` carries the full name in its `title` (ELEG-43), so matching the
    // full string is right even where the display is ellipsised.
    filterText: (r) => r.filename,
    columns: [
      { key: 'name', label: 'Name', value: (r) => r.filename },
      // startedAt/endedAt are epoch *milliseconds* here (Date.now()), unlike print
      // history's seconds — it only matters if you compare the two, which nothing does.
      {
        key: 'started',
        label: 'Started',
        value: (r) => nonZero(r.startedAt),
        initialDirection: 'desc',
      },
      {
        key: 'duration',
        label: 'Duration',
        value: (r) => nonZero(r.duration),
        initialDirection: 'desc',
      },
      { key: 'outcome', label: 'Outcome', value: (r) => r.outcome },
    ],
    defaultSort: { key: 'started', dir: 'desc' },
    selects: [
      {
        id: 'outcome',
        label: 'Outcome',
        options: [
          { value: 'completed', label: 'completed' },
          { value: 'failed', label: 'failed' },
          { value: 'stopped', label: 'stopped' },
        ],
        match: (r, value) => r.outcome === value,
      },
    ],
    onChange: () => renderReportList(),
  });
  return reportControls;
}

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
    reportData = (await res.json()) as { reports: ReportSummary[]; active: boolean };
    reportsLoaded = true;
    renderReportList();
  } catch {
    container.innerHTML = '<div class="file-empty">Failed to load reports</div>';
  }
}

/** Renders whatever was last fetched, through the current sort and filter. */
function renderReportList(): void {
  const container = $('print-reports-entries');
  const data = reportData;
  if (!container || !data) return;

  const controls = ensureReportControls();
  const reports = controls.apply(data.reports);

  if (reports.length === 0 && !data.active) {
    // "No reports yet" and "nothing matches your filter" are different facts.
    container.innerHTML = controls.emptyHtml(
      'No print reports yet. Reports are automatically generated when prints complete.',
    );
    return;
  }

  let html = '';
  if (data.active) {
    html += '<div class="report-active">📊 Report collection in progress…</div>';
  }

  for (const r of reports) {
    const statusIcon = r.outcome === 'completed' ? '✅' : r.outcome === 'failed' ? '❌' : '⏹';
    const statusClass =
      r.outcome === 'completed' ? 'success' : r.outcome === 'failed' ? 'danger' : 'warning';
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

  // Bind delete buttons. Rebound on every render because the rows are replaced.
  container.querySelectorAll('.report-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.reportId;
      if (!id || !confirm(`Delete report for this print?`)) return;
      try {
        const res = await fetchTimeout(`/api/reports/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          reportsLoaded = false;
          loadReports();
        }
      } catch {
        /* ignore */
      }
    });
  });
}

export function refreshReports(): void {
  reportsLoaded = false;
  loadReports();
}

export function bindReportControls(): void {
  const btn = document.getElementById('btn-reports-refresh');
  if (btn) btn.addEventListener('click', () => refreshReports());
}
