/**
 * Keyboard shortcut wiring (ELEG-33) — turns `keymap.ts`'s pure resolution into actual
 * DOM effects.
 *
 * **Destructive actions are dispatched by clicking the real button**, not by sending a
 * command directly. `bindControls` in `controls.ts` is what puts the throttle, the
 * in-flight disable and (for Stop) the `confirm()` dialog on `btn-stop` — clicking it
 * is how a shortcut inherits every one of those for free, and it means a shortcut can
 * never do less checking than the button: whatever the button's handler does, the
 * shortcut gets exactly that, because it IS that handler running.
 *
 * Home is the one exception worth calling out: its buttons have never called
 * `confirm()` — the CC2 firmware homes all axes regardless of which button is
 * pressed, so the two buttons never needed to ask. The issue is explicit that Home is
 * destructive, so this module adds a confirmation in front of the click, using the
 * same `window.confirm` mechanism Stop already uses, rather than sending a raw
 * command or inventing a second dialog implementation.
 */

import { switchToTab } from './settings';
import { toggleCameraOverlay } from './print-status';
import { resolveShortcut, type ShortcutAction, type ShortcutContext } from './keymap';

let bound = false;

const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isTextInputFocused(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  if (TEXT_INPUT_TAGS.has(active.tagName)) return true;
  return active.isContentEditable === true;
}

/**
 * Any surface the issue calls "a modal/confirmation/overlay" — checked so a shortcut
 * typed while one of these is open does not also drive the dashboard behind it.
 * `window.confirm` itself needs no entry here: it is a blocking, synchronous native
 * dialog, so no `keydown` reaches this listener while one is open.
 */
function isModalOpen(): boolean {
  const cameraModal = document.getElementById('camera-modal');
  if (cameraModal && !cameraModal.classList.contains('hidden')) return true;
  if (document.getElementById('print-dialog-overlay')) return true;
  if (document.getElementById('power-loss-overlay')) return true;
  return false;
}

function currentContext(): ShortcutContext {
  return { inputFocused: isTextInputFocused(), modalOpen: isModalOpen() };
}

/** Click a button by id if it exists — a no-op is correct wherever that card is not mounted (yet). */
function clickButton(id: string): void {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  el?.click();
}

function dispatch(action: ShortcutAction): void {
  switch (action.type) {
    case 'tab':
      switchToTab(action.tab);
      return;
    case 'focus-filter':
      switchToTab('dashboard');
      document.getElementById('files-filter')?.focus();
      return;
    case 'toggle-camera-overlay':
      toggleCameraOverlay();
      return;
    case 'help':
      switchToTab('help');
      return;
    case 'pause':
      clickButton('btn-pause');
      return;
    case 'resume':
      clickButton('btn-resume');
      return;
    case 'stop':
      // btn-stop's own click handler (controls.ts) calls confirm() before sending —
      // nothing here duplicates or bypasses that.
      clickButton('btn-stop');
      return;
    case 'home':
      if (!confirm('Home all axes?\n\nThe toolhead will move — make sure the bed is clear.')) {
        return;
      }
      clickButton('btn-home-all');
      return;
  }
}

function onKeydown(e: KeyboardEvent): void {
  const action = resolveShortcut(e, currentContext());
  if (!action) return;
  e.preventDefault();
  dispatch(action);
}

/** Bind the global shortcut listener. Idempotent — safe to call every time the dashboard is shown. */
export function bindKeyboardShortcuts(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('keydown', onKeydown);
}
