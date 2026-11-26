/**
 * Camera health from evidence (ELEG-178).
 *
 * The old `getCameraHealth()` answered `available` only if a frame had been cached in the
 * last 5 s or an upstream was *open*, so the resting state with no viewer was
 * `unavailable`, and a connection that never delivered a frame read as `available`. Both
 * were artefacts of when somebody last pulled a frame, not facts about the camera.
 *
 * This module separates the two halves: `CameraEvidence` records what actually happened
 * (a frame arrived, an attempt opened, an attempt failed and why), and
 * `deriveCameraHealth` turns that plus the printer's own `external_device.camera` into a
 * state. The derivation is pure so every state can be pinned by a test.
 *
 * Deliberately **no background probe** of the camera port: the firmware serves at most
 * ~4 MJPEG clients, and a probe would hold one of them. Evidence comes only from real
 * attempts — a viewer's stream, or a snapshot taken by the AI monitor, Telegram or REST.
 */

import type { CameraHealth } from '../types.js';

/** A frame younger than this means the camera is streaming. */
export const STREAMING_WINDOW_MS = 10_000;

/** What really happened on the camera path. Mutated by the proxy in `rest-api.ts`. */
export class CameraEvidence {
  lastFrameAt: number | null = null;
  lastFailureAt: number | null = null;
  lastFailure: string | null = null;
  /** Set while an upstream attempt is open and has not yet produced a frame. */
  connectingSince: number | null = null;

  attemptStarted(now = Date.now()): void {
    this.connectingSince = now;
  }

  frame(now = Date.now()): void {
    this.lastFrameAt = now;
    this.connectingSince = null;
  }

  failed(reason: string, now = Date.now()): void {
    this.lastFailureAt = now;
    this.lastFailure = reason;
    this.connectingSince = null;
  }

  /** An attempt that ended without a frame or an error (e.g. no viewer left). */
  attemptEnded(): void {
    this.connectingSince = null;
  }

  /**
   * The printer (re)connected over MQTT. A failure recorded while it was away says nothing
   * about the camera now, and with no viewer nothing would retry to overwrite it — so it
   * is dropped, and the printer's fresh `external_device.camera` decides again.
   */
  printerReconnected(): void {
    this.lastFailureAt = null;
    this.lastFailure = null;
  }

  /** The printer changed (ELEG-95): nothing known about the old camera applies. */
  reset(): void {
    this.lastFrameAt = null;
    this.lastFailureAt = null;
    this.lastFailure = null;
    this.connectingSince = null;
  }
}

export interface CameraHealthInput {
  /** `config.cameraEnabled`. */
  enabled: boolean;
  /**
   * The printer's `external_device.camera`, **only while MQTT is connected**. When it is
   * not, the store still replays the last-known status (ELEG-167 saw `camera: true` from a
   * printer that was off the network), so the caller passes `null` instead.
   */
  printerReportsCamera: boolean | null;
}

function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 120) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** The camera's state from evidence. See `CameraState` in `src/types.ts` for the order. */
export function deriveCameraHealth(
  ev: Readonly<CameraEvidence>,
  input: CameraHealthInput,
  now = Date.now(),
): CameraHealth {
  const base = {
    lastFrameAt: ev.lastFrameAt,
    lastFailureAt: ev.lastFailureAt,
    lastFailure: ev.lastFailure,
    printerReportsCamera: input.printerReportsCamera,
  };

  if (!input.enabled) {
    return { ...base, state: 'disabled', reason: 'Camera disabled (CAMERA_ENABLED=false)' };
  }

  if (ev.lastFrameAt !== null && now - ev.lastFrameAt < STREAMING_WINDOW_MS) {
    return { ...base, state: 'streaming', reason: `Last frame ${ago(ev.lastFrameAt, now)}` };
  }

  // A failure newer than the last frame wins over a retry in progress, so a dead camera
  // reads `unreachable` steadily instead of flickering through `connecting` every retry.
  if (
    ev.lastFailureAt !== null &&
    (ev.lastFrameAt === null || ev.lastFailureAt >= ev.lastFrameAt)
  ) {
    return {
      ...base,
      state: 'unreachable',
      reason: `${ev.lastFailure ?? 'Camera request failed'} (${ago(ev.lastFailureAt, now)})`,
    };
  }

  if (ev.connectingSince !== null) {
    return {
      ...base,
      state: 'connecting',
      reason: `Waiting for the first frame (${ago(ev.connectingSince, now)})`,
    };
  }

  if (input.printerReportsCamera === true) {
    const last = ev.lastFrameAt !== null ? `; last frame ${ago(ev.lastFrameAt, now)}` : '';
    return {
      ...base,
      state: 'idle',
      reason: `Printer reports a camera; no viewer is pulling frames${last}`,
    };
  }

  if (input.printerReportsCamera === false) {
    return { ...base, state: 'absent', reason: 'Printer reports no camera attached' };
  }

  return {
    ...base,
    state: 'unknown',
    reason: 'Printer not connected, and no camera request has been made',
  };
}

/** `external_device.camera`, trusted only from a connected printer. */
export function printerCameraReport(
  connected: boolean,
  status: { external_device?: { camera?: boolean } } | null | undefined,
): boolean | null {
  if (!connected) return null;
  const camera = status?.external_device?.camera;
  return typeof camera === 'boolean' ? camera : null;
}
