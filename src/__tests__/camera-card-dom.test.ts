// @vitest-environment jsdom
/**
 * The Camera card's unavailable state (ELEG-166). See `service-status-dom.test.ts` for the
 * jsdom conventions. The state arrives through `updateServiceStatus`, exactly as it does
 * from `/ws`, so the wiring is under test and not just the module.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetCameraCardForTest, setCameraStreamUrlSource } from '../ui/camera-card';
import { updateServiceStatus } from '../ui/service-status';

function mountCard() {
  document.body.innerHTML = `
    <div id="camera-card">
      <button id="camera-snapshot-btn" title="Save snapshot">Snapshot</button>
      <button id="camera-overlay-btn" title="Toggle status overlay">Overlay</button>
      <button id="camera-expand-btn" title="Toggle large view">Expand</button>
      <div id="camera-wrap"><img id="camera-feed" alt="Camera off" src="/api/stream"></div>
    </div>`;
  return {
    img: document.getElementById('camera-feed') as HTMLImageElement,
    empty: () => document.getElementById('camera-unavailable') as HTMLElement,
    btn: (id: string) => document.getElementById(id) as HTMLButtonElement,
  };
}

const push = (camera: string, reason = '', printerReportsCamera: boolean | null = true) =>
  updateServiceStatus({
    uptime: 1,
    mqtt: 'connected',
    mqttRegisterAttempts: 0,
    printerSn: 'X',
    printerIp: '192.0.2.10',
    wsClients: 1,
    telegram: 'disabled',
    ai: 'disabled',
    camera,
    cameraHealth: {
      state: camera,
      reason,
      lastFrameAt: null,
      lastFailureAt: null,
      lastFailure: null,
      printerReportsCamera,
    },
  });

/** Record every assignment to `img.src`, because a re-request is an assignment. */
function trackSrc(img: HTMLImageElement): string[] {
  const writes: string[] = [];
  let current = img.getAttribute('src') ?? '';
  Object.defineProperty(img, 'src', {
    configurable: true,
    get: () => current,
    set: (v: string) => {
      current = v;
      writes.push(v);
    },
  });
  return writes;
}

beforeEach(() => {
  resetCameraCardForTest();
  setCameraStreamUrlSource(() => '/api/stream');
});

describe('camera card unavailable state', () => {
  it('says why instead of showing a black box, and locks the buttons with a reason', () => {
    const c = mountCard();
    push('unreachable', 'HTTP 503 from the camera');

    expect(c.empty().classList.contains('hidden')).toBe(false);
    expect(c.empty().textContent).toContain('Camera unavailable');
    expect(c.empty().textContent).toContain('HTTP 503 from the camera');
    for (const id of ['camera-snapshot-btn', 'camera-overlay-btn', 'camera-expand-btn']) {
      expect(c.btn(id).disabled).toBe(true);
      expect(c.btn(id).title).toContain('HTTP 503 from the camera');
    }
  });

  it('re-requests the stream once when the camera comes back, and clears the empty state', () => {
    const c = mountCard();
    push('unreachable', 'timeout');
    const writes = trackSrc(c.img);

    push('idle', 'printer reports a camera');
    expect(writes).toEqual(['/api/stream']);
    expect(c.empty().classList.contains('hidden')).toBe(true);
    expect(c.btn('camera-snapshot-btn').disabled).toBe(false);
    expect(c.btn('camera-snapshot-btn').title).toBe('Save snapshot');

    // A later healthy frame must not re-request again.
    push('streaming');
    push('idle');
    expect(writes).toHaveLength(1);
  });

  it('does not re-request when the printer does not report a camera', () => {
    const c = mountCard();
    push('unreachable', 'timeout', false);
    const writes = trackSrc(c.img);
    push('connecting', '', false);
    expect(writes).toHaveLength(0);
  });

  it('Retry re-assigns the stream and keeps the same button element', () => {
    const c = mountCard();
    push('unreachable', 'timeout');
    const retry = c.empty().querySelector('button') as HTMLButtonElement;
    const writes = trackSrc(c.img);

    retry.click();
    expect(writes).toEqual(['/api/stream']);

    // Another status frame must not rebuild the button under the user.
    push('unreachable', 'timeout');
    expect(c.empty().querySelector('button')).toBe(retry);
    // And the retry already was the re-request: recovery must not repeat it.
    push('idle');
    expect(writes).toHaveLength(1);
  });

  it('shows connecting as a note without Retry and leaves the buttons alone', () => {
    const c = mountCard();
    push('connecting', 'waiting for the first frame');

    expect(c.empty().classList.contains('hidden')).toBe(false);
    expect(c.empty().textContent).toContain('Connecting');
    expect(c.empty().textContent).not.toContain('Camera unavailable');
    expect(c.empty().querySelector('button')!.classList.contains('hidden')).toBe(true);
    expect(c.btn('camera-snapshot-btn').disabled).toBe(false);
  });

  it('treats a failing <img> as unavailable even when the service says idle', () => {
    const c = mountCard();
    push('idle');
    expect(c.empty().classList.contains('hidden')).toBe(true);

    c.img.dispatchEvent(new Event('error'));
    expect(c.empty().classList.contains('hidden')).toBe(false);
    expect(c.btn('camera-expand-btn').disabled).toBe(true);
  });

  it('stays quiet for a healthy stream', () => {
    const c = mountCard();
    push('streaming');
    expect(c.empty().classList.contains('hidden')).toBe(true);
    expect(c.btn('camera-snapshot-btn').disabled).toBe(false);
  });
});
