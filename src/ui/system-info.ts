import type { PrinterState } from '../printer-state';
import { $, escapeHtml } from './helpers';

let lastKey = '';

export function renderSystemInfo(state: PrinterState): void {
  const container = $('system-info');
  const attrs = state.attributes;
  const sysInfo = state.systemInfo;

  if (!attrs && !sysInfo) return;

  // Build a key from several fields to detect changes
  const key = JSON.stringify([attrs?.sn, attrs?.software_version?.ota_version, sysInfo]);
  if (key === lastKey) return;
  lastKey = key;

  const rows: [string, string][] = [];

  if (attrs) {
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
  }

  if (sysInfo) {
    for (const [k, v] of Object.entries(sysInfo)) {
      if (typeof v === 'string' || typeof v === 'number') {
        const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        rows.push([label, String(v)]);
      }
    }
  }

  let html = '<div class="info-grid">';
  for (const [label, value] of rows) {
    html += `<div class="info-row">`;
    html += `<span class="info-label">${escapeHtml(label)}</span>`;
    html += `<span class="info-value">${escapeHtml(value)}</span>`;
    html += `</div>`;
  }
  html += '</div>';

  container.innerHTML = html;
}
