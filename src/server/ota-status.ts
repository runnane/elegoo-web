/**
 * OTA firmware-update state, read-only, for the non-browser consumers (ELEG-104).
 *
 * The web dashboard got a "do not power off" banner in ELEG-98, derived from the
 * printer's own `sub_status` (2601 OTAInfoUpdating, 2701 OTADownloading, 2702
 * OTAExtracting, 2703 OTAUpdating, 2704 OTAComplete, 2705 OTAFailed — see
 * `isOtaSubStatus` in `src/types.ts`). Telegram and the Moonraker compat layer say the
 * same thing through their own channels; the two pure functions here are the whole of
 * that decision, so a test reaches them without a bot, a socket or a printer.
 *
 * Nothing in this module — or anywhere it is called from — sends an OTA command. The
 * flash trigger (method 1039) stays parked in ELEG-99; this only reacts to what the
 * printer reports on its own.
 */

import { isOtaInProgressSubStatus, isOtaSubStatus, SUB_STATUS_NAMES } from '../types.js';

/**
 * The four moments worth telling a human about, out of every OTA `sub_status_change`:
 *
 * - `entered`    — the printer just went from a non-OTA state into an in-progress OTA
 *                  phase. The one "do not power off" warning.
 * - `completed`  — it reported 2704 OTAComplete (it will reboot on its own).
 * - `failed`     — it reported 2705 OTAFailed.
 * - `ended`      — it left an in-progress phase for a non-OTA state without ever
 *                  reporting 2704/2705 (a reboot mid-flash reconnects this way). A
 *                  neutral message so the earlier warning does not hang unanswered.
 *
 * `null` for everything else, and in particular for the hop between in-progress phases
 * (2701 → 2702 → 2703): those arrive at the printer's cadence, and a message per hop
 * is exactly the noise the issue warned against.
 */
export type OtaTransition = 'entered' | 'completed' | 'failed' | 'ended';

export function classifyOtaTransition(fromCode: number, toCode: number): OtaTransition | null {
  const fromOta = isOtaSubStatus(fromCode);
  const toOta = isOtaSubStatus(toCode);
  if (!fromOta && !toOta) return null;
  // The terminal codes speak for themselves whichever phase preceded them — including
  // a service (re)start whose baseline already sits at 2704/2705 (fromCode -1).
  if (toCode === 2704) return 'completed';
  if (toCode === 2705) return 'failed';
  if (!fromOta && toOta) return 'entered';
  // Leaving OTA: only an in-progress phase leaves a warning to close out. Leaving
  // 2704/2705 was already reported when the terminal code arrived.
  if (fromOta && !toOta) return isOtaInProgressSubStatus(fromCode) ? 'ended' : null;
  return null;
}

/**
 * The phase name as the web banner's neighbours would show it — `SUB_STATUS_NAMES`
 * says 'OTA Downloading'; the "OTA " prefix is redundant next to "Firmware update".
 */
export function otaPhaseName(subStatus: number): string {
  const name = SUB_STATUS_NAMES[subStatus];
  if (!name) return `code ${subStatus}`;
  return name.replace(/^OTA\s+/, '');
}

/**
 * Text for Moonraker's `display_status.message` — Klipper's `M117` channel, which
 * Mainsail and Fluidd already render as a banner without any schema change on our side.
 * Empty (the field's normal value here) whenever the printer is not reporting an OTA
 * code, so the banner clears on its own once the update is over.
 *
 * Wording mirrors `renderOtaBanner` in `src/ui/print-status.ts` (ELEG-98) so a person
 * looking at Mainsail and at the dashboard reads the same sentence.
 */
export function otaDisplayMessage(subStatus: number | undefined | null): string {
  if (subStatus == null || !isOtaSubStatus(subStatus)) return '';
  if (isOtaInProgressSubStatus(subStatus)) {
    return `Firmware update in progress (${otaPhaseName(subStatus)}) — do not power off the printer`;
  }
  if (subStatus === 2704) return 'Firmware update complete — the printer will restart on its own';
  // 2705 OTAFailed
  return 'Firmware update failed';
}
