import { describe, expect, it } from 'vitest';
import { BINDINGS, isDestructiveAction, resolveShortcut, type KeyLikeEvent } from '../ui/keymap';

const OPEN: { inputFocused: boolean; modalOpen: boolean } = {
  inputFocused: false,
  modalOpen: false,
};

/**
 * One event per binding that satisfies exactly that binding's `match` — used by the
 * focus-guard and modal-guard tests below to exercise every binding, not just the ones
 * spelled out explicitly. Kept in binding order so a new binding added to `BINDINGS`
 * without a corresponding entry here fails loudly (`binding.match` returns false for
 * every existing event) rather than being silently skipped by the guard tests.
 */
const CANONICAL_EVENTS: readonly KeyLikeEvent[] = [
  { key: '1' },
  { key: '2' },
  { key: '3' },
  { key: '4' },
  { key: '5' },
  { key: 'f' },
  { key: 'c' },
  { key: '?', shiftKey: true },
  { key: 'p', shiftKey: true },
  { key: 'r', shiftKey: true },
  { key: 's', shiftKey: true },
  { key: 'h', shiftKey: true },
];

describe('resolveShortcut — every binding resolves to its own action (BINDINGS stays in sync with CANONICAL_EVENTS)', () => {
  it('CANONICAL_EVENTS has exactly one entry per binding, in order', () => {
    expect(CANONICAL_EVENTS).toHaveLength(BINDINGS.length);
  });

  it.each(BINDINGS.map((b, i) => [b.display, i] as const))(
    'binding "%s" resolves via its canonical event',
    (_display, i) => {
      const event = CANONICAL_EVENTS[i];
      expect(resolveShortcut(event, OPEN)).toEqual(BINDINGS[i].action);
    },
  );
});

describe('resolveShortcut — explicit bindings', () => {
  it('bare number keys switch tabs', () => {
    expect(resolveShortcut({ key: '1' }, OPEN)).toEqual({ type: 'tab', tab: 'dashboard' });
    expect(resolveShortcut({ key: '2' }, OPEN)).toEqual({ type: 'tab', tab: 'tools' });
    expect(resolveShortcut({ key: '3' }, OPEN)).toEqual({ type: 'tab', tab: 'settings' });
    expect(resolveShortcut({ key: '4' }, OPEN)).toEqual({ type: 'tab', tab: 'debug' });
    expect(resolveShortcut({ key: '5' }, OPEN)).toEqual({ type: 'tab', tab: 'help' });
  });

  it('"f" focuses the file filter', () => {
    expect(resolveShortcut({ key: 'f' }, OPEN)).toEqual({ type: 'focus-filter' });
  });

  it('"c" toggles the camera overlay', () => {
    expect(resolveShortcut({ key: 'c' }, OPEN)).toEqual({ type: 'toggle-camera-overlay' });
  });

  it('"?" opens help — matched by character, not by treating Shift as a modifier', () => {
    expect(resolveShortcut({ key: '?', shiftKey: true }, OPEN)).toEqual({ type: 'help' });
  });

  it('Shift+P pauses; Shift+R resumes — no confirmation needed, but Shift is required', () => {
    expect(resolveShortcut({ key: 'p', shiftKey: true }, OPEN)).toEqual({ type: 'pause' });
    expect(resolveShortcut({ key: 'r', shiftKey: true }, OPEN)).toEqual({ type: 'resume' });
  });

  it('Shift+S stops; Shift+H homes', () => {
    expect(resolveShortcut({ key: 's', shiftKey: true }, OPEN)).toEqual({ type: 'stop' });
    expect(resolveShortcut({ key: 'h', shiftKey: true }, OPEN)).toEqual({ type: 'home' });
  });

  it('is case-insensitive on the letter', () => {
    expect(resolveShortcut({ key: 'P', shiftKey: true }, OPEN)).toEqual({ type: 'pause' });
    expect(resolveShortcut({ key: 'S', shiftKey: true }, OPEN)).toEqual({ type: 'stop' });
  });
});

