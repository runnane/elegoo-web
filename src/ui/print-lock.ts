/**
 * ELEG-163 — lock the controls that can ruin a running job.
 *
 * While the printer has a job (printing, paused, or waiting on a power-loss decision),
 * the jog pad, both Home buttons, the heater Set/Off buttons and inputs, the temperature
 * presets and the Canvas tray Load/Unload buttons are disabled. A mis-tap on any of them
 * would home the toolhead into the part, move it mid-layer, kill a heater, or start a
 * filament change under a print.
 *
 * Deliberately left live: Pause / Resume / Stop / Emergency stop, fans, the light and
 * speed mode — all reasonable things to change mid-print. The four calibration actions
 * are locked by `renderMaintenance` already (any status other than idle).
 *
 * The lock is marked with `data-print-lock` so `guardedSend`'s re-enable path (response
 * or timeout) cannot hand a locked button back to the user mid-print.
 *
 * Which statuses count as a job is `isJobActive` in `src/types.ts`, shared with the
 * server's print guard (ELEG-176, `src/server/print-guard.ts`). The server is deliberately
 * more permissive on 1028 than this lock: it refuses only heater-off and a nozzle below
 * extrusion temperature, while the UI locks Set and the presets too, against a mis-tap.
 */

/** Elements locked while a job is active. */
export const PRINT_LOCK_SELECTOR = [
  '.move-btn', // jog X/Y/Z and both Home buttons
  '#btn-set-nozzle',
  '#btn-off-nozzle',
  '#btn-set-bed',
  '#btn-off-bed',
  '#set-nozzle-temp',
  '#set-bed-temp',
  '.temp-preset-btn',
  '.spool-load-btn',
  '.spool-unload-btn',
].join(', ');

export const PRINT_LOCK_REASON = 'Disabled while printing';

/** True when an element is currently held disabled by the print lock. */
export function isPrintLocked(el: Element): boolean {
  return (el as HTMLElement).dataset?.printLock === '1';
}

/**
 * Lock or unlock every matching control under `root`. Idempotent, so it is safe to run
 * on every render — including after a card re-renders its buttons from scratch.
 */
export function applyPrintLock(root: ParentNode, locked: boolean): void {
  root.querySelectorAll<HTMLButtonElement | HTMLInputElement>(PRINT_LOCK_SELECTOR).forEach((el) => {
    if (locked) {
      if (isPrintLocked(el)) return;
      el.dataset.printLock = '1';
      el.dataset.printLockTitle = el.getAttribute('title') ?? '';
      el.title = PRINT_LOCK_REASON;
      el.disabled = true;
      return;
    }
    if (!isPrintLocked(el)) return;
    const prevTitle = el.dataset.printLockTitle ?? '';
    if (prevTitle) el.title = prevTitle;
    else el.removeAttribute('title');
    delete el.dataset.printLock;
    delete el.dataset.printLockTitle;
    // A command still in flight keeps its own disable until the response arrives.
    if (!el.classList.contains('cmd-pending')) el.disabled = false;
  });
}
