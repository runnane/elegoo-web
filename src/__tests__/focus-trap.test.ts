// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFocusTrap, focusableWithin } from '../ui/focus-trap';

/**
 * ELEG-41.
 *
 * The issue says "focus behaviour needs a browser; there is no jsdom here". That was
 * true when it was filed and is not any more — ELEG-61 added the jsdom environment and
 * ELEG-64 finished it off. jsdom implements `focus()`, `document.activeElement` and
 * event dispatch, which is everything these assertions need.
 *
 * What jsdom does NOT implement is the *native* behaviour of the `inert` attribute, so
 * the inert tests assert that the attribute is applied and removed, not that the browser
 * honours it. That distinction is stated rather than glossed: honouring it is the
 * browser's job and is checked by hand.
 */

/**
 * The real shape: a dashboard containing a button that commands the machine, and a modal
 * that is a sibling deeper in the tree — not a direct child of body, which is why the
 * trap walks the whole ancestor chain.
 */
function mountLayout() {
  document.body.innerHTML = `
    <div id="app">
      <div id="dashboard">
        <button id="opener">Expand camera</button>
        <button id="danger-home">Home</button>
        <button id="danger-stop">Stop print</button>
      </div>
      <div id="camera-modal" tabindex="-1">
        <img id="camera-modal-img" alt="Camera">
        <button id="camera-modal-close">close</button>
        <button id="camera-modal-snapshot">snapshot</button>
      </div>
    </div>
  `;
  return {
    modal: document.getElementById('camera-modal') as HTMLElement,
    opener: document.getElementById('opener') as HTMLButtonElement,
    close: document.getElementById('camera-modal-close') as HTMLButtonElement,
    snapshot: document.getElementById('camera-modal-snapshot') as HTMLButtonElement,
    home: document.getElementById('danger-home') as HTMLButtonElement,
    dashboard: document.getElementById('dashboard') as HTMLElement,
  };
}

/** Dispatch a Tab keypress the way the trap listens for it. */
function pressTab(shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(e);
  return e;
}

let release: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  release?.();
  release = null;
});

describe('focusableWithin', () => {
  it('finds the focusable children in order', () => {
    const { modal } = mountLayout();
    // The modal itself is tabindex="-1" and must NOT be listed: it is programmatically
    // focusable but not in the tab order, so wrapping to it would strand the user.
    expect(focusableWithin(modal).map((el) => el.id)).toEqual([
      'camera-modal-close',
      'camera-modal-snapshot',
    ]);
  });

  it('excludes disabled controls', () => {
    const { modal, snapshot } = mountLayout();
    snapshot.disabled = true;
    expect(focusableWithin(modal).map((el) => el.id)).toEqual(['camera-modal-close']);
  });

  it('excludes anything marked inert or aria-hidden', () => {
    const { modal, snapshot } = mountLayout();
    snapshot.setAttribute('inert', '');
    expect(focusableWithin(modal).map((el) => el.id)).toEqual(['camera-modal-close']);

    snapshot.removeAttribute('inert');
    snapshot.setAttribute('aria-hidden', 'true');
    expect(focusableWithin(modal).map((el) => el.id)).toEqual(['camera-modal-close']);
  });
});

describe('createFocusTrap', () => {
  it('moves focus into the overlay when opened', () => {
    const { modal, opener, close } = mountLayout();
    opener.focus();
    release = createFocusTrap(modal);
    expect(document.activeElement).toBe(close);
  });

  it('wraps Tab from the last element back to the first', () => {
    const { modal, close, snapshot } = mountLayout();
    release = createFocusTrap(modal);

    snapshot.focus();
    const e = pressTab();

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('wraps Shift+Tab from the first element back to the last', () => {
    const { modal, close, snapshot } = mountLayout();
    release = createFocusTrap(modal);

    close.focus();
    const e = pressTab(true);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(snapshot);
  });

  it('pulls focus back if it has somehow reached the page behind', () => {
    // The core safety property. `danger-home` commands a physical machine, and it is
    // behind an overlay the user cannot see past.
    const { modal, home, close } = mountLayout();
    release = createFocusTrap(modal);

    home.focus();
    expect(document.activeElement).toBe(home);

    pressTab();

    expect(document.activeElement).toBe(close);
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it('marks the background inert and aria-hidden, and unmarks it on release', () => {
    // jsdom does not implement inert's behaviour, so this asserts the attribute
    // contract only; that a browser honours it is checked by hand.
    const { modal, dashboard } = mountLayout();
    release = createFocusTrap(modal);

    expect(dashboard.hasAttribute('inert')).toBe(true);
    expect(dashboard.getAttribute('aria-hidden')).toBe('true');
    // The overlay's own subtree must never be marked.
    expect(modal.hasAttribute('inert')).toBe(false);

    release();
    release = null;

    expect(dashboard.hasAttribute('inert')).toBe(false);
    expect(dashboard.hasAttribute('aria-hidden')).toBe(false);
  });

  it('does not clobber an element that was already aria-hidden', () => {
    // Restoring such an element to "not hidden" on close would be a new bug.
    const { modal, dashboard } = mountLayout();
    dashboard.setAttribute('aria-hidden', 'true');

    release = createFocusTrap(modal);
    release();
    release = null;

    expect(dashboard.getAttribute('aria-hidden')).toBe('true');
  });

  it('calls onEscape and does not act on other keys', () => {
    const { modal } = mountLayout();
    let escapes = 0;
    release = createFocusTrap(modal, { onEscape: () => escapes++ });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(escapes).toBe(0);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(escapes).toBe(1);
  });

  it('restores focus to the opener on release', () => {
    const { modal, opener } = mountLayout();
    opener.focus();
    release = createFocusTrap(modal);
    expect(document.activeElement).not.toBe(opener);

    release();
    release = null;

    // Otherwise a keyboard user is dumped at the top of the document.
    expect(document.activeElement).toBe(opener);
  });

  it('stops trapping once released', () => {
    const { modal, home } = mountLayout();
    release = createFocusTrap(modal);
    release();
    release = null;

    home.focus();
    pressTab();

    // No longer pulled back — the trap must not outlive the overlay.
    expect(document.activeElement).toBe(home);
  });

  it('keeps focus on the container when the overlay has nothing focusable', () => {
    document.body.innerHTML = `<div id="app"><div id="other">x</div><div id="m" tabindex="-1"></div></div>`;
    const modal = document.getElementById('m') as HTMLElement;
    release = createFocusTrap(modal);

    const e = pressTab();

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(modal);
  });
});
