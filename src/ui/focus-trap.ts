/**
 * Keyboard focus trap for modal overlays (ELEG-41).
 *
 * ## Why this is not merely a tidiness fix
 *
 * The camera fullscreen overlay covers the dashboard, but the dashboard is still there
 * and still interactive. Without a trap, Tab walks focus out of the overlay and onto the
 * move, temperature and stop controls — which the user **cannot see**, and which
 * **command a physical machine with heaters and motors**. A keyboard user could press
 * one without ever knowing it was there.
 *
 * That is the whole reason this is filed as a bug rather than an accessibility nicety,
 * and it is why the background is made `inert` rather than merely visually covered.
 */

/**
 * Selector for things that can hold focus.
 *
 * `:not([disabled])` and the negative-tabindex exclusion matter: a disabled button and a
 * `tabindex="-1"` container are both programmatically focusable but are **not** in the
 * Tab order, so including them would make the wrap land somewhere the user cannot reach
 * by tabbing — which looks exactly like a broken trap.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The focusable elements inside `root`, in Tab order.
 *
 * Filters on **explicit** hiding only — `inert`, `aria-hidden`, the `hidden` attribute,
 * and the repo's own `.hidden` class — deliberately *not* on geometry. `offsetParent`
 * and `getClientRects()` are the usual visibility test, but jsdom has no layout engine
 * and reports every element as having none, so a geometry check would exclude
 * everything under test and the trap would look broken exactly where it is verified.
 *
 * For this overlay the distinction does not arise in practice: the container is the
 * modal, and its children are visible whenever it is open.
 */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('inert') || el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('.hidden')) return false;
    return true;
  });
}

/** Ancestors of `el` up to and including `document.body`. */
function ancestorChain(el: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== document.body) {
    chain.push(node);
    node = node.parentElement;
  }
  return chain;
}

/**
 * Mark everything outside `container` as inert, and return the undo.
 *
 * Walks the ancestor chain and marks each ancestor's *other* children, so the overlay's
 * own subtree stays reachable however deeply it is nested. Marking only `body`'s
 * children would not work here — the camera modal is not a direct child of `body`.
 *
 * Both `inert` and `aria-hidden` are set: `inert` removes it from the tab order in
 * browsers that support it, and `aria-hidden` makes assistive technology agree with what
 * the eye sees, which is the pair the issue asks for.
 */
function makeBackgroundInert(container: HTMLElement): () => void {
  const chain = ancestorChain(container);
  const marked: HTMLElement[] = [];

  for (const node of chain) {
    const parent = node.parentElement;
    if (!parent) continue;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      // Never clobber an element that was already inert or aria-hidden for its own
      // reasons — restoring it to "not hidden" on close would be a new bug.
      if (sibling.hasAttribute('inert') || sibling.hasAttribute('aria-hidden')) continue;
      sibling.setAttribute('inert', '');
      sibling.setAttribute('aria-hidden', 'true');
      marked.push(sibling);
    }
  }

  return () => {
    for (const el of marked) {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
  };
}

export interface FocusTrapOptions {
  /** Called on Escape. The trap does not close anything itself. */
  onEscape?: () => void;
}

/**
 * Trap Tab and Shift+Tab inside `container` until the returned release function runs.
 *
 * Release also restores focus to whatever had it when the trap was created — otherwise a
 * keyboard user is dumped at the top of the document and has to tab all the way back to
 * where they were.
 */
export function createFocusTrap(
  container: HTMLElement,
  options: FocusTrapOptions = {},
): () => void {
  const opener = document.activeElement as HTMLElement | null;
  const undoInert = makeBackgroundInert(container);

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      options.onEscape?.();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusable = focusableWithin(container);
    if (focusable.length === 0) {
      // Nothing to tab to — keep focus on the container rather than letting it escape
      // to the controls behind, which is the case this whole module exists to prevent.
      e.preventDefault();
      container.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey) {
      // Wrapping backwards off the first element, or from the container itself.
      if (active === first || active === container || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
      return;
    }

    if (active === last || !container.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  // Listening on the document in the capture phase, not on the container: once focus has
  // somehow reached the background, a container-scoped listener would never see the
  // keypress and could not pull focus back.
  document.addEventListener('keydown', onKeydown, true);

  const first = focusableWithin(container)[0];
  (first ?? container).focus();

  return function release(): void {
    document.removeEventListener('keydown', onKeydown, true);
    undoInert();
    opener?.focus?.();
  };
}
