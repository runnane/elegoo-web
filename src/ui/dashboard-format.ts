/**
 * Dashboard text formatting — the pure half (ELEG-174).
 *
 * Free of DOM and module-level side effects, so it can be unit-tested in the node
 * environment. `print-status.ts` imports it; that module wires the camera and reads UI
 * settings at import time, which makes it a poor thing to test directly.
 */

import { powerLossState, STATUS_NAMES, SUB_STATUS_NAMES } from '../types';

/**
 * A temperature reading for display, without the unit.
 *
 * The printer reports whole degrees almost all of the time, and the dashboard used to
 * print them with two decimals ("210.00"). A whole number is shown as one; anything else
 * gets a single decimal, which is more precision than the sensors carry anyway.
 */
export function formatTemperature(celsius: number): string {
  if (!Number.isFinite(celsius)) return '--';
  const tenths = Math.round(celsius * 10) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

/**
 * The " · <sub-status>" suffix shown after a status word, or nothing.
 *
 * Several sub-statuses carry the same name as the status they belong to — 2075
 * "Printing", 2502 "Paused", 2801 "Homing", 2901 "Auto Leveling" — which rendered as
 * "Printing · Printing". `shown` is the word actually rendered before the suffix, which
 * is not always the status name (the badge hardcodes "Printing" and "Paused").
 */
export function subStatusSuffix(shown: string, subStatusName: string | undefined): string {
  const sub = subStatusName?.trim() ?? '';
  if (!sub) return '';
  if (sub.toLowerCase() === shown.trim().toLowerCase()) return '';
  return ` · ${sub}`;
}

/** What the print-status badge says, and the class that colours it. */
export interface StatusBadgeView {
  text: string;
  className: 'badge-printing' | 'badge-paused' | 'badge-busy' | 'badge-error' | 'badge-idle';
}

/**
 * The print-status badge for a machine status and sub-status.
 *
 * Moved out of `renderDashboard` so the de-duplication can be tested: each branch passes
 * the word it actually renders to `subStatusSuffix`, because the printing and paused
 * branches render a fixed word, not the status name.
 */
export function statusBadge(
  status: number | undefined | null,
  subStatus: number | undefined | null,
): StatusBadgeView {
  const statusName = (status != null ? STATUS_NAMES[status] : undefined) ?? 'Unknown';
  const subStatusName = (subStatus != null ? SUB_STATUS_NAMES[subStatus] : undefined) ?? '';
  const isPrinting = status === 2;
  const isPaused = subStatus === 2502 || subStatus === 2505;
  const subLabel = subStatusSuffix(statusName, subStatusName);
  const powerLoss = powerLossState(status, subStatus);

  if (isPrinting && !isPaused) {
    return {
      text: `⟳ Printing${subStatusSuffix('Printing', subStatusName)}`,
      className: 'badge-printing',
    };
  }
  if (isPaused) {
    return {
      text: `⏸ Paused${subStatusSuffix('Paused', subStatusName)}`,
      className: 'badge-paused',
    };
  }
  if (status === 5) return { text: `📐 ${statusName}${subLabel}`, className: 'badge-busy' };
  if (status === 3 || status === 4 || status === 13) {
    return { text: `🔄 ${statusName}${subLabel}`, className: 'badge-busy' };
  }
  if (status === 6 || status === 7 || status === 8) {
    return { text: `⚙️ ${statusName}${subLabel}`, className: 'badge-busy' };
  }
  if (status === 14) return { text: `🛑 ${statusName}`, className: 'badge-error' };
  if (powerLoss !== 'none') {
    // Status 15 used to fall through to the idle branch and render as `badge-idle` —
    // the printer sitting on a half-finished job awaiting a decision, styled as though
    // it had nothing to do (ELEG-29).
    return powerLoss === 'awaiting_decision'
      ? { text: '⚡ Power loss — resume or cancel', className: 'badge-error' }
      : { text: `⚡ ${statusName}${subLabel}`, className: 'badge-busy' };
  }
  return { text: statusName + subLabel, className: 'badge-idle' };
}

/**
 * The header subtitle: hostname, model in parentheses, firmware.
 *
 * The CC2 reports a hostname of "Elegoo Centauri Carbon 2" and a model of "Centauri
 * Carbon 2", which read "Elegoo Centauri Carbon 2 (Centauri Carbon 2)". The parenthesis
 * is dropped when the hostname already contains the model; a renamed printer keeps it.
 */
export function printerSubtitle(
  hostname: string | undefined,
  model: string | undefined,
  firmware: string | undefined,
): string {
  const host = hostname?.trim() ?? '';
  const mdl = model?.trim() ?? '';
  let name: string;
  if (!host) name = mdl;
  else if (!mdl || host.toLowerCase().includes(mdl.toLowerCase())) name = host;
  else name = `${host} (${mdl})`;
  const fw = firmware?.trim();
  return fw ? `${name} — FW ${fw}` : name;
}

/**
 * Toolhead speed for the Speed & Flow card.
 *
 * `gcode_move.speed` is the gcode feed rate in mm/min (a typical value is 12000). Shown
 * as mm/s — 200 mm/s is the number people know their printer by, and it is short enough
 * not to wrap in the sidebar.
 */
export function formatToolheadSpeed(mmPerMin: number | undefined): string {
  if (!mmPerMin || !Number.isFinite(mmPerMin) || mmPerMin <= 0) return '-- mm/s';
  return `${Math.round(mmPerMin / 60)} mm/s`;
}
