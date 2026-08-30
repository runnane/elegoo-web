/**
 * Relative timestamps for the log panels — "2m ago" as a toggle (ELEG-45).
 *
 * **A toggle, never a replacement.** Absolute time is what you need when correlating
 * with `journalctl`, the printer's own display, or somebody else's screenshot — and that
 * is the case where getting it wrong costs the most. So the default is absolute, and the
 * absolute value stays reachable in the `title` attribute even when relative is on.
 *
 * ## Why this updates spans in place instead of re-rendering
 *
 * "2m ago" written once and never updated is worse than a clock: it is a clock that
 * lies. But re-rendering the log on a timer is not the way to fix it, for two reasons
 * that are specific to this repo:
 *
 *  1. **`renderLog` deliberately short-circuits.** It returns early when the last
 *     timestamp and the entry count are both unchanged, so a periodic
 *     `renderLog()` call would do *nothing* — the relative times would sit there stale
 *     and the bug would look like the timer was broken.
 *  2. **A re-render assigns `innerHTML`**, which destroys and rebuilds every row. That
 *     is what fights the auto-scroll and the expand/collapse state, and it is the same
 *     class of problem ELEG-49…52 solved for the list views.
 *
 * So the render sites emit `<span class="…-time" data-ts="…" title="…">`, and `tick()`
 * walks those spans and rewrites their text only. No `innerHTML`, no rebuilt rows,
 * nothing for the auto-scroll or the pause button to fight with.
 */

import { loadUISettings } from './ui-settings';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format `then` relative to `now`, both epoch milliseconds.
 *
 * Pure, and `now` is a parameter rather than a call to `Date.now()` precisely so the
 * boundaries can be tested — they are where these read wrong.
 *
 * Rounds **down** throughout: at 119 seconds this says "1m ago", not "2m ago". Reading
 * a slightly conservative age is better than one that claims more time has passed than
 * actually has, which is the direction that misleads when you are watching something
 * happen.
 */
export function formatRelative(then: number, now: number): string {
  const delta = now - then;

  // A clock skew or an event stamped very slightly in the future should read as "now"
  // rather than as a negative age.
  if (delta < 10 * SECOND) return 'just now';
  if (delta < MINUTE) return `${Math.floor(delta / SECOND)}s ago`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

/** Whether the relative rendering is currently switched on. */
export function relativeEnabled(): boolean {
  return loadUISettings().relativeTimestamps;
}

/**
 * Rewrite the text of every timestamp span on the page.
 *
 * Each span carries `data-ts` (epoch ms) and `data-abs` (the absolute string the site
 * would otherwise have shown), so this can switch either way without the render sites
 * being involved.
 */
export function refreshTimestamps(now: number = Date.now()): void {
  const relative = relativeEnabled();
  for (const el of document.querySelectorAll<HTMLElement>('[data-ts][data-abs]')) {
    const ts = Number(el.dataset.ts);
    const abs = el.dataset.abs ?? '';
    if (!Number.isFinite(ts)) continue;
    el.textContent = relative ? formatRelative(ts, now) : abs;
    // The absolute value stays available on hover in both modes — that is the whole
    // point of not making this a replacement.
    el.title = abs;
  }
}

/**
 * Build the markup for one timestamp cell.
 *
 * Called by the three render sites so the attribute contract lives in one place; the
 * ticker below depends on it.
 */
export function timestampSpan(cls: string, ts: number, absolute: string): string {
  const text = relativeEnabled() ? formatRelative(ts, Date.now()) : absolute;
  return `<span class="${cls}" data-ts="${ts}" data-abs="${escapeAttr(absolute)}" title="${escapeAttr(absolute)}">${escapeAttr(text)}</span>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the once-a-second refresh.
 *
 * Cheap by construction: it touches only `textContent` on the timestamp spans, and only
 * while relative mode is on. Idempotent, so calling it again does not stack timers.
 */
export function startTimestampTicker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (relativeEnabled()) refreshTimestamps();
  }, SECOND);
}

/** Stop the ticker. Exists for symmetry and for tests. */
export function stopTimestampTicker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
