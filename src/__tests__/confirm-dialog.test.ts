// @vitest-environment jsdom
/**
 * ELEG-165 — the in-app confirmation that replaced `window.confirm`.
 *
 * The wiring through a real guarded button (a cancelled Stop/Home sends nothing, a
 * shortcut cannot stack a second dialog) is in `keyboard-shortcuts-dom.test.ts`; this
 * file pins the helper's own contract.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { confirmDialog } from '../ui/confirm-dialog';

const overlay = () => document.getElementById('confirm-dialog-overlay');
const button = (which: 'confirm' | 'cancel') =>
  document.getElementById(`confirm-dialog-${which}`) as HTMLButtonElement;

function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  // Settle anything a failed assertion left open, so one test cannot leak into the next.
  overlay() && button('cancel').click();
  document.body.innerHTML = '';
});

describe('confirmDialog', () => {
  it('resolves true on Confirm and removes itself', async () => {
    const p = confirmDialog('Delete it?');
    expect(overlay()).not.toBeNull();
    button('confirm').click();
    expect(await p).toBe(true);
    expect(overlay()).toBeNull();
  });

  it('resolves false on Cancel', async () => {
    const p = confirmDialog('Delete it?');
    button('cancel').click();
    expect(await p).toBe(false);
    expect(overlay()).toBeNull();
  });

  it('resolves false on Escape', async () => {
    const p = confirmDialog('Delete it?');
    pressEscape();
    expect(await p).toBe(false);
    expect(overlay()).toBeNull();
  });

  it('resolves false on a backdrop click, but not on a click inside the dialog', async () => {
    const p = confirmDialog('Delete it?');
    document.querySelector<HTMLElement>('.confirm-dialog')!.click();
    expect(overlay()).not.toBeNull();
    overlay()!.click();
    expect(await p).toBe(false);
  });

  it('focuses Cancel for a danger confirmation and Confirm otherwise', async () => {
    const danger = confirmDialog('Stop?', { danger: true });
    expect(document.activeElement).toBe(button('cancel'));
    expect(button('confirm').classList.contains('btn-danger')).toBe(true);
    button('cancel').click();
    await danger;

    const plain = confirmDialog('Proceed?');
    expect(document.activeElement).toBe(button('confirm'));
    expect(button('confirm').classList.contains('btn-primary')).toBe(true);
    button('cancel').click();
    await plain;
  });

  it('returns focus to the trigger and lifts inert from the page behind it', async () => {
    document.body.innerHTML = '<main id="page"><button id="trigger">Go</button></main>';
    const trigger = document.getElementById('trigger') as HTMLButtonElement;
    trigger.focus();

    const p = confirmDialog('Sure?', { danger: true });
    expect(document.getElementById('page')!.hasAttribute('inert')).toBe(true);
    pressEscape();
    await p;

    expect(document.getElementById('page')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('renders the message as text, never markup', async () => {
    const p = confirmDialog('<img id="pwn" src=x> report.gcode');
    expect(document.getElementById('pwn')).toBeNull();
    expect(document.getElementById('confirm-dialog-message')!.textContent).toBe(
      '<img id="pwn" src=x> report.gcode',
    );
    button('cancel').click();
    await p;
  });

  it('asking again cancels the open one instead of stacking', async () => {
    const first = confirmDialog('First?');
    const second = confirmDialog('Second?');
    expect(await first).toBe(false);
    expect(document.querySelectorAll('#confirm-dialog-overlay')).toHaveLength(1);
    expect(document.getElementById('confirm-dialog-message')!.textContent).toBe('Second?');
    button('confirm').click();
    expect(await second).toBe(true);
  });

  it('uses custom labels and title', async () => {
    const p = confirmDialog('Really?', {
      title: 'Delete file',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
    });
    expect(document.getElementById('confirm-dialog-title')!.textContent).toBe('Delete file');
    expect(button('confirm').textContent).toBe('Delete');
    expect(button('cancel').textContent).toBe('Keep');
    button('cancel').click();
    await p;
  });
});
