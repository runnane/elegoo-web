/** Structured MQTT log viewer with filters, search, pause, and highlighting */

import type { LogStore, LogEntry } from '../log-store';
import { $, escapeHtml } from './helpers';
import { METHOD_NAMES } from './log-methods';
import { loadUISettings, saveUISettings } from './ui-settings';
import { timestampSpan } from './relative-time';
import { exportLogEntries } from './log-export';
import { toast } from './toast';

let autoScroll = true;
let paused = false;
let searchText = '';
let directionFilter: 'all' | 'sent' | 'received' = loadUISettings().slogDirection as
  | 'all'
  | 'sent'
  | 'received';
let typeFilter: 'all' | 'status' | 'command' | 'response' | 'heartbeat' = loadUISettings()
  .slogType as 'all' | 'status' | 'command' | 'response' | 'heartbeat';
let methodFilter: number | 'all' = (() => {
  const v = loadUISettings().slogMethod;
  return v === 'all' ? 'all' : parseInt(v) || 'all';
})();
let showDiff = false;
const expandedEntries = new Set<number>();
const pinnedEntries = new Set<number>();
let pendingCount = 0;
let lastRenderedTs = '';
let lastRenderedCount = '';

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString('nb-NO', { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function classifyEntry(entry: LogEntry): 'status' | 'command' | 'response' | 'heartbeat' | 'other' {
  if (entry.type === 'PING' || entry.type === 'PONG') return 'heartbeat';
  if (entry.topic.includes('api_status')) return 'status';
  if (entry.topic.includes('api_request')) return 'command';
  if (entry.topic.includes('api_response')) return 'response';
  if (entry.topic.includes('api_register')) return 'command';
  return 'other';
}

function matchesFilters(entry: LogEntry): boolean {
  // Direction filter
  if (directionFilter !== 'all' && entry.direction !== directionFilter) return false;

  // Type filter
  if (typeFilter !== 'all') {
    const cls = classifyEntry(entry);
    if (typeFilter === 'status' && cls !== 'status') return false;
    if (typeFilter === 'command' && cls !== 'command') return false;
    if (typeFilter === 'response' && cls !== 'response') return false;
    if (typeFilter === 'heartbeat' && cls !== 'heartbeat') return false;
  }

  // Method filter
  if (methodFilter !== 'all') {
    if (entry.method !== methodFilter) return false;
  }

  // Search text
  if (searchText) {
    const lower = searchText.toLowerCase();
    return (
      entry.topic.toLowerCase().includes(lower) ||
      (entry.method != null && String(entry.method).includes(lower)) ||
      (entry.type?.toLowerCase().includes(lower) ?? false) ||
      entry.payload.toLowerCase().includes(lower) ||
      (entry.method != null && (METHOD_NAMES[entry.method] ?? '').toLowerCase().includes(lower))
    );
  }

  return true;
}

function highlightMatch(text: string): string {
  if (!searchText) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const searchEscaped = escapeHtml(searchText);
  const regex = new RegExp(`(${searchEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(regex, '<mark class="log-highlight">$1</mark>');
}

function shortTopic(topic: string): string {
  const parts = topic.split('/');
  return parts[parts.length - 1];
}

function methodLabel(entry: LogEntry): string {
  if (entry.type) return entry.type;
  if (entry.method != null) {
    const name = METHOD_NAMES[entry.method];
    return name ? `${entry.method} ${name}` : `M${entry.method}`;
  }
  return '';
}

function typeIcon(entry: LogEntry): string {
  const cls = classifyEntry(entry);
  switch (cls) {
    case 'status':
      return '📊';
    case 'command':
      return '📤';
    case 'response':
      return '📥';
    case 'heartbeat':
      return '💓';
    default:
      return '📋';
  }
}

function computeDiff(prev: unknown, curr: unknown, prefix = ''): string[] {
  const changes: string[] = [];
  if (typeof prev !== 'object' || typeof curr !== 'object' || !prev || !curr) {
    if (prev !== curr) changes.push(`${prefix}: ${JSON.stringify(prev)} → ${JSON.stringify(curr)}`);
    return changes;
  }
  const p = prev as Record<string, unknown>;
  const c = curr as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(p), ...Object.keys(c)]);
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in p)) {
      changes.push(`+ ${path}: ${JSON.stringify(c[key])}`);
    } else if (!(key in c)) {
      changes.push(`- ${path}: ${JSON.stringify(p[key])}`);
    } else if (
      typeof p[key] === 'object' &&
      typeof c[key] === 'object' &&
      p[key] &&
      c[key] &&
      !Array.isArray(p[key])
    ) {
      changes.push(...computeDiff(p[key], c[key], path));
    } else if (JSON.stringify(p[key]) !== JSON.stringify(c[key])) {
      changes.push(`~ ${path}: ${JSON.stringify(p[key])} → ${JSON.stringify(c[key])}`);
    }
  }
  return changes;
}

function compactPayload(entry: LogEntry): string {
  if (entry.type === 'PING' || entry.type === 'PONG') return entry.type;
  const raw = entry.raw as Record<string, unknown>;
  if (!raw) return entry.payload;

  // For status events, show key changed fields
  if (classifyEntry(entry) === 'status') {
    const keys = Object.keys(raw);
    const interesting = keys.filter((k) => k !== 'method' && k !== 'id');
    if (interesting.length <= 4) return interesting.join(', ');
    return `${interesting.slice(0, 3).join(', ')} +${interesting.length - 3} more`;
  }

  // For responses, show error_code
  if (classifyEntry(entry) === 'response') {
    const result = raw.result as Record<string, unknown> | undefined;
    if (result?.error_code !== undefined) {
      const code = result.error_code as number;
      return code === 0 ? '✅ OK' : `❌ Error ${code}`;
    }
  }

  // The deliberate exception to the CSS-truncation rule (ELEG-43): this is a DOM-size
  // guard, not a layout decision. A megabyte payload across hundreds of log rows is a
  // performance problem no stylesheet can solve, and the row expands to show it in full.
  return entry.payload.slice(0, 200);
}

function renderSlogRow(e: LogEntry, prevStatusRaw: unknown): string {
  const dirClass = e.direction === 'sent' ? 'slog-sent' : 'slog-recv';
  const typeClass = `slog-type-${classifyEntry(e)}`;
  const isExpanded = expandedEntries.has(e.timestamp);
  const isPinned = pinnedEntries.has(e.timestamp);
  const icon = typeIcon(e);
  const method = methodLabel(e);
  const summary = compactPayload(e);

  let row = '';
  row += `<div class="slog-row ${dirClass} ${typeClass} ${isPinned ? 'slog-pinned' : ''}" data-ts="${e.timestamp}">`;
  row += `<div class="slog-row-header">`;
  row += `<span class="slog-icon">${icon}</span>`;
  row += timestampSpan('slog-time', e.timestamp, formatTimestamp(e.timestamp));
  row += `<span class="slog-dir">${e.direction === 'sent' ? '→' : '←'}</span>`;
  row += `<span class="slog-method">${highlightMatch(method)}</span>`;
  row += `<span class="slog-topic">${highlightMatch(shortTopic(e.topic))}</span>`;
  row += `<span class="slog-summary">${highlightMatch(summary)}</span>`;
  row += `<button class="slog-pin-btn ${isPinned ? 'pinned' : ''}" data-pin-ts="${e.timestamp}" title="${isPinned ? 'Unpin' : 'Pin'}">📌</button>`;
  row += `<span class="slog-expand">${isExpanded ? '▾' : '▸'}</span>`;
  row += `</div>`;

  if (isExpanded) {
    if (showDiff && classifyEntry(e) === 'status' && prevStatusRaw) {
      const diffs = computeDiff(prevStatusRaw, e.raw);
      if (diffs.length) {
        row += `<pre class="slog-detail slog-diff">${diffs.map((d) => escapeHtml(d)).join('\n')}</pre>`;
      } else {
        row += `<pre class="slog-detail slog-diff">No changes from previous status</pre>`;
      }
    } else {
      row += `<pre class="slog-detail">${escapeHtml(JSON.stringify(e.raw, null, 2))}</pre>`;
    }
  }

  row += `</div>`;
  return row;
}

export function renderStructuredLog(store: LogStore): void {
  if (paused) {
    pendingCount++;
    $('slog-paused-badge').textContent = `PAUSED (${pendingCount} pending)`;
    return;
  }

  const container = $('slog-entries');
  const entries = store.getEntries().filter(matchesFilters);

  const lastEntry = entries[entries.length - 1];
  const tsKey = lastEntry ? String(lastEntry.timestamp) : '';
  const countKey = String(entries.length) + String(pinnedEntries.size) + String(showDiff);
  if (tsKey === lastRenderedTs && countKey === lastRenderedCount) return;
  lastRenderedTs = tsKey;
  lastRenderedCount = countKey;

  // Render pinned entries first at the top
  const pinned =
    pinnedEntries.size > 0 ? store.getEntries().filter((e) => pinnedEntries.has(e.timestamp)) : [];

  let html = '';

  if (pinned.length) {
    html += `<div class="slog-pinned-section">`;
    html += `<div class="slog-pinned-header">📌 Pinned (${pinned.length})</div>`;
    for (const e of pinned) {
      html += renderSlogRow(e, null);
    }
    html += `</div>`;
  }

  let prevStatusRaw: unknown = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    html += renderSlogRow(e, classifyEntry(e) === 'status' ? prevStatusRaw : null);
    if (classifyEntry(e) === 'status') {
      prevStatusRaw = e.raw;
    }
  }

  container.innerHTML = html;
  $('slog-count').textContent = `${entries.length} messages`;

  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

let slogControlsBound = false;

export function bindStructuredLogControls(store: LogStore): void {
  if (slogControlsBound) return;
  slogControlsBound = true;

  // Delegated click handler on container (replaces per-row listeners)
  const container = $('slog-entries');
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Pin button click
    const pinBtn = target.closest('.slog-pin-btn') as HTMLElement | null;
    if (pinBtn) {
      e.stopPropagation();
      const ts = parseInt(pinBtn.dataset.pinTs ?? '0');
      if (pinnedEntries.has(ts)) pinnedEntries.delete(ts);
      else pinnedEntries.add(ts);
      lastRenderedTs = '';
      renderStructuredLog(store);
      return;
    }
    // Row click to expand/collapse
    const row = target.closest('.slog-row') as HTMLElement | null;
    if (row) {
      const ts = parseInt(row.dataset.ts ?? '0');
      if (expandedEntries.has(ts)) expandedEntries.delete(ts);
      else expandedEntries.add(ts);
      autoScroll = false;
      ($('slog-autoscroll') as HTMLInputElement).checked = false;
      lastRenderedTs = '';
      renderStructuredLog(store);
    }
  });

  // Populate method filter dropdown
  const methodSelect = $('slog-method-filter') as HTMLSelectElement;
  const sortedMethods = Object.entries(METHOD_NAMES).sort(
    (a, b) => parseInt(a[0]) - parseInt(b[0]),
  );
  for (const [code, name] of sortedMethods) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${code} ${name}`;
    methodSelect.appendChild(opt);
  }

  // Tab switching
  const savedTab = loadUISettings().logTab;
  document.querySelectorAll('.log-tab').forEach((tab) => {
    const tabName = (tab as HTMLElement).dataset.tab;
    tab.classList.toggle('active', tabName === savedTab);
    tab.addEventListener('click', () => {
      document.querySelectorAll('.log-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = (tab as HTMLElement).dataset.tab;
      $('log-tab-structured').classList.toggle('hidden', name !== 'structured');
      $('log-tab-raw').classList.toggle('hidden', name !== 'raw');
      saveUISettings({ logTab: name ?? 'structured' });
    });
  });
  // Apply saved tab visibility
  $('log-tab-structured').classList.toggle('hidden', savedTab !== 'structured');
  $('log-tab-raw').classList.toggle('hidden', savedTab !== 'raw');

  // Restore saved filter values on selects
  ($('slog-direction-filter') as HTMLSelectElement).value = directionFilter;
  ($('slog-type-filter') as HTMLSelectElement).value = typeFilter;
  ($('slog-method-filter') as HTMLSelectElement).value =
    methodFilter === 'all' ? 'all' : String(methodFilter);

  // Search
  $('slog-search').addEventListener('input', (e) => {
    searchText = (e.target as HTMLInputElement).value;
    lastRenderedTs = '';
    renderStructuredLog(store);
  });

  // Direction filter
  $('slog-direction-filter').addEventListener('change', (e) => {
    directionFilter = (e.target as HTMLSelectElement).value as typeof directionFilter;
    saveUISettings({ slogDirection: directionFilter });
    lastRenderedTs = '';
    renderStructuredLog(store);
  });

  // Type filter
  $('slog-type-filter').addEventListener('change', (e) => {
    typeFilter = (e.target as HTMLSelectElement).value as typeof typeFilter;
    saveUISettings({ slogType: typeFilter });
    lastRenderedTs = '';
    renderStructuredLog(store);
  });

  // Method filter
  $('slog-method-filter').addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    methodFilter = val === 'all' ? 'all' : parseInt(val);
    saveUISettings({ slogMethod: val });
    lastRenderedTs = '';
    renderStructuredLog(store);
  });

  // Auto-scroll
  $('slog-autoscroll').addEventListener('change', (e) => {
    autoScroll = (e.target as HTMLInputElement).checked;
  });

  // Pause
  $('slog-pause').addEventListener('click', () => {
    paused = !paused;
    $('slog-pause').textContent = paused ? '▶' : '⏸';
    $('slog-paused-badge').classList.toggle('hidden', !paused);
    if (!paused) {
      pendingCount = 0;
      $('slog-paused-badge').textContent = 'PAUSED';
      lastRenderedTs = '';
      renderStructuredLog(store);
    }
  });

  // Clear
  $('slog-clear').addEventListener('click', () => {
    store.clear();
    expandedEntries.clear();
    pinnedEntries.clear();
    lastRenderedTs = '';
    lastRenderedCount = '';
  });

  $('slog-export').addEventListener('click', () => {
    // Whatever the direction / type / method / search filters are currently showing —
    // the same set on screen, so the file matches what the user was looking at.
    const entries = store.getEntries().filter(matchesFilters);
    if (!entries.length) {
      toast('Nothing to export — no messages match the filters', 'warning');
      return;
    }
    const count = exportLogEntries(entries, 'structured');
    toast(`Exported ${count} message${count === 1 ? '' : 's'}`, 'success');
  });

  // Diff toggle
  $('slog-diff').addEventListener('click', () => {
    showDiff = !showDiff;
    $('slog-diff').classList.toggle('btn-active', showDiff);
    lastRenderedTs = '';
    renderStructuredLog(store);
  });
}