describe('resolveShortcut — every printer action requires the modifier, not just the destructive ones', () => {
  it('bare "p" (no Shift) resolves to nothing — it does NOT pause the print', () => {
    expect(resolveShortcut({ key: 'p' }, OPEN)).toBeNull();
  });

  it('bare "r" (no Shift) resolves to nothing — it does NOT resume the print', () => {
    expect(resolveShortcut({ key: 'r' }, OPEN)).toBeNull();
  });

  it('bare "s" (no Shift) resolves to nothing — it does NOT stop the print', () => {
    expect(resolveShortcut({ key: 's' }, OPEN)).toBeNull();
  });

  it('bare "h" (no Shift) resolves to nothing — it does NOT home the axes', () => {
    expect(resolveShortcut({ key: 'h' }, OPEN)).toBeNull();
  });

  it('Ctrl/Meta/Alt is never substituted for Shift on a printer-action binding', () => {
    expect(resolveShortcut({ key: 'p', ctrlKey: true }, OPEN)).toBeNull();
    expect(resolveShortcut({ key: 'r', metaKey: true }, OPEN)).toBeNull();
    expect(resolveShortcut({ key: 's', ctrlKey: true }, OPEN)).toBeNull();
    expect(resolveShortcut({ key: 's', metaKey: true }, OPEN)).toBeNull();
    expect(resolveShortcut({ key: 'h', altKey: true }, OPEN)).toBeNull();
  });

  it('every destructive binding is flagged by isDestructiveAction; Pause/Resume are not, despite also needing Shift', () => {
    for (const binding of BINDINGS) {
      const destructive = binding.action.type === 'stop' || binding.action.type === 'home';
      expect(isDestructiveAction(binding.action)).toBe(destructive);
    }
  });
});

describe('resolveShortcut — a browser-reserved combo is never hijacked', () => {
  it('Ctrl+F (browser find) does not resolve to focus-filter', () => {
    expect(resolveShortcut({ key: 'f', ctrlKey: true }, OPEN)).toBeNull();
  });

  it('Meta+F (macOS find) does not resolve to focus-filter', () => {
    expect(resolveShortcut({ key: 'f', metaKey: true }, OPEN)).toBeNull();
  });

  it('Ctrl+P (browser print) does not resolve to pause', () => {
    expect(resolveShortcut({ key: 'p', ctrlKey: true }, OPEN)).toBeNull();
  });
});

describe('resolveShortcut — focus guard', () => {
  it('every binding resolves to null while a text input has focus', () => {
    BINDINGS.forEach((binding, i) => {
      expect(
        resolveShortcut(CANONICAL_EVENTS[i], { inputFocused: true, modalOpen: false }),
        `binding "${binding.display}" fired while an input was focused`,
      ).toBeNull();
    });
  });
});

describe('resolveShortcut — modal guard', () => {
  it('every binding resolves to null while a modal/confirmation/overlay is open', () => {
    BINDINGS.forEach((binding, i) => {
      expect(
        resolveShortcut(CANONICAL_EVENTS[i], { inputFocused: false, modalOpen: true }),
        `binding "${binding.display}" fired while a modal was open`,
      ).toBeNull();
    });
  });
});

describe('resolveShortcut — held-key guard', () => {
  it('a repeated (held) Stop keypress does not re-fire the action', () => {
    expect(resolveShortcut({ key: 's', shiftKey: true, repeat: true }, OPEN)).toBeNull();
  });

  it('a repeated (held) Home keypress does not re-fire the action', () => {
    expect(resolveShortcut({ key: 'h', shiftKey: true, repeat: true }, OPEN)).toBeNull();
  });

  it('a single, non-repeated Stop keypress still resolves normally', () => {
    expect(resolveShortcut({ key: 's', shiftKey: true, repeat: false }, OPEN)).toEqual({
      type: 'stop',
    });
  });
});
