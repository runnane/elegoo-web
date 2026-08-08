/**
 * Power-loss recovery prompt (ELEG-29).
 *
 * The CC2 reports machine status 15 after power is restored with a print in progress.
 * It then sits there waiting to be told whether to carry on or give up, and the web app
 * is the thing people have open — so this is the one place where *not* having UI has a
 * real cost.
 *
 * ## The methods, and how far they are verified
 *
 * Resume is **1023 (ResumePrint)** and cancel is **1022 (CancelPrint)** — the same
 * methods as a normal resume and stop, both taking no parameters. The issue asked for
 * that assumption to be checked rather than believed. It was, against both protocol
 * sources in `data/`:
 *
 * - `CC2_PROTOCOL_REFERENCE.md` — the full method table has no power-loss-specific
 *   method; state 15 is `PowerOffResume` and 2405/2406 are its sub-statuses.
 * - `CC2-OFFICIAL-APP-PATTERNS.md` — same, independently transcribed from the app.
 *
 * So the assumption is *supported* by everything available. It is **not confirmed
 * against a live recovery**, because triggering one means cutting power mid-print,
 * which nobody should do to find out. See the OPERATOR issue linked from ELEG-29.
 *
 * ## The boundary
 *
 * Both buttons command the printer. Neither was ever fired to test this, per AGENTS.md.
 */

import type { CommandSender } from '../ws-client';
import type { PowerLossState } from '../types';
import { escapeHtml } from './helpers';

/**
 * Only prompt once per recovery. Without this, the dialog would be rebuilt on every
 * status frame — roughly once a second — and a click could never land.
 */
let promptedForRecovery = false;

/** Reset when the printer leaves the recovery state, so a later power loss prompts again. */
function resetIfClear(state: PowerLossState): void {
  if (state === 'none') promptedForRecovery = false;
}

/** Show the prompt if a recovery is waiting on a decision, and has not been prompted. */
export function maybeShowPowerLossDialog(
  state: PowerLossState,
  filename: string | undefined,
  client: CommandSender,
): void {
  resetIfClear(state);
  // 'resuming' and 'resumed' mean the decision is already made; prompting again would
  // invite a second resume on a print that is already recovering.
  if (state !== 'awaiting_decision') return;
  if (promptedForRecovery) return;
  if (document.getElementById('power-loss-overlay')) return;
  promptedForRecovery = true;
  showPowerLossDialog(filename, client);
}

function close(): void {
  document.getElementById('power-loss-overlay')?.remove();
}

function showPowerLossDialog(filename: string | undefined, client: CommandSender): void {
  const overlay = document.createElement('div');
  overlay.id = 'power-loss-overlay';
  overlay.className = 'print-dialog-overlay';

  const fileLine = filename
    ? `<div class="print-dialog-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>`
    : '';

  overlay.innerHTML = `
    <div class="print-dialog">
      <div class="print-dialog-header">
        <span>⚡ Power loss detected</span>
      </div>
      <div class="print-dialog-body">
        <p>The printer lost power during a print and is waiting for a decision.</p>
        ${fileLine}
        <p class="settings-hint">
          Check the model and the bed before resuming — a print that shifted or came
          loose while the power was off will not recover, and resuming will print into
          the air. Cancelling cannot be undone.
        </p>
      </div>
      <div class="print-dialog-footer">
        <button class="btn btn-ghost" id="power-loss-dismiss">Decide later</button>
        <button class="btn btn-danger" id="power-loss-cancel">Cancel print</button>
        <button class="btn btn-primary" id="power-loss-resume">Resume print</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('#power-loss-dismiss')?.addEventListener('click', close);

  overlay.querySelector('#power-loss-resume')?.addEventListener('click', () => {
    close();
    client.sendCommand(1023, {});
  });

  overlay.querySelector('#power-loss-cancel')?.addEventListener('click', () => {
    // Confirmed separately: this abandons a job that may be most of the way done, and
    // the printer cannot be asked to undo it.
    if (!confirm('Cancel the interrupted print?\n\nThis cannot be undone.')) return;
    close();
    client.sendCommand(1022, {});
  });
}
