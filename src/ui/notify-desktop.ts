/**
 * Desktop notification alongside the audible alert (ELEG-84).
 *
 * Reuses `alertForEvent` from `alert-sound.ts` rather than inventing a second rule about
 * which events matter — ELEG-46 already guarded against exactly that drift, and ELEG-84
 * is explicit that a notification must reuse the same decision rather than write a
 * second one.
 *
 * **Secure-context conclusion, recorded here because this file is where it bites.** The
 * Notifications API only works in a secure context (`https:` or `localhost`). Production
 * for this repo (`.agents/deployment.md`) is systemd serving plain HTTP on `:8088` from
 * `/opt/elegooweb`, and the documented Docker/`docker-compose.example.yml` path is the
 * same — `http://<host>:8088`. Whether anything in front of that is HTTPS is decided
 * outside this repo (an ANS reverse-proxy vhost, per AGENTS.md's "Exposure is decided
 * outside this repo"), and this repo has no way to know. So a plain-HTTP LAN address is
 * the *expected* common case for this app, not an edge case — `window.isSecureContext`
 * is false there, and the setting must say so plainly rather than the button silently
 * doing nothing. `localhost` (dev, or a browser on the printer host itself) is the case
 * that works out of the box.
 */

import { alertForEvent } from './alert-sound';
import { loadUISettings } from './ui-settings';

/** Why a notification is or isn't available, for the settings UI to report honestly. */
export type NotifySupport = 'insecure' | 'unsupported' | 'default' | 'denied' | 'granted';

function notificationCtor(): typeof Notification | null {
  // Guard secure context first and explicitly — some browsers still expose the
  // `Notification` global in an insecure context but reject `requestPermission`, which
  // would otherwise show up as an unexplained 'default' that never becomes 'granted'.
  if (!window.isSecureContext) return null;
  const w = window as unknown as { Notification?: typeof Notification };
  return w.Notification ?? null;
}

/** Current support/permission state. */
export function notifySupport(): NotifySupport {
  if (!window.isSecureContext) return 'insecure';
  const Ctor = notificationCtor();
  if (!Ctor) return 'unsupported';
  if (Ctor.permission === 'granted') return 'granted';
  if (Ctor.permission === 'denied') return 'denied';
  return 'default';
}

/**
 * Ask the user for permission.
 *
 * **Must only be called from a user gesture** — a button click in the settings panel,
 * never on page load. Requesting on load either does nothing (many browsers ignore it)
 * or burns the one prompt a user gets, permanently landing on 'denied' with no further
 * browser-level way to ask again.
 */
export async function requestNotifyPermission(): Promise<NotifySupport> {
  const Ctor = notificationCtor();
  if (!Ctor) return notifySupport();
  const result = await Ctor.requestPermission();
  if (result === 'granted') return 'granted';
  if (result === 'denied') return 'denied';
  return 'default';
}

const TITLES: Record<'success' | 'failure', string> = {
  success: 'Print completed',
  failure: 'Print needs attention',
};

const BODIES: Record<'success' | 'failure', string> = {
  success: 'The print finished successfully.',
  failure: 'The print failed or hit a critical error — check the dashboard.',
};

/** A fixed tag: a second notification replaces the first rather than stacking. */
const NOTIFICATION_TAG = 'elegoo-web-alert';

/**
 * Show a desktop notification for a live event, if the setting is on and permission has
 * been granted.
 *
 * **Only ever call this for events arriving live.** The event log is restored on
 * connect, and firing a notification for a print that finished hours ago would be
 * considerably worse than the audio equivalent, because a notification persists after
 * it fires — so `main.ts` calls this from the live-event path and never from
 * `loadEventLogHistory`, the same seam `maybeAlertForEvent` uses.
 */
export function maybeNotifyForEvent(event: Record<string, unknown>): void {
  if (!loadUISettings().notifyDesktop) return;
  if (notifySupport() !== 'granted') return;
  const kind = alertForEvent(event);
  if (!kind) return;
  const Ctor = notificationCtor();
  if (!Ctor) return;
  new Ctor(TITLES[kind], { body: BODIES[kind], tag: NOTIFICATION_TAG });
}
