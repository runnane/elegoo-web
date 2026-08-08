/** AI Monitor panel — shows live analysis results and alert history */

import { $, escapeHtml, escapeAttr } from './helpers';
import { toast } from './toast';

interface AIIssue {
  type: string;
  description: string;
  confidence: number;
}

interface AIAnalysis {
  timestamp: number;
  source: 'vlm' | 'local' | 'motion';
  status: 'ok' | 'warning' | 'critical';
  confidence: number;
  issues: AIIssue[];
  description: string;
  durationMs: number;
  labelScores?: Array<{ label: string; score: number }>;
}

interface AIAlert {
  timestamp: number;
  status: 'warning' | 'critical';
  issues: AIIssue[];
  description: string;
  consecutiveWarnings: number;
}

const MAX_HISTORY = 30;
const analysisHistory: AIAnalysis[] = [];
const alertHistory: AIAlert[] = [];
let latestVlm: AIAnalysis | null = null;
let latestLocal: AIAnalysis | null = null;
let aiServiceStatus: string = 'disabled';
let aiConfig: Record<string, unknown> | null = null;

/** Update the AI panel with the current service-reported AI status and config */
export function updateAIStatus(status: string, config?: Record<string, unknown> | null): void {
  aiServiceStatus = status;
  if (config) aiConfig = config;
  renderAIPanel();
}

export function handleAIAnalysis(data: Record<string, unknown>): void {
  const analysis: AIAnalysis = {
    timestamp: (data.timestamp as number) || Date.now(),
    source: (data.source as 'vlm' | 'local' | 'motion') || 'vlm',
    status: (data.status as 'ok' | 'warning' | 'critical') || 'ok',
    confidence: (data.confidence as number) || 0,
    issues: (data.issues as AIIssue[]) || [],
    description: (data.description as string) || '',
    durationMs: (data.durationMs as number) || 0,
    labelScores: (data.labelScores as Array<{ label: string; score: number }>) || undefined,
  };

  analysisHistory.unshift(analysis);
  if (analysisHistory.length > MAX_HISTORY) analysisHistory.pop();

  if (analysis.source === 'vlm') latestVlm = analysis;
  else latestLocal = analysis;

  renderAIPanel();
}

export function handleAIAlert(data: Record<string, unknown>): void {
  const alert: AIAlert = {
    timestamp: (data.timestamp as number) || Date.now(),
    status: (data.status as 'warning' | 'critical') || 'warning',
    issues: (data.issues as AIIssue[]) || [],
    description: (data.description as string) || '',
    consecutiveWarnings: (data.consecutiveWarnings as number) || 0,
  };

  alertHistory.unshift(alert);
  if (alertHistory.length > MAX_HISTORY) alertHistory.pop();

  // Show toast for alerts
  const icon = alert.status === 'critical' ? '🚨' : '⚠️';
  toast(`${icon} AI: ${alert.description}`, alert.status === 'critical' ? 'error' : 'warning');

  renderAIPanel();
}

