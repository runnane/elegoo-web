/**
 * ELEG-178: the camera's health is derived from evidence, not from a 5 s frame cache.
 * One test per state, plus the transitions the old code got wrong: an open-but-silent
 * connection read as `available`, and nobody pulling frames read as `unavailable`.
 */
import { describe, expect, it } from 'vitest';
import {
  CameraEvidence,
  STREAMING_WINDOW_MS,
  deriveCameraHealth,
  printerCameraReport,
} from '../camera-health.js';

const T0 = 1_800_000_000_000;
const ON = { enabled: true, printerReportsCamera: true } as const;

function evidence(): CameraEvidence {
  return new CameraEvidence();
}

describe('deriveCameraHealth — one state each', () => {
  it('disabled: CAMERA_ENABLED=false wins over everything, even a fresh frame', () => {
    const ev = evidence();
    ev.frame(T0);
    const h = deriveCameraHealth(ev, { enabled: false, printerReportsCamera: true }, T0);
    expect(h.state).toBe('disabled');
    expect(h.reason).toContain('CAMERA_ENABLED');
  });

  it('streaming: a frame inside the window', () => {
    const ev = evidence();
    ev.frame(T0);
    const h = deriveCameraHealth(ev, ON, T0 + STREAMING_WINDOW_MS - 1);
    expect(h.state).toBe('streaming');
    expect(h.lastFrameAt).toBe(T0);
  });

  it('unreachable: the last attempt failed, with the reason and the time', () => {
    const ev = evidence();
    ev.failed('Camera answered HTTP 503', T0);
    const h = deriveCameraHealth(ev, ON, T0 + 3_000);
    expect(h.state).toBe('unreachable');
    expect(h.reason).toBe('Camera answered HTTP 503 (3s ago)');
    expect(h.lastFailure).toBe('Camera answered HTTP 503');
    expect(h.lastFailureAt).toBe(T0);
  });

  it('connecting: an attempt is open and no frame has arrived', () => {
    const ev = evidence();
    ev.attemptStarted(T0);
    expect(deriveCameraHealth(ev, ON, T0 + 1_000).state).toBe('connecting');
  });

  it('idle: the connected printer reports a camera and nothing is pulling frames', () => {
    const h = deriveCameraHealth(evidence(), ON, T0);
    expect(h.state).toBe('idle');
    expect(h.printerReportsCamera).toBe(true);
  });

  it('absent: the connected printer reports no camera', () => {
    const h = deriveCameraHealth(evidence(), { enabled: true, printerReportsCamera: false }, T0);
    expect(h.state).toBe('absent');
  });

  it('unknown: no evidence and no printer report', () => {
    const h = deriveCameraHealth(evidence(), { enabled: true, printerReportsCamera: null }, T0);
    expect(h.state).toBe('unknown');
  });
});

describe('deriveCameraHealth — transitions', () => {
  it('connecting does not read as streaming, then a real frame does', () => {
    const ev = evidence();
    ev.attemptStarted(T0);
    expect(deriveCameraHealth(ev, ON, T0).state).not.toBe('streaming');
    ev.frame(T0 + 500);
    expect(deriveCameraHealth(ev, ON, T0 + 600).state).toBe('streaming');
  });

  it('a stale frame with nobody pulling is idle, not an error', () => {
    const ev = evidence();
    ev.frame(T0);
    const h = deriveCameraHealth(ev, ON, T0 + STREAMING_WINDOW_MS);
    expect(h.state).toBe('idle');
    expect(h.reason).toContain('last frame 10s ago');
  });

  it('a failure after the last frame is unreachable, and a retry does not hide it', () => {
    const ev = evidence();
    ev.frame(T0);
    ev.failed('Camera closed the stream', T0 + STREAMING_WINDOW_MS + 1);
    ev.attemptStarted(T0 + STREAMING_WINDOW_MS + 2);
    expect(deriveCameraHealth(ev, ON, T0 + STREAMING_WINDOW_MS + 3).state).toBe('unreachable');
  });

  it('a frame after a failure recovers to streaming', () => {
    const ev = evidence();
    ev.failed('Camera connection failed: connect ECONNREFUSED', T0);
    ev.frame(T0 + 1_000);
    expect(deriveCameraHealth(ev, ON, T0 + 1_500).state).toBe('streaming');
  });

  it('a failure from before the printer reconnected does not outlive the reconnect', () => {
    const ev = evidence();
    ev.failed('Snapshot timed out after 10 s', T0);
    ev.printerReconnected();
    const h = deriveCameraHealth(ev, ON, T0 + 60_000);
    expect(h.state).toBe('idle');
    expect(h.lastFailure).toBeNull();
  });

  it('reset (printer switch) forgets the old camera entirely', () => {
    const ev = evidence();
    ev.failed('Camera answered HTTP 503', T0);
    ev.reset();
    expect(deriveCameraHealth(ev, ON, T0).state).toBe('idle');
  });
});

describe('printerCameraReport', () => {
  const status = { external_device: { camera: true } };

  it('trusts external_device.camera only from a connected printer', () => {
    expect(printerCameraReport(true, status)).toBe(true);
    expect(printerCameraReport(true, { external_device: { camera: false } })).toBe(false);
    // The store replays a stale status while MQTT is down (ELEG-167): not evidence.
    expect(printerCameraReport(false, status)).toBeNull();
  });

  it('is null when the printer has not reported external_device', () => {
    expect(printerCameraReport(true, null)).toBeNull();
    expect(printerCameraReport(true, {})).toBeNull();
  });
});
