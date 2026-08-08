/** Service status — compact header badge with click-to-expand dropdown + system info */

import { $, escapeHtml } from './helpers';
import type { PrinterState } from '../printer-state';
import { type MqttPhase, mqttBannerHeadline, mqttPhaseMessage } from '../types';

export interface ServiceStatus {
  uptime: number;
  mqtt: string;
  /**
   * The finer split of `mqtt`'s `broker_only` (ELEG-59). Optional because a browser can
   * outlive a server restart and still be holding a `service_status` from before this
   * shipped; `phaseOf()` falls back to the coarse field in that case.
   */
  mqttPhase?: MqttPhase;
  mqttRegisterAttempts: number;
  printerSn: string | null;
  printerIp: string;
  wsClients: number;
  telegram: string;
  ai: string;
  camera: string;
}

interface ServiceCheck {
  label: string;
  state: string;
  okValues: string[];
}

/** What the MQTT row reads. `registering…` is now reserved for actually registering. */
const PHASE_LABELS: Record<MqttPhase, string> = {
  connected: 'connected',
  disconnected: 'disconnected',
  awaiting_sn: 'waiting for printer',
  registering: 'registering...',
  rejected: 'refused — too many clients',
};

/**
 * Prefer the server's phase; fall back to deriving one from the coarse `mqtt` field so a
 * browser holding a pre-ELEG-59 `service_status` still renders sensibly. The fallback
 * cannot tell `awaiting_sn` from `registering` — that is the whole point of the new
 * field — so it reports the vaguer of the two rather than guessing.
 */
function phaseOf(s: ServiceStatus): MqttPhase {
  if (s.mqttPhase) return s.mqttPhase;
  if (s.mqtt === 'connected') return 'connected';
  return s.mqtt === 'broker_only' ? 'registering' : 'disconnected';
}

let lastStatus: ServiceStatus | null = null;
let dropdownBound = false;

