/**
 * The Camera card's unavailable state (ELEG-166).
 *
 * Before this the card was a bare black box whenever the camera was down: no text, no
 * reason, no retry, and buttons that could only fail. It consumes the same
 * `service_status.camera` / `cameraHealth` the status pill reads (ELEG-178).
 *
 * Two stability rules:
 * - the empty-state element and its Retry button are created once and only have their
 *   text and `hidden` class changed, because the card is re-rendered from every status
 *   frame and a rebuilt button would eat the click;
 * - the stream is re-requested **once** on recovery, never on every frame. The server
 *   ends a dead `/api/stream` (ELEG-178) and `print-status.ts` only assigns `src` when the
 *   path changes, so without this a dashboard left open stays dark after the printer returns.
 *
 * The stream URL carries no cache-buster: the REST router matches `/api/stream` exactly,
 * so `?t=` would 404. Clearing `src` and assigning it again re-requests it instead.
 */

import type { CameraHealth } from '../types';

/** States in which there is no usable camera. `connecting` is a note, not an error. */
const BAD_STATES = new Set<string>(['unreachable', 'unknown', 'absent', 'disabled', 'unavailable']);

const TITLES: Record<string, string> = {
  disabled: 'Camera disabled',
  absent: 'No camera on this printer',
};

const DEFAULT_REASON: Record<string, string> = {
  unreachable: 'The camera did not answer.',
  unknown: 'The camera state is not known yet.',
  absent: 'The printer reports no camera.',
  disabled: 'The camera is switched off in the service configuration.',
  unavailable: 'The service reports the camera as unavailable.',
};

let streamUrl: () => string = () => '/api/stream';
let state: string | null = null;
let health: CameraHealth | undefined;
let printerHasCamera: boolean | null = null;
let imgErrored = false;
let pendingRecovery = false;
let prevBad = false;
let wired: HTMLImageElement | null = null;

/** `print-status.ts` owns the overlay toggle, so it tells this module which URL is current. */
export function setCameraStreamUrlSource(fn: () => string): void {
  streamUrl = fn;
}

/** True while the card is showing the unavailable state. */
export function isCameraUnavailable(): boolean {
  return isBad();
}

function isBad(): boolean {
  return imgErrored || (state !== null && BAD_STATES.has(state));
}

function printerReports(): boolean {
  if (state === 'idle' || state === 'streaming') return true;
  return health?.printerReportsCamera ?? printerHasCamera === true;
}

function feed(): HTMLImageElement | null {
  return document.getElementById('camera-feed') as HTMLImageElement | null;
}

/** Re-request the stream from the server. */
function reloadStream(): void {
  const img = feed();
  if (!img) return;
  imgErrored = false;
  img.removeAttribute('src');
  img.src = streamUrl();
}

function ensureEmptyState(wrap: HTMLElement): HTMLElement {
  let el = document.getElementById('camera-unavailable');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'camera-unavailable';
  el.className = 'camera-unavailable hidden';
  el.setAttribute('role', 'status');
  el.innerHTML =
    '<strong class="camera-unavailable-title"></strong>' +
    '<span class="camera-unavailable-reason"></span>' +
    '<button type="button" class="btn btn-sm camera-retry-btn">Retry</button>';
  el.querySelector('button')!.addEventListener('click', (e) => {
    e.stopPropagation();
    // The click is itself the re-request, so a later recovery must not repeat it.
    pendingRecovery = false;
    reloadStream();
    reconcile();
  });
  wrap.appendChild(el);
  return el;
}

function wireImage(img: HTMLImageElement): void {
  if (wired === img) return;
  wired = img;
  img.addEventListener('error', () => {
    // An img with no src also errors in some engines; only a real request counts.
    if (!img.getAttribute('src')) return;
    imgErrored = true;
    reconcile();
  });
  img.addEventListener('load', () => {
    if (!imgErrored) return;
    imgErrored = false;
    reconcile();
  });
}

function setButtons(bad: boolean, why: string): void {
  for (const id of ['camera-snapshot-btn', 'camera-overlay-btn', 'camera-expand-btn']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) continue;
    if (bad) {
      if (btn.dataset.origTitle === undefined) btn.dataset.origTitle = btn.title;
      btn.disabled = true;
      btn.dataset.cameraLock = '1';
      btn.title = `Unavailable: ${why}`;
    } else if (btn.dataset.cameraLock === '1') {
      btn.disabled = false;
      delete btn.dataset.cameraLock;
      btn.title = btn.dataset.origTitle ?? '';
      delete btn.dataset.origTitle;
    }
  }
}

function reconcile(): void {
  const wrap = document.getElementById('camera-wrap');
  const img = feed();
  if (!wrap || !img) return;
  wireImage(img);

  const bad = isBad();
  if (bad && !prevBad) pendingRecovery = true;
  prevBad = bad;

  if (!bad && pendingRecovery && printerReports()) {
    pendingRecovery = false;
    reloadStream();
  }

  const el = ensureEmptyState(wrap);
  const connecting = !bad && state === 'connecting';
  const show = bad || connecting;
  el.classList.toggle('hidden', !show);
  wrap.dataset.cameraUnavailable = bad ? '1' : '';
  el.classList.toggle('camera-unavailable-note', connecting);

  let reason = '';
  if (bad) {
    reason =
      health?.reason ||
      (imgErrored && !(state && BAD_STATES.has(state))
        ? 'The video stream could not be loaded.'
        : DEFAULT_REASON[state ?? ''] || 'The camera is not available.');
    (el.querySelector('.camera-unavailable-title') as HTMLElement).textContent =
      (state && TITLES[state]) || 'Camera unavailable';
  } else if (connecting) {
    reason = health?.reason || '';
    (el.querySelector('.camera-unavailable-title') as HTMLElement).textContent =
      'Connecting to camera…';
  }
  (el.querySelector('.camera-unavailable-reason') as HTMLElement).textContent = reason;
  // Retry does nothing useful when the camera is off by configuration or the printer has none.
  (el.querySelector('button') as HTMLElement).classList.toggle(
    'hidden',
    !bad || state === 'disabled' || state === 'absent',
  );

  setButtons(bad, reason);
}

/** Feed it every `service_status` payload (initial and pushed). */
export function applyCameraStatus(data: { camera?: unknown; cameraHealth?: CameraHealth }): void {
  state = typeof data.camera === 'string' ? data.camera : null;
  health = data.cameraHealth;
  reconcile();
}

/** `external_device.camera` from the printer status frame; called on every frame, cheap. */
export function setPrinterReportsCamera(has: boolean): void {
  printerHasCamera = has;
  reconcile();
}

/** Test seam: drop all module state. */
export function resetCameraCardForTest(): void {
  state = null;
  health = undefined;
  printerHasCamera = null;
  imgErrored = false;
  pendingRecovery = false;
  prevBad = false;
  wired = null;
}
