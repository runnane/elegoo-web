/**
 * In-app confirmation (ELEG-165) — the replacement for `window.confirm`.
 *
 * Browser dialogs are banned in every web UI in the set (constitution §24), and a guard in
 * `scripts/gates.sh`'s lint step (biome `noAlert`) fails the gates if one comes back.
 *
 * ## What the native dialog did that this must still do
 *
 * `window.confirm` is blocking, so while it was open no `keydown` reached the keyboard
 * shortcut listener and no second click could land behind it. This modal is asynchronous,
 * so that is no longer free:
 *
 * - `keyboard-shortcuts.ts` checks for `#confirm-dialog-overlay` in `isModalOpen()`, so a
 *   Shift+S typed over an open "Stop the print?" dialog does not stack a second one.
 * - `createFocusTrap` makes the rest of the page `inert`, so a mouse-less user cannot Tab
 *   onto the controls behind it and the dashboard cannot be clicked through it.
 *
 * The message is rendered with `textContent` — a file name or printer name in it is data,
 * never markup.
 */

import { createFocusTrap } from './focus-trap';

export const CONFIRM_OVERLAY_ID = 'confirm-dialog-overlay';

export interface ConfirmOptions {
  /** Dialog title. Defaults to "Are you sure?". */
  title?: string;
  /** Label of the confirming button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label of the cancelling button. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Destructive or machine-driving action: the confirm button is styled `btn-danger` and
   * the default focus is on Cancel, so a stray Enter or Space does not confirm. Without it
   * the confirm button is primary and holds the default focus.
   */
  danger?: boolean;
  /** Extra class on the dialog box, for a distinct treatment (emergency stop). */
  className?: string;
}

let dismissOpen: (() => void) | null = null;

/**
 * Ask the user to confirm. Resolves `true` only on an explicit click of the confirm
 * button; Cancel, Escape and a click on the backdrop all resolve `false`.
 *
 * Only one confirmation can be open: asking again cancels the one on screen (resolving it
 * `false`) rather than stacking, so an action is never confirmed by a click that was
 * meant for a different question.
 */
export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  dismissOpen?.();

  const { title = 'Are you sure?', confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = options;
  const danger = options.danger === true;

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = CONFIRM_OVERLAY_ID;
    overlay.className = 'print-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = ['print-dialog', 'confirm-dialog', options.className]
      .filter(Boolean)
      .join(' ');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'print-dialog-header';
    const titleEl = document.createElement('span');
    titleEl.id = 'confirm-dialog-title';
    titleEl.textContent = title;
    header.appendChild(titleEl);
    dialog.setAttribute('aria-labelledby', titleEl.id);

    const body = document.createElement('div');
    body.className = 'print-dialog-body';
    const text = document.createElement('p');
    text.className = 'confirm-dialog-message';
    text.id = 'confirm-dialog-message';
    text.textContent = message;
    body.appendChild(text);
    dialog.setAttribute('aria-describedby', text.id);

    const footer = document.createElement('div');
    footer.className = 'print-dialog-footer';
    // Cancel first in DOM order: the focus trap puts initial focus on the first focusable.
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.id = 'confirm-dialog-cancel';
    cancelBtn.textContent = cancelLabel;
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.id = 'confirm-dialog-confirm';
    confirmBtn.textContent = confirmLabel;
    footer.append(cancelBtn, confirmBtn);

    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let release: (() => void) | null = null;
    function settle(answer: boolean): void {
      if (!release) return; // already settled
      const undo = release;
      release = null;
      dismissOpen = null;
      overlay.remove();
      undo(); // lifts `inert` and returns focus to the trigger
      resolve(answer);
    }

    release = createFocusTrap(dialog, { onEscape: () => settle(false) });
    dismissOpen = () => settle(false);
    if (!danger) confirmBtn.focus();

    cancelBtn.addEventListener('click', () => settle(false));
    confirmBtn.addEventListener('click', () => settle(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) settle(false);
    });
  });
}