export function updateServiceStatus(data: Record<string, unknown>): void {
  lastStatus = data as unknown as ServiceStatus;
  renderServiceStatus();
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function isOk(state: string, okValues: string[]): boolean {
  return okValues.includes(state);
}

function dotHtml(ok: boolean): string {
  return `<span class="status-dot ${ok ? 'status-dot-ok' : 'status-dot-err'}"></span>`;
}

export function renderServiceStatus(): void {
  const badge = $('svc-header-badge');
  const dotsEl = $('svc-header-dots');
  const countEl = $('svc-header-count');
  const dropdown = $('service-status');

  if (!badge || !dotsEl || !countEl) return;

  // Bind dropdown toggle once
  if (!dropdownBound) {
    dropdownBound = true;
    const wrap = $('svc-header-wrap');
    const dd = $('svc-dropdown');
    if (wrap && dd) {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        dd.classList.toggle('hidden');
      });
      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target as Node)) dd.classList.add('hidden');
      });
    }
  }

  if (!lastStatus) {
    dotsEl.innerHTML = '';
    countEl.textContent = '--';
    if (dropdown) dropdown.innerHTML = '<div class="svc-loading">Waiting for service...</div>';
    return;
  }

  const s = lastStatus;

  // Define all services for health check
  const checks: ServiceCheck[] = [
    { label: 'MQTT', state: s.mqtt, okValues: ['connected'] },
    { label: 'Telegram', state: s.telegram, okValues: ['running'] },
    { label: 'AI', state: s.ai, okValues: ['monitoring', 'idle'] },
    { label: 'Camera', state: s.camera, okValues: ['available'] },
    { label: 'Printer', state: s.printerSn ? 'ok' : 'err', okValues: ['ok'] },
  ];

  const healthy = checks.filter((c) => isOk(c.state, c.okValues)).length;
  const total = checks.length;

  // Header badge: colored dots + count
  const allOk = healthy === total;
  dotsEl.innerHTML = checks.map((c) => dotHtml(isOk(c.state, c.okValues))).join('');
  countEl.textContent = `${healthy}/${total}`;
  badge.classList.toggle('svc-all-ok', allOk);
  badge.classList.toggle('svc-has-err', !allOk);

  // Dropdown detail
  if (!dropdown) return;

  const phase = phaseOf(s);
  const mqttLabel = PHASE_LABELS[phase];

  // The banner used to fire on `broker_only && attempts >= 3`, which meant it could
  // never fire for the case that most needed it: when the printer never speaks, no SN is
  // learned, registration is never attempted and `mqttRegisterAttempts` stays 0 forever
  // (ELEG-59). The decision now lives in `mqttBannerHeadline`, where it is testable.
  const headline = mqttBannerHeadline(phase, s.mqttRegisterAttempts);
  const firmwareBanner = headline
    ? `<div class="svc-firmware-warning">
        ⚠️ <strong>${escapeHtml(headline)}</strong> — ${escapeHtml(mqttPhaseMessage(phase))}
        ${phase === 'registering' ? `(${s.mqttRegisterAttempts} registration attempts)` : ''}
      </div>`
    : '';

  dropdown.innerHTML = `
    ${firmwareBanner}
    <div class="svc-list">
      <div class="svc-item">${dotHtml(isOk(s.mqtt, ['connected']))}<span class="svc-label">MQTT</span><span class="svc-value">${mqttLabel}</span></div>
      <div class="svc-item">${dotHtml(isOk(s.telegram, ['running']))}<span class="svc-label">Telegram</span><span class="svc-value">${s.telegram}</span></div>
      <div class="svc-item">${dotHtml(isOk(s.ai, ['monitoring', 'idle']))}<span class="svc-label">AI</span><span class="svc-value">${s.ai}</span></div>
      <div class="svc-item">${dotHtml(isOk(s.camera, ['available']))}<span class="svc-label">Camera</span><span class="svc-value">${s.camera}</span></div>
      <div class="svc-item">${dotHtml(!!s.printerSn)}<span class="svc-label">Printer</span><span class="svc-value">${s.printerSn || 'unknown'}</span></div>
      <div class="svc-item">${dotHtml(true)}<span class="svc-label">WS Clients</span><span class="svc-value">${s.wsClients}</span></div>
      <div class="svc-item">${dotHtml(true)}<span class="svc-label">Uptime</span><span class="svc-value">${formatUptime(s.uptime)}</span></div>
    </div>
  `;
}

/* ─── System Info (rendered into dropdown) ─── */

let lastSysKey = '';

export function renderSystemInfo(state: PrinterState): void {
  const container = $('system-info');
  if (!container) return;

  const attrs = state.attributes;
  if (!attrs) return;

  const key = JSON.stringify([attrs.sn, attrs.software_version?.ota_version]);
  if (key === lastSysKey) return;
  lastSysKey = key;

  // Everything here comes from 1001 (GET_ATTRIBUTES). There used to be a second loop
  // over `state.systemInfo`, filled from method 1062 — it never produced a single row,
  // because 1062 answers `{"error_code": 1100}` on this firmware and the handler only
  // stored a result on `error_code === 0` (ELEG-55).
  const rows: [string, string][] = [];

  rows.push(['Hostname', attrs.hostname]);
  rows.push(['Model', attrs.machine_model]);
  rows.push(['Serial', attrs.sn]);
  rows.push(['IP', attrs.ip]);
  if (attrs.software_version) {
    rows.push(['OTA Version', attrs.software_version.ota_version]);
    rows.push(['MCU Version', attrs.software_version.mcu_version]);
    rows.push(['SoC Version', attrs.software_version.soc_version]);
  }
  if (attrs.hardware_version) {
    rows.push(['Hardware', attrs.hardware_version]);
  }
  if (attrs.protocol_version) {
    rows.push(['Protocol', attrs.protocol_version]);
  }

  let html = '<div class="svc-list">';
  for (const [label, value] of rows) {
    html += `<div class="svc-item"><span class="svc-label">${escapeHtml(label)}</span><span class="svc-value">${escapeHtml(value)}</span></div>`;
  }
  html += '</div>';

  container.innerHTML = html;
}
