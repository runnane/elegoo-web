import type { LogStore, LogEntry } from '../log-store';
import { $, escapeHtml } from './helpers';

let autoScroll = true;
let expandedEntries = new Set<number>();
let filterText = '';

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('nb-NO', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function shortTopic(topic: string): string {
  // Show just the last segment: api_request, api_response, api_status, etc.
  const parts = topic.split('/');
  return parts[parts.length - 1];
}

function methodLabel(entry: LogEntry): string {
  if (entry.type) return entry.type; // PING/PONG
  if (entry.method != null) return `M${entry.method}`;
  return '';
}

function matchesFilter(entry: LogEntry): boolean {
  if (!filterText) return true;
  const lower = filterText.toLowerCase();
  return (
    entry.topic.toLowerCase().includes(lower) ||
    (entry.method != null && String(entry.method).includes(lower)) ||
    (entry.type?.toLowerCase().includes(lower) ?? false) ||
    entry.payload.toLowerCase().includes(lower)
  );
}

export function renderLog(store: LogStore): void {
  const container = $('log-entries');
  const entries = store.getEntries().filter(matchesFilter);

  // Only re-render if content changed (check last entry timestamp)
  const lastEntry = entries[entries.length - 1];
  const lastRendered = container.dataset.lastTs;
  const countRendered = container.dataset.count;
  if (lastEntry && String(lastEntry.timestamp) === lastRendered && String(entries.length) === countRendered) {
    return;
  }

  let html = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const dirClass = e.direction === 'sent' ? 'log-sent' : 'log-recv';
    const dirArrow = e.direction === 'sent' ? '→' : '←';
    const isExpanded = expandedEntries.has(e.timestamp);

    html += `<div class="log-row ${dirClass}" data-idx="${i}" data-ts="${e.timestamp}">`;
    html += `<span class="log-time">${formatTimestamp(e.timestamp)}</span>`;
    html += `<span class="log-dir">${dirArrow}</span>`;
    html += `<span class="log-topic">${escapeHtml(shortTopic(e.topic))}</span>`;
    html += `<span class="log-method">${escapeHtml(methodLabel(e))}</span>`;
    if (isExpanded) {
      html += `<pre class="log-payload expanded">${escapeHtml(JSON.stringify(e.raw, null, 2))}</pre>`;
    } else {
      html += `<span class="log-payload">${escapeHtml(e.payload)}</span>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;
  container.dataset.lastTs = lastEntry ? String(lastEntry.timestamp) : '';
  container.dataset.count = String(entries.length);

  // Click to expand/collapse
  container.querySelectorAll('.log-row').forEach(row => {
    row.addEventListener('click', () => {
      const ts = parseInt((row as HTMLElement).dataset.ts ?? '0');
      if (expandedEntries.has(ts)) {
        expandedEntries.delete(ts);
      } else {
        expandedEntries.add(ts);
      }
      renderLog(store);
    });
  });

  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

export function bindLogControls(store: LogStore): void {
  $('log-clear').addEventListener('click', () => {
    store.clear();
    expandedEntries.clear();
  });

  $('log-autoscroll').addEventListener('change', (e) => {
    autoScroll = (e.target as HTMLInputElement).checked;
  });

  $('log-filter').addEventListener('input', (e) => {
    filterText = (e.target as HTMLInputElement).value;
    renderLog(store);
  });
}