function statusIcon(status: string): string {
  switch (status) {
    case 'ok':
      return '✅';
    case 'warning':
      return '⚠️';
    case 'critical':
      return '🚨';
    default:
      return '❓';
  }
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function renderLabelScores(
  scores: Array<{ label: string; score: number }> | undefined,
  source: string,
): string {
  if (!scores || scores.length === 0) return '';
  // Sort by score descending
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const rows = sorted
    .map((s) => {
      const pct = Math.round(s.score * 100);
      const barColor =
        pct > 30 ? 'var(--warning)' : pct > 15 ? 'var(--accent)' : 'var(--text-muted)';
      return `<div class="ai-label-row">
      <div class="ai-label-bar" style="width:${Math.max(2, pct)}%;background:${barColor}"></div>
      <span class="ai-label-pct">${pct}%</span>
      <span class="ai-label-text">${escapeHtml(s.label)}</span>
    </div>`;
    })
    .join('');
  return `<details class="ai-label-details" data-label-source="${source}"><summary>Label scores (${sorted.length})</summary><div class="ai-label-scores">${rows}</div></details>`;
}

function renderAnalysisCard(a: AIAnalysis): string {
  const issues =
    a.issues.length > 0
      ? a.issues
          .map(
            (i) =>
              `<span class="ai-issue ai-issue-${a.status}" title="${escapeHtml(i.description)}">${escapeHtml(i.type)} (${Math.round(i.confidence * 100)}%)</span>`,
          )
          .join(' ')
      : '<span class="ai-no-issues">No issues</span>';

  return `
    <div class="ai-analysis ai-status-${a.status}">
      <div class="ai-analysis-header">
        <span>${statusIcon(a.status)}</span>
        <span class="ai-source">${a.source.toUpperCase()}</span>
        <span class="ai-confidence">${Math.round(a.confidence * 100)}%</span>
        <span class="ai-time">${timeAgo(a.timestamp)}</span>
        <span class="ai-duration">${a.durationMs}ms</span>
      </div>
      <div class="ai-description">${escapeHtml(a.description)}</div>
      <div class="ai-issues">${issues}</div>
      ${renderLabelScores(a.labelScores, a.source)}
    </div>
  `;
}

function renderAlertItem(a: AIAlert): string {
  const issues = a.issues.map((i) => escapeHtml(i.type)).join(', ') || 'unknown';
  return `
    <div class="ai-alert-item ai-alert-${a.status}">
      <span>${statusIcon(a.status)}</span>
      <span class="ai-alert-desc" title="${escapeAttr(a.description)}">${escapeHtml(a.description)}</span>
      <span class="ai-alert-issues">${issues}</span>
      <span class="ai-time">${timeAgo(a.timestamp)}</span>
    </div>
  `;
}

export function renderAIPanel(): void {
  const container = $('ai-panel');
  if (!container) return;

  // Preserve <details> open states before re-rendering
  const openStates = new Map<string, boolean>();
  container.querySelectorAll('details[data-label-source]').forEach((el) => {
    const key = (el as HTMLElement).dataset.labelSource ?? '';
    openStates.set(key, (el as HTMLDetailsElement).open);
  });
  const historyOpen = container.querySelector('details.ai-section');
  const historyWasOpen = historyOpen ? (historyOpen as HTMLDetailsElement).open : false;

  // Latest results section
  const latestCards: string[] = [];
  if (latestVlm) latestCards.push(renderAnalysisCard(latestVlm));
  if (latestLocal) latestCards.push(renderAnalysisCard(latestLocal));

  const latestHtml =
    latestCards.length > 0
      ? latestCards.join('')
      : `<div class="ai-empty">${aiStatusMessage()}</div>`;

  // Alert history
  const alertHtml =
    alertHistory.length > 0
      ? alertHistory.slice(0, 10).map(renderAlertItem).join('')
      : '<div class="ai-empty">No alerts</div>';

  // Recent history (collapsed by default)
  const historyHtml =
    analysisHistory.length > 0
      ? analysisHistory
          .slice(0, 15)
          .map((a) => {
            const t = new Date(a.timestamp).toLocaleTimeString();
            return `<div class="ai-history-row ai-status-${a.status}">
        <span>${statusIcon(a.status)}</span>
        <span class="ai-source">${a.source}</span>
        <span class="ai-hist-desc" title="${escapeAttr(a.description)}">${escapeHtml(a.description)}</span>
        <span class="ai-time">${t}</span>
      </div>`;
          })
          .join('')
      : '<div class="ai-empty">No history</div>';

  container.innerHTML = `
    <div class="ai-section">
      <div class="ai-status-line">${aiStatusIcon()} ${aiStatusMessage()}</div>
      ${renderConfigInfo()}
    </div>
    <div class="ai-section">
      <h4>Latest Analysis</h4>
      ${latestHtml}
    </div>
    <div class="ai-section">
      <h4>Alerts</h4>
      ${alertHtml}
    </div>
    <details class="ai-section"${historyWasOpen ? ' open' : ''}>
      <summary>History (${analysisHistory.length})</summary>
      <div class="ai-history">${historyHtml}</div>
    </details>
  `;

  // Restore <details> open states for label scores
  container.querySelectorAll('details[data-label-source]').forEach((el) => {
    const key = (el as HTMLElement).dataset.labelSource ?? '';
    if (openStates.get(key)) {
      (el as HTMLDetailsElement).open = true;
    }
  });
}

function aiStatusIcon(): string {
  switch (aiServiceStatus) {
    case 'monitoring':
      return '🔍';
    case 'idle':
      return '✅';
    case 'stopped':
      return '⏹';
    default:
      return '⚫';
  }
}

function aiStatusMessage(): string {
  switch (aiServiceStatus) {
    case 'monitoring':
      return 'Monitoring active — analyzing camera every ' + (aiConfig?.intervalSec ?? '?') + 's';
    case 'idle':
      return 'Enabled — waiting for print to start';
    case 'stopped':
      return 'AI monitor stopped';
    default:
      return 'AI monitoring not enabled';
  }
}

function renderConfigInfo(): string {
  if (!aiConfig || aiServiceStatus === 'disabled') return '';

  const vlm = aiConfig.vlmEnabled
    ? `<span class="ai-config-on">✓ VLM</span> <span class="ai-config-detail">${escapeHtml(String(aiConfig.vlmModel))} @ ${escapeHtml(String(aiConfig.vlmBaseUrl))}</span>`
    : '<span class="ai-config-off">✗ VLM disabled</span>';

  const local = aiConfig.localEnabled
    ? `<span class="ai-config-on">✓ CLIP</span> <span class="ai-config-detail">${escapeHtml(String(aiConfig.localModel))}${aiConfig.localReady ? '' : ' (loading...)'}</span>`
    : '<span class="ai-config-off">✗ Local CLIP disabled</span>';

  const interval = `every ${aiConfig.intervalSec}s`;
  const threshold = `alert after ${aiConfig.alertThreshold} warnings`;

  const stats = aiConfig.analysisCount
    ? `<div class="ai-config-row">📊 ${aiConfig.analysisCount} analyses performed, ${aiConfig.consecutiveWarnings} consecutive warnings</div>`
    : '';

  return `
    <div class="ai-config-info">
      <div class="ai-config-row">${vlm}</div>
      <div class="ai-config-row">${local}</div>
      <div class="ai-config-row">⏱ ${interval} · ${threshold}</div>
      ${stats}
    </div>
  `;
}
