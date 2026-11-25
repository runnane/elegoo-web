/**
 * Pinch / wheel / double-tap zoom and drag-to-pan for the enlarged camera view
 * (ELEG-158). The maths are in `zoom-pan.ts`; this is only the event wiring.
 *
 * `surface` is the element that receives the gestures and clips the zoomed image; `img`
 * is transformed inside it. `.camera-modal` sets `touch-action: none`, so the browser
 * hands every touch to these pointer handlers instead of zooming the page.
 */
import { type View, IDENTITY, panBy, toggleZoom, wheelFactor, zoomAt } from './zoom-pan';

export interface CameraZoom {
  /** Back to the fitted view — on open and on close. */
  reset(): void;
  /**
   * True when a click at `timeStamp` is the tail of a pan or pinch. The modal closes on
   * a backdrop click. Pointer capture is the primary guard: it retargets a drag's click
   * to `surface`, so a drag released over the backdrop does not close (measured in
   * Chromium — this check alone changes nothing there). This is the fallback for an
   * engine that captures but still targets the click at the common ancestor. Time-boxed
   * because a touch gesture usually ends with no click at all: a flag left set swallowed
   * the next real tap on the backdrop (measured, before this was a timestamp).
   */
  isGestureClick(timeStamp: number): boolean;
}

/** A click this soon (ms) after a gesture ends is that gesture's own click. */
const GESTURE_CLICK_MS = 300;

/** Movement below this (px) is still a tap, not a pan. */
const TAP_SLOP = 8;
/** Two taps within this many ms and px of each other are a double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

export function attachCameraZoom(surface: HTMLElement, img: HTMLImageElement): CameraZoom {
  let view: View = { ...IDENTITY };
  let gestured = false;
  let gestureEndedAt = Number.NEGATIVE_INFINITY;
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number } | null = null;
  let moved = false;
  let lastTap: { t: number; x: number; y: number } | null = null;

  // The image's untransformed layout box: `offset*` ignore the transform.
  const box = () => ({ w: img.offsetWidth, h: img.offsetHeight });
  const local = (clientX: number, clientY: number) => {
    const r = surface.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };
  const apply = () => {
    img.style.transform =
      view.scale === 1 ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    surface.classList.toggle('zoomed', view.scale > 1);
  };
  const pinch = () => {
    const [a, b] = [...pointers.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  img.draggable = false;

  surface.addEventListener('pointerdown', (e) => {
    surface.setPointerCapture?.(e.pointerId);
    const p = local(e.clientX, e.clientY);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      downAt = p;
      moved = false;
    } else {
      moved = true; // a second finger makes this a pinch, never a tap
    }
  });

  surface.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = local(e.clientX, e.clientY);
    if (pointers.size >= 2) {
      const before = pinch();
      pointers.set(e.pointerId, p);
      const after = pinch();
      if (before.dist > 0) {
        view = zoomAt(view, after.dist / before.dist, after.mid.x, after.mid.y, box());
        view = panBy(view, after.mid.x - before.mid.x, after.mid.y - before.mid.y, box());
      }
      gestured = true;
    } else {
      pointers.set(e.pointerId, p);
      if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) > TAP_SLOP) moved = true;
      if (moved && view.scale > 1) {
        view = panBy(view, p.x - prev.x, p.y - prev.y, box());
        gestured = true;
      }
    }
    apply();
  });

  const end = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (gestured) {
      gestureEndedAt = e.timeStamp;
      if (pointers.size === 0) gestured = false;
    }
    if (pointers.size > 0 || moved || e.type === 'pointercancel') return;
    // A clean single tap: two of them close together make a double-tap.
    const p = local(e.clientX, e.clientY);
    const now = e.timeStamp;
    if (
      lastTap &&
      now - lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_PX
    ) {
      view = toggleZoom(view, p.x, p.y, box());
      lastTap = null;
      apply();
    } else {
      lastTap = { t: now, x: p.x, y: p.y };
    }
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);

  surface.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      view = zoomAt(view, wheelFactor(e.deltaY), p.x, p.y, box());
      apply();
    },
    { passive: false },
  );

  return {
    reset() {
      view = { ...IDENTITY };
      pointers.clear();
      lastTap = null;
      gestured = false;
      gestureEndedAt = Number.NEGATIVE_INFINITY;
      apply();
    },
    isGestureClick(timeStamp) {
      return timeStamp - gestureEndedAt < GESTURE_CLICK_MS;
    },
  };
}
