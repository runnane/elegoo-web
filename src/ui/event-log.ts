/** Event Log panel — shows important printer events (start, error, milestones, layer changes) */

import { $, escapeHtml } from './helpers';

interface EventLogEntry {
  ts: number;
  event: Record<string, unknown>;
}

const MAX_ENTRIES = 100;
const entries: EventLogEntry[] = [];

/** Format timestamp as HH:MM:SS */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Format duration in seconds as human-readable */
function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Get icon and CSS class for event type */
function eventMeta(type: string): { icon: string; cls: string } {
  switch (type) {
    case 'connected':       return { icon: '🔗', cls: 'event-success' };
    case 'disconnected':    return { icon: '🔌', cls: 'event-warning' };
    case 'print_started':   return { icon: '▶️', cls: 'event-info' };
    case 'print_completed': return { icon: '✅', cls: 'event-success' };
    case 'print_failed':    return { icon: '❌', cls: 'event-error' };
    case 'print_progress':  return { icon: '📊', cls: 'event-muted' };
    case 'error':           return { icon: '🚨', cls: 'event-error' };
    case 'filament_runout': return { icon: '🧵', cls: 'event-error' };
    case 'layer_change':        return { icon: '📏', cls: 'event-muted' };
    case 'first_layer_complete': return { icon: '🥇', cls: 'event-success' };
    case 'status_change':       return { icon: '🔄', cls: 'event-info' };
    case 'sub_status_change':   return { icon: '↪️', cls: 'event-muted' };
    default:                    return { icon: '📋', cls: 'event-muted' };
  }
}

/** Build human-readable description for an event */
function eventDescription(e: Record<string, unknown>): string {
  const type = e.type as string;
  switch (type) {
    case 'connected':
      return `Connected to printer ${escapeHtml(String(e.sn || ''))}`;
    case 'disconnected':
      return 'Printer disconnected';
    case 'print_started': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      return e.resumed ? `Resumed print: ${fn}` : `Print started: ${fn}`;
    }
    case 'print_completed': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      const dur = typeof e.duration === 'number' ? ` (${fmtDuration(e.duration)})` : '';
      return `Print completed: ${fn}${dur}`;
    }
    case 'print_failed': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      const reason = escapeHtml(String(e.reason || 'unknown'));
      return `Print failed: ${fn} — ${reason}`;
    }
    case 'print_progress': {
      const pct = e.progress as number;
      const layer = e.layer as number;
      const total = e.totalLayers as number;
      const rem = typeof e.remaining === 'number' ? ` (${fmtDuration(e.remaining as number)} remaining)` : '';
      return `Progress: ${pct}% — Layer ${layer}/${total}${rem}`;
    }
    case 'error': {
      const names = (e.names as string[]) || [];
      return `Error: ${names.map(n => escapeHtml(n)).join(', ') || 'Unknown'}`;
    }
    case 'filament_runout':
      return 'Filament runout detected';
    case 'layer_change': {
      const layer = e.layer as number;
      const total = e.totalLayers as number;
      const dur = typeof e.durationSec === 'number' ? ` (layer took ${fmtDuration(e.durationSec as number)})` : '';
      return `Layer ${layer}${total ? '/' + total : ''}${dur}`;
    }
    case 'first_layer_complete': {
      const fn = escapeHtml(String(e.filename || 'unknown'));
      const dur = typeof e.durationSec === 'number' ? ` (${fmtDuration(e.durationSec as number)})` : '';
      return `First layer complete: ${fn}${dur}`;
    }
    case 'status_change':
      return `Status: ${escapeHtml(String(e.from))} → ${escapeHtml(String(e.to))}`;
    case 'sub_status_change':
      return `Sub-status: ${escapeHtml(String(e.from || 'Default'))} → ${escapeHtml(String(e.to || 'Default'))}`;
    default:
      return `Event: ${escapeHtml(type)}`;
  }
}

/** Add a single event log entry */
export function handleEventLog(data: { ts: number; event: Record<string, unknown> }): void {
  entries.push(data);
  if (entries.length > MAX_ENTRIES) entries.shift();
  renderEventLog();
}

/** Load event log history from init snapshot */
export function loadEventLogHistory(history: Array<{ ts: number; event: Record<string, unknown> }>): void {
  entries.length = 0;
  for (const e of history) {
    entries.push(e);
  }
  // Trim to max
  while (entries.length > MAX_ENTRIES) entries.shift();
  renderEventLog();
}

/** Render the event log panel */
export function renderEventLog(): void {
  const container = $('event-log-entries');
  if (!container) return;

  if (entries.length === 0) {
    container.innerHTML = '<div class="event-log-empty">No events yet</div>';
    return;
  }

  // Most recent first
  const html = entries.slice().reverse().map(entry => {
    const type = (entry.event.type as string) || 'unknown';
    const meta = eventMeta(type);
    const desc = eventDescription(entry.event);
    return `<div class="event-log-row ${meta.cls}">
      <span class="event-log-icon">${meta.icon}</span>
      <span class="event-log-time">${fmtTime(entry.ts)}</span>
      <span class="event-log-desc">${desc}</span>
    </div>`;
  }).join('');

  container.innerHTML = html;
}
