export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** Fetch with AbortController timeout (default 15s). Throws on timeout. */
export function fetchTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

export function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Format a Date as HH:MM local time (e.g. "14:35") */
export function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fanPct(speed: number): number {
  return Math.round((speed / 255) * 100);
}

export function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Thumbnail placeholder ───────────────────────────────────────────
//
// Thumbnails arrive from the printer as base64 PNG (method 1045). A truncated or
// corrupt one used to fall back to the browser's broken-image icon, which reads as
// "this app is broken" rather than "this one file has no usable preview" (ELEG-42).

/**
 * Neutral stand-in for a thumbnail that is missing or will not decode.
 *
 * Stroke-only on a transparent background deliberately: a data-URI SVG cannot read the
 * stylesheet's custom properties, so anything with a filled background would have to
 * hardcode one and would then be wrong in whichever theme it was not picked for.
 */
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" ' +
  'stroke="#8a8a9e" stroke-width="2" stroke-linejoin="round">' +
  '<rect x="6" y="9" width="36" height="30" rx="3"/>' +
  '<circle cx="17" cy="20" r="3.5"/>' +
  '<path d="M9 34l10-9 7 6 5-4 8 7"/></svg>';

export const THUMBNAIL_PLACEHOLDER_SRC = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

/**
 * Marks an `<img>` as a printer thumbnail, so the delegated handler below recognises it.
 * Thumbnails render from several places, some as HTML strings with no element handle at
 * render time, so a marker class plus one listener beats threading a handler through
 * each call site — and it covers any thumbnail added later for free.
 */
export const THUMBNAIL_CLASS = 'thumb-img';

/** Swap a failed thumbnail for the placeholder. Idempotent. */
function useThumbnailPlaceholder(img: HTMLImageElement): void {
  // Without this guard a placeholder that itself failed would re-enter forever.
  if (img.dataset.thumbFallback === '1') return;
  img.dataset.thumbFallback = '1';
  img.src = THUMBNAIL_PLACEHOLDER_SRC;
  img.classList.add('thumb-img-fallback');
}

/**
 * Install the one delegated thumbnail-error handler. Call once, at startup.
 *
 * Capture phase is required: `error` on an `<img>` does not bubble, so a listener on
 * `document` only sees it on the way down.
 */
export function installThumbnailFallback(): void {
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLImageElement)) return;
      if (!el.classList.contains(THUMBNAIL_CLASS)) return;
      useThumbnailPlaceholder(el);
    },
    true,
  );
}

/** Analyze thumbnail brightness and toggle a CSS class for dark images */
export function applyDarkThumbnailCheck(img: HTMLImageElement, container: HTMLElement): void {
  const check = () => {
    // The placeholder is a stroke-only SVG: sampling it would read as "dark" on its
    // transparent pixels and dim the container for a file that simply has no preview.
    if (img.dataset.thumbFallback === '1') {
      container.classList.remove('thumbnail-dark');
      return;
    }
    const canvas = document.createElement('canvas');
    const size = 32;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let total = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      count++;
    }
    const avg = count > 0 ? total / count : 128;
    container.classList.toggle('thumbnail-dark', avg < 50);
  };
  if (img.complete && img.naturalWidth > 0) check();
  else img.addEventListener('load', check, { once: true });
}
