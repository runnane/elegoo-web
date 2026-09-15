/**
 * Keyboard shortcut resolution (ELEG-33) — a pure function from a key event and the
 * current focus/overlay context to an action, or `null` for "do nothing".
 *
 * ## Why bare keys are unsafe here
 *
 * The original `TODO.md` item proposed bare single keys for Pause/Resume/Stop/Home —
 * `S` stops a print, `H` drives the toolhead into whatever is on the bed. On a page
 * often left open on a second monitor, a stray keystroke (a cat, a sleeve, a focus
 * slip) fires it with no undo. See the issue for the full argument.
 *
 * ## The scheme
 *
 * - **Bare keys only for non-destructive, non-printer actions**: switching tabs,
 *   focusing the file filter, toggling the camera overlay, opening Help. The issue's
 *   own list of what may be bare is exactly this set — Pause and Resume are printer
 *   commands and are not on it, so they do not get a bare key either, even though
 *   neither needs a confirmation.
 * - **Every printer action sits behind Shift**, chosen because it needs no
 *   Cmd-vs-Ctrl distinction between macOS and everything else, and collides with none
 *   of the browser-reserved `Ctrl+`/`Cmd+` combos (`Ctrl+W`, `Ctrl+R`, `Ctrl+H`, …).
 *   The issue's page-left-open-on-a-second-monitor argument applies just as much to a
 *   bare `P` pausing a 14-hour print or a bare `R` restarting motion on a paused one as
 *   it does to Stop or Home — a stray keystroke commands the printer either way. Pause
 *   and Resume resolve to an action on `Shift+P`/`Shift+R` with **no confirmation**
 *   (the issue's "Pause is arguably safe" is about the confirmation, not the modifier,
 *   and the existing buttons in `src/ui/controls.ts` confirm neither). Stop and Home
 *   also require Shift, **and** additionally go through a confirmation — the DOM
 *   wiring in `keyboard-shortcuts.ts` is what actually shows it before sending
 *   anything.
 * - **Emergency Stop has no binding at all** — it is not in the original proposal, it
 *   already has an always-visible button, and adding a keyboard path to it only grows
 *   the accidental-trigger surface without anyone having asked for it.
 * - **Nothing resolves while a text input has focus, while a modal/confirmation/
 *   overlay is open, or on a held-key repeat** — `resolveShortcut` returns `null` for
 *   all three, checked by the caller (`keyboard-shortcuts.ts`) rather than trusted to
 *   it, so every binding gets the guard rather than each call site remembering to ask.
 */

/** The subset of `KeyboardEvent` this module reads — kept minimal so tests do not need a real event. */
export interface KeyLikeEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** True when the OS is auto-repeating a held key. */
  repeat?: boolean;
}

export interface ShortcutContext {
  /** An `input`, `textarea`, `select`, or `contenteditable` element currently has focus. */
  inputFocused: boolean;
  /** A modal, confirmation dialog, or overlay (camera fullscreen, print dialog, power-loss prompt) is open. */
  modalOpen: boolean;
}

export type MainTab = 'dashboard' | 'tools' | 'settings' | 'debug' | 'help';

export type ShortcutAction =
  | { type: 'tab'; tab: MainTab }
  | { type: 'focus-filter' }
  | { type: 'toggle-camera-overlay' }
  | { type: 'help' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'home' };

/** Actions that command physical motion or abandon a job — see the module doc for why these two. */
const DESTRUCTIVE_ACTIONS: ReadonlySet<ShortcutAction['type']> = new Set(['stop', 'home']);

export function isDestructiveAction(action: ShortcutAction): boolean {
  return DESTRUCTIVE_ACTIONS.has(action.type);
}

/** No modifier at all — the plain "press this key" case. */
function bare(key: string): (e: KeyLikeEvent) => boolean {
  return (e) => e.key.toLowerCase() === key && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

/**
 * A key whose printed character already requires Shift to type on a standard layout
 * (`?` is Shift+`/`). Checked by exact character, and Shift is deliberately excluded
 * from the modifier check — to the person pressing it, this is one keystroke, not a
 * modified one, which is how the issue itself describes it ("opening help (?)").
 */
function bareSymbol(key: string): (e: KeyLikeEvent) => boolean {
  return (e) => e.key === key && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** The Shift-modified form used for every printer action (Pause, Resume, Stop, Home). */
function shiftOnly(key: string): (e: KeyLikeEvent) => boolean {
  return (e) =>
    e.key.toLowerCase() === key && e.shiftKey === true && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export interface Binding {
  match: (e: KeyLikeEvent) => boolean;
  action: ShortcutAction;
  /** How the key is written for a person — e.g. `Shift+S`. Drives the Help tab table. */
  display: string;
  /** What the binding does, in Help-tab prose. */
  label: string;
}

/**
 * Single source of truth for what is bound to what — `keyboard-shortcuts.ts` reads
 * `match`/`action` to dispatch, and the Help tab (`help.ts`) reads `display`/`label` to
 * render the table, so the documented bindings and the live ones cannot drift apart.
 */
export const BINDINGS: ReadonlyArray<Binding> = [
  {
    match: bare('1'),
    action: { type: 'tab', tab: 'dashboard' },
    display: '1',
    label: 'Switch to the Dashboard tab',
  },
  {
    match: bare('2'),
    action: { type: 'tab', tab: 'tools' },
    display: '2',
    label: 'Switch to the Tools tab',
  },
  {
    match: bare('3'),
    action: { type: 'tab', tab: 'settings' },
    display: '3',
    label: 'Switch to the Settings tab',
  },
  {
    match: bare('4'),
    action: { type: 'tab', tab: 'debug' },
    display: '4',
    label: 'Switch to the Debug tab',
  },
  {
    match: bare('5'),
    action: { type: 'tab', tab: 'help' },
    display: '5',
    label: 'Switch to the Help tab',
  },
  {
    match: bare('f'),
    action: { type: 'focus-filter' },
    display: 'F',
    label: 'Focus the file filter (Files list)',
  },
  {
    match: bare('c'),
    action: { type: 'toggle-camera-overlay' },
    display: 'C',
    label: 'Toggle the camera status overlay',
  },
  {
    match: bareSymbol('?'),
    action: { type: 'help' },
    display: '?',
    label: 'Open this Help tab',
  },
  {
    match: shiftOnly('p'),
    action: { type: 'pause' },
    display: 'Shift+P',
    label: 'Pause the current print',
  },
  {
    match: shiftOnly('r'),
    action: { type: 'resume' },
    display: 'Shift+R',
    label: 'Resume the paused print',
  },
  {
    match: shiftOnly('s'),
    action: { type: 'stop' },
    display: 'Shift+S',
    label: 'Stop the current print — asks for confirmation',
  },
  {
    match: shiftOnly('h'),
    action: { type: 'home' },
    display: 'Shift+H',
    label: 'Home all axes — asks for confirmation',
  },
];

/**
 * Resolve a key event to an action, or `null`.
 *
 * The three guards run before any binding is even consulted, so a new binding added
 * later inherits them for free rather than needing to remember to ask.
 */
export function resolveShortcut(
  event: KeyLikeEvent,
  context: ShortcutContext,
): ShortcutAction | null {
  if (context.inputFocused) return null;
  if (context.modalOpen) return null;
  if (event.repeat) return null;

  for (const binding of BINDINGS) {
    if (binding.match(event)) return binding.action;
  }
  return null;
}
